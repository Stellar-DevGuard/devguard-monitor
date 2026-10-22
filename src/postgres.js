import { NETWORKS, MonitorError } from './ingester.js';

/** Schema is static; applications should use an isolated DB role. */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS devguard_checkpoints (
 network TEXT NOT NULL, contract_id TEXT NOT NULL, start_ledger BIGINT NOT NULL,
 cursor TEXT, latest_ledger BIGINT, updated_at TIMESTAMPTZ,
 PRIMARY KEY (network, contract_id)
);
CREATE TABLE IF NOT EXISTS devguard_events (
 network TEXT NOT NULL, contract_id TEXT NOT NULL, event_id TEXT NOT NULL,
 ledger BIGINT NOT NULL, payload JSONB NOT NULL,
 PRIMARY KEY (network, contract_id, event_id)
);
CREATE INDEX IF NOT EXISTS devguard_events_ledger_idx
 ON devguard_events (network, contract_id, ledger, event_id);`;

export async function migrate(pool) { await pool.query(SCHEMA); }

/** Fetch outside a DB transaction, compare and commit under a checkpoint row lock. */
export async function ingestPage({ pool, rpc, config, clock = () => new Date() }) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('A pg-compatible pool is required');
  const keys = [config.network, config.contractId];
  const network = await rpc('getNetwork');
  if (network?.passphrase !== NETWORKS[config.network]) throw new MonitorError('RPC network passphrase mismatch');
  const checkpoint = await pool.query(
    'SELECT start_ledger, cursor FROM devguard_checkpoints WHERE network = $1 AND contract_id = $2', keys);
  const prior = checkpoint.rows[0] ?? null;
  if (checkpoint.rows.length > 1 || (prior && Number(prior.start_ledger) !== config.startLedger))
    throw new MonitorError('Checkpoint conflicts with configured startLedger');
  const cursor = prior?.cursor ?? null;
  const health = await rpc('getHealth');
  if (!cursor && Number.isSafeInteger(health?.oldestLedger) && config.startLedger < health.oldestLedger)
    throw new MonitorError('Start ledger is outside RPC retention');
  const params = { filters: [{ type: 'contract', contractIds: [config.contractId] }], pagination: { limit: config.limit } };
  if (cursor) params.pagination.cursor = cursor;
  else params.startLedger = config.startLedger;
  const page = await rpc('getEvents', params);
  if (!page || !Array.isArray(page.events)) throw new MonitorError('Malformed RPC event page');
  if (page.cursor != null && (typeof page.cursor !== 'string' || !page.cursor))
    throw new MonitorError('Malformed RPC cursor');
  for (const event of page.events) {
    if (typeof event?.id !== 'string' || !event.id || event.contractId !== config.contractId ||
        !Number.isSafeInteger(event.ledger) || event.ledger < config.startLedger)
      throw new MonitorError('Malformed or unexpected contract event');
  }
  const client = await pool.connect();
  let open = false;
  try {
    await client.query('BEGIN'); open = true;
    await client.query(
      'INSERT INTO devguard_checkpoints (network, contract_id, start_ledger) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [...keys, config.startLedger]);
    const locked = await client.query(
      'SELECT start_ledger, cursor FROM devguard_checkpoints WHERE network = $1 AND contract_id = $2 FOR UPDATE', keys);
    const current = locked.rows[0];
    if (!current || Number(current.start_ledger) !== config.startLedger || (current.cursor ?? null) !== cursor)
      throw new MonitorError('Checkpoint moved during RPC fetch; retry');
    let inserted = 0;
    for (const event of page.events) {
      const row = await client.query(
        'INSERT INTO devguard_events (network, contract_id, event_id, ledger, payload) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING',
        [...keys, event.id, event.ledger, JSON.stringify(event)]);
      inserted += row.rowCount;
    }
    const nextCursor = page.cursor ?? cursor;
    await client.query(
      'UPDATE devguard_checkpoints SET cursor=$3, latest_ledger=$4, updated_at=$5 WHERE network=$1 AND contract_id=$2',
      [...keys, nextCursor, page.latestLedger ?? null, clock()]);
    await client.query('COMMIT'); open = false;
    return { received: page.events.length, inserted, cursor: nextCursor, latestLedger: page.latestLedger ?? null };
  } catch (error) {
    if (open) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { error.rollbackError = rollbackError; }
    }
    throw error;
  } finally { client.release(); }
}

export async function listEvents(pool, { network, contractId, afterLedger = 0, limit = 100 }) {
  if (!Object.hasOwn(NETWORKS, network) || !/^C[A-Z2-7]{55}$/.test(contractId))
    throw new TypeError('Invalid network or contract ID');
  if (!Number.isSafeInteger(afterLedger) || afterLedger < 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError('Invalid pagination');
  const result = await pool.query(
    'SELECT payload FROM devguard_events WHERE network=$1 AND contract_id=$2 AND ledger>$3 ORDER BY ledger, event_id LIMIT $4',
    [network, contractId, afterLedger, limit]);
  return result.rows.map(row => row.payload);
}
