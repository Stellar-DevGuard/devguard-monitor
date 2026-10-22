# Monitor API and polling worker (experimental)

The new modules extend the PostgreSQL-backed event ingester. The API is read-only; the worker ingests one RPC page per poll and uses exponential backoff for errors.

## API

`createApiServer({ pool })` from `src/api.js` returns a Node.js HTTP server. Bind it to `127.0.0.1` and place an authenticating reverse proxy in front before exposing it to other hosts.

- `GET /health`: verifies PostgreSQL connectivity; 200 on success or 503 on failure.
- `GET /v1/events?network=testnet&contractId=C...&limit=100`: returns `{ events, nextCursor }`.
- For the next page, provide both `afterLedger` and `afterEventId` from `nextCursor`; records are ordered by ledger/event ID.

The API has **no authentication, rate limiting, TLS termination, or CORS policy**. Do not bind it to a public interface or expose it directly to the internet.

## Worker

`runWorker({ pool, rpc, config, signal })` from `src/worker.js` repeatedly invokes the existing PostgreSQL `ingestPage` function. Use an `AbortController` for graceful shutdown. The default poll interval is 5 seconds with bounded exponential backoff to 60 seconds.

Run only one polling worker per contract. Transactions protect database checkpoints from concurrent writes, but this is not a distributed work queue or leader-election system. No automatic catch-up beyond what the provider still retains is possible.

This module does not start a network server or worker when imported. Application bootstrapping, database credentials, deployment, and authentication remain the operator's responsibility.
