import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestPage, listEvents, migrate, SCHEMA } from '../src/postgres.js';
import { NETWORKS } from '../src/ingester.js';

const config = { network: 'testnet', contractId: 'C' + 'A'.repeat(55), startLedger: 100, limit: 20 };
const event = { id: '100-1', contractId: config.contractId, ledger: 100 };
function pool({ prior, locked = { start_ledger: '100', cursor: null }, failInsert = false } = {}) {
  const calls = []; let released = false;
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT start_ledger') && !sql.includes('FOR UPDATE')) return { rows: prior ? [prior] : [] };
    if (sql.includes('FOR UPDATE')) return { rows: [locked] };
    if (sql.includes('INSERT INTO devguard_events')) {
      if (failInsert) throw Error('write failed');
      return { rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };
  return { query, calls, connect: async () => ({ query, release: () => { released = true; } }),
    get released() { return released; } };
}
function rpc(page = { events: [event], cursor: 'next', latestLedger: 120 }, passphrase = NETWORKS.testnet) {
  const calls = [];
  const run = async (method, params) => {
    calls.push({ method, params });
    if (method === 'getNetwork') return { passphrase };
    if (method === 'getHealth') return { oldestLedger: 90 };
    return page;
  };
  return { run, calls };
}
test('schema has composite primary keys', () => {
  assert.match(SCHEMA, /PRIMARY KEY \(network, contract_id, event_id\)/);
});
test('inserts events and cursor in one transaction', async () => {
  const db = pool(), remote = rpc();
  const result = await ingestPage({ pool: db, rpc: remote.run, config });
  assert.equal(result.inserted, 1);
  assert.equal(remote.calls[2].params.startLedger, 100);
  assert.ok(db.calls.some(c => c.sql === 'COMMIT'));
  assert.equal(db.released, true);
});
test('cursor resumption omits startLedger', async () => {
  const db = pool({ prior: { start_ledger: '100', cursor: 'old' },
    locked: { start_ledger: '100', cursor: 'old' } }), remote = rpc({ events: [], cursor: 'new' });
  await ingestPage({ pool: db, rpc: remote.run, config });
  assert.equal(remote.calls[2].params.pagination.cursor, 'old');
  assert.equal(remote.calls[2].params.startLedger, undefined);
});
test('cursor conflict rolls back', async () => {
  const db = pool({ locked: { start_ledger: '100', cursor: 'moved' } });
  await assert.rejects(ingestPage({ pool: db, rpc: rpc().run, config }), /Checkpoint moved/);
  assert.ok(db.calls.some(c => c.sql === 'ROLLBACK'));
});
test('database error rolls back cursor update', async () => {
  const db = pool({ failInsert: true });
  await assert.rejects(ingestPage({ pool: db, rpc: rpc().run, config }), /write failed/);
  assert.ok(!db.calls.some(c => c.sql === 'COMMIT'));
  assert.ok(db.calls.some(c => c.sql === 'ROLLBACK'));
});
test('network mismatch blocks event ingestion', async () => {
  const db = pool();
  await assert.rejects(ingestPage({ pool: db, rpc: rpc(undefined, NETWORKS.mainnet).run, config }), /passphrase mismatch/);
  assert.equal(db.calls.length, 0);
});
test('unexpected events rejected before transaction', async () => {
  const db = pool(), remote = rpc({ events: [{ ...event, contractId: 'OTHER' }] });
  await assert.rejects(ingestPage({ pool: db, rpc: remote.run, config }), /unexpected/);
  assert.ok(!db.calls.some(c => c.sql === 'BEGIN'));
});
test('bounded parameterized event lookup', async () => {
  const db = pool();
  await listEvents(db, { network: 'testnet', contractId: config.contractId, limit: 10 });
  assert.deepEqual(db.calls[0].params, ['testnet', config.contractId, 0, 10]);
  await assert.rejects(listEvents(db, { network: 'testnet', contractId: config.contractId, limit: 1000 }), /pagination/);
});
test('schema migration sends static SQL', async () => {
  const db = pool();
  await migrate(db);
  assert.equal(db.calls[0].sql, SCHEMA);
});
