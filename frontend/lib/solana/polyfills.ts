import { Buffer } from 'buffer'

/**
 * The Solana modules shared with agent-runtime (chain/solana.ts and friends) use Node's Buffer.
 * Browsers have none: install one before they run. Imported first by every lib/solana module.
 */
const scope = globalThis as { Buffer?: typeof Buffer }
if (typeof scope.Buffer === 'undefined') scope.Buffer = Buffer
