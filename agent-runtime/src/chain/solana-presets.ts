import { SOLANA_DEVNET_CHAIN_ID } from './solana.ts'
import type { ChainId } from './types.ts'

/**
 * The Solana clusters AgentEco knows, as plain data — shared by ./solana-registry.ts (the process
 * side, which reads the environment) and the website (which imports this file into the browser,
 * so it must stay free of Node APIs).
 */

export interface SolanaPreset {
  name: string
  aliases: string[]
  chainId: ChainId
  rpcUrl: string
  tokenSymbol: string
  defaultMint: string
  nativeSymbol: string
  explorerUrl: string
  explorerName: string
  explorerQuery: string
  testnet: boolean
}

export const SOLANA_PRESETS: Record<string, SolanaPreset> = {
  'solana-devnet': {
    name: 'Solana Devnet',
    aliases: ['solana', 'devnet-solana'],
    chainId: SOLANA_DEVNET_CHAIN_ID,
    rpcUrl: 'https://api.devnet.solana.com',
    tokenSymbol: 'USDC',
    // Circle's devnet USDC: an SPL Token mint with 6 decimals (checked on devnet, 11 Oct 2026).
    defaultMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    nativeSymbol: 'SOL',
    explorerUrl: 'https://explorer.solana.com',
    explorerName: 'Solana Explorer',
    explorerQuery: '?cluster=devnet',
    testnet: true,
  },
}
