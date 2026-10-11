import { openWallet } from '../../agent-runtime/src/sdk/wallet.ts'
import { chainFamily, servedChainIds } from '../../agent-runtime/src/chain/multi.ts'
import { SOLANA_PRESETS } from '../../agent-runtime/src/chain/solana-registry.ts'
import type { ChainAdapter } from '../../agent-runtime/src/chain/types.ts'
import { apiUrl as resolveApi, loadConfig, resolveChain, DEFAULT_CHAIN, type Config } from './config.ts'
import type { Io } from './io.ts'
import { Jobs } from './jobs.ts'
import { hasKey, loadKey, type AgentKey, type EvmKey, type KeyFamily, type SolanaKey } from './keystore.ts'

/** Shared by every command: where things live, the config, and the (lazily loaded) keys. */
export class Ctx {
  readonly config: Config
  readonly api: string
  private readonly loaded = new Map<KeyFamily, AgentKey>()
  private jobsInstance: Jobs | null = null

  constructor(
    readonly io: Io,
    readonly keyName = 'default'
  ) {
    this.config = loadConfig(io.home)
    this.api = resolveApi(this.config, io.env)
  }

  /** The key of a chain family (EVM unless asked), loaded on first use and registered so it can never be printed. */
  key(): EvmKey
  key(family: 'solana'): SolanaKey
  key(family?: KeyFamily): AgentKey
  key(family: KeyFamily = 'evm'): AgentKey {
    let key = this.loaded.get(family)
    if (!key) {
      key = loadKey(this.io.home, this.keyName, family)
      for (const secret of key.secrets) this.io.secrets.add(secret)
      this.loaded.set(family, key)
    }
    return key
  }

  /** The key to use on a chain: the one of the chain's family. */
  keyFor(chainId: string): AgentKey {
    return this.key(chainFamily(chainId))
  }

  /**
   * The chains worth showing balances for: the ones this process serves (the primary EVM chain unless
   * CHAINS says more), plus Solana's preset chains when the agent has a Solana key.
   */
  knownChains(): string[] {
    const ids = [...servedChainIds(), ...Object.values(SOLANA_PRESETS).map((p) => p.chainId)]
    return [...new Set(ids)].filter((id) => hasKey(this.io.home, this.keyName, chainFamily(id)))
  }

  chain(flag?: string): string {
    return resolveChain(flag ?? this.config.defaultChain ?? DEFAULT_CHAIN)
  }

  /** An adapter on `chainId` that signs with this agent's key for that chain. */
  async adapter(chainId: string): Promise<ChainAdapter> {
    return (await openWallet(chainId, this.keyFor(chainId).privateKey)).adapter
  }

  jobs(): Jobs {
    this.jobsInstance ??= new Jobs({
      home: this.io.home,
      config: this.config,
      keyFor: (chainId) => this.keyFor(chainId).privateKey,
      apiUrl: this.api,
      pollMs: Number(this.io.env.AGENTECO_POLL_MS) || undefined,
      log: (m) => this.io.err(`[agenteco] ${m}`),
    })
    return this.jobsInstance
  }
}

/** A message the person should read, with the exit code the process ends on. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code = 1
  ) {
    super(message)
  }
}
