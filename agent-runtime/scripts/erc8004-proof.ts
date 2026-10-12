/**
 * A proof of the ERC-8004 integration on a live testnet (the official registries): the proof-run
 * seller registers an agent identity, and the proof-run buyer publishes feedback for a settled deal
 * of scripts/proof-run.ts, exactly as the SDK does after a rating.
 *
 *   cd agent-runtime && npx tsx scripts/erc8004-proof.ts [base-sepolia | ethereum-sepolia | arbitrum-sepolia] [escrowId] [agentId registerTx]
 *
 * Keys come from .proof/wallets.json (git-ignored) and are never printed. The registration file
 * is a data: URI (fully on-chain, as EIP-8004 allows), so nothing has to be hosted.
 */
import { readFileSync, writeFileSync } from 'node:fs'

/** The deployments of scripts/proof-run.ts, and the settled deal each one's feedback is about. */
const DEPLOYMENTS = {
  'base-sepolia': { chain: 'eip155:84532', eco: '0xF8448762AeCE0039f1072Da74477fbFAD629fDB8', block: '48021794', rpc: 'https://sepolia.base.org', escrow: '6', label: 'Base Sepolia' },
  'ethereum-sepolia': { chain: 'eip155:11155111', eco: '0x3048b1a3CeeE4f1AF09485e49f059d094EF6f865', block: '11901363', rpc: '', escrow: '1', label: 'Ethereum Sepolia' },
  'arbitrum-sepolia': { chain: 'eip155:421614', eco: '0xaf77570B25D2EAD24a53Eead61deEB0bc21a83ea', block: '318529770', rpc: 'https://sepolia-rollup.arbitrum.io/rpc', escrow: '1', label: 'Arbitrum Sepolia' },
} as const
const arg = process.argv[2]
const name = (arg && arg in DEPLOYMENTS ? arg : 'base-sepolia') as keyof typeof DEPLOYMENTS
const rest = arg && arg in DEPLOYMENTS ? process.argv.slice(3) : process.argv.slice(2) // the old form: [escrowId] [agentId registerTx]
const dep = DEPLOYMENTS[name]
const suffix = dep.chain.replace(/[^A-Za-z0-9]/g, '_')
process.env.CHAINS = dep.chain
process.env[`AGENT_ECO_ADDRESS__${suffix}`] = dep.eco
process.env[`DEPLOYMENT_BLOCK__${suffix}`] = dep.block
if (dep.rpc) process.env[`RPC_URL__${suffix}`] = dep.rpc
process.env.EVM_STALE_RETRIES = '10'

const { signerChain } = await import('../src/chain/registry.ts')
const { buildRegistrationFile, dealFeedback } = await import('../src/shared/erc8004.ts')
const wallets = JSON.parse(readFileSync(new URL('../../.proof/wallets.json', import.meta.url), 'utf8'))
const escrowId = rest[0] ?? dep.escrow
const CHAIN = dep.chain

const seller = signerChain(CHAIN, wallets.evm.seller.privateKey)
const buyer = signerChain(CHAIN, wallets.evm.buyer.privateKey)
const cfg = seller.config.erc8004
if (!cfg) throw new Error(`no ERC-8004 registries configured for ${dep.label}`)
console.log('identity registry  ', cfg.identity)
console.log('reputation registry', cfg.reputation)

const file = buildRegistrationFile({
  name: 'AgentEco proof seller',
  description: `A seller wallet used in the AgentEco proof run on ${dep.label} (translation jobs through the AgentEco escrow).`,
  capabilities: ['translation'],
  agentUrl: 'https://github.com/SannyDermawan/agenteco-multichain',
  active: true,
})
const agentURI = `data:application/json;base64,${Buffer.from(JSON.stringify(file)).toString('base64')}`

// Optional: reuse an identity from an interrupted run (argv[3] = agentId, argv[4] = its register tx hash).
const registered = rest[1]
  ? { agentId: BigInt(rest[1]), txHash: rest[2] as `0x${string}` }
  : await seller.erc8004Register(agentURI)
console.log(`registered agent #${registered.agentId}, tx ${seller.explorer.txUrl(registered.txHash)}`)
/** A public RPC can answer from a node that lags the transaction: retry the read for a while. */
async function patient<T>(read: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await read()
    } catch (err) {
      if (i >= 30) throw err
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
}
const owner = await patient(() => seller.erc8004Owner(registered.agentId))
console.log('identity NFT owner:', owner, owner.toLowerCase() === seller.signer!.toLowerCase() ? '(the seller)' : '(MISMATCH)')

const feedback = dealFeedback({ score: 90, capability: 'translation', chainId: CHAIN, escrowId })
const feedbackTx = await buyer.erc8004GiveFeedback(registered.agentId, feedback)
console.log(`feedback from the buyer, tx ${buyer.explorer.txUrl(feedbackTx)}`)

let read = null
for (let i = 0; i < 20 && !read; i++) {
  read = await buyer.erc8004LastFeedback(registered.agentId, buyer.signer!)
  if (!read) await new Promise((r) => setTimeout(r, 1000))
}
console.log('read back from the registry:', JSON.stringify(read, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))

// The registry must refuse the agent's own owner as the reviewer.
let selfRefused = false
try {
  await seller.erc8004GiveFeedback(registered.agentId, feedback)
} catch {
  selfRefused = true
}
console.log('the owner reviewing its own agent is refused:', selfRefused)

writeFileSync(
  new URL(`../../.proof/erc8004-${name}.json`, import.meta.url),
  JSON.stringify(
    {
      chain: CHAIN,
      identityRegistry: cfg.identity,
      reputationRegistry: cfg.reputation,
      agentId: registered.agentId.toString(),
      registerTx: seller.explorer.txUrl(registered.txHash),
      feedbackTx: buyer.explorer.txUrl(feedbackTx),
      feedback: read && { value: read.value.toString(), tag1: read.tag1, tag2: read.tag2 },
      selfFeedbackRefused: selfRefused,
    },
    null,
    2
  )
)
