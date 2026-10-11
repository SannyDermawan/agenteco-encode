import { chainFamily, readAdapter } from '../../agent-runtime/src/chain/multi.ts'
import { chainConfig } from '../../agent-runtime/src/chain/registry.ts'
import { solanaEntry } from '../../agent-runtime/src/chain/solana-registry.ts'

/** The escrow contract (EVM) or program (Solana) of a chain, with an explorer link to it. Throws for a chain that is not configured. */
export function escrowContract(chainId: string): { address: string; url: string } {
  const address = chainFamily(chainId) === 'solana' ? solanaEntry(chainId).config.programId : chainConfig(chainId).agentEco
  return { address, url: readAdapter(chainId).explorer.addressUrl(address) }
}

/** The settlement token's symbol on a configured chain. */
export function tokenSymbolOn(chainId: string): string {
  return chainFamily(chainId) === 'solana' ? solanaEntry(chainId).config.tokenSymbol : chainConfig(chainId).tokenSymbol
}
