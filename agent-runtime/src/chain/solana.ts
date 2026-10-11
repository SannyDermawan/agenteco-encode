/**
 * SolanaAdapter: a ChainAdapter (./types.ts) over the `agenteco_escrow` Anchor program in
 * `solana/programs/agenteco_escrow`. See docs/SOLANA.md for the full design.
 *
 * Status: the only `SolanaBackend` is the litesvm one in test-support/, used by the conformance
 * test (./conformance.test.ts). There is no RPC backend, no deployment, and nothing here is
 * wired into the chain registry or the backend — see docs/SOLANA.md §9.
 */
import { createHash } from 'node:crypto'
import {
  AccountRole,
  address,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Encoder,
  getProgramDerivedAddress,
  getPublicKeyFromAddress,
  isAddress,
  verifySignature as verifyEd25519,
  type Address,
  type Instruction as IInstruction,
  type SignatureBytes,
  type TransactionSigner,
} from '@solana/kit'
import { parseUnits } from 'viem'
import type {
  ArbiterSetup,
  ChainAdapter,
  ChainId,
  EscrowBasic,
  EscrowDisputeInfo,
  EscrowHashes,
  EscrowId,
  EscrowStatusCode,
  EscrowTimestamps,
  EscrowWindows,
  Hash32,
  OnchainReputation,
  RatingEvent,
  RulingOutcome,
  TimeoutAction,
  TimeoutClaim,
  TimeoutClaimHooks,
  TimeoutFlag,
  TimerLimits,
  TokenInfo,
  TxHash,
} from './types.ts'

export const SPL_TOKEN_PROGRAM_ID = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const SYSTEM_PROGRAM_ID = address('11111111111111111111111111111111')
const RENT_SYSVAR_ID = address('SysvarRent111111111111111111111111111111111')

/** CAIP-2 id of Solana devnet: `solana:` + the first 32 base58 characters of its genesis hash. */
export const SOLANA_DEVNET_CHAIN_ID = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'

/** Whether `chainId` has the shape of a Solana CAIP-2 id (`solana:` + 32 base58 characters). */
export function isSolanaChainId(chainId: string): boolean {
  return /^solana:[1-9A-HJ-NP-Za-km-z]{32}$/.test(chainId)
}

/** What SolanaAdapter needs from wherever the transactions actually run — litesvm today, a real RPC later. */
export interface SolanaBackend {
  getAccount(addr: Address): Promise<{ data: Uint8Array; lamports: bigint; owner: Address } | null>
  getClock(): Promise<{ slot: bigint; unixTimestamp: bigint }>
  send(instructions: IInstruction[], feePayer: TransactionSigner): Promise<TxHash>
}

export interface SolanaChainConfig {
  chainId: ChainId
  programId: Address
  mint: Address
  tokenSymbol: string
  nativeSymbol: string
  explorerUrl: string
  explorerName: string
  /** Negotiated off-chain, same as EvmChainConfig's fields of the same name. */
  executionWindow: bigint
  reviewWindow: bigint
  /** The id the program was initialized to number its escrows from (same field as EvmChainConfig's). */
  firstEscrowId: bigint
}

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function sighash(name: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`global:${name}`).digest()).slice(0, 8)
}

function assertDiscriminator(data: Uint8Array, accountName: string): void {
  const expected = createHash('sha256').update(`account:${accountName}`).digest().subarray(0, 8)
  if (!Buffer.from(data).subarray(0, 8).equals(expected)) throw new Error(`not a ${accountName} account of this program`)
}

function u64le(n: bigint): Uint8Array {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(n)
  return new Uint8Array(b)
}

function i64le(n: bigint): Uint8Array {
  const b = Buffer.alloc(8)
  b.writeBigInt64LE(n)
  return new Uint8Array(b)
}

function u16le(n: number): Uint8Array {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return new Uint8Array(b)
}

