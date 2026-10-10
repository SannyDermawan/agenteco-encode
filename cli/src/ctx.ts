import { signerChain } from '../../agent-runtime/src/chain/registry.ts'
import { apiUrl as resolveApi, loadConfig, resolveChain, DEFAULT_CHAIN, type Config } from './config.ts'
import type { Io } from './io.ts'
import { Jobs } from './jobs.ts'
import { loadKey } from './keystore.ts'

/** Shared by every command: where things live, the config, and the (lazily loaded) key. */
export class Ctx {
  readonly config: Config
  readonly api: string
  private loaded: ReturnType<typeof loadKey> | null = null
  private jobsInstance: Jobs | null = null

  constructor(
    readonly io: Io,
    readonly keyName = 'default'
  ) {
    this.config = loadConfig(io.home)
    this.api = resolveApi(this.config, io.env)
  }

  /** The key, loaded on first use and registered so it can never be printed. */
  key() {
    if (!this.loaded) {
      this.loaded = loadKey(this.io.home, this.keyName)
      this.io.secrets.add(this.loaded.privateKey)
      // The key without its 0x prefix is as secret as the key.
      this.io.secrets.add(this.loaded.privateKey.slice(2))
    }
    return this.loaded
  }

  chain(flag?: string): string {
    return resolveChain(flag ?? this.config.defaultChain ?? DEFAULT_CHAIN)
  }

  adapter(chainId: string) {
    return signerChain(chainId, this.key().privateKey)
  }

  jobs(): Jobs {
    this.jobsInstance ??= new Jobs({
      home: this.io.home,
      config: this.config,
      privateKey: this.key().privateKey,
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
