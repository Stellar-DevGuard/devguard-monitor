import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate, ingestPage, listEvents } from '../src/postgres.js';
import { NETWORKS } from '../src/ingester.js';

const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
const contractId = 'C' + 'A'.repeat(55);
const config = { network: 'testnet', contractId, startLedger: 500, limit: 2 };
function remote(pages) {
  return async method => {
    if (method === 'getNetwork') return { passphrase: NETWORKS.testnet };
    if (method === 'getHealth') return { oldestLedger: 400 };
    if (method === 'getEvents') return pages.shift();
    throw Error('Unsupported RPC method');
  };
}
test('real PostgreSQL: atomic checkpoints, idempotent rows and same-ledger pagination', async () => {
  await migrate(pool);
  await pool.query('DELETE FROM devguard_events WHERE network=$1 AND contract_id=$2', ['testnet', contractId]);
  await pool.query('DELETE FROM devguard_checkpoints WHERE network=$1 AND contract_id=$2', ['testnet', contractId]);
  const events = ['a','b','c'].map(id => ({ id, contractId, ledger: 500 }));
  try {
    const rpc = remote([
      { events: events.slice(0,2), cursor: 'c1', latestLedger: 520 },
      { events: [events[1], events[2]], cursor: 'c2', latestLedger: 521 }
    ]);
    const first = await ingestPage({ pool, rpc, config });
    const second = await ingestPage({ pool, rpc, config });
    assert.equal(first.inserted, 2);
    assert.equal(second.inserted, 1);
    const stored = await pool.query('SELECT cursor FROM devguard_checkpoints WHERE network=$1 AND contract_id=$2', ['testnet', contractId]);
    assert.equal(stored.rows[0].cursor, 'c2');
    const page1 = await listEvents(pool, { network: 'testnet', contractId, limit: 2 });
    const page2 = await listEvents(pool, { network: 'testnet', contractId, ...page1.nextCursor, limit: 2 });
    assert.deepEqual([...page1.events, ...page2.events].map(e => e.id), ['a','b','c']);
  } finally {
    await pool.query('DELETE FROM devguard_events WHERE network=$1 AND contract_id=$2', ['testnet', contractId]);
    await pool.query('DELETE FROM devguard_checkpoints WHERE network=$1 AND contract_id=$2', ['testnet', contractId]);
    await pool.end();
  }
});
