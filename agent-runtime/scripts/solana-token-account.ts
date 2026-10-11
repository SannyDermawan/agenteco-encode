/**
 * Creates the associated token account of `--owner` for the escrow's settlement token, if it does not
 * exist (docs/SOLANA.md §8): buyers, sellers and the fee treasury each need one before they transact.
 * The payer's keypair file is read locally and never printed.
 *
 *   cd agent-runtime
 *   npx tsx scripts/solana-token-account.ts --keypair <payer.json> --mint <token> --owner <address> [--rpc <url>]
 *
 * Same cluster rule as solana-initialize.ts: devnet, testnet or a local validator only.
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { address, createKeyPairSignerFromBytes } from '@solana/kit'
import { SOLANA_DEVNET_CHAIN_ID, SolanaAdapter } from '../src/chain/solana.ts'
import { SolanaRpcBackend, assertTestCluster } from '../src/chain/solana-rpc.ts'

const { values: args } = parseArgs({
  options: { keypair: { type: 'string' }, mint: { type: 'string' }, owner: { type: 'string' }, rpc: { type: 'string', default: 'https://api.devnet.solana.com' } },
})
for (const name of ['keypair', 'mint', 'owner'] as const) {
  if (!args[name]) {
    console.error(`missing --${name}`)
    process.exit(2)
  }
}

async function main() {
  await assertTestCluster(args.rpc!)
  const payer = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(args.keypair!, 'utf8'))))
  const adapter = new SolanaAdapter(
    {
      chainId: SOLANA_DEVNET_CHAIN_ID,
      programId: payer.address, // not used by this call
      mint: address(args.mint!),
      tokenSymbol: '',
      nativeSymbol: 'SOL',
      explorerUrl: '',
      explorerName: '',
      executionWindow: BigInt(0),
      reviewWindow: BigInt(0),
      firstEscrowId: BigInt(1),
    },
    new SolanaRpcBackend(args.rpc!),
    payer
  )
  const result = await adapter.ensureTokenAccount(args.owner!)
  console.log(result.created ? `created ${result.address} (${result.txHash})` : `already exists: ${result.address}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
