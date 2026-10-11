/**
 * A throwaway Solana "chain" for tests: the compiled agenteco_escrow program running in litesvm
 * (in-process, no validator), with the same cast as the anvil harness (deployer, arbiter, buyer,
 * seller, keeper, treasury) and the same escrow settings (min window 120 s, accept timeout 120 s,
 * dispute timeout 900 s, fee 2.5%).
 *
 * The program must be built first: `cd solana/programs/agenteco_escrow && cargo build-sbf --arch v3`
 * (v0 runs too). See docs/SOLANA.md §6.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner,
} from '@solana/kit'
import { FailedTransactionMetadata, LiteSVM } from 'litesvm'
import { SPL_TOKEN_PROGRAM_ID, buildInitializeInstruction, type SolanaBackend } from '../src/chain/solana.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROGRAM_SO = join(HERE, '../../solana/target/deploy/agenteco_escrow.so')
const LIB_RS = join(HERE, '../../solana/programs/agenteco_escrow/src/lib.rs')
/** The id the program was compiled with: its `declare_id!`, so another program keypair needs no change here. */
export const TEST_PROGRAM_ID = address(/declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/.exec(readFileSync(LIB_RS, 'utf8'))![1])
const ATA_PROGRAM_ID = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const START_TIME = 1_700_000_000n

/** Why the Solana tests cannot run here, or null when they can. */
export function solanaUnavailable(): string | null {
  if (!existsSync(PROGRAM_SO)) return 'missing solana/target/deploy/agenteco_escrow.so — run `cargo build-sbf --arch v3` in solana/programs/agenteco_escrow'
  return null
}

/** litesvm behind the SolanaBackend interface: accounts and the clock are read in-process, writes go through sendTransaction. */
export class LiteSvmBackend implements SolanaBackend {
  constructor(readonly svm: LiteSVM) {}

  async getAccount(addr: Address) {
    const account = this.svm.getAccount(addr)
    return account.exists ? { data: new Uint8Array(account.data), lamports: BigInt(account.lamports), owner: account.programAddress } : null
  }

  async getClock() {
    const clock = this.svm.getClock()
    return { slot: clock.slot, unixTimestamp: clock.unixTimestamp }
  }

  async send(instructions: Instruction[], feePayer: TransactionSigner) {
    const transaction = await pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(feePayer, tx),
      (tx) => this.svm.setTransactionMessageLifetimeUsingLatestBlockhash(tx),
      (tx) => appendTransactionMessageInstructions(instructions, tx),
      (tx) => signTransactionMessageWithSigners(tx)
    )
    const result = this.svm.sendTransaction(transaction)
    // litesvm has no blocks: a new blockhash keeps two identical transactions from being "already processed".
    this.svm.expireBlockhash()
    if (result instanceof FailedTransactionMetadata) {
      throw new Error(`transaction failed: ${result.err()}\n${result.meta().logs().join('\n')}`)
    }
    return getSignatureFromTransaction(transaction)
  }
}

export interface SolanaTestChain {
  svm: LiteSVM
  backend: LiteSvmBackend
  programId: Address
  mint: Address
  decimals: number
  signers: Record<'deployer' | 'arbiter' | 'buyer' | 'seller' | 'keeper' | 'other', KeyPairSigner>
  /** The wallet that owns the treasury token account (fees are paid to its token account). */
  treasury: KeyPairSigner
  /** The settlement token's associated account of `owner`, created (empty) if it does not exist yet. */
  tokenAccountOf(owner: Address): Promise<Address>
  /** Move the clock forward. */
  advance(seconds: number): Promise<void>
  /** Mint settlement tokens (base units) to an owner. */
  mintTo(owner: Address, amount: bigint): Promise<void>
}

const addressEncoder = getAddressEncoder()
const bytes = (addr: Address) => new Uint8Array(addressEncoder.encode(addr))



/** The 82-byte SPL Token mint layout. */
function mintData(authority: Address, decimals: number): Uint8Array {
  const b = Buffer.alloc(82)
  b.writeUInt32LE(1, 0) // mint_authority: Some
  Buffer.from(bytes(authority)).copy(b, 4)
  b.writeBigUInt64LE(0n, 36) // supply (cosmetic for these tests)
  b.writeUInt8(decimals, 44)
  b.writeUInt8(1, 45) // is_initialized
  return new Uint8Array(b)
}

