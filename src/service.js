import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { validateConfig, createRpc } from './ingester.js';
import { migrate } from './postgres.js';
import { createApiServer } from './api.js';
import { runWorker } from './worker.js';

function integer(value, fallback, name, min, max) {
  if (value === undefined || value === '') return fallback;
  if (!/^[0-9]+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) ||
      Number(value) < min || Number(value) > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return Number(value);
}

/** Parse environment only; secrets are read by the pg driver and never logged. */
export function readConfiguration(env) {
  if (!env.DATABASE_URL) throw new TypeError('DATABASE_URL is required');
  const config = validateConfig({
    rpcUrl: env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
    contractId: env.CONTRACT_ID,
    startLedger: integer(env.START_LEDGER, NaN, 'START_LEDGER', 1, Number.MAX_SAFE_INTEGER),
    network: env.STELLAR_NETWORK || 'testnet',
    limit: integer(env.PAGE_SIZE, 100, 'PAGE_SIZE', 1, 1000)
  });
  const host = env.API_HOST || '127.0.0.1';
  // Deliberately refuse exposure to all network interfaces.
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new TypeError('API_HOST must be loopback; use an authenticated reverse proxy for external access');
  }
  return {
    config, connectionString: env.DATABASE_URL, host,
    port: integer(env.API_PORT, 4100, 'API_PORT', 1, 65535),
    intervalMs: integer(env.POLL_INTERVAL_MS, 5000, 'POLL_INTERVAL_MS', 100, 3_600_000),
    migrateOnStart: env.MIGRATE_ON_START === 'true'
  };
}

/** Starts one loopback API and a worker; caller owns lifecycle and database pool. */
export async function startService({ pool, settings, logger = console,
  rpc = createRpc(settings.config.rpcUrl),
  createServerImpl = createApiServer, runWorkerImpl = runWorker } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.end !== 'function')
    throw new TypeError('Database pool with query/end is required');
  if (settings.migrateOnStart) await migrate(pool);
  else await pool.query('SELECT 1 FROM devguard_checkpoints LIMIT 0');
  const server = createServerImpl({ pool, logger });
  await new Promise((done, fail) => {
    const onError = error => { server.off('listening', onListening); fail(error); };
    const onListening = () => { server.off('error', onError); done(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(settings.port, settings.host);
  });
  const controller = new AbortController();
  let workerFailure = null;
  const workerPromise = Promise.resolve().then(() => runWorkerImpl({
    pool, rpc, config: settings.config, signal: controller.signal,
    intervalMs: settings.intervalMs, logger
  })).catch(error => {
    workerFailure = error;
    logger.error?.('DevGuard worker terminated', { message: error.message });
    controller.abort();
  });
  let closing = null;
  return {
    server,
    get workerFailure() { return workerFailure; },
    async close() {
      if (closing) return closing;
      closing = (async () => {
        controller.abort();
        await workerPromise;
        await new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
        await pool.end();
      })();
      return closing;
    }
  };
}

/** Startup entry point. The pg package is required only when running the service. */
export async function main(env = process.env) {
  const settings = readConfiguration(env);
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString: settings.connectionString,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000
  });
  let instance;
  try { instance = await startService({ pool, settings }); }
  catch (error) { await pool.end(); throw error; }
  console.log(`DevGuard Monitor API listening on ${settings.host}:${settings.port}`);
  let shutdownStarted = false;
  const shutdown = async () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    try { await instance.close(); }
    catch (error) { console.error('Shutdown failed:', error.message); process.exitCode = 1; }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return instance;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { console.error(`${error.name}: ${error.message}`); process.exitCode = 1; });
}
