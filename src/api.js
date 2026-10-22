import { createServer } from 'node:http';
import { listEvents } from './postgres.js';

const send = (res, status, body) => {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(data);
};

/** Deliberately read-only. Bind to loopback unless protected by an authenticating reverse proxy. */
export function createApiServer({ pool, logger = console, queryEvents = listEvents } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('Database pool required');
  return createServer(async (req, res) => {
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { return send(res, 400, { error: 'Invalid URL' }); }
    if (url.pathname === '/health' && url.search === '') {
      try { await pool.query('SELECT 1'); return send(res, 200, { status: 'ok' }); }
      catch { return send(res, 503, { status: 'unavailable' }); }
    }
    if (url.pathname !== '/v1/events') return send(res, 404, { error: 'Not found' });
    const allowed = new Set(['network', 'contractId', 'afterLedger', 'afterEventId', 'limit']);
    if ([...url.searchParams.keys()].some(key => !allowed.has(key)) ||
        [...allowed].some(key => url.searchParams.getAll(key).length > 1)) {
      return send(res, 400, { error: 'Invalid query parameters' });
    }
    const raw = key => url.searchParams.get(key);
    const numeric = (key, fallback) => {
      const value = raw(key);
      return value === null ? fallback : /^\d+$/.test(value) ? Number(value) : NaN;
    };
    const opts = {
      network: raw('network'), contractId: raw('contractId'),
      afterLedger: numeric('afterLedger', 0), afterEventId: raw('afterEventId') ?? '',
      limit: numeric('limit', 100)
    };
    try {
      const result = await queryEvents(pool, opts);
      return send(res, 200, result);
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        return send(res, 400, { error: error.message });
      }
      logger.error?.('Failed to query events', error);
      return send(res, 503, { error: 'Event storage unavailable' });
    }
  });
}