/** The 165-byte SPL Token account layout. */
function tokenAccountData(mint: Address, owner: Address, amount: bigint): Uint8Array {
  const b = Buffer.alloc(165)
  Buffer.from(bytes(mint)).copy(b, 0)
  Buffer.from(bytes(owner)).copy(b, 32)
  b.writeBigUInt64LE(amount, 64)
  b.writeUInt8(1, 108) // state: Initialized
  return new Uint8Array(b)
}

export async function startSolanaTestChain(opts: { decimals?: number; feeBps?: number } = {}): Promise<SolanaTestChain> {
  const reason = solanaUnavailable()
  if (reason) throw new Error(reason)
  const decimals = opts.decimals ?? 6 // USDC-like
  const svm = new LiteSVM()
  svm.addProgramFromFile(TEST_PROGRAM_ID, PROGRAM_SO)

  // litesvm starts at unix time 0; the program (like AgentEco.sol) reads 0 as "never happened".
  const clock = svm.getClock()
  clock.unixTimestamp = START_TIME
  svm.setClock(clock)

  const roles = ['deployer', 'arbiter', 'buyer', 'seller', 'keeper', 'other'] as const
  const generated = await Promise.all([...roles, 'treasury' as const].map(() => generateKeyPairSigner()))
  const signers = Object.fromEntries(roles.map((r, i) => [r, generated[i]])) as SolanaTestChain['signers']
  const treasury = generated[roles.length]
  for (const s of [...Object.values(signers), treasury]) svm.airdrop(s.address, lamports(100_000_000_000n))

  const mint = (await generateKeyPairSigner()).address
  svm.setAccount({
    address: mint,
    data: mintData(signers.deployer.address, decimals),
    executable: false,
    lamports: lamports(svm.minimumBalanceForRentExemption(82n)),
    programAddress: SPL_TOKEN_PROGRAM_ID,
    space: 82n,
  })

  const ataOf = async (owner: Address) =>
    (await getProgramDerivedAddress({ programAddress: ATA_PROGRAM_ID, seeds: [bytes(owner), bytes(SPL_TOKEN_PROGRAM_ID), bytes(mint)] }))[0]

  const putTokenAccount = (account: Address, owner: Address, amount: bigint) =>
    svm.setAccount({
      address: account,
      data: tokenAccountData(mint, owner, amount),
      executable: false,
      lamports: lamports(svm.minimumBalanceForRentExemption(165n)),
      programAddress: SPL_TOKEN_PROGRAM_ID,
      space: 165n,
    })

  const backend = new LiteSvmBackend(svm)
  const chain: SolanaTestChain = {
    svm,
    backend,
    programId: TEST_PROGRAM_ID,
    mint,
    decimals,
    signers,
    treasury,
    async tokenAccountOf(owner) {
      const account = await ataOf(owner)
      if (!svm.getAccount(account).exists) putTokenAccount(account, owner, 0n)
      return account
    },
    async advance(seconds) {
      const c = svm.getClock()
      c.unixTimestamp += BigInt(seconds)
      c.slot += 1n
      svm.setClock(c)
      svm.expireBlockhash()
    },
    async mintTo(owner, amount) {
      const account = await chain.tokenAccountOf(owner)
      const existing = svm.getAccount(account)
      if (!existing.exists) throw new Error('token account missing')
      putTokenAccount(account, owner, Buffer.from(existing.data).readBigUInt64LE(64) + amount)
    },
  }

  // The same token accounts a real deployment would have: every party's, and the treasury's.
  for (const s of [...Object.values(signers), treasury]) await chain.tokenAccountOf(s.address)

  await backend.send(
    [
      await buildInitializeInstruction({
        programId: TEST_PROGRAM_ID,
        admin: signers.deployer,
        arbiter: signers.arbiter.address,
        treasury: treasury.address,
        mint,
        feeBps: opts.feeBps ?? 250,
        minWindow: 120n,
        acceptTimeout: 120n,
        disputeTimeout: 900n,
        firstEscrowId: 1n,
      }),
    ],
    signers.deployer
  )

  return chain
}