const addressEncoder = getAddressEncoder()
const addressDecoder = getAddressDecoder()
const pubkeyBytes = (addr: Address): Uint8Array => new Uint8Array(addressEncoder.encode(addr))
const bytesToAddress = (bytes: Uint8Array): Address => addressDecoder.decode(bytes)

const CONFIG_SEED = enc('config')
const ESCROW_SEED = enc('escrow')
const VAULT_SEED = enc('vault')
const REPUTATION_SEED = enc('reputation')

async function configPda(programId: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: programId, seeds: [CONFIG_SEED] })
  return pda
}
async function escrowPda(programId: Address, id: EscrowId): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: programId, seeds: [ESCROW_SEED, u64le(id)] })
  return pda
}
async function vaultPda(programId: Address, id: EscrowId): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: programId, seeds: [VAULT_SEED, u64le(id)] })
  return pda
}
async function reputationPda(programId: Address, seller: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: programId, seeds: [REPUTATION_SEED, pubkeyBytes(seller)] })
  return pda
}

type AnyAccountMeta = { address: Address; role: AccountRole; signer?: TransactionSigner }

function writable(addr: Address): AnyAccountMeta {
  return { address: addr, role: AccountRole.WRITABLE }
}
function readonly(addr: Address): AnyAccountMeta {
  return { address: addr, role: AccountRole.READONLY }
}
function writableSigner(signer: TransactionSigner): AnyAccountMeta {
  return { address: signer.address, role: AccountRole.WRITABLE_SIGNER, signer }
}
function readonlySigner(signer: TransactionSigner): AnyAccountMeta {
  return { address: signer.address, role: AccountRole.READONLY_SIGNER, signer }
}

// The program's EscrowStatus variants (Funded..Refunded) in the EVM contract's numbering
// (CREATED = 0 never occurs on Solana — see docs/SOLANA.md §2).
const STATUS_CODE = [1, 2, 3, 4, 5, 6] as const // Funded..Refunded -> FUNDED..REFUNDED

interface DecodedEscrow {
  id: bigint
  buyer: Address
  seller: Address
  mint: Address
  amount: bigint
  status: EscrowStatusCode
  feeBps: number
  createdAt: bigint
  fundedAt: bigint
  executingAt: bigint
  deliveredAt: bigint
  settledAt: bigint
  executionWindow: bigint
  reviewWindow: bigint
  executionDeadline: bigint
  reviewDeadline: bigint
  acceptDeadline: bigint
  disputedAt: bigint
  disputeDeadline: bigint
  taskHash: Hash32
  resultHash: Hash32
  disputeReasonHash: Hash32
  disputeResponseHash: Hash32
  resolutionHash: Hash32
  rated: boolean
}

function hex32(b: Buffer): Hash32 {
  return `0x${b.toString('hex')}` as Hash32
}

function decodeEscrow(data: Uint8Array): DecodedEscrow {
  assertDiscriminator(data, 'Escrow')
  const b = Buffer.from(data).subarray(8) // skip the 8-byte Anchor discriminator
  let o = 0
  const u64 = () => {
    const v = b.readBigUInt64LE(o)
    o += 8
    return v
  }
  const i64 = () => {
    const v = b.readBigInt64LE(o)
    o += 8
    return v
  }
  const pk = () => {
    const v = bytesToAddress(b.subarray(o, o + 32))
    o += 32
    return v
  }
  const hash = () => {
    const v = hex32(b.subarray(o, o + 32))
    o += 32
    return v
  }
  const id = u64()
  const buyer = pk()
  const seller = pk()
  const mint = pk()
  const amount = u64()
  const statusIdx = b.readUInt8(o)
  o += 1
  const feeBps = b.readUInt16LE(o)
  o += 2
  const createdAt = i64()
  const fundedAt = i64()
  const executingAt = i64()
  const deliveredAt = i64()
  const settledAt = i64()
  const executionWindow = i64()
  const reviewWindow = i64()
  const executionDeadline = i64()
  const reviewDeadline = i64()
  const acceptDeadline = i64()
  const disputedAt = i64()
  const disputeDeadline = i64()
  const taskHash = hash()
  const resultHash = hash()
  const disputeReasonHash = hash()
  const disputeResponseHash = hash()
  const resolutionHash = hash()
  const rated = b.readUInt8(o) === 1
  return {
    id,
    buyer,
    seller,
    mint,
    amount,
    status: STATUS_CODE[statusIdx] as EscrowStatusCode,
    feeBps,
    createdAt,
    fundedAt,
    executingAt,
    deliveredAt,
    settledAt,
    executionWindow,
    reviewWindow,
    executionDeadline,
    reviewDeadline,
    acceptDeadline,
    disputedAt,
    disputeDeadline,
    taskHash,
    resultHash,
    disputeReasonHash,
    disputeResponseHash,
    resolutionHash,
    rated,
  }
}

