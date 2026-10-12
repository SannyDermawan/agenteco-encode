import { defineChain } from 'viem'
import { CHAIN_ID, EVM_NETWORK, MULTICALL3, RPC_URL } from './network'

/** The EVM chain this build targets (the selected network, or the primary EVM one while a Solana network is selected; see ./network.ts). */
export const appChain = defineChain({
  id: CHAIN_ID,
  name: EVM_NETWORK.chainName,
  nativeCurrency: { name: EVM_NETWORK.nativeSymbol, symbol: EVM_NETWORK.nativeSymbol, decimals: 18 },
  rpcUrls: {
    default: { http: [RPC_URL] },
  },
  blockExplorers: {
    default: { name: EVM_NETWORK.explorerName, url: EVM_NETWORK.explorerUrl },
  },
  contracts: MULTICALL3 ? { multicall3: { address: MULTICALL3 } } : undefined,
  testnet: EVM_NETWORK.isTestnet,
})
