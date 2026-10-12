/**
 * A proof run on a live testnet: real escrow deals through the chain-neutral ChainAdapter, on
 * Base Sepolia, Ethereum Sepolia, Arbitrum Sepolia, Tempo Moderato, BOT Chain Testnet or Solana devnet. Three deals, nothing mocked:
 *
 *   1. settle        create+fund, start, deliver, accept: fee to the treasury, rest to the seller, a rating
 *   2. dispute, buyer wins    deliver, dispute, the seller answers, the arbiter rules for the buyer: refund, no fee
 *   3. dispute, seller wins   same, the arbiter rules for the seller: paid, fee charged
 *
 * It asserts the exact balances after every step and writes the transaction links to
 * .proof/results-<chain>.json. Test wallets come from .proof/wallets.json (created by hand, git-ignored);
 * the arbiter of Base Sepolia is a member of its council (ARBITER_PRIVATE_KEY in backend/.env).
 *
 *   cd agent-runtime && npx tsx scripts/proof-run.ts base-sepolia | ethereum-sepolia | arbitrum-sepolia | tempo-moderato | bot-testnet
 *   cd agent-runtime && npx tsx scripts/proof-run.ts solana-devnet
 *
 * Keys are read from local files and never printed. Testnet and devnet only.
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { keccak256, toHex, type Hex } from 'viem'

/** The EVM deployments of this repository (AgentEco v3 + ArbiterCouncil, first escrow id 1, deployer = treasury). */
const EVM = {
  'base-sepolia': { chain: 'eip155:84532', eco: '0xF8448762AeCE0039f1072Da74477fbFAD629fDB8', block: '48021794', rpc: 'https://sepolia.base.org' },
  'ethereum-sepolia': { chain: 'eip155:11155111', eco: '0x3048b1a3CeeE4f1AF09485e49f059d094EF6f865', block: '11901363', rpc: undefined },
  'arbitrum-sepolia': { chain: 'eip155:421614', eco: '0xaf77570B25D2EAD24a53Eead61deEB0bc21a83ea', block: '318529770', rpc: 'https://sepolia-rollup.arbitrum.io/rpc' },
  'bot-testnet': { chain: 'eip155:968', eco: '0xaf77570B25D2EAD24a53Eead61deEB0bc21a83ea', block: '26642374', rpc: undefined },
  'tempo-moderato': { chain: 'eip155:42431', eco: '0x2620424C73A39624bDcd3fa43aABF425d6Da997e', block: '39319911', rpc: undefined },
} as const
type EvmName = keyof typeof EVM

