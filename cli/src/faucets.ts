import { SOLANA_DEVNET_CHAIN_ID } from '../../agent-runtime/src/chain/solana.ts'

/**
 * Where a person gets test funds on each chain. Manual links only: these faucets need a human
 * (captchas, social checks), and nothing here tries to get around that. Mirrors the app's presets
 * (frontend/lib/web3/network.ts).
 */
export interface FaucetGuide {
  /** Native gas (needed before anything else can be sent). */
  gas: { label: string; url: string }[]
  /** How to get the settlement token. */
  token: string
}

export const FAUCETS: Record<string, FaucetGuide> = {
  'eip155:97': {
    gas: [
      { label: 'QuickNode BNB testnet faucet', url: 'https://faucet.quicknode.com/binance-smart-chain/bnb-testnet' },
      { label: 'BNB Chain Telegram bot', url: 'https://t.me/bnbchain_official_bot' },
    ],
    token: 'mUSDT is AgentEco\'s own test token: once the wallet has a little tBNB, run `agenteco faucet` (100 mUSDT, once a day).',
  },
  [SOLANA_DEVNET_CHAIN_ID]: {
    gas: [{ label: 'Solana faucet (devnet SOL)', url: 'https://faucet.solana.com' }],
    token: "Devnet USDC comes from Circle's faucet (a person has to ask for it): https://faucet.circle.com — choose Solana Devnet and paste the agent address.",
  },
  'eip155:11155111': {
    gas: [{ label: 'Google Cloud Web3 faucet (Sepolia ETH)', url: 'https://cloud.google.com/application/web3/faucet/ethereum/sepolia' }],
    token: "Test USDC comes from Circle's faucet (a person has to ask for it): https://faucet.circle.com — choose Ethereum Sepolia and paste the agent address.",
  },
  'eip155:421614': {
    gas: [{ label: 'Arbitrum faucets and the Ethereum Sepolia bridge', url: 'https://docs.arbitrum.io/build-decentralized-apps/reference/node-providers#faucets' }],
    token: "Test USDC comes from Circle's faucet (a person has to ask for it): https://faucet.circle.com — choose Arbitrum Sepolia and paste the agent address.",
  },
  'eip155:42431': {
    gas: [],
    token: 'Tempo has no gas token: fees are paid in a stablecoin. Fund the agent address with `cast rpc tempo_fundAddress <address> --rpc-url https://rpc.moderato.tempo.xyz` or https://tempo.xyz/developers/docs/quickstart/faucet (pathUSD, AlphaUSD, BetaUSD, ThetaUSD). The settlement token is AlphaUSD; keep fees out of it by setting the account fee token to pathUSD (docs/MULTICHAIN.md).',
  },
  'eip155:84532': {
    gas: [{ label: 'Coinbase Developer Platform faucet (Base Sepolia ETH)', url: 'https://portal.cdp.coinbase.com/products/faucet' }],
    token: "Test USDC comes from Circle's faucet (a person has to ask for it): https://faucet.circle.com — choose Base Sepolia and paste the agent address.",
  },
}

export function faucetGuide(chainId: string): FaucetGuide {
  return FAUCETS[chainId] ?? { gas: [], token: 'This chain has no known test faucet here.' }
}
