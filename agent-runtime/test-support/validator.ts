/**
 * A real `solana-test-validator` for tests (opt-in: set SOLANA_LOCAL_VALIDATOR=1). Unlike litesvm it
 * has a real RPC, real transaction confirmation and a real clock, so it is what exercises
 * SolanaRpcBackend. Windows are short (the clock cannot be warped: tests wait).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AccountRole,
  address,
  createSolanaRpc,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  lamports,
  type AccountSignerMeta,
  type Address,
  type KeyPairSigner,
} from '@solana/kit'
import { SPL_TOKEN_PROGRAM_ID, SOLANA_DEVNET_CHAIN_ID, SolanaAdapter, buildInitializeInstruction } from '../src/chain/solana.ts'
import { generateSolanaSecretKey } from '../src/chain/solana-keys.ts'
import { SolanaRpcBackend } from '../src/chain/solana-rpc.ts'
import { PROGRAM_SO, TEST_PROGRAM_ID } from './litesvm.ts'

const SYSTEM_PROGRAM_ID = address('11111111111111111111111111111111')
const ATA_PROGRAM_ID = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')

export const VALIDATOR_TIMERS = { minWindow: 10, acceptTimeout: 30, disputeTimeout: 30, executionWindow: 30, reviewWindow: 30 }

export function localValidatorUnavailable(): string | null {
  if (process.env.SOLANA_LOCAL_VALIDATOR !== '1') return 'opt-in: set SOLANA_LOCAL_VALIDATOR=1 (needs solana-test-validator; takes about 3 minutes)'
  if (spawnSync('solana-test-validator', ['--version']).error) return 'solana-test-validator is not installed'
  if (!existsSync(PROGRAM_SO)) return 'missing solana/target/deploy/agenteco_escrow.so — run `cargo build-sbf --arch v3` in solana/programs/agenteco_escrow'
  return null
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

const addressEncoder = getAddressEncoder()
const bytes = (a: Address) => new Uint8Array(addressEncoder.encode(a))
const le = (n: bigint, size: number) => {
  const b = Buffer.alloc(size)
  b.writeBigUInt64LE(n)
  return b
}

export interface ValidatorChain {
  rpcUrl: string
  backend: SolanaRpcBackend
  programId: Address
  mint: Address
  decimals: number
  signers: Record<'deployer' | 'arbiter' | 'buyer' | 'seller' | 'keeper' | 'other', KeyPairSigner>
  /** The same wallets' secret keys (64 bytes), for code that takes a key — the SDK and the CLI. */
  secretKeys: Record<'deployer' | 'arbiter' | 'buyer' | 'seller' | 'keeper' | 'other', Uint8Array>
  treasury: KeyPairSigner
  adapterFor(role: keyof ValidatorChain['signers'], overrides?: Partial<ConstructorParameters<typeof SolanaAdapter>[0]>): SolanaAdapter
  mintTo(owner: Address, amount: bigint): Promise<void>
  stop(): void
}

