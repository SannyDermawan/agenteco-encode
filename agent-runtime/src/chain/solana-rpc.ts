/**
 * SolanaBackend over a JSON-RPC endpoint (devnet, testnet or a local validator). Reads and
 * confirmation use one commitment (default `confirmed`), so a read right after a write sees it.
 * Tested against a local solana-test-validator (docs/SOLANA.md §10) and exercised on devnet (§5). A public
 * endpoint answers HTTP 429 when a method is called too often, so every request backs off and retries on it.
 */
import {
  address,
  appendTransactionMessageInstructions,
  createDefaultRpcTransport,
  createSolanaRpc,
  createSolanaRpcFromTransport,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isSolanaError,
  pipe,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Commitment,
  type Instruction,
  type RpcTransport,
  type Signature,
  type TransactionSigner,
} from '@solana/kit'
import { SOLANA_DEVNET_CHAIN_ID, type SolanaBackend } from './solana.ts'
import { base64ToBytes, readI64, readU64 } from './bytes.ts'

const CLOCK_SYSVAR = address('SysvarC1ock11111111111111111111111111111111')

const RATE_LIMIT_RETRIES = 8
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function isRateLimited(error: unknown): boolean {
  return isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) && error.context.statusCode === 429
}

/** Retries a request the node refused with HTTP 429 (a public RPC's per-method limit): 0.4 s, 0.8 s, ... up to 8 s apart. */
export function retryingOnRateLimit(inner: RpcTransport, baseDelayMs = 400): RpcTransport {
  const retrying = async (config: Parameters<RpcTransport>[0]) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await inner(config)
      } catch (error) {
        if (!isRateLimited(error) || attempt >= RATE_LIMIT_RETRIES) throw error
        await sleep(Math.min(8_000, baseDelayMs * 2 ** attempt) + Math.floor(Math.random() * 100))
      }
    }
  }
  return retrying as RpcTransport
}

export class SolanaRpcBackend implements SolanaBackend {
  private readonly rpc
  /** How often a sent transaction's status is read: quickly on a local validator, gently on a public node. */
  private readonly pollMs: number

  constructor(
    rpcUrl: string,
    private readonly commitment: 'confirmed' | 'finalized' = 'confirmed',
    private readonly confirmTimeoutMs = 60_000
  ) {
    this.rpc = createSolanaRpcFromTransport(retryingOnRateLimit(createDefaultRpcTransport({ url: rpcUrl })))
    this.pollMs = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(rpcUrl).hostname) ? 200 : 500
  }

  async getAccount(addr: Address) {
    const { value } = await this.rpc.getAccountInfo(addr, { encoding: 'base64', commitment: this.commitment }).send()
    if (!value) return null
    return { data: base64ToBytes(value.data[0]), lamports: BigInt(value.lamports), owner: value.owner }
  }

  async getClock() {
    const account = await this.getAccount(CLOCK_SYSVAR)
    if (!account) throw new Error('the Clock sysvar is not readable')
    const data = account.data
    // Clock: slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64, unix_timestamp i64.
    return { slot: readU64(data, 0), unixTimestamp: readI64(data, 32) }
  }

  async send(instructions: Instruction[], feePayer: TransactionSigner) {
    const { value: blockhash } = await this.rpc.getLatestBlockhash({ commitment: this.commitment }).send()
    const transaction = await pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(feePayer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
      (tx) => appendTransactionMessageInstructions(instructions, tx),
      (tx) => signTransactionMessageWithSigners(tx)
    )
    const signature = getSignatureFromTransaction(transaction)
    try {
      // Simulated against the same commitment the reads use, so a rejection is the program's own.
      await this.rpc
        .sendTransaction(getBase64EncodedWireTransaction(transaction), { encoding: 'base64', preflightCommitment: this.commitment })
        .send()
    } catch (error) {
      throw new Error(`transaction rejected: ${describe(error)}`, { cause: error })
    }
    const deadline = Date.now() + this.confirmTimeoutMs
    while (Date.now() < deadline) {
      const [status] = (await this.rpc.getSignatureStatuses([signature]).send()).value
      if (status?.err) throw new Error(`transaction failed: ${JSON.stringify(status.err, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
      if (status && reached(status.confirmationStatus, this.commitment)) return signature
      await sleep(this.pollMs)
    }
    throw new Error(`transaction ${signature} was not ${this.commitment} after ${this.confirmTimeoutMs / 1000} s`)
  }

  /** The cluster's genesis hash (a served chain's id is its first 32 characters). */
  async getGenesisHash(): Promise<string> {
    return this.rpc.getGenesisHash().send()
  }

  async getTransactionLogs(signature: string) {
    const tx = await this.rpc.getTransaction(signature as Signature, { encoding: 'json', commitment: this.commitment, maxSupportedTransactionVersion: 0 }).send()
    if (!tx?.meta || tx.meta.err) return null
    return [...(tx.meta.logMessages ?? [])]
  }

  async listProgramTransactions(programId: Address, range: { fromSlot: bigint; toSlot: bigint }) {
    const found: { signature: string; slot: bigint }[] = []
    let before: Signature | undefined
    for (;;) {
      const page = await this.rpc.getSignaturesForAddress(programId, { limit: 1000, commitment: this.commitment, ...(before && { before }) }).send()
      if (page.length === 0) break
      for (const entry of page) {
        if (entry.err === null && entry.slot >= range.fromSlot && entry.slot <= range.toSlot) found.push({ signature: entry.signature, slot: BigInt(entry.slot) })
      }
      const oldest = page[page.length - 1]
      if (BigInt(oldest.slot) < range.fromSlot || page.length < 1000) break
      before = oldest.signature
    }
    return found.reverse()
  }
}

const ORDER: Commitment[] = ['processed', 'confirmed', 'finalized']
function reached(status: Commitment | null | undefined, wanted: Commitment): boolean {
  return status !== null && status !== undefined && ORDER.indexOf(status) >= ORDER.indexOf(wanted)
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const logs = (error as { context?: { logs?: string[] } }).context?.logs
    return logs?.length ? `${error.message}\n${logs.join('\n')}` : error.message
  }
  return String(error)
}

const DEVNET_GENESIS_PREFIX = SOLANA_DEVNET_CHAIN_ID.slice('solana:'.length)
const TESTNET_GENESIS = '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY'

/**
 * Whether a cluster may be used by the setup scripts: Solana devnet, testnet (by genesis hash), or any
 * cluster served from this machine (a local validator). Mainnet-beta and every unknown cluster are refused.
 */
export function clusterAllowed(genesisHash: string, rpcHostname: string): boolean {
  const local = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(rpcHostname)
  return genesisHash.startsWith(DEVNET_GENESIS_PREFIX) || genesisHash === TESTNET_GENESIS || local
}

/** Throws unless `rpcUrl` answers for an allowed cluster (see clusterAllowed). Reads one value; sends nothing. */
export async function assertTestCluster(rpcUrl: string): Promise<void> {
  const genesis = await createSolanaRpc(rpcUrl).getGenesisHash().send()
  if (!clusterAllowed(genesis, new URL(rpcUrl).hostname)) {
    throw new Error(`refusing: ${rpcUrl} is not Solana devnet, testnet or a local validator (genesis ${genesis})`)
  }
}