interface DecodedConfig {
  admin: Address
  arbiter: Address
  treasury: Address
  mint: Address
  feeBps: number
  minWindow: bigint
  acceptTimeout: bigint
  disputeTimeout: bigint
  nextEscrowId: bigint
}

function decodeConfig(data: Uint8Array): DecodedConfig {
  const b = Buffer.from(data).subarray(8)
  assertDiscriminator(data, 'Config')
  let o = 0
  const pk = () => {
    const v = bytesToAddress(b.subarray(o, o + 32))
    o += 32
    return v
  }
  const admin = pk()
  const arbiter = pk()
  const treasury = pk()
  const mint = pk()
  const feeBps = b.readUInt16LE(o)
  o += 2
  const minWindow = b.readBigInt64LE(o)
  o += 8
  const acceptTimeout = b.readBigInt64LE(o)
  o += 8
  const disputeTimeout = b.readBigInt64LE(o)
  o += 8
  const nextEscrowId = b.readBigUInt64LE(o)
  return { admin, arbiter, treasury, mint, feeBps, minWindow, acceptTimeout, disputeTimeout, nextEscrowId }
}

interface DecodedReputation {
  completedJobs: bigint
  failedJobs: bigint
  totalVolumeSettled: bigint
  ratingSum: bigint
  ratingCount: bigint
}

function decodeReputation(data: Uint8Array): DecodedReputation {
  assertDiscriminator(data, 'Reputation')
  const b = Buffer.from(data).subarray(8 + 32) // skip discriminator + seller pubkey
  let o = 0
  const u64 = () => {
    const v = b.readBigUInt64LE(o)
    o += 8
    return v
  }
  return {
    completedJobs: u64(),
    failedJobs: u64(),
    totalVolumeSettled: u64(),
    ratingSum: u64(),
    ratingCount: u64(),
  }
}

function decodeTokenAmount(data: Uint8Array): bigint {
  // spl-token Account layout: mint(32) owner(32) amount(u64) ...
  return Buffer.from(data).readBigUInt64LE(64)
}

export interface InitializeParams {
  programId: Address
  /** Signs, pays for the Config account and becomes the program's admin (fee and arbiter changes). */
  admin: TransactionSigner
  /** Signs dispute rulings: a wallet, or a multisig vault. */
  arbiter: Address
  /** The wallet that owns the token account fees are paid to (must hold one for `mint`). */
  treasury: Address
  /** The deployment's one settlement token. */
  mint: Address
  feeBps: number
  /** Seconds. The shortest execution / review window, the seller's accept timeout and the arbiter's ruling time. */
  minWindow: bigint
  acceptTimeout: bigint
  disputeTimeout: bigint
  firstEscrowId: bigint
}