export async function startLocalValidatorChain(feeBps = 250): Promise<ValidatorChain> {
  const reason = localValidatorUnavailable()
  if (reason) throw new Error(reason)
  const [rpcPort, faucetPort] = [await freePort(), await freePort()]
  const ledger = mkdtempSync(join(tmpdir(), 'agenteco-validator-'))
  const rpcUrl = `http://127.0.0.1:${rpcPort}`
  const proc: ChildProcess = spawn(
    'solana-test-validator',
    ['--reset', '--quiet', '--ledger', ledger, '--rpc-port', String(rpcPort), '--faucet-port', String(faucetPort), '--bind-address', '127.0.0.1', '--bpf-program', TEST_PROGRAM_ID, PROGRAM_SO],
    { stdio: 'ignore' }
  )
  const stop = () => {
    if (!proc.killed) proc.kill()
    rmSync(ledger, { recursive: true, force: true })
  }
  try {
    const rpc = createSolanaRpc(rpcUrl)
    for (let i = 0; ; i++) {
      try {
        await rpc.getHealth().send()
        break
      } catch {
        if (i > 300) throw new Error('solana-test-validator did not start')
        await new Promise((r) => setTimeout(r, 200))
      }
    }

    const roles = ['deployer', 'arbiter', 'buyer', 'seller', 'keeper', 'other'] as const
    const secrets = await Promise.all([...roles, 'treasury' as const, 'mint' as const].map(() => generateSolanaSecretKey()))
    const generated = await Promise.all(secrets.map((secret) => createKeyPairSignerFromBytes(secret)))
    const signers = Object.fromEntries(roles.map((r, i) => [r, generated[i]])) as ValidatorChain['signers']
    const secretKeys = Object.fromEntries(roles.map((r, i) => [r, secrets[i]])) as ValidatorChain['secretKeys']
    const treasury = generated[roles.length]
    const mintSigner = generated[roles.length + 1]
    for (const s of [...Object.values(signers), treasury]) {
      await rpc.requestAirdrop(s.address, lamports(100_000_000_000n), { commitment: 'confirmed' }).send()
    }
    for (let i = 0; i < 100; i++) {
      const balances = await Promise.all(Object.values(signers).map((s) => rpc.getBalance(s.address, { commitment: 'confirmed' }).send()))
      if (balances.every((b) => b.value > 0n)) break
      await new Promise((r) => setTimeout(r, 200))
    }

    const backend = new SolanaRpcBackend(rpcUrl)
    const decimals = 6
    const mint = mintSigner.address
    const rent = await rpc.getMinimumBalanceForRentExemption(82n).send()
    const payer: AccountSignerMeta = { address: signers.deployer.address, role: AccountRole.WRITABLE_SIGNER, signer: signers.deployer }
    const newMint: AccountSignerMeta = { address: mint, role: AccountRole.WRITABLE_SIGNER, signer: mintSigner }
    await backend.send(
      [
        {
          programAddress: SYSTEM_PROGRAM_ID, // CreateAccount
          accounts: [payer, newMint],
          data: new Uint8Array(Buffer.concat([Buffer.from([0, 0, 0, 0]), le(BigInt(rent), 8), le(82n, 8), bytes(SPL_TOKEN_PROGRAM_ID)])),
        },
        {
          programAddress: SPL_TOKEN_PROGRAM_ID, // InitializeMint2: decimals, mint authority, no freeze authority
          accounts: [{ address: mint, role: AccountRole.WRITABLE }],
          data: new Uint8Array(Buffer.concat([Buffer.from([20, decimals]), bytes(signers.deployer.address), Buffer.from([0])])),
        },
      ],
      signers.deployer
    )

    const config = {
      chainId: SOLANA_DEVNET_CHAIN_ID,
      programId: TEST_PROGRAM_ID,
      mint,
      tokenSymbol: 'TST',
      nativeSymbol: 'SOL',
      explorerUrl: 'https://explorer.solana.com',
      explorerName: 'Solana Explorer',
      executionWindow: BigInt(VALIDATOR_TIMERS.executionWindow),
      reviewWindow: BigInt(VALIDATOR_TIMERS.reviewWindow),
      firstEscrowId: BigInt(1),
    }
    const adapterFor: ValidatorChain['adapterFor'] = (role, overrides) => new SolanaAdapter({ ...config, ...overrides }, backend, signers[role])
    const ataOf = async (owner: Address) =>
      (await getProgramDerivedAddress({ programAddress: ATA_PROGRAM_ID, seeds: [bytes(owner), bytes(SPL_TOKEN_PROGRAM_ID), bytes(mint)] }))[0]

    // Every party's token account, created through the adapter's own helper, paid by the deployer.
    const deployer = adapterFor('deployer')
    for (const owner of [...Object.values(signers), treasury]) await deployer.ensureTokenAccount(owner.address)

    await backend.send(
      [
        await buildInitializeInstruction({
          programId: TEST_PROGRAM_ID,
          admin: signers.deployer,
          arbiter: signers.arbiter.address,
          treasury: treasury.address,
          mint,
          feeBps,
          minWindow: BigInt(VALIDATOR_TIMERS.minWindow),
          acceptTimeout: BigInt(VALIDATOR_TIMERS.acceptTimeout),
          disputeTimeout: BigInt(VALIDATOR_TIMERS.disputeTimeout),
          firstEscrowId: 1n,
        }),
      ],
      signers.deployer
    )

    return {
      rpcUrl,
      backend,
      programId: TEST_PROGRAM_ID,
      mint,
      decimals,
      signers,
      secretKeys,
      treasury,
      adapterFor,
      async mintTo(owner, amount) {
        const authority: AccountSignerMeta = { address: signers.deployer.address, role: AccountRole.READONLY_SIGNER, signer: signers.deployer }
        await backend.send(
          [
            {
              programAddress: SPL_TOKEN_PROGRAM_ID, // MintTo
              accounts: [
                { address: mint, role: AccountRole.WRITABLE },
                { address: await ataOf(owner), role: AccountRole.WRITABLE },
                authority,
              ],
              data: new Uint8Array(Buffer.concat([Buffer.from([7]), le(amount, 8)])),
            },
          ],
          signers.deployer
        )
      },
      stop,
    }
  } catch (error) {
    stop()
    throw error
  }
}
