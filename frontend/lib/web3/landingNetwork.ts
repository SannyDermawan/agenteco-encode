import { AVAILABLE_NETWORKS } from './network'

/**
 * The landing page always describes the default network: it is rendered on the server,
 * where a visitor's own network choice (remembered in their browser, see ./network.ts)
 * is unknown, so using it here would make the server and browser renders disagree.
 */
const landing = AVAILABLE_NETWORKS[0]

export const TOKEN_SYMBOL = landing.tokenSymbol
export const AGENT_ECO_ADDRESS = landing.agentEcoAddress
export const EXPLORER_NAME = landing.explorerName

export function explorerAddressUrl(address: string): string {
  return `${landing.explorerUrl}/address/${address}`
}
