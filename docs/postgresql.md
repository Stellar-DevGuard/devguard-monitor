# PostgreSQL event storage (experimental)

The `src/postgres.js` module provides database persistence alongside the original JSON file store. It is not yet the default CLI backend.

## Why PostgreSQL?

Stellar RPC `getEvents` history is bounded. Persisting events by `(network, contract_id, event_id)` prevents duplicate storage, and committing a page's events and cursor in the same SQL transaction prevents advancing a checkpoint without committing its events.

## Usage

Install a compatible `pg` package in the consuming service and configure it with environment variables (never commit credentials).

```js
import pg from 'pg';
import { validateConfig, createRpc } from '../src/ingester.js';
import { migrate, ingestPage, listEvents } from '../src/postgres.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const config = validateConfig({
  rpcUrl: process.env.STELLAR_RPC_URL,
  network: 'testnet',
  contractId: process.env.CONTRACT_ID,
  startLedger: Number(process.env.START_LEDGER)
});
try {
  await migrate(pool); // use a dedicated migration role in production
  const result = await ingestPage({ pool, rpc: createRpc(config.rpcUrl), config });
  console.log(result);
  console.log(await listEvents(pool, { network: config.network, contractId: config.contractId }));
} finally {
  await pool.end();
}
```

## Guarantees and limitations

- The checkpoint row is locked during the SQL transaction. Competing workers that fetched the same cursor cannot both advance it; one fails and should retry from a new checkpoint.
- RPC requests occur outside the transaction to avoid holding database locks during network requests.
- Event IDs are unique within a network/contract pair. Writes are idempotent.
- A crashed transaction rolls back both events and cursor.
- Query pagination uses an exclusive `afterLedger`; for multiple events in the same ledger, use a composite (ledger, event ID) cursor before relying on this query for complete pagination.
- There is no built-in scheduler, connection pooling implementation, backoff strategy, or HTTP API. This module accepts a compatible externally managed pool.
- Database integration tests against a real PostgreSQL instance remain outstanding. Current tests use a mock pool.
- PostgreSQL must run over an authenticated, encrypted connection in real deployments.

Stellar reference: https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getEvents
