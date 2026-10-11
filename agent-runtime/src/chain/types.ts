/**
 * The chain-neutral surface of AgentEco: everything the business logic (SDK, hosts, keeper,
 * API) needs from a chain, with nothing EVM-specific in it. EvmAdapter (./evm.ts) is the
 * first implementation; docs/MULTICHAIN.md describes the design.
 */

/** A CAIP-2 chain id, e.g. `eip155:97`. */
export type ChainId = string

/** An escrow's number on its chain (a u64 on Solana, a uint256 on EVM chains). */
export type EscrowId = bigint

/** A 32-byte hash as 0x-prefixed hex — keccak256 of the committed text, on every chain. */
export type Hash32 = `0x${string}`

/** A transaction hash (EVM: 0x hex) or signature (Solana: base58), as the chain prints it. */
export type TxHash = string

/** Mirrors AgentEco's `OrderStatus` ordering: CREATED, FUNDED, EXECUTING, DELIVERED, DISPUTED, SETTLED, REFUNDED. */
export type EscrowStatusCode = number

export interface TokenInfo {
  address: string
  symbol: string
  decimals: number
}

/** An escrow's parties, amount and status. */
export interface EscrowBasic {
  id: EscrowId
  buyer: string
  seller: string
  amount: bigint
  status: EscrowStatusCode
}

/** Every hash committed for an escrow (all zeros until that stage happened). */
export interface EscrowHashes {
  taskHash: Hash32
  resultHash: Hash32
  disputeReasonHash: Hash32
  disputeResponseHash: Hash32
  resolutionHash: Hash32
}

/** Unix seconds; 0 until the stage was reached. */
export interface EscrowTimestamps {
  createdAt: bigint
  fundedAt: bigint
  executingAt: bigint
  deliveredAt: bigint
  settledAt: bigint
}

/** The negotiated windows and their deadlines (0 until execution / delivery started). */
export interface EscrowWindows {
  executionWindow: bigint
  reviewWindow: bigint
  executionDeadline: bigint
  reviewDeadline: bigint
}

/** Dispute timing, the accept deadline and whether the buyer has rated. */
export interface EscrowDisputeInfo {
  disputedAt: bigint
  disputeDeadline: bigint
  acceptDeadline: bigint
  rated: boolean
}

/** Who may rule disputes: a wallet, or a council (a small multisig) and its members. */
export interface ArbiterSetup {
  arbiter: string
  council: { address: string; members: string[]; rulingThreshold: number; adminThreshold: number } | null
}

export type RulingOutcome =
  /** The ruling executed in this transaction. */
  | { kind: 'executed'; hash: TxHash }
  /** A council vote was recorded; more members must vote the same ruling. */
  | { kind: 'voted'; hash: TxHash; votes: number; needed: number }
  /** This member already voted for exactly this ruling; waiting for the others. */
  | { kind: 'already-voted'; votes: number; needed: number }

/** The permissionless calls that move a timed-out escrow on. */
export type TimeoutAction = 'claimAcceptTimeout' | 'claimExecutionTimeout' | 'finalizeAfterReviewWindow' | 'claimDisputeTimeout'

/** The eligibility flags a chain exposes for those calls. */
export type TimeoutFlag = 'acceptTimedOut' | 'executionTimedOut' | 'reviewExpired' | 'disputeTimedOut'

export interface TimeoutClaim {
  hash: TxHash
  success: boolean
  blockNumber: bigint
}

export interface TimeoutClaimHooks {
  /** The call was checked (simulated) and is about to be sent. */
  onSubmitting?: () => void
  /** The transaction was sent; its receipt is awaited next. */
  onSent?: (hash: TxHash) => void
}

/** Raw on-chain reputation of a seller, summed over every deployment on the chain. */
export interface OnchainReputation {
  completedJobs: number
  failedJobs: number
  /** completed / (completed + failed) × 100; 0 before the first finished job. */
  successRatePct: number
  ratingCount: number
  /** Average buyer rating on the contract's 1–100 scale; null with no ratings. */
  avgRatingScore: number | null
}

/** A buyer's rating of a seller, as the chain recorded it (score on the 1–100 scale). */
export interface RatingEvent {
  escrowId: EscrowId
  seller: string
  buyer: string
  score: number
  txHash: string | null
}

/** Timer limits fixed in the escrow program at deploy, in seconds. */
export interface TimerLimits {
  minWindow: bigint
  maxWindow: bigint
  disputeTimeout: bigint
}

export interface ChainAdapter {
  readonly chainId: ChainId
  readonly family: 'evm' | 'solana'
  /** Address of the wallet that signs this adapter's writes; null for a read-only adapter. */
  readonly signer: string | null
  readonly nativeSymbol: string
  /** Decimals of the native coin's base unit (wei: 18, lamports: 9) — for showing balances. */
  readonly nativeDecimals: number
  readonly explorer: { name: string; txUrl(hash: string): string; addressUrl(address: string): string }

