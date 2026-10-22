import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const NETWORKS = Object.freeze({
  testnet: 'Test SDF Network ; September 2015',
  mainnet: 'Public Global Stellar Network ; September 2015'
});
export class MonitorError extends Error {
  constructor(message) { super(message); this.name = 'MonitorError'; }
}
const CONTRACT_PATTERN = /^C[A-Z2-7]{55}$/;
export function validateConfig({ rpcUrl, contractId, startLedger, limit = 100, network = 'testnet' }) {
  const u = new URL(rpcUrl);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new TypeError('Invalid RPC URL');
  if (!CONTRACT_PATTERN.test(contractId)) throw new TypeError('Expected a Stellar contract ID');
  if (!Number.isSafeInteger(startLedger) || startLedger < 1) throw new TypeError('startLedger must be a positive integer');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('limit must be 1..1000');
  if (!Object.hasOwn(NETWORKS, network)) throw new TypeError('Unknown network');
  return { rpcUrl: u.toString(), contractId, startLedger, limit, network };
}
export function createRpc(url, { fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
  let id = 0;
  return async (method, params = {}) => {
    const requestId = ++id;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (e) { throw new MonitorError(`RPC network failure: ${e.message}`); }
    if (!response.ok) throw new MonitorError(`RPC HTTP ${response.status}`);
    let payload;
    try { payload = await response.json(); } catch { throw new MonitorError('RPC returned invalid JSON'); }
    if (payload?.jsonrpc !== '2.0' || payload.id !== requestId) throw new MonitorError('RPC response ID mismatch');
    if (payload.error) throw new MonitorError(`RPC ${payload.error.code}: ${payload.error.message}`);
    if (!Object.hasOwn(payload, 'result')) throw new MonitorError('RPC result missing');
    return payload.result;
  };
}
export function fileStore(filename) {
  const location = resolve(filename);
  return {
    async load() {
      try { return JSON.parse(await fs.readFile(location, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async save(snapshot) {
      await fs.mkdir(dirname(location), { recursive: true });
      const temp = `${location}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        await fs.rename(temp, location);
      } finally { await fs.rm(temp, { force: true }); }
    }
  };
}
function assertSnapshot(snapshot, config) {
  if (!snapshot || snapshot.version !== 1 || snapshot.contractId !== config.contractId ||
      snapshot.network !== config.network || snapshot.startLedger !== config.startLedger ||
      !Array.isArray(snapshot.events) ||
      (snapshot.cursor !== null && (typeof snapshot.cursor !== 'string' || snapshot.cursor.length === 0))) {
    throw new MonitorError('Existing snapshot does not match configuration or is malformed');
  }
  const ids = new Set();
  for (const event of snapshot.events) {
    if (typeof event?.id !== 'string' || ids.has(event.id)) throw new MonitorError('Snapshot has invalid or duplicate event IDs');
    ids.add(event.id);
  }
  return snapshot;
}
export function initialSnapshot(config) {
  return { version: 1, network: config.network, contractId: config.contractId,
    startLedger: config.startLedger, cursor: null, events: [], lastPolledAt: null, latestLedger: null };
}
export async function pollOnce({ rpc, store, config, clock = () => new Date().toISOString() }) {
  const current = assertSnapshot((await store.load()) ?? initialSnapshot(config), config);
  const network = await rpc('getNetwork');
  if (network?.passphrase !== NETWORKS[config.network]) throw new MonitorError('RPC network passphrase mismatch');
  const health = await rpc('getHealth');
  const oldestLedger = health.oldestLedger;
  if (!current.cursor && Number.isSafeInteger(oldestLedger) && config.startLedger < oldestLedger) {
    throw new MonitorError(`Start ledger ${config.startLedger} is outside RPC retention (oldest ${oldestLedger})`);
  }
  const params = { filters: [{ type: 'contract', contractIds: [config.contractId] }], pagination: { limit: config.limit } };
  if (current.cursor) params.pagination.cursor = current.cursor;
  else params.startLedger = config.startLedger;
  const page = await rpc('getEvents', params);
  if (!page || !Array.isArray(page.events)) throw new MonitorError('RPC getEvents response missing events');
  if (page.cursor != null && (typeof page.cursor !== 'string' || !page.cursor)) throw new MonitorError('Malformed RPC cursor');
  const seen = new Set(current.events.map(event => event.id));
  const nextEvents = [...current.events];
  let added = 0;
  for (const event of page.events) {
    if (typeof event?.id !== 'string' || !event.id || event.contractId !== config.contractId ||
        !Number.isSafeInteger(event.ledger)) throw new MonitorError('Malformed or unexpected contract event');
    if (!seen.has(event.id)) { seen.add(event.id); nextEvents.push(event); added++; }
  }
  const next = { ...current, cursor: page.cursor ?? current.cursor, latestLedger: page.latestLedger ?? current.latestLedger,
    lastPolledAt: clock(), events: nextEvents };
  await store.save(next);
  return { received: page.events.length, added, total: next.events.length, cursor: next.cursor, latestLedger: next.latestLedger };
}