const which = process.argv[2]
if (which !== 'solana-devnet' && !(which && which in EVM)) {
  console.error(`usage: proof-run.ts ${Object.keys(EVM).join(' | ')} | solana-devnet`)
  process.exit(2)
}
const evm = which === 'solana-devnet' ? null : EVM[which as EvmName]
// A deployment's address and block can also come from the environment (PROOF_ECO, PROOF_BLOCK), for a fresh one.
const evmEco = (process.env.PROOF_ECO || evm?.eco) as string
const evmBlock = (process.env.PROOF_BLOCK || evm?.block) as string
const SOLANA = { chain: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', program: '3GEEC3dQH1tP2YTZD9Jv915Yj8hcSN6WE8nQZiLJcgHE' }
const ROOT = new URL('../../', import.meta.url)
const wallets = JSON.parse(readFileSync(new URL('.proof/wallets.json', ROOT), 'utf8'))

if (evm) {
  const suffix = evm.chain.replace(/[^A-Za-z0-9]/g, '_')
  process.env.CHAINS = evm.chain
  process.env[`AGENT_ECO_ADDRESS__${suffix}`] = evmEco
  process.env[`DEPLOYMENT_BLOCK__${suffix}`] = evmBlock
  // One backend per request where the public node is load-balanced: it can answer a simulation from a node that lags a block.
  if (evm.rpc) process.env[`RPC_URL__${suffix}`] = evm.rpc
  process.env.EVM_STALE_RETRIES = '10'
} else {
  process.env.CHAINS = SOLANA.chain
  process.env.AGENT_ECO_PROGRAM__solana_EtWTRABZaYq6iMfeYKouRu166VU2xqa1 = SOLANA.program
}

const hash = (text: string) => keccak256(toHex(text)) as `0x${string}`
const unit = BigInt(1_000_000) // both USDC mints have 6 decimals

type Adapter = import('../src/chain/types.ts').ChainAdapter

async function adapters(): Promise<{ buyer: Adapter; seller: Adapter; arbiter: Adapter; treasury: string; chainId: string }> {
  if (evm) {
    const { signerChain } = await import('../src/chain/registry.ts')
    const backendEnv = readFileSync(new URL('backend/.env', ROOT), 'utf8')
    const arbiterKey = /^ARBITER_PRIVATE_KEY=(\S+)/m.exec(backendEnv)![1].replace(/^['"]|['"]$/g, '')
    const hex = (k: string) => (k.startsWith('0x') ? k : `0x${k}`) as Hex
    return {
      chainId: evm.chain,
      buyer: signerChain(evm.chain, wallets.evm.buyer.privateKey),
      seller: signerChain(evm.chain, wallets.evm.seller.privateKey),
      arbiter: signerChain(evm.chain, hex(arbiterKey)),
      treasury: '0xFC2F38db21394C2dF0f1A690a154ad303311B644',
    }
  }
  const { signerSolana } = await import('../src/chain/solana-registry.ts')
  const { secretKeyFromBase58 } = await import('../src/chain/solana.ts')
  const { createKeyPairSignerFromBytes } = await import('@solana/kit')
  const signer = async (b58: string) => createKeyPairSignerFromBytes(secretKeyFromBase58(b58))
  return {
    chainId: SOLANA.chain,
    buyer: signerSolana(SOLANA.chain, await signer(wallets.solana.buyer.secretKeyBase58)),
    seller: signerSolana(SOLANA.chain, await signer(wallets.solana.seller.secretKeyBase58)),
    arbiter: signerSolana(SOLANA.chain, await signer(wallets.solana.arbiter.secretKeyBase58)),
    treasury: '75AkXNq6sC5umjEPiq8hTbY1WESEfB3Xr5eWd7KaJd3z',
  }
}

/** Reads lag writes on a public RPC (another node answers): poll until the chain shows the expected value. */
async function eventually<T>(read: () => Promise<T>, want: T, what: string): Promise<void> {
  let last: T | undefined
  for (let i = 0; i < 45; i++) {
    last = await read()
    if (last === want) return
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`${what}: expected ${String(want)}, the chain still shows ${String(last)}`)
}

const FUNDED = 1
const DELIVERED = 3
const DISPUTED = 4
const SETTLED = 5
const REFUNDED = 6

async function main() {
  const { buyer, seller, arbiter, treasury, chainId } = await adapters()
  const buyerAddr = buyer.signer!
  const sellerAddr = seller.signer!
  const bal = (a: string) => buyer.tokenBalance(a)
  const link = (tx: string) => buyer.explorer.txUrl(tx)

  console.log(`${which}: buyer ${buyerAddr}, seller ${sellerAddr}, treasury ${treasury}`)
  const start = { buyer: await bal(buyerAddr), seller: await bal(sellerAddr), treasury: await bal(treasury) }
  const need = BigInt(2) * unit
  if (start.buyer < need) {
    console.error(`the buyer holds ${Number(start.buyer) / 1e6} USDC; this run needs at least ${Number(need) / 1e6}. Fund ${buyerAddr} from the faucet and run again.`)
    process.exit(3)
  }
  console.log(`start: buyer ${Number(start.buyer) / 1e6}, seller ${Number(start.seller) / 1e6}, treasury ${Number(start.treasury) / 1e6} USDC`)

  const expected = { ...start }
  const check = async (when: string) => {
    await eventually(() => bal(buyerAddr), expected.buyer, `buyer balance ${when}`)
    await eventually(() => bal(sellerAddr), expected.seller, `seller balance ${when}`)
    await eventually(() => bal(treasury), expected.treasury, `treasury balance ${when}`)
  }
  const status = (id: bigint, want: number, what: string) => eventually(() => buyer.getEscrowStatus(id), want, `escrow #${id} ${what}`)
  const results: Record<string, unknown> = { chain: chainId, program: evm ? evmEco : SOLANA.program, ranAt: new Date().toISOString(), deals: [] as unknown[] }
  const deals = results.deals as Record<string, unknown>[]

  const open = async (label: string, amount: string) => {
    const price = BigInt(Math.round(Number(amount) * 1e6))
    const id = await buyer.createAndFundEscrow({ seller: sellerAddr, amount, taskHash: hash(`${label} / ${results.ranAt}`) })
    expected.buyer -= price
    await status(id, FUNDED, 'funded')
    await check(`after funding ${label}`)
    console.log(`  #${id} funded (${amount} USDC)`)
    return { id, price }
  }
  const deliver = async (id: bigint, label: string) => {
    await seller.startExecution(id)
    await seller.markDelivered(id, hash(`result of ${label}`))
    await status(id, DELIVERED, 'delivered')
  }
  const feeOf = (price: bigint) => (price * BigInt(250)) / BigInt(10_000)

  // 1. Settlement + rating
  console.log('deal 1: settle')
  {
    const { id, price } = await open('deal 1', '0.4')
    await deliver(id, 'deal 1')
    await buyer.acceptAndSettle(id)
    await status(id, SETTLED, 'settled')
    expected.seller += price - feeOf(price)
    expected.treasury += feeOf(price)
    await check('after settlement')
    const ratingTx = await buyer.rateSeller(id, 90)
    const rep = await buyer.getReputation(sellerAddr)
    console.log(`  #${id} settled, fee ${Number(feeOf(price)) / 1e6} USDC, rated 90; reputation ${JSON.stringify(rep)}`)
    deals.push({ deal: 'settle', escrowId: id.toString(), amount: '0.4 USDC', fee: `${Number(feeOf(price)) / 1e6} USDC`, ratingTx: link(ratingTx), reputation: rep })
  }

  // 2. Dispute, the arbiter rules for the buyer: refund, no fee
  console.log('deal 2: dispute, buyer wins')
  {
    const { id } = await open('deal 2', '0.4')
    await deliver(id, 'deal 2')
    const disputeTx = await buyer.raiseDispute(id, hash('the result does not follow the brief'))
    await status(id, DISPUTED, 'disputed')
    const responseTx = await seller.submitDisputeResponse(id, hash('the result follows the brief exactly'))
    const ruling = await arbiter.ruleDispute(id, false, hash('ruling: refund the buyer'))
    await status(id, REFUNDED, 'refunded')
    expected.buyer += BigInt(400_000)
    await check('after the refund')
    console.log(`  #${id} refunded to the buyer, no fee (${ruling.kind})`)
    deals.push({ deal: 'dispute, buyer wins', escrowId: id.toString(), amount: '0.4 USDC', fee: '0 (refunds are free)', disputeTx: link(disputeTx), responseTx: link(responseTx), ruling })
  }

  // 3. Dispute, the arbiter rules for the seller: paid, fee charged
  console.log('deal 3: dispute, seller wins')
  {
    const { id, price } = await open('deal 3', '0.3')
    await deliver(id, 'deal 3')
    const disputeTx = await buyer.raiseDispute(id, hash('the buyer doubts the result'))
    const responseTx = await seller.submitDisputeResponse(id, hash('the result is correct and complete'))
    const ruling = await arbiter.ruleDispute(id, true, hash('ruling: pay the seller'))
    await status(id, SETTLED, 'settled')
    expected.seller += price - feeOf(price)
    expected.treasury += feeOf(price)
    await check('after the ruling for the seller')
    console.log(`  #${id} paid to the seller, fee ${Number(feeOf(price)) / 1e6} USDC (${ruling.kind})`)
    deals.push({ deal: 'dispute, seller wins', escrowId: id.toString(), amount: '0.3 USDC', fee: `${Number(feeOf(price)) / 1e6} USDC`, disputeTx: link(disputeTx), responseTx: link(responseTx), ruling })
  }

  results.finalBalancesUSDC = { buyer: Number(await bal(buyerAddr)) / 1e6, seller: Number(await bal(sellerAddr)) / 1e6, treasury: Number(await bal(treasury)) / 1e6 }
  results.escrowIdsOnChain = (await buyer.escrowIds()).map(String)
  writeFileSync(new URL(`.proof/results-${which}.json`, ROOT), JSON.stringify(results, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
  console.log('all balances matched the contract rules exactly. Results: .proof/results-' + which + '.json')
  console.log(JSON.stringify(results.finalBalancesUSDC))
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