  /** The form addresses are stored and compared in (EVM: lowercase hex; Solana: base58 as is). */
  normalizeAddress(address: string): string
  /** Whether `address` is well formed for this chain (EVM: 20-byte hex; Solana: base58 of 32 bytes). */
  isValidAddress(address: string): boolean
  /**
   * Whether `signature` is `address`'s signature of the UTF-8 text `message` — for API sign-in and
   * account linking. EVM: EIP-191 personal_sign, 0x hex (contract wallets are not supported). Solana:
   * ed25519 over the message bytes, base58 as wallets print it.
   */
  verifySignature(params: { address: string; message: string; signature: string }): Promise<boolean>
  /** The settlement token. */
  token(): Promise<TokenInfo>
  /** Latest block number (or slot). */
  head(): Promise<bigint>
  nativeBalance(address: string): Promise<bigint>
  tokenBalance(address: string): Promise<bigint>

  // --- Writes (need a signer) ---
  /** Buyer: create the escrow for `amount` (a decimal in token units), committing `taskHash`, and fund it. */
  createAndFundEscrow(params: { seller: string; amount: number | string; taskHash: Hash32 }): Promise<EscrowId>
  /** Seller: FUNDED → EXECUTING. */
  startExecution(id: EscrowId): Promise<void>
  /** Seller: deliver the result (its hash — the payload lives off-chain). */
  markDelivered(id: EscrowId, resultHash: Hash32): Promise<void>
  /** Buyer: accept the delivered result and release payment. */
  acceptAndSettle(id: EscrowId): Promise<void>
  /** Buyer: dispute a delivered result. */
  raiseDispute(id: EscrowId, reasonHash: Hash32): Promise<TxHash>
  /** Seller: answer a dispute once, before its deadline. */
  submitDisputeResponse(id: EscrowId, responseHash: Hash32): Promise<TxHash>
  /** Buyer: rate the seller 1–100, once, after the escrow is final and something was delivered. */
  rateSeller(id: EscrowId, score: number): Promise<TxHash>
  /** Arbiter wallet: rule a dispute directly. */
  resolveDispute(id: EscrowId, toSeller: boolean, rationaleHash: Hash32): Promise<TxHash>
  /** Arbiter or council member: rule a dispute — directly, or by a council vote. */
  ruleDispute(id: EscrowId, toSeller: boolean, rationaleHash: Hash32): Promise<RulingOutcome>
  /** Anyone: claim a timeout the escrow is due for (checked before sending). */
  claimTimeout(id: EscrowId, action: TimeoutAction, hooks?: TimeoutClaimHooks): Promise<TimeoutClaim>
  /** Send `amount` (base units) of the settlement token from the signer. */
  transferToken(to: string, amount: bigint): Promise<TxHash>
  /** Send the signer's whole native balance minus the transfer fee; null when it does not cover the fee. */
  sweepNative(to: string): Promise<TxHash | null>

  // --- Reads ---
  getEscrowBasic(id: EscrowId): Promise<EscrowBasic>
  getEscrowStatus(id: EscrowId): Promise<EscrowStatusCode>
  getResultHash(id: EscrowId): Promise<Hash32>
  getEscrowHashes(id: EscrowId): Promise<EscrowHashes>
  getEscrowTimestamps(id: EscrowId): Promise<EscrowTimestamps>
  getEscrowWindows(id: EscrowId): Promise<EscrowWindows>
  getEscrowDisputeInfo(id: EscrowId): Promise<EscrowDisputeInfo>
  /** Whether the escrow is past the deadline `flag` stands for. */
  readTimeoutFlag(id: EscrowId, flag: TimeoutFlag): Promise<boolean>
  /** The arbiter of the deployment holding `id`, or of the current deployment when none is given. */
  getArbiterSetup(id?: EscrowId): Promise<ArbiterSetup>
  /** Every escrow id that exists (`currentOnly`: the current deployment's only — the ones that can still change). */
  escrowIds(opts?: { currentOnly?: boolean }): Promise<EscrowId[]>
  readEscrowBasics(ids: EscrowId[]): Promise<EscrowBasic[]>
  /** Every escrow, as basic info. */
  listEscrows(opts?: { currentOnly?: boolean }): Promise<EscrowBasic[]>
  getReputation(seller: string): Promise<OnchainReputation>
  timerLimits(): Promise<TimerLimits>
  /** Ratings recorded by one transaction. */
  ratingsInTx(txHash: string): Promise<RatingEvent[]>
  /** Ratings recorded in a block range (keep it within the chain's log range). */
  ratings(fromBlock: bigint, toBlock: bigint): Promise<RatingEvent[]>
}
