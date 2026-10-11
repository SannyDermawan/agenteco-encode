import { createPublicClient, createWalletClient, http, nonceManager } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { appChain } from './chain.ts'
import { RPC_URL, appTransport } from './network.ts'
import type { KeeperConfig } from './config.ts'

export function createClients(config: KeeperConfig) {
  if (!config.keeperPrivateKey) throw new Error('KEEPER_PRIVATE_KEY is required for the EVM keeper clients')
  // Local nonce tracking: public RPCs can lag on the pending nonce.
  const account = privateKeyToAccount(config.keeperPrivateKey, { nonceManager })
  // The configured RPC with its fallbacks, unless a different one was given.
  const transport = config.rpcUrl === RPC_URL ? appTransport() : http(config.rpcUrl)

  const publicClient = createPublicClient({ chain: appChain, transport })
  const walletClient = createWalletClient({ account, chain: appChain, transport })

  return { account, publicClient, walletClient }
}

export type Clients = ReturnType<typeof createClients>
