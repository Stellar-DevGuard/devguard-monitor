import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiServer } from '../src/api.js';
import { runWorker } from '../src/worker.js';

async function withServer(api, fn) {
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  try { return await fn(`http://127.0.0.1:${api.address().port}`); }
  finally { await new Promise(resolve => api.close(resolve)); }
}
const contractId = 'C' + 'A'.repeat(55);
test('health endpoint checks database', async () => {
  const server = createApiServer({ pool: { query: async () => ({ rows: [] }) } });
  await withServer(server, async base => {
    const r = await fetch(base + '/health');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: 'ok' });
  });
});
test('events endpoint passes validated pagination and renders result', async () => {
  let options;
  const api = createApiServer({
    pool: { query: async () => ({ rows: [] }) },
    queryEvents: async (_pool, opts) => { options = opts; return { events: [{ id: 'one' }], nextCursor: null }; }
  });
  await withServer(api, async base => {
    const r = await fetch(base + '/v1/events?network=testnet&contractId=' + contractId + '&afterLedger=12&afterEventId=abc&limit=20');
    assert.equal(r.status, 200);
    assert.equal((await r.json()).events[0].id, 'one');
    assert.deepEqual(options, { network: 'testnet', contractId, afterLedger: 12, afterEventId: 'abc', limit: 20 });
  });
});
test('API rejects writes, unknown params, duplicates, and malformed numbers', async () => {
  const api = createApiServer({ pool: { query: async () => ({ rows: [] }) } });
  await withServer(api, async base => {
    assert.equal((await fetch(base + '/v1/events', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/v1/events?unexpected=1')).status, 400);
    assert.equal((await fetch(base + '/v1/events?limit=2&limit=3')).status, 400);
    assert.equal((await fetch(base + '/v1/events?limit=2oops')).status, 400);
  });
});
test('API does not expose storage errors', async () => {
  const api = createApiServer({ pool: { query: async () => { throw Error('DB password secret'); } }, logger: { error() {} } });
  await withServer(api, async base => {
    const r = await fetch(base + '/health');
    assert.equal(r.status, 503);
    assert.doesNotMatch(JSON.stringify(await r.json()), /secret/);
  });
});
test('worker polls, resets backoff after success, then stops on abort', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const delays = [];
  await runWorker({
    pool: {}, rpc: () => {}, config: {}, signal: controller.signal,
    logger: { info() {}, error() {} }, intervalMs: 100, maxBackoffMs: 800,
    ingest: async () => {
      attempts++;
      if (attempts === 1) throw Error('transient');
      if (attempts === 3) controller.abort();
      return { received: 1, inserted: 1 };
    },
    sleepImpl: async ms => { delays.push(ms); }
  });
  assert.deepEqual(delays, [200, 100]);
  assert.equal(attempts, 3);
});
test('worker honors pre-aborted signal and refuses invalid intervals', async () => {
  const controller = new AbortController(); controller.abort();
  let attempts = 0;
  await runWorker({ signal: controller.signal, intervalMs: 100, maxBackoffMs: 200,
    ingest: async () => { attempts++; } });
  assert.equal(attempts, 0);
  await assert.rejects(runWorker({ signal: controller.signal, intervalMs: 0 }), /Invalid polling/);
});