/** The one-time `initialize` call that sets a deployed program up (see docs/SOLANA.md). */
export async function buildInitializeInstruction(p: InitializeParams): Promise<IInstruction> {
  const config = await configPda(p.programId)
  const data = Buffer.concat([
    sighash('initialize'),
    pubkeyBytes(p.arbiter),
    pubkeyBytes(p.treasury),
    u16le(p.feeBps),
    i64le(p.minWindow),
    i64le(p.acceptTimeout),
    i64le(p.disputeTimeout),
    u64le(p.firstEscrowId),
  ])
  return {
    programAddress: p.programId,
    accounts: [writableSigner(p.admin), writable(config), readonly(p.mint), readonly(SYSTEM_PROGRAM_ID)],
    data: new Uint8Array(data),
  }
}

export class SolanaAdapter implements ChainAdapter {
  readonly chainId: ChainId
  readonly family = 'solana' as const
  readonly nativeSymbol: string
  readonly explorer: ChainAdapter['explorer']

  private readonly backend: SolanaBackend
  private readonly programId: Address
  private readonly mint: Address
  private readonly tokenSymbol: string
  private readonly executionWindow: bigint
  private readonly reviewWindow: bigint
  private readonly firstEscrowId: bigint
  private readonly feePayer: TransactionSigner | null

  constructor(config: SolanaChainConfig, backend: SolanaBackend, feePayer: TransactionSigner | null = null) {
    this.chainId = config.chainId
    this.nativeSymbol = config.nativeSymbol
    this.programId = config.programId
    this.mint = config.mint
    this.tokenSymbol = config.tokenSymbol
    this.executionWindow = config.executionWindow
    this.reviewWindow = config.reviewWindow
    this.firstEscrowId = config.firstEscrowId
    this.backend = backend
    this.feePayer = feePayer
    this.explorer = {
      name: config.explorerName,
      txUrl: (hash: string) => `${config.explorerUrl}/tx/${hash}`,
      addressUrl: (a: string) => `${config.explorerUrl}/address/${a}`,
    }
  }

  get signer(): string | null {
    return this.feePayer?.address ?? null
  }

  normalizeAddress(a: string): string {
    return a
  }

  isValidAddress(a: string): boolean {
    return isAddress(a)
  }

  async verifySignature(params: { address: string; message: string; signature: string }): Promise<boolean> {
    try {
      if (!isAddress(params.address)) return false
      const key = await getPublicKeyFromAddress(address(params.address))
      const sig = new Uint8Array(getBase58Encoder().encode(params.signature)) as SignatureBytes
      return await verifyEd25519(key, sig, new TextEncoder().encode(params.message))
    } catch {
      return false
    }
  }

  private requireSigner(): TransactionSigner {
    if (!this.feePayer) throw new Error('read-only adapter: no signer configured')
    return this.feePayer
  }

  private async getAccountOrThrow(addr: Address, what: string): Promise<{ data: Uint8Array }> {
    const acc = await this.backend.getAccount(addr)
    if (!acc) throw new Error(`${what} not found: ${addr}`)
    return acc
  }

  private async decodedEscrow(id: EscrowId): Promise<DecodedEscrow> {
    const pda = await escrowPda(this.programId, id)
    const acc = await this.getAccountOrThrow(pda, `escrow ${id}`)
    return decodeEscrow(acc.data)
  }

  private async decodedConfig(): Promise<DecodedConfig> {
    const pda = await configPda(this.programId)
    const acc = await this.getAccountOrThrow(pda, 'config')
    return decodeConfig(acc.data)
  }

  async token(): Promise<TokenInfo> {
    const acc = await this.getAccountOrThrow(this.mint, 'mint')
    const decimals = Buffer.from(acc.data).readUInt8(44) // spl-token Mint: mint_authority COption(36) + supply(8) = 44
    return { address: this.mint, symbol: this.tokenSymbol, decimals }
  }

  async head(): Promise<bigint> {
    return (await this.backend.getClock()).slot
  }

  async nativeBalance(addr: string): Promise<bigint> {
    const acc = await this.backend.getAccount(address(addr))
    return acc?.lamports ?? 0n
  }

