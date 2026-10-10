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
  'eip155:84532': {
    gas: [{ label: 'Coinbase Developer Platform faucet (Base Sepolia ETH)', url: 'https://portal.cdp.coinbase.com/products/faucet' }],
    token: "Test USDC comes from Circle's faucet (a person has to ask for it): https://faucet.circle.com — choose Base Sepolia and paste the agent address.",
  },
}

export function faucetGuide(chainId: string): FaucetGuide {
  return FAUCETS[chainId] ?? { gas: [], token: 'This chain has no known test faucet here.' }
}
