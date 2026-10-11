import {
  decodeEventLog,
  getAbiItem,
  isAddress,
  parseEventLogs,
  parseUnits,
  recoverMessageAddress,
  type Log,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem'
import { AGENT_ECO_ABI, ARBITER_COUNCIL_ABI } from '../shared/abi.generated.ts'
import { sameWallet } from '../shared/wallets.ts'
import { IDENTITY_REGISTRY_ABI, REPUTATION_REGISTRY_ABI, type Erc8004Registries } from '../shared/erc8004.ts'
import { ERC20_ABI } from '../onchain/abi.ts'
import type {
  ChainAdapter,
  ChainId,
  EscrowDisputeInfo,
  EscrowHashes,
  Hash32,
  EscrowId,
  EscrowTimestamps,
  EscrowWindows,
  OnchainReputation,
  RatingEvent,
  RulingOutcome,
  TimerLimits,
  TimeoutAction,
  TimeoutClaim,
  TimeoutClaimHooks,
  TimeoutFlag,
  TokenInfo,
} from './types.ts'

/**
 * AgentEco on an EVM chain: the AgentEco.sol escrow contract (current deployment plus any
 * legacy ones), its ArbiterCouncil, and the settlement ERC-20. Everything here used to live
 * in onchain/escrow.ts, onchain/arbiter.ts, onchain/escrowIndex.ts, keeper/escrowKeeper.ts
 * and host/reputation.ts, unchanged in behaviour: same calls, same order, same errors.
 *
 * The adapter holds no module state: the deployment comes in as `EvmChainConfig` (see
 * ./default.ts for the one built from the NETWORK env), the wallet as `EvmClients`.
 */

/** An earlier AgentEco deployment whose escrows (ids in [firstEscrowId, endEscrowId)) are still read. */
export interface EvmLegacyDeployment {
  address: Address
  firstEscrowId: bigint
  endEscrowId: bigint
}

export interface EvmChainConfig {
  chainId: ChainId
  /** The viem chain (id, RPC list, explorer, Multicall3). */
  chain: Chain
  /** The current AgentEco deployment. */
  agentEco: Address
  /** Settlement token (ERC-20). */
  usdt: Address
  tokenSymbol: string
  nativeSymbol: string
  explorerUrl: string
  explorerName: string
  /** Windows a new escrow is created with, in seconds. */
  executionWindow: bigint
  reviewWindow: bigint
  /** First escrow id of `agentEco`; lower ids belong to a legacy deployment. */
  firstEscrowId: bigint
  /** Earlier deployments, oldest first. */
  legacy: EvmLegacyDeployment[]
  /** Block the current deployment was created at; log scans start there (null = unknown). */
  deploymentBlock: bigint | null
  /** Largest block span per eth_getLogs call the RPC accepts. */
  logRange: bigint
  /** Least native gas (decimal, in ether units) a hosted agent's wallet needs before the host runs it. */
  hostedMinGas: string
  /** System wallets (keeper, arbiter) below this native balance log a warning. */
  lowGasWarn: string
  /** ERC-8004 registries on this chain; null = no ERC-8004 features here. */
  erc8004: Erc8004Registries | null
}

/** One ERC-8004 feedback entry as the Reputation Registry stores it. */
export interface Erc8004Feedback {
  index: bigint
  value: bigint
  valueDecimals: number
  tag1: string
  tag2: string
  isRevoked: boolean
}

/** What the adapter talks through. Without a wallet it is read-only. */
export interface EvmClients {
  publicClient: PublicClient
  walletClient?: WalletClient
  account?: Account
}

export interface EscrowBasic {
  id: bigint
  buyer: Address
  seller: Address
  amount: bigint
  status: number
}

export interface ArbiterSetup {
  /** AgentEco.arbiter() */
  arbiter: Address
  /** Present when the arbiter is an ArbiterCouncil. */
  council: { address: Address; members: Address[]; rulingThreshold: number; adminThreshold: number } | null
}

const FLAG_READER = {
  acceptTimedOut: 'isAcceptTimedOut',
  executionTimedOut: 'isExecutionTimedOut',
  reviewExpired: 'isReviewExpired',
  disputeTimedOut: 'isDisputeTimedOut',
} as const satisfies Record<TimeoutFlag, string>

const MULTICALL_BATCH = 200
const SELLER_RATED = getAbiItem({ abi: AGENT_ECO_ABI, name: 'SellerRated' })

interface SellerRatedArgs {
  escrowId: bigint
  seller: Address
  buyer: Address
  score: number
}

export class EvmAdapter implements ChainAdapter {
  readonly family = 'evm' as const
  readonly chainId: ChainId
  readonly nativeSymbol: string
  readonly nativeDecimals: number
  readonly explorer: ChainAdapter['explorer']

  private readonly publicClient: PublicClient
  private readonly walletClient: WalletClient | undefined
  private readonly account: Account | undefined
  private tokenInfo: Promise<TokenInfo> | undefined

  constructor(
    readonly config: EvmChainConfig,
    clients: EvmClients
  ) {
    this.chainId = config.chainId
    this.nativeSymbol = config.nativeSymbol
    this.nativeDecimals = config.chain.nativeCurrency.decimals
    this.explorer = {
      name: config.explorerName,
      txUrl: (hash) => `${config.explorerUrl}/tx/${hash}`,
      addressUrl: (address) => `${config.explorerUrl}/address/${address}`,
    }
    this.publicClient = clients.publicClient
    this.walletClient = clients.walletClient
    this.account = clients.account ?? clients.walletClient?.account
  }

  get signer(): string | null {
    return this.account?.address ?? null
  }

  /** The read client, for the few reads that are specific to an EVM chain (receipts, balances, logs). */
  get client(): PublicClient {
    return this.publicClient
  }

  private wallet(): WalletClient {
    if (!this.walletClient) throw new Error('This chain adapter is read-only: it has no wallet to sign with.')
    return this.walletClient
  }

  private signing(): { wallet: WalletClient; account: Account } {
    const wallet = this.wallet()
    const account = this.account
    if (!account) throw new Error('This chain adapter is read-only: it has no wallet to sign with.')
    return { wallet, account }
  }

  normalizeAddress(address: string): string {
    return address.toLowerCase()
  }

  isValidAddress(address: string): boolean {
    return isAddress(address)
  }

  async verifySignature(params: { address: string; message: string; signature: string }): Promise<boolean> {
    try {
      const recovered = await recoverMessageAddress({ message: params.message, signature: params.signature as Hex })
      return recovered.toLowerCase() === params.address.toLowerCase()
    } catch {
      return false
    }
  }

  // --- Deployments ---------------------------------------------------------

  /** The AgentEco contract that holds this escrow: the current one, or the legacy one its id falls in. */
  agentEcoFor(escrowId: bigint): Address {
    const { agentEco, firstEscrowId, legacy } = this.config
    if (escrowId >= firstEscrowId) return agentEco
    return legacy.find((d) => escrowId >= d.firstEscrowId && escrowId < d.endEscrowId)?.address ?? agentEco
  }

  /** Every AgentEco deployment on this chain, the current one first. */
  get allAgentEcoAddresses(): Address[] {
    return [this.config.agentEco, ...this.config.legacy.map((d) => d.address).reverse()]
  }

  /** Whether `address` is one of this chain's AgentEco deployments. */
  isAgentEcoAddress(address: string): boolean {
    const a = address.toLowerCase()
    return this.allAgentEcoAddresses.some((x) => x.toLowerCase() === a)
  }

  // --- Chain ---------------------------------------------------------------

  head(): Promise<bigint> {
    return this.publicClient.getBlockNumber()
  }

  /** The chain id the RPC reports (to refuse an RPC that points at another chain). */
  rpcChainId(): Promise<number> {
    return this.publicClient.getChainId()
  }

  nativeBalance(address: string): Promise<bigint> {
    return this.publicClient.getBalance({ address: address as Address })
  }

  /**
   * Send the signer's whole native balance to `to`, minus the fee for that transfer.
   * Returns null when the balance does not even cover the fee.
   */
  async sweepNative(to: string): Promise<Hex | null> {
    const { wallet, account } = this.signing()
    const [balance, gasPrice] = await Promise.all([
      this.publicClient.getBalance({ address: account.address }),
      this.publicClient.getGasPrice(),
    ])
    // Plain transfer = 21000 gas; doubled so a gas-price tick between quote and send can't make it fail.
    const fee = gasPrice * BigInt(21000) * BigInt(2)
    if (balance <= fee) return null
    const hash = await wallet.sendTransaction({ to: to as Address, value: balance - fee, chain: wallet.chain, account })
    await this.publicClient.waitForTransactionReceipt({ hash })
    return hash
  }

  // --- Token ---------------------------------------------------------------

  tokenBalance(address: string): Promise<bigint> {
    return this.publicClient.readContract({ address: this.config.usdt, abi: ERC20_ABI, functionName: 'balanceOf', args: [address as Address] })
  }

  /** Send `amount` (base units) of the settlement token from the signer to `to`, and wait for it. */
  async transferToken(to: string, amount: bigint): Promise<Hex> {
    const { wallet, account } = this.signing()
    const hash = await wallet.writeContract({
      address: this.config.usdt,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [to as Address, amount],
      chain: wallet.chain,
      account,
    })
    await this.publicClient.waitForTransactionReceipt({ hash })
    return hash
  }

  token(): Promise<TokenInfo> {
    this.tokenInfo ??= this.publicClient
      .readContract({ address: this.config.usdt, abi: ERC20_ABI, functionName: 'decimals' })
      .then((decimals) => ({ address: this.config.usdt, symbol: this.config.tokenSymbol, decimals }))
    return this.tokenInfo
  }

  // --- Writes --------------------------------------------------------------

  private parseCreatedEscrowId(receipt: TransactionReceipt): bigint | null {
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.config.agentEco.toLowerCase()) continue
      try {
        const decoded = decodeEventLog({ abi: AGENT_ECO_ABI, data: log.data, topics: log.topics })
        if (decoded.eventName === 'EscrowCreated') {
          return (decoded.args as { escrowId: bigint }).escrowId
        }
      } catch {
        continue
      }
    }
    return null
  }

  async createAndFundEscrow({ seller, amount: price, taskHash }: { seller: string; amount: number | string; taskHash: Hex }): Promise<bigint> {
    const { wallet, account } = this.signing()
    const { publicClient } = this
    const { agentEco, usdt } = this.config
    const decimals = await publicClient.readContract({ address: usdt, abi: ERC20_ABI, functionName: 'decimals' })
    const amount = parseUnits(price.toString(), decimals)

    const createHash = await wallet.writeContract({
      address: agentEco,
      abi: AGENT_ECO_ABI,
      functionName: 'createEscrow',
      args: [seller as Address, amount, this.config.executionWindow, this.config.reviewWindow, taskHash],
      chain: wallet.chain,
      account,
    })
    const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash })
    const escrowId = this.parseCreatedEscrowId(createReceipt)
    if (escrowId === null) throw new Error('Could not read the new escrow id from the createEscrow receipt.')

    const allowance = await publicClient.readContract({
      address: usdt,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [account.address, agentEco],
    })
    if (allowance < amount) {
      const approveHash = await wallet.writeContract({
        address: usdt,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [agentEco, amount],
        chain: wallet.chain,
        account,
      })
      await publicClient.waitForTransactionReceipt({ hash: approveHash })
    }

    const fundHash = await wallet.writeContract({
      address: agentEco,
      abi: AGENT_ECO_ABI,
      functionName: 'fundEscrow',
      args: [escrowId],
      chain: wallet.chain,
      account,
    })
    await publicClient.waitForTransactionReceipt({ hash: fundHash })

    return escrowId
  }

  /** Send a call on the escrow's contract and wait for it, without checking the receipt's status. */
  private async sendAndWait(id: bigint, functionName: 'startExecution' | 'markDelivered' | 'acceptAndSettle', args: readonly unknown[]): Promise<void> {
    const { wallet, account } = this.signing()
    const hash = await wallet.writeContract({
      address: this.agentEcoFor(id),
      abi: AGENT_ECO_ABI,
      functionName,
      args,
      chain: wallet.chain,
      account,
    } as never)
    await this.publicClient.waitForTransactionReceipt({ hash })
  }

  startExecution(id: bigint): Promise<void> {
    return this.sendAndWait(id, 'startExecution', [id])
  }

  markDelivered(id: bigint, resultHash: Hex): Promise<void> {
    return this.sendAndWait(id, 'markDelivered', [id, resultHash])
  }

  acceptAndSettle(id: bigint): Promise<void> {
    return this.sendAndWait(id, 'acceptAndSettle', [id])
  }

  /** Send a call and wait for it; a reverted receipt throws. */
  private async writeAndWait(
    functionName: 'raiseDispute' | 'submitDisputeResponse' | 'rateSeller' | 'resolveDisputeForSeller' | 'resolveDisputeForBuyer',
    args: readonly [bigint, ...unknown[]]
  ): Promise<Hex> {
    const { wallet, account } = this.signing()
    const hash = await wallet.writeContract({
      address: this.agentEcoFor(args[0]),
      abi: AGENT_ECO_ABI,
      functionName,
      args,
      chain: wallet.chain,
      account,
    } as never)
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted (tx ${hash})`)
    return hash
  }

  raiseDispute(id: bigint, reasonHash: Hex): Promise<Hex> {
    return this.writeAndWait('raiseDispute', [id, reasonHash])
  }

  submitDisputeResponse(id: bigint, responseHash: Hex): Promise<Hex> {
    return this.writeAndWait('submitDisputeResponse', [id, responseHash])
  }

  rateSeller(id: bigint, score: number): Promise<Hex> {
    return this.writeAndWait('rateSeller', [id, score])
  }

  resolveDispute(id: bigint, toSeller: boolean, rationaleHash: Hex): Promise<Hex> {
    return this.writeAndWait(toSeller ? 'resolveDisputeForSeller' : 'resolveDisputeForBuyer', [id, rationaleHash])
  }

  private async waitOk(hash: Hex, what: string): Promise<void> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`${what} reverted (tx ${hash})`)
  }

  async ruleDispute(id: bigint, toSeller: boolean, rationaleHash: Hex): Promise<RulingOutcome> {
    const { wallet, account } = this.signing()
    const { publicClient } = this
    const eco = this.agentEcoFor(id)
    const setup = await this.arbiterSetupAt(eco)
    if (!canRule(setup, account.address)) {
      throw new Error(`${account.address} is neither the arbiter nor a member of its council.`)
    }

    if (!setup.council) {
      const hash = await wallet.writeContract({
        address: eco,
        abi: AGENT_ECO_ABI,
        functionName: toSeller ? 'resolveDisputeForSeller' : 'resolveDisputeForBuyer',
        args: [id, rationaleHash],
        chain: wallet.chain,
        account,
      })
      await this.waitOk(hash, 'resolveDispute')
      return { kind: 'executed', hash }
    }

    const council = setup.council.address
    const needed = setup.council.rulingThreshold
    const rulingId = await publicClient.readContract({
      address: council,
      abi: ARBITER_COUNCIL_ABI,
      functionName: 'rulingId',
      args: [id, toSeller, rationaleHash],
    })
    const [voted, [votesBefore]] = await Promise.all([
      publicClient.readContract({ address: council, abi: ARBITER_COUNCIL_ABI, functionName: 'hasVoted', args: [rulingId, account.address] }),
      publicClient.readContract({ address: council, abi: ARBITER_COUNCIL_ABI, functionName: 'proposals', args: [rulingId] }),
    ])
    if (voted) return { kind: 'already-voted', votes: Number(votesBefore), needed }

    const hash = await wallet.writeContract({
      address: council,
      abi: ARBITER_COUNCIL_ABI,
      functionName: 'voteRuling',
      args: [id, toSeller, rationaleHash],
      chain: wallet.chain,
      account,
    })
    await this.waitOk(hash, 'voteRuling')
    const [votes, executed] = await publicClient.readContract({ address: council, abi: ARBITER_COUNCIL_ABI, functionName: 'proposals', args: [rulingId] })
    return executed ? { kind: 'executed', hash } : { kind: 'voted', hash, votes: Number(votes), needed }
  }

  async claimTimeout(id: bigint, action: TimeoutAction, hooks?: TimeoutClaimHooks): Promise<TimeoutClaim> {
    const { wallet, account } = this.signing()
    // Simulate first: catches a stale/ineligible escrow (e.g. someone else's keeper already claimed it) before gas is spent.
    const { request } = await this.publicClient.simulateContract({
      address: this.agentEcoFor(id),
      abi: AGENT_ECO_ABI,
      functionName: action,
      args: [id],
      account,
    })
    hooks?.onSubmitting?.()
    const hash = await wallet.writeContract(request)
    hooks?.onSent?.(hash)
    // Awaiting the receipt, not just the hash, is what keeps the same escrow from being submitted twice.
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash })
    return { hash: receipt.transactionHash, success: receipt.status === 'success', blockNumber: receipt.blockNumber }
  }

  // --- Reads ---------------------------------------------------------------

  async getEscrowBasic(id: bigint): Promise<EscrowBasic> {
    const [buyer, seller, amount, status] = await this.publicClient.readContract({
      address: this.agentEcoFor(id),
      abi: AGENT_ECO_ABI,
      functionName: 'getEscrowBasic',
      args: [id],
    })
    return { id, buyer, seller, amount, status: Number(status) }
  }

  /** The delivered result's hash (every deployment has getResultHash, also v1 without getEscrowHashes). */
  getResultHash(id: bigint): Promise<Hash32> {
    return this.publicClient.readContract({ address: this.agentEcoFor(id), abi: RESULT_HASH_ABI, functionName: 'getResultHash', args: [id] })
  }

  getEscrowStatus(id: bigint): Promise<number> {
    return this.publicClient.readContract({ address: this.agentEcoFor(id), abi: AGENT_ECO_ABI, functionName: 'getEscrowStatus', args: [id] })
  }

  async getEscrowDisputeInfo(id: bigint): Promise<EscrowDisputeInfo> {
    const [disputedAt, disputeDeadline, acceptDeadline, rated] = await this.publicClient.readContract({
      address: this.agentEcoFor(id),
      abi: AGENT_ECO_ABI,
      functionName: 'getEscrowDisputeInfo',
      args: [id],
    })
    return { disputedAt, disputeDeadline, acceptDeadline, rated }
  }

  async getEscrowHashes(id: bigint): Promise<EscrowHashes> {
    const [taskHash, resultHash, disputeReasonHash, disputeResponseHash, resolutionHash] = await this.publicClient.readContract({
      address: this.agentEcoFor(id),
      abi: AGENT_ECO_ABI,
      functionName: 'getEscrowHashes',
      args: [id],
    })
    return { taskHash, resultHash, disputeReasonHash, disputeResponseHash, resolutionHash }
  }

  async getEscrowTimestamps(id: bigint): Promise<EscrowTimestamps> {
    const [createdAt, fundedAt, executingAt, deliveredAt, settledAt] = await this.publicClient.readContract({
      address: this.agentEcoFor(id),
      abi: AGENT_ECO_ABI,
      functionName: 'getEscrowTimestamps',
      args: [id],
    })
    return { createdAt, fundedAt, executingAt, deliveredAt, settledAt }
  }

  async getEscrowWindows(id: bigint): Promise<EscrowWindows> {
    const [executionWindow, reviewWindow, executionDeadline, reviewDeadline] = await this.publicClient.readContract({
      address: this.agentEcoFor(id),
      abi: AGENT_ECO_ABI,
      functionName: 'getEscrowWindows',
      args: [id],
    })
    return { executionWindow, reviewWindow, executionDeadline, reviewDeadline }
  }

  readTimeoutFlag(id: bigint, flag: TimeoutFlag): Promise<boolean> {
    return this.publicClient.readContract({ address: this.agentEcoFor(id), abi: AGENT_ECO_ABI, functionName: FLAG_READER[flag], args: [id] })
  }

  // --- Arbiter -------------------------------------------------------------

  /** The arbiter of one AgentEco deployment: a wallet, or an ArbiterCouncil whose members vote. */
  async arbiterSetupAt(agentEco: Address = this.config.agentEco): Promise<ArbiterSetup> {
    const { publicClient } = this
    const arbiter = await publicClient.readContract({ address: agentEco, abi: AGENT_ECO_ABI, functionName: 'arbiter' })
    const code = await publicClient.getCode({ address: arbiter })
    if (!code || code === '0x') return { arbiter, council: null }
    const [members, rulingThreshold, adminThreshold, councilEco] = await Promise.all([
      publicClient.readContract({ address: arbiter, abi: ARBITER_COUNCIL_ABI, functionName: 'getMembers' }),
      publicClient.readContract({ address: arbiter, abi: ARBITER_COUNCIL_ABI, functionName: 'rulingThreshold' }),
      publicClient.readContract({ address: arbiter, abi: ARBITER_COUNCIL_ABI, functionName: 'adminThreshold' }),
      publicClient.readContract({ address: arbiter, abi: ARBITER_COUNCIL_ABI, functionName: 'agentEco' }),
    ])
    if (councilEco.toLowerCase() !== agentEco.toLowerCase()) {
      throw new Error(`The arbiter ${arbiter} is a council for another contract (${councilEco}).`)
    }
    return { arbiter, council: { address: arbiter, members: [...members], rulingThreshold: Number(rulingThreshold), adminThreshold: Number(adminThreshold) } }
  }

  getArbiterSetup(id?: bigint): Promise<ArbiterSetup> {
    return this.arbiterSetupAt(id === undefined ? this.config.agentEco : this.agentEcoFor(id))
  }

  // --- Escrow index --------------------------------------------------------
  // Discovery from contract state, not event logs: public RPCs refuse eth_getLogs or prune
  // history, while AgentEco numbers escrows firstEscrowId..nextEscrowId-1 and getEscrowBasic
  // works against any RPC, forever.

  private async idsOn(address: Address, first: bigint, cap?: bigint): Promise<bigint[]> {
    const next = await this.publicClient.readContract({ address, abi: AGENT_ECO_ABI, functionName: 'nextEscrowId' })
    const end = cap !== undefined && cap < next ? cap : next
    const ids: bigint[] = []
    for (let id = first; id < end; id++) ids.push(id)
    return ids
  }

  async escrowIds(opts: { currentOnly?: boolean } = {}): Promise<bigint[]> {
    const { agentEco, firstEscrowId, legacy } = this.config
    const lists = await Promise.all([
      ...(opts.currentOnly ? [] : legacy.map((d) => this.idsOn(d.address, d.firstEscrowId, d.endEscrowId))),
      this.idsOn(agentEco, firstEscrowId),
    ])
    return lists.flat()
  }

  async readEscrowBasics(ids: bigint[]): Promise<EscrowBasic[]> {
    const out: EscrowBasic[] = []
    for (let i = 0; i < ids.length; i += MULTICALL_BATCH) {
      const chunk = ids.slice(i, i + MULTICALL_BATCH)
      const calls = chunk.map((id) => ({
        address: this.agentEcoFor(id),
        abi: AGENT_ECO_ABI,
        functionName: 'getEscrowBasic' as const,
        args: [id] as const,
      }))
      const results = this.config.chain.contracts?.multicall3
        ? await this.publicClient.multicall({ contracts: calls, allowFailure: false })
        : await Promise.all(calls.map((c) => this.publicClient.readContract(c)))
      results.forEach(([buyer, seller, amount, status], j) => {
        out.push({ id: chunk[j], buyer, seller, amount, status: Number(status) })
      })
    }
    return out
  }

  async listEscrows(opts: { currentOnly?: boolean } = {}): Promise<EscrowBasic[]> {
    return this.readEscrowBasics(await this.escrowIds(opts))
  }

  // --- Contract limits -----------------------------------------------------

  /** The current deployment's timer limits, fixed at deploy. */
  async timerLimits(): Promise<TimerLimits> {
    const read = (functionName: 'minWindow' | 'MAX_WINDOW' | 'disputeTimeout') =>
      this.publicClient.readContract({ address: this.config.agentEco, abi: AGENT_ECO_ABI, functionName }) as Promise<bigint>
    const [minWindow, maxWindow, disputeTimeout] = await Promise.all([read('minWindow'), read('MAX_WINDOW'), read('disputeTimeout')])
    return { minWindow, maxWindow, disputeTimeout }
  }

  // --- Ratings (SellerRated events) ----------------------------------------

  private ratingsIn(logs: Log[]): RatingEvent[] {
    return parseEventLogs({ abi: AGENT_ECO_ABI, logs, eventName: 'SellerRated' })
      .filter((l) => this.isAgentEcoAddress(l.address))
      .map((l) => ratingEvent(l.args as SellerRatedArgs, l.transactionHash))
  }

  /** The SellerRated event(s) in one transaction, from any AgentEco deployment on this chain. */
  async ratingsInTx(txHash: string): Promise<RatingEvent[]> {
    const receipt = await this.publicClient.getTransactionReceipt({ hash: txHash as Hex })
    return this.ratingsIn(receipt.logs as Log[])
  }

  /** SellerRated events of the current deployment in [fromBlock, toBlock] — callers keep the span within `config.logRange`. */
  async ratings(fromBlock: bigint, toBlock: bigint): Promise<RatingEvent[]> {
    const logs = await this.publicClient.getLogs({ address: this.config.agentEco, event: SELLER_RATED, fromBlock, toBlock })
    return logs.map((l) => ratingEvent(l.args as SellerRatedArgs, l.transactionHash))
  }

  // --- ERC-8004 (identity and reputation registries) -----------------------

  /** The same chain and wallet, with these ERC-8004 registries (e.g. as the API reports them). */
  withErc8004(registries: Erc8004Registries | null): EvmAdapter {
    return new EvmAdapter({ ...this.config, erc8004: registries }, { publicClient: this.publicClient, walletClient: this.walletClient, account: this.account })
  }

  private registries(): Erc8004Registries {
    if (!this.config.erc8004) throw new Error(`ERC-8004 is not configured on ${this.chainId} (ERC8004_IDENTITY_REGISTRY / ERC8004_REPUTATION_REGISTRY).`)
    return this.config.erc8004
  }

  /** The Registered event in a transaction on this chain's Identity Registry, or null. */
  async erc8004Registration(txHash: string): Promise<{ agentId: bigint; agentURI: string; owner: Address } | null> {
    const { identity } = this.registries()
    const receipt = await this.publicClient.getTransactionReceipt({ hash: txHash as Hex })
    const [event] = parseEventLogs({ abi: IDENTITY_REGISTRY_ABI, logs: receipt.logs as Log[], eventName: 'Registered' }).filter(
      (l) => l.address.toLowerCase() === identity.toLowerCase()
    )
    return event ? { agentId: event.args.agentId, agentURI: event.args.agentURI, owner: event.args.owner } : null
  }

  /** Register the signer as an agent whose registration file is at `agentURI`; it owns the identity NFT. */
  async erc8004Register(agentURI: string): Promise<{ agentId: bigint; txHash: Hex }> {
    const { wallet, account } = this.signing()
    const { identity } = this.registries()
    const hash = await wallet.writeContract({
      address: identity,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'register',
      args: [agentURI],
      chain: wallet.chain,
      account,
    })
    await this.waitOk(hash, 'register')
    const registered = await this.erc8004Registration(hash)
    if (!registered) throw new Error(`No Registered event in ${hash}`)
    return { agentId: registered.agentId, txHash: hash }
  }

  async erc8004Owner(agentId: bigint): Promise<Address> {
    return this.publicClient.readContract({ address: this.registries().identity, abi: IDENTITY_REGISTRY_ABI, functionName: 'ownerOf', args: [agentId] })
  }

  async erc8004AgentURI(agentId: bigint): Promise<string> {
    return this.publicClient.readContract({ address: this.registries().identity, abi: IDENTITY_REGISTRY_ABI, functionName: 'tokenURI', args: [agentId] })
  }

  /**
   * The signer gives feedback on an agent. The registry refuses the agent's own owner or
   * operator as the reviewer. Returns the transaction hash; a revert throws.
   */
  async erc8004GiveFeedback(
    agentId: bigint,
    feedback: { value: bigint; valueDecimals: number; tag1: string; tag2: string; endpoint?: string; feedbackURI?: string; feedbackHash?: Hex }
  ): Promise<Hex> {
    const { wallet, account } = this.signing()
    const hash = await wallet.writeContract({
      address: this.registries().reputation,
      abi: REPUTATION_REGISTRY_ABI,
      functionName: 'giveFeedback',
      args: [
        agentId,
        feedback.value,
        feedback.valueDecimals,
        feedback.tag1,
        feedback.tag2,
        feedback.endpoint ?? '',
        feedback.feedbackURI ?? '',
        feedback.feedbackHash ?? `0x${'0'.repeat(64)}`,
      ],
      chain: wallet.chain,
      account,
    })
    await this.waitOk(hash, 'giveFeedback')
    return hash
  }

  /** A client's latest feedback on an agent, or null when it gave none. */
  async erc8004LastFeedback(agentId: bigint, client: string): Promise<Erc8004Feedback | null> {
    const { reputation } = this.registries()
    const index = await this.publicClient.readContract({
      address: reputation,
      abi: REPUTATION_REGISTRY_ABI,
      functionName: 'getLastIndex',
      args: [agentId, client as Address],
    })
    if (index === BigInt(0)) return null
    const [value, valueDecimals, tag1, tag2, isRevoked] = await this.publicClient.readContract({
      address: reputation,
      abi: REPUTATION_REGISTRY_ABI,
      functionName: 'readFeedback',
      args: [agentId, client as Address, index],
    })
    return { index, value, valueDecimals, tag1, tag2, isRevoked }
  }

  // --- Reputation ----------------------------------------------------------

  /**
   * Raw on-chain reputation, as AgentEco.sol reports it — summed over the current deployment
   * and every legacy one, so a seller keeps its history.
   */
  async getReputation(seller: string): Promise<OnchainReputation> {
    const reads = await Promise.all(
      this.allAgentEcoAddresses.map((contract) =>
        this.publicClient.readContract({ address: contract, abi: AGENT_ECO_ABI, functionName: 'getReputation', args: [seller as Address] })
      )
    )
    let [completed, failed, ratingSum, ratingCount] = [BigInt(0), BigInt(0), BigInt(0), BigInt(0)]
    for (const [c, f, , sum, count] of reads) {
      completed += c
      failed += f
      ratingSum += sum
      ratingCount += count
    }
    const completedJobs = Number(completed)
    const failedJobs = Number(failed)
    const finished = completedJobs + failedJobs
    const count = Number(ratingCount)
    return {
      completedJobs,
      failedJobs,
      successRatePct: finished === 0 ? 0 : (completedJobs / finished) * 100,
      ratingCount: count,
      avgRatingScore: count === 0 ? null : Number(ratingSum) / count,
    }
  }
}

function ratingEvent(args: SellerRatedArgs, txHash: string | null): RatingEvent {
  return { escrowId: args.escrowId, seller: args.seller, buyer: args.buyer, score: Number(args.score), txHash }
}

const RESULT_HASH_ABI = [
  {
    inputs: [{ internalType: 'uint256', name: 'escrowId', type: 'uint256' }],
    name: 'getResultHash',
    outputs: [{ internalType: 'bytes32', name: '', type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

/** Whether `address` can rule: it is the arbiter wallet, or a member of the arbiter council. */
export function canRule(setup: { arbiter: string; council: { members: string[] } | null }, address: string): boolean {
  if (setup.council) return setup.council.members.some((m) => sameWallet(m, address))
  return sameWallet(setup.arbiter, address)
}
