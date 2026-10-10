#!/usr/bin/env node
import { bootstrapChains } from './bootstrap.ts'

// The SDK reads its chain settings when it first loads, so the API's chain list is fetched first.
// (The MCP server's stdout is the protocol: nothing may be printed to it before it starts.)
const argv = process.argv.slice(2)
await bootstrapChains(argv)
const { main } = await import('./main.ts')
process.exit(await main(argv))
