import { solanaUnavailable, startSolanaTestChain, type SolanaTestChain } from '../../agent-runtime/test-support/litesvm.ts'
import { localValidatorUnavailable, startLocalValidatorChain, VALIDATOR_TIMERS } from '../../agent-runtime/test-support/validator.ts'

/**
 * The Solana chain the API suites run against: the escrow program in litesvm (default), or on a real
 * solana-test-validator (SOLANA_LOCAL_VALIDATOR=1, ~2 min), where the API reaches it through
 * SolanaRpcBackend exactly as in production.
 */
export const useValidator = process.env.SOLANA_LOCAL_VALIDATOR === '1'
export const solanaSkip = (useValidator ? localValidatorUnavailable() : solanaUnavailable()) ?? false

/** What the tests need of a chain, whichever kind it is. */
export interface Rig {
  signers: SolanaTestChain['signers']
  /** The same wallets' secret keys, for the SDK and the CLI, which take keys rather than signers. */
  secretKeys: SolanaTestChain['secretKeys']
  programId: string
  mint: string
  /** Seconds a funded escrow waits for its seller before it can be refunded. */
  acceptTimeout: number
  mintTo(owner: string, amount: bigint): Promise<void>
  advance(seconds: number): Promise<void>
  /** Make the API's registry serve this chain (the settings an operator would set, or an in-process backend). */
  configureApi(registry: typeof import('../../agent-runtime/src/chain/solana-registry.ts')): void
  stop(): void
}

export async function startRig(): Promise<Rig> {
  if (useValidator) {
    const v = await startLocalValidatorChain(250)
    const suffix = SOL.replace(/[^A-Za-z0-9]/g, '_')
    return {
      signers: v.signers,
      secretKeys: v.secretKeys,
      programId: v.programId,
      mint: v.mint,
      acceptTimeout: VALIDATOR_TIMERS.acceptTimeout,
      mintTo: (owner, amount) => v.mintTo(owner as never, amount),
      advance: (seconds) => new Promise((resolve) => setTimeout(resolve, (seconds + 1) * 1000)),
      configureApi: () => {
        Object.assign(process.env, {
          [`RPC_URL__${suffix}`]: v.rpcUrl,
          [`AGENT_ECO_PROGRAM__${suffix}`]: v.programId,
          [`TOKEN_MINT__${suffix}`]: v.mint,
        })
      },
      stop: v.stop,
    }
  }
  const c = await startSolanaTestChain({ feeBps: 250 })
  return {
    signers: c.signers,
    secretKeys: c.secretKeys,
    programId: c.programId,
    mint: c.mint,
    acceptTimeout: 120,
    mintTo: (owner, amount) => c.mintTo(owner as never, amount),
    advance: (seconds) => c.advance(seconds),
    // The in-process chain stands in for the cluster: the config a preset would build, a litesvm backend.
    configureApi: (registry) =>
      registry.registerSolanaChain({
        config: {
          chainId: SOL,
          programId: c.programId,
          mint: c.mint,
          tokenSymbol: 'USDC',
          nativeSymbol: 'SOL',
          explorerUrl: 'https://explorer.solana.com',
          explorerName: 'Solana Explorer',
          explorerQuery: '?cluster=devnet',
          executionWindow: BigInt(300),
          reviewWindow: BigInt(600),
          firstEscrowId: BigInt(1),
        },
        rpcUrl: 'memory://litesvm',
        testnet: true,
        name: 'Solana Devnet (test)',
        backend: c.backend,
      }),
    stop: () => {},
  }
}

export const SOL = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
