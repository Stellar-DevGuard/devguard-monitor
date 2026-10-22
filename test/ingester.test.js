import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStore, pollOnce, validateConfig, NETWORKS, createRpc, MonitorError } from '../src/ingester.js';
const contractId = 'C' + 'A'.repeat(55);
const config = validateConfig({ rpcUrl: 'https://rpc.example', contractId, startLedger: 200, limit: 3 });
const event = (id, ledger = 201) => ({ id, contractId, ledger, value: 'AAAA' });
const memoryStore = () => { let value = null; return { load: async () => value, save: async x => { value = structuredClone(x); } }; };
function fakeRpc(pages, network = NETWORKS.testnet, oldestLedger = 100) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'getNetwork') return { passphrase: network };
    if (method === 'getHealth') return { status: 'healthy', oldestLedger, latestLedger: 300 };
    if (method === 'getEvents') return pages.shift();
    throw Error('Unknown RPC method');
  };
  return { rpc, calls };
}
test('validates endpoint, contract, network, and limits', () => {
  assert.throws(() => validateConfig({ ...config, contractId: 'bad' }), /contract ID/);
  assert.throws(() => validateConfig({ ...config, limit: 0 }), /limit/);
  assert.throws(() => validateConfig({ ...config, network: 'unknown' }), /network/);
  assert.throws(() => validateConfig({ ...config, rpcUrl: 'file:///tmp/rpc' }), /RPC URL/);
});
test('first page uses startLedger and saves events', async () => {
  const { rpc, calls } = fakeRpc([{ events: [event('one')], cursor: 'page-one', latestLedger: 300 }]);
  const store = memoryStore();
  const result = await pollOnce({ rpc, store, config, clock: () => 'timestamp' });
  assert.equal(result.added, 1);
  assert.equal(result.total, 1);
  assert.equal((await store.load()).lastPolledAt, 'timestamp');
  assert.equal(calls[2].params.startLedger, 200);
  assert.deepEqual(calls[2].params.pagination, { limit: 3 });
});
test('resumes cursor without startLedger and deduplicates ids', async () => {
  const { rpc, calls } = fakeRpc([
    { events: [event('one')], cursor: 'p1' },
    { events: [event('one'), event('two', 202)], cursor: 'p2' }
  ]);
  const store = memoryStore();
  await pollOnce({ rpc, store, config });
  const result = await pollOnce({ rpc, store, config });
  assert.equal(result.added, 1);
  assert.equal(result.total, 2);
  assert.equal(calls[5].params.startLedger, undefined);
  assert.equal(calls[5].params.pagination.cursor, 'p1');
});
test('rejects unexpected network without querying events', async () => {
  const { rpc, calls } = fakeRpc([], NETWORKS.mainnet);
  await assert.rejects(pollOnce({ rpc, store: memoryStore(), config }), /passphrase mismatch/);
  assert.deepEqual(calls.map(c => c.method), ['getNetwork']);
});
test('rejects ledger outside RPC retention', async () => {
  const { rpc, calls } = fakeRpc([], NETWORKS.testnet, 201);
  await assert.rejects(pollOnce({ rpc, store: memoryStore(), config }), /outside RPC retention/);
  assert.equal(calls.length, 2);
});
test('rejects malformed and unrelated contract events without advancing', async () => {
  const { rpc } = fakeRpc([{ events: [event('one'), { ...event('two'), contractId: 'OTHER' }], cursor: 'bad' }]);
  const store = memoryStore();
  await assert.rejects(pollOnce({ rpc, store, config }), /Malformed or unexpected/);
  assert.equal(await store.load(), null);
});
test('fileStore persists atomically and resumes from disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devguard-'));
  try {
    const store = fileStore(join(dir, 'events.json'));
    const { rpc } = fakeRpc([{ events: [event('one')], cursor: 'one' }]);
    await pollOnce({ rpc, store, config });
    assert.equal(JSON.parse(await readFile(join(dir, 'events.json'), 'utf8')).events.length, 1);
    assert.equal((await store.load()).cursor, 'one');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('rejects mismatched checkpoints', async () => {
  const store = { load: async () => ({ version: 1, contractId: 'OTHER', events: [], cursor: null }), save: async () => {} };
  await assert.rejects(pollOnce({ rpc: async () => {}, store, config }), /does not match/);
});
test('RPC client enforces JSON-RPC ids and reports errors', async () => {
  const rpc = createRpc('https://rpc.example', { fetchImpl: async () => ({ ok: true, json: async () => ({jsonrpc: '2.0', id: 999, result: {}})}) });
  await assert.rejects(rpc('getHealth'), MonitorError);
});
