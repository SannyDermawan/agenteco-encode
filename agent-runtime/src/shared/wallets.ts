/**
 * Wallet addresses of every chain family, as the API and the database store them.
 *
 * EVM addresses are hex and case-insensitive: stored lowercase. Solana addresses are base58 and
 * CASE-SENSITIVE: stored exactly as given, lowercasing one corrupts it. The two forms cannot be
 * confused (a base58 string has no `0`, and no `0x` prefix), so the family follows from the text.
 * Format only: whether a Solana string is really a 32-byte key is the adapter's check.
 */

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export type WalletFamily = 'evm' | 'solana'

export const isEvmWallet = (value: string): boolean => EVM_ADDRESS.test(value)
export const isSolanaWallet = (value: string): boolean => SOLANA_ADDRESS.test(value)
export const isWalletAddress = (value: string): boolean => isEvmWallet(value) || isSolanaWallet(value)

export function walletFamily(value: string): WalletFamily | null {
  return isEvmWallet(value) ? 'evm' : isSolanaWallet(value) ? 'solana' : null
}

/** The stored form: lowercase for EVM, untouched for Solana (and for anything that is not a wallet address). */
export function normalizeWallet(value: string): string {
  return isEvmWallet(value) ? value.toLowerCase() : value
}

/** Whether two wallet strings name the same wallet, by the rules of their family. */
export function sameWallet(a: string, b: string): boolean {
  return normalizeWallet(a) === normalizeWallet(b)
}