  private async ataFor(owner: Address): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
      seeds: [pubkeyBytes(owner), pubkeyBytes(SPL_TOKEN_PROGRAM_ID), pubkeyBytes(this.mint)],
    })
    return pda
  }

  async tokenBalance(addr: string): Promise<bigint> {
    const ata = await this.ataFor(address(addr))
    const acc = await this.backend.getAccount(ata)
    return acc ? decodeTokenAmount(acc.data) : 0n
  }

  async createAndFundEscrow(params: { seller: string; amount: number | string; taskHash: Hash32 }): Promise<EscrowId> {
    const buyer = this.requireSigner()
    const config = await this.decodedConfig()
    const { decimals } = await this.token()
    const amountBase = parseUnits(params.amount.toString(), decimals)
    const seller = address(params.seller)
    const id = config.nextEscrowId
    const escrow = await escrowPda(this.programId, id)
    const vault = await vaultPda(this.programId, id)
    const reputation = await reputationPda(this.programId, seller)
    const configAddr = await configPda(this.programId)
    const buyerAta = await this.ataFor(buyer.address)

    const data = Buffer.concat([
      sighash('create_and_fund_escrow'),
      u64le(amountBase),
      i64le(this.executionWindow),
      i64le(this.reviewWindow),
      Buffer.from(params.taskHash.slice(2), 'hex'),
    ])
    const ix: IInstruction = {
      programAddress: this.programId,
      accounts: [
        writableSigner(buyer),
        readonly(seller),
        writable(configAddr),
        writable(escrow),
        readonly(this.mint),
        writable(vault),
        writable(buyerAta),
        writable(reputation),
        readonly(SPL_TOKEN_PROGRAM_ID),
        readonly(SYSTEM_PROGRAM_ID),
        readonly(RENT_SYSVAR_ID),
      ],
      data: new Uint8Array(data),
    }
    await this.backend.send([ix], buyer)
    return id
  }

  async startExecution(id: EscrowId): Promise<void> {
    const seller = this.requireSigner()
    const escrow = await escrowPda(this.programId, id)
    await this.backend.send(
      [{ programAddress: this.programId, accounts: [readonlySigner(seller), writable(escrow)], data: sighash('start_execution') }],
      seller
    )
  }

  async markDelivered(id: EscrowId, resultHash: Hash32): Promise<void> {
    const seller = this.requireSigner()
    const escrow = await escrowPda(this.programId, id)
    const data = Buffer.concat([sighash('mark_delivered'), Buffer.from(resultHash.slice(2), 'hex')])
    await this.backend.send(
      [{ programAddress: this.programId, accounts: [readonlySigner(seller), writable(escrow)], data: new Uint8Array(data) }],
      seller
    )
  }

  private async settleAccounts(id: EscrowId) {
    const e = await this.decodedEscrow(id)
    const escrow = await escrowPda(this.programId, id)
    const vault = await vaultPda(this.programId, id)
    const reputation = await reputationPda(this.programId, e.seller)
    const configAddr = await configPda(this.programId)
    const config = await this.decodedConfig()
    const sellerAta = await this.ataFor(e.seller)
    const treasuryAta = await this.ataFor(config.treasury)
    return { escrow, vault, reputation, sellerAta, treasuryAta, configAddr }
  }

  async acceptAndSettle(id: EscrowId): Promise<void> {
    const buyer = this.requireSigner()
    const { escrow, vault, reputation, sellerAta, treasuryAta, configAddr } = await this.settleAccounts(id)
    await this.backend.send(
      [
        {
          programAddress: this.programId,
          accounts: [readonlySigner(buyer), readonly(configAddr), writable(escrow), writable(vault), writable(sellerAta), writable(treasuryAta), writable(reputation), readonly(SPL_TOKEN_PROGRAM_ID)],
          data: sighash('accept_and_settle'),
        },
      ],
      buyer
    )
  }

  async raiseDispute(id: EscrowId, reasonHash: Hash32): Promise<TxHash> {
    const buyer = this.requireSigner()
    const escrow = await escrowPda(this.programId, id)
    const configAddr = await configPda(this.programId)
    const data = Buffer.concat([sighash('raise_dispute'), Buffer.from(reasonHash.slice(2), 'hex')])
    return this.backend.send(
      [{ programAddress: this.programId, accounts: [readonlySigner(buyer), writable(escrow), readonly(configAddr)], data: new Uint8Array(data) }],
      buyer
    )
  }

  async submitDisputeResponse(id: EscrowId, responseHash: Hash32): Promise<TxHash> {
    const seller = this.requireSigner()
    const escrow = await escrowPda(this.programId, id)
    const data = Buffer.concat([sighash('submit_dispute_response'), Buffer.from(responseHash.slice(2), 'hex')])
    return this.backend.send(
      [{ programAddress: this.programId, accounts: [readonlySigner(seller), writable(escrow)], data: new Uint8Array(data) }],
      seller
    )
  }

  async rateSeller(id: EscrowId, score: number): Promise<TxHash> {
    const buyer = this.requireSigner()
    const e = await this.decodedEscrow(id)
    const escrow = await escrowPda(this.programId, id)
    const reputation = await reputationPda(this.programId, e.seller)
    const data = Buffer.concat([sighash('rate_seller'), Buffer.from([score])])
    return this.backend.send(
      [{ programAddress: this.programId, accounts: [readonlySigner(buyer), writable(escrow), writable(reputation)], data: new Uint8Array(data) }],
      buyer
    )
  }

  async resolveDispute(id: EscrowId, toSeller: boolean, rationaleHash: Hash32): Promise<TxHash> {
    const arbiter = this.requireSigner()
    const e = await this.decodedEscrow(id)
    const escrow = await escrowPda(this.programId, id)
    const vault = await vaultPda(this.programId, id)
    const reputation = await reputationPda(this.programId, e.seller)
    const configAddr = await configPda(this.programId)
    const config = await this.decodedConfig()
    const payoutAta = toSeller ? await this.ataFor(e.seller) : await this.ataFor(e.buyer)
    const treasuryAta = await this.ataFor(config.treasury)
    const data = Buffer.concat([sighash('resolve_dispute'), Buffer.from([toSeller ? 1 : 0]), Buffer.from(rationaleHash.slice(2), 'hex')])
    return this.backend.send(
      [
        {
          programAddress: this.programId,
          accounts: [
            readonlySigner(arbiter),
            readonly(configAddr),
            writable(escrow),
            writable(vault),
            writable(payoutAta),
            writable(treasuryAta),
            writable(reputation),
            readonly(SPL_TOKEN_PROGRAM_ID),
          ],
          data: new Uint8Array(data),
        },
      ],
      arbiter
    )
  }

  async ruleDispute(id: EscrowId, toSeller: boolean, rationaleHash: Hash32): Promise<RulingOutcome> {
    // No council program this phase (docs/SOLANA.md §6): a single arbiter signer always
    // resolves directly, the same as resolveDispute.
    const hash = await this.resolveDispute(id, toSeller, rationaleHash)
    return { kind: 'executed', hash }
  }

  async claimTimeout(id: EscrowId, action: TimeoutAction, hooks?: TimeoutClaimHooks): Promise<TimeoutClaim> {
    const e = await this.decodedEscrow(id)
    const escrow = await escrowPda(this.programId, id)
    const vault = await vaultPda(this.programId, id)
    const reputation = await reputationPda(this.programId, e.seller)
    const configAddr = await configPda(this.programId)
    const config = await this.decodedConfig()
    const keeper = this.requireSigner()

    hooks?.onSubmitting?.()

    let ix: IInstruction
    if (action === 'claimAcceptTimeout') {
      const buyerAta = await this.ataFor(e.buyer)
      ix = { programAddress: this.programId, accounts: [writable(escrow), writable(vault), writable(buyerAta), readonly(SPL_TOKEN_PROGRAM_ID)], data: sighash('claim_accept_timeout') }
    } else if (action === 'claimExecutionTimeout') {
      const buyerAta = await this.ataFor(e.buyer)
      ix = {
        programAddress: this.programId,
        accounts: [writable(escrow), writable(vault), writable(buyerAta), writable(reputation), readonly(SPL_TOKEN_PROGRAM_ID)],
        data: sighash('claim_execution_timeout'),
      }
    } else if (action === 'finalizeAfterReviewWindow') {
      const sellerAta = await this.ataFor(e.seller)
      const treasuryAta = await this.ataFor(config.treasury)
      ix = {
        programAddress: this.programId,
        accounts: [readonlySigner(keeper), readonly(configAddr), writable(escrow), writable(vault), writable(sellerAta), writable(treasuryAta), writable(reputation), readonly(SPL_TOKEN_PROGRAM_ID)],
        data: sighash('finalize_after_review_window'),
      }
    } else {
      const buyerAta = await this.ataFor(e.buyer)
      ix = { programAddress: this.programId, accounts: [writable(escrow), writable(vault), writable(buyerAta), readonly(SPL_TOKEN_PROGRAM_ID)], data: sighash('claim_dispute_timeout') }
    }

    const hash = await this.backend.send([ix], keeper)
    hooks?.onSent?.(hash)
    const slot = (await this.backend.getClock()).slot
    return { hash, success: true, blockNumber: slot }
  }

  async transferToken(to: string, amount: bigint): Promise<TxHash> {
    const from = this.requireSigner()
    const fromAta = await this.ataFor(from.address)
    const toAta = await this.ataFor(address(to))
    const data = Buffer.concat([Buffer.from([3]), u64le(amount)]) // spl-token Transfer
    return this.backend.send(
      [{ programAddress: SPL_TOKEN_PROGRAM_ID, accounts: [writable(fromAta), writable(toAta), readonlySigner(from)], data: new Uint8Array(data) }],
      from
    )
  }

  async sweepNative(to: string): Promise<TxHash | null> {
    const from = this.requireSigner()
    const acc = await this.backend.getAccount(from.address)
    const fee = 5000n
    if (!acc || acc.lamports <= fee) return null
    const amount = acc.lamports - fee
    const data = Buffer.concat([Buffer.from([2, 0, 0, 0]), u64le(amount)]) // System::Transfer
    return this.backend.send(
      [{ programAddress: SYSTEM_PROGRAM_ID, accounts: [writableSigner(from), writable(address(to))], data: new Uint8Array(data) }],
      from
    )
  }

  async getEscrowBasic(id: EscrowId): Promise<EscrowBasic> {
    const e = await this.decodedEscrow(id)
    return { id: e.id, buyer: e.buyer, seller: e.seller, amount: e.amount, status: e.status }
  }

  async getEscrowStatus(id: EscrowId): Promise<EscrowStatusCode> {
    return (await this.decodedEscrow(id)).status
  }

  async getResultHash(id: EscrowId): Promise<Hash32> {
    return (await this.decodedEscrow(id)).resultHash
  }

  async getEscrowHashes(id: EscrowId): Promise<EscrowHashes> {
    const e = await this.decodedEscrow(id)
    return { taskHash: e.taskHash, resultHash: e.resultHash, disputeReasonHash: e.disputeReasonHash, disputeResponseHash: e.disputeResponseHash, resolutionHash: e.resolutionHash }
  }

  async getEscrowTimestamps(id: EscrowId): Promise<EscrowTimestamps> {
    const e = await this.decodedEscrow(id)
    return { createdAt: e.createdAt, fundedAt: e.fundedAt, executingAt: e.executingAt, deliveredAt: e.deliveredAt, settledAt: e.settledAt }
  }

  async getEscrowWindows(id: EscrowId): Promise<EscrowWindows> {
    const e = await this.decodedEscrow(id)
    return { executionWindow: e.executionWindow, reviewWindow: e.reviewWindow, executionDeadline: e.executionDeadline, reviewDeadline: e.reviewDeadline }
  }

  async getEscrowDisputeInfo(id: EscrowId): Promise<EscrowDisputeInfo> {
    const e = await this.decodedEscrow(id)
    return { disputedAt: e.disputedAt, disputeDeadline: e.disputeDeadline, acceptDeadline: e.acceptDeadline, rated: e.rated }
  }

  async readTimeoutFlag(id: EscrowId, flag: TimeoutFlag): Promise<boolean> {
    const e = await this.decodedEscrow(id)
    const now = (await this.backend.getClock()).unixTimestamp
    switch (flag) {
      case 'acceptTimedOut':
        return e.status === 1 && now > e.acceptDeadline
      case 'executionTimedOut':
        return e.status === 2 && now > e.executionDeadline
      case 'reviewExpired':
        return e.status === 3 && now > e.reviewDeadline
      case 'disputeTimedOut':
        return e.status === 4 && now > e.disputeDeadline
    }
  }

  async getArbiterSetup(_id?: EscrowId): Promise<ArbiterSetup> {
    const config = await this.decodedConfig()
    // No council program this phase (docs/SOLANA.md §6): the configured arbiter is a
    // single pubkey, which may itself be a multisig vault (e.g. Squads) — this adapter
    // cannot distinguish that from a plain wallet without a dedicated council program.
    return { arbiter: config.arbiter, council: null }
  }

  async escrowIds(_opts?: { currentOnly?: boolean }): Promise<EscrowId[]> {
    const config = await this.decodedConfig()
    const ids: EscrowId[] = []
    for (let id = this.firstEscrowId; id < config.nextEscrowId; id++) ids.push(id)
    return ids
  }

  async readEscrowBasics(ids: EscrowId[]): Promise<EscrowBasic[]> {
    return Promise.all(ids.map((id) => this.getEscrowBasic(id)))
  }

  async listEscrows(opts?: { currentOnly?: boolean }): Promise<EscrowBasic[]> {
    return this.readEscrowBasics(await this.escrowIds(opts))
  }

  async getReputation(seller: string): Promise<OnchainReputation> {
    const pda = await reputationPda(this.programId, address(seller))
    const acc = await this.backend.getAccount(pda)
    if (!acc) return { completedJobs: 0, failedJobs: 0, successRatePct: 0, ratingCount: 0, avgRatingScore: null }
    const r = decodeReputation(acc.data)
    const completedJobs = Number(r.completedJobs)
    const failedJobs = Number(r.failedJobs)
    const finished = completedJobs + failedJobs
    const ratingCount = Number(r.ratingCount)
    return {
      completedJobs,
      failedJobs,
      successRatePct: finished === 0 ? 0 : (completedJobs / finished) * 100,
      ratingCount,
      avgRatingScore: ratingCount === 0 ? null : Number(r.ratingSum) / ratingCount,
    }
  }

  async timerLimits(): Promise<TimerLimits> {
    const config = await this.decodedConfig()
    return { minWindow: config.minWindow, maxWindow: 90n * 24n * 60n * 60n, disputeTimeout: config.disputeTimeout }
  }

  async ratingsInTx(_txHash: string): Promise<RatingEvent[]> {
    throw new Error('ratingsInTx is not implemented for Solana yet: the program emits no on-chain events this phase (see docs/SOLANA.md §10)')
  }

  async ratings(_fromBlock: bigint, _toBlock: bigint): Promise<RatingEvent[]> {
    throw new Error('ratings is not implemented for Solana yet: the program emits no on-chain events this phase (see docs/SOLANA.md §10)')
  }
}

export const __internal = { decodeEscrow, decodeConfig, decodeReputation, bytesToAddress, sighash }
