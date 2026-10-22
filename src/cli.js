#!/usr/bin/env node
import { createRpc, fileStore, pollOnce, validateConfig } from './ingester.js';
const usage = `DevGuard Monitor — ingest contract events to an atomic local JSON snapshot

Usage:
  node src/cli.js --rpc-url URL --contract-id CONTRACT --start-ledger N --output FILE [--network testnet|mainnet] [--limit N]

Runs one page per invocation. Schedule repeated invocations with an external job runner.
Only run one process per output file. Use a persistent output volume.
`;
export async function run(args, { output = console.log, fetchImpl } = {}) {
  if (args.includes('--help') || args.length === 0) { output(usage); return 0; }
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--rpc-url', '--contract-id', '--start-ledger', '--output', '--network', '--limit'].includes(key)) throw new TypeError(`Unknown flag ${key}`);
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new TypeError(`Missing value for ${key}`);
    if (flags[key]) throw new TypeError(`Duplicate flag ${key}`);
    flags[key] = args[++i];
  }
  if (!flags['--output']) throw new TypeError('--output is required');
  const config = validateConfig({
    rpcUrl: flags['--rpc-url'], contractId: flags['--contract-id'], startLedger: Number(flags['--start-ledger']),
    limit: flags['--limit'] === undefined ? 100 : Number(flags['--limit']), network: flags['--network'] || 'testnet'
  });
  const result = await pollOnce({ rpc: createRpc(config.rpcUrl, { fetchImpl }), store: fileStore(flags['--output']), config });
  output(JSON.stringify(result));
  return 0;
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(`${error.name}: ${error.message}`); process.exitCode = 1;
  });
}
