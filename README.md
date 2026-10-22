# Stellar DevGuard Monitor

A checkpointed, read-only Soroban contract-event ingester. Fetches one page of Stellar RPC `getEvents` per invocation and saves the results and pagination cursor in an atomic JSON snapshot.

> Community-maintained; not affiliated with or endorsed by the Stellar Development Foundation.

## Requirements

Node.js 20+ and a Stellar RPC endpoint with sufficient event history. No wallet keys or accounts required.

## Quick start

```bash
npm ci
npm run check
npm test
node src/cli.js --rpc-url https://soroban-testnet.stellar.org --contract-id YOUR_CONTRACT_ID --start-ledger YOUR_RECENT_LEDGER --output ./data/events.json --network testnet --limit 100
```

Run the same command repeatedly to fetch additional pages. You must supply a valid deployed Soroban contract ID and a ledger still available in your RPC provider's retention window. The program checks the RPC network passphrase before querying events.

The JSON snapshot includes the original RPC event objects and an opaque cursor. Duplicate `id` values are suppressed during subsequent runs. An atomic file rename keeps the event list and cursor in a single checkpoint, reducing the risk of advancing without saving data.

## Limitations and safety

- Runs **one page per invocation**, not a continuous background service. Use a scheduler or worker process to poll regularly.
- Run only **one worker per output file**; simultaneous writers are not coordinated and could lose updates.
- Local JSON storage grows with every event and is not suitable for large production histories. A transactional database and unique event constraint are planned.
- If the selected start ledger is older than the RPC provider's retention window, ingestion stops rather than silently skipping history. Existing cursors may also become unavailable and produce an RPC error.
- It cannot reconstruct events older than your provider retains. For historical backfills use archival infrastructure or previously persisted data.
- An RPC endpoint receives the contract IDs you query. Do not put endpoint credentials into the URL.
- No smart-contract deployment, transaction signing, or wallet access is performed.

## Architecture

`src/ingester.js` validates configuration, implements a strict JSON-RPC 2.0 client, verifies the network, and processes a page of events. `fileStore()` persists one atomic checkpoint. `src/cli.js` is a thin argument parser and CLI entry point. Unit tests run with mocked RPC and a real temporary directory.

## Roadmap

1. Add PostgreSQL storage with unique event IDs and transactional cursor commits.
2. Expose query endpoints for contract event history.
3. Add periodic polling with bounded retries, backoff, and metrics.
4. Add multi-contract configuration and lifecycle management.
5. Integrate with DevGuard Dashboard.

## License

MIT. Contributions are welcome via focused PRs that include tests and an explanation of behavior.
