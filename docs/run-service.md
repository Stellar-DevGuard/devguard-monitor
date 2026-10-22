# Running the Monitor service (experimental)

This entry point connects the PostgreSQL ingester, read-only HTTP API, and polling worker. It is **not** a production deployment recipe: authentication, migrations, metrics, audit logging, and monitoring of lost RPC retention windows need more work.

## Prerequisites

- Node.js 20+
- PostgreSQL 16 or newer, reachable through a properly secured connection
- An RPC endpoint supporting `getNetwork`, `getHealth`, and `getEvents`
- One real Stellar contract ID and a starting ledger within the endpoint's current retention window

## Run

```bash
npm ci
# The pg driver is not yet a locked runtime dependency; install in your environment.
npm install --no-save --package-lock=false pg@8
# Provide actual values via your shell/secret manager, not .env.example itself.
export DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:5432/devguard'
export STELLAR_NETWORK=testnet
export STELLAR_RPC_URL=https://soroban-testnet.stellar.org
export CONTRACT_ID='YOUR_REAL_C..._STELLAR_CONTRACT_ID'
export START_LEDGER=123456
export MIGRATE_ON_START=true
npm run start:service
```

Use `MIGRATE_ON_START=true` only for initial setup with an authorized database role. For subsequent runs, set it to `false` and grant the runtime role only the permissions it needs.

The HTTP API listens on `127.0.0.1:4100` by default. For a local dashboard in another process:

```bash
# In devguard-dashboard/
MONITOR_API_URL=http://127.0.0.1:4100 npm start
```

Then visit `http://127.0.0.1:3000`. The dashboard and Monitor must have compatible network access. The Monitor API is **unauthenticated**: do not bind or forward it directly to a public interface.

## Running assumptions

- Only one service process should ingest any given network/contract pair. Database row locks protect cursor writes but do not provide distributed scheduling or rate limit coordination.
- `START_LEDGER` must be within the `getHealth.oldestLedger` to `getHealth.latestLedger` range, not an arbitrary historical ledger.
- The worker polls repeatedly, with bounded exponential backoff after RPC failures.
- SIGINT and SIGTERM stop polling, close HTTP listening, and end the database pool.
- PostgreSQL schema creation is separated from runtime by `MIGRATE_ON_START`; no automatic schema versioning yet.
- The `pg` dependency should be added as a pinned, lockfile-backed runtime dependency before a packaged production release.

See [Stellar getEvents](https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getEvents) and [getHealth](https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getHealth) for current RPC behavior.
