import { setTimeout as sleep } from 'node:timers/promises';
import { ingestPage } from './postgres.js';

/** One process per contract. Cursor row locking protects DB commits but not RPC rate limits. */
export async function runWorker({
  pool, rpc, config, signal, logger = console, ingest = ingestPage,
  intervalMs = 5000, maxBackoffMs = 60000, sleepImpl = sleep
}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 ||
      !Number.isSafeInteger(maxBackoffMs) || maxBackoffMs < intervalMs) {
    throw new RangeError('Invalid polling interval or backoff');
  }
  if (!signal || typeof signal.aborted !== 'boolean') throw new TypeError('AbortSignal is required');
  let failures = 0;
  while (!signal.aborted) {
    try {
      const result = await ingest({ pool, rpc, config });
      failures = 0;
      logger.info?.('DevGuard poll completed', {
        received: result.received, inserted: result.inserted, latestLedger: result.latestLedger
      });
    } catch (error) {
      if (signal.aborted) break;
      failures++;
      logger.error?.('DevGuard poll failed', { error: error.message, failures });
    }
    if (signal.aborted) break;
    const delay = failures === 0 ? intervalMs :
      Math.min(maxBackoffMs, intervalMs * (2 ** Math.min(failures, 20)));
    try { await sleepImpl(delay, undefined, { signal }); }
    catch (error) {
      if (signal.aborted || error?.name === 'AbortError') break;
      throw error;
    }
  }
}
