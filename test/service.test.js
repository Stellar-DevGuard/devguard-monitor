import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readConfiguration, startService } from '../src/service.js';

const base = {
  DATABASE_URL: 'postgresql://local/example', CONTRACT_ID: 'C' + 'A'.repeat(55),
  START_LEDGER: '1000', STELLAR_NETWORK: 'testnet', API_PORT: '4100'
};
test('reads valid service configuration with secure loopback defaults', () => {
  const opts = readConfiguration(base);
  assert.equal(opts.config.startLedger, 1000);
  assert.equal(opts.config.limit, 100);
  assert.equal(opts.host, '127.0.0.1');
  assert.equal(opts.port, 4100);
  assert.equal(opts.migrateOnStart, false);
});
test('rejects missing keys and unsafe public bindings', () => {
  assert.throws(() => readConfiguration({ ...base, DATABASE_URL: '' }), /DATABASE_URL/);
  assert.throws(() => readConfiguration({ ...base, API_HOST: '0.0.0.0' }), /loopback/);
  assert.throws(() => readConfiguration({ ...base, START_LEDGER: '-2' }), /START_LEDGER/);
  assert.throws(() => readConfiguration({ ...base, PAGE_SIZE: '1001' }), /PAGE_SIZE/);
  assert.throws(() => readConfiguration({ ...base, API_PORT: '99999' }), /API_PORT/);
});
test('starts listener and worker, then gracefully shuts down exactly once', async () => {
  const calls = [];
  const pool = { query: async sql => { calls.push(sql); return { rows: [] }; },
    end: async () => { calls.push('pool.end'); } };
  class FakeServer extends EventEmitter {
    listen(port, host) { calls.push(`listen:${host}:${port}`); queueMicrotask(() => this.emit('listening')); }
    close(cb) { calls.push('server.close'); cb(); }
  }
  const settings = readConfiguration(base);
  let observedSignal;
  const svc = await startService({
    pool, settings, rpc: async () => ({}),
    createServerImpl: () => new FakeServer(),
    runWorkerImpl: async ({ signal, config }) => {
      observedSignal = signal;
      assert.equal(config.contractId, base.CONTRACT_ID);
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(observedSignal && !observedSignal.aborted);
  await Promise.all([svc.close(), svc.close()]);
  assert.equal(observedSignal.aborted, true);
  assert.deepEqual(calls, [
    'SELECT 1 FROM devguard_checkpoints LIMIT 0',
    'listen:127.0.0.1:4100', 'server.close', 'pool.end'
  ]);
});
test('fails before listening when database tables are missing', async () => {
  const pool = { query: async () => { throw Error('relation does not exist'); }, end: async () => {} };
  await assert.rejects(startService({ pool, settings: readConfiguration(base) }), /relation does not exist/);
});
