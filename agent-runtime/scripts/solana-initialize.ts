/**
 * One-time setup of a deployed agenteco_escrow program (docs/SOLANA.md §9): writes its Config
 * (arbiter, treasury, the settlement token, fee, windows).
 *
 *   cd agent-runtime
 *   npx tsx scripts/solana-initialize.ts --keypair ~/.config/solana/devnet-deployer.json \
 *     --mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU --arbiter <address> --treasury <address> [--dry-run]
 *
 * The keypair file is read locally and never printed. The cluster must be Solana devnet, testnet or a
 * local validator: any other genesis hash (mainnet-beta included) is refused. `--dry-run` builds
 * the instruction and prints it without touching the network.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  address,
  appendTransactionMessageInstruction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
} from '@solana/kit'
import { SPL_TOKEN_PROGRAM_ID, SOLANA_DEVNET_CHAIN_ID, buildInitializeInstruction } from '../src/chain/solana.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB_RS = join(HERE, '../../solana/programs/agenteco_escrow/src/lib.rs')
const DEVNET_GENESIS_PREFIX = SOLANA_DEVNET_CHAIN_ID.slice('solana:'.length)
const TESTNET_GENESIS = '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY'

const { values: args } = parseArgs({
  options: {
    keypair: { type: 'string' },
    rpc: { type: 'string', default: 'https://api.devnet.solana.com' },
    'program-id': { type: 'string' },
    mint: { type: 'string' },
    arbiter: { type: 'string' },
    treasury: { type: 'string' },
    'fee-bps': { type: 'string', default: '250' },
    'min-window': { type: 'string', default: '120' },
    'accept-timeout': { type: 'string', default: '120' },
    'dispute-timeout': { type: 'string', default: '900' },
    'first-escrow-id': { type: 'string', default: '1' },
    'dry-run': { type: 'boolean', default: false },
  },
})

function required(name: 'keypair' | 'mint' | 'arbiter' | 'treasury'): string {
  const value = args[name]
  if (!value) {
    console.error(`missing --${name}`)
    process.exit(2)
  }
  return value
}

async function main() {
  const programId = address(args['program-id'] ?? /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/.exec(readFileSync(LIB_RS, 'utf8'))![1])
  const mint = address(required('mint'))
  const arbiter = address(required('arbiter'))
  const treasury = address(required('treasury'))
  const admin = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(required('keypair'), 'utf8'))))
  const instruction = await buildInitializeInstruction({
    programId,
    admin,
    arbiter,
    treasury,
    mint,
    feeBps: Number(args['fee-bps']),
    minWindow: BigInt(args['min-window']!),
    acceptTimeout: BigInt(args['accept-timeout']!),
    disputeTimeout: BigInt(args['dispute-timeout']!),
    firstEscrowId: BigInt(args['first-escrow-id']!),
  })
  const [config] = await getProgramDerivedAddress({ programAddress: programId, seeds: [new TextEncoder().encode('config')] })

  console.log(`program   ${programId}`)
  console.log(`config    ${config}`)
  console.log(`admin     ${admin.address}  (pays, and may later change the fee, treasury and arbiter)`)
  console.log(`arbiter   ${arbiter}`)
  console.log(`treasury  ${treasury}  (needs a token account for the mint)`)
  console.log(`mint      ${mint}`)
  console.log(`fee       ${args['fee-bps']} bps; windows min ${args['min-window']} s, accept ${args['accept-timeout']} s, dispute ${args['dispute-timeout']} s; first escrow id ${args['first-escrow-id']}`)
  if (args['dry-run']) {
    console.log(`dry run: instruction data ${Buffer.from(instruction.data!).toString('hex')}`)
    return
  }

  const rpc = createSolanaRpc(args.rpc!)
  const genesis = await rpc.getGenesisHash().send()
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(args.rpc!).hostname)
  if (!genesis.startsWith(DEVNET_GENESIS_PREFIX) && genesis !== TESTNET_GENESIS && !local) {
    console.error(`refusing: ${args.rpc} is not Solana devnet, testnet or a local validator (genesis ${genesis})`)
    process.exit(1)
  }
  const mintAccount = await rpc.getAccountInfo(mint, { encoding: 'base64' }).send()
  if (!mintAccount.value || mintAccount.value.owner !== SPL_TOKEN_PROGRAM_ID) {
    console.error('refusing: the mint does not exist on this cluster or is not an SPL Token mint')
    process.exit(1)
  }
  if ((await rpc.getAccountInfo(config as Address, { encoding: 'base64' }).send()).value) {
    console.error('refusing: this program is already initialized')
    process.exit(1)
  }

  const { value: blockhash } = await rpc.getLatestBlockhash().send()
  const transaction = await pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(admin, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
    (tx) => appendTransactionMessageInstruction(instruction, tx),
    (tx) => signTransactionMessageWithSigners(tx)
  )
  const signature = await rpc.sendTransaction(getBase64EncodedWireTransaction(transaction), { encoding: 'base64' }).send()
  for (let i = 0; i < 60; i++) {
    const [status] = (await rpc.getSignatureStatuses([signature]).send()).value
    if (status?.err) throw new Error(`initialize failed: ${JSON.stringify(status.err, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      console.log(`initialized: ${signature}`)
      return
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`not confirmed after 60 s: ${signature}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
