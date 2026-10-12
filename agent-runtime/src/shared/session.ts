/**
 * Read sessions: a Sign-In with Ethereum (EIP-4361) message the website signs
 * once, so the API can show a wallet its own orders without a signature
 * prompt on every request. Shared by the frontend (creates it) and the
 * backend (verifies it — backend/src/session.ts).
 */

/** Request header carrying base64(JSON { message, signature }). */
export const READ_SESSION_HEADER = 'x-agenteco-session'

/** Fixed statement — the backend accepts no other, so a sign-in for another app never works here. */
export const READ_SESSION_STATEMENT = 'Sign in to AgentEco to view your own orders. This is free and sends no transaction.'

/** Longest a session may live (issuedAt → expirationTime). */
export const READ_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000

export interface ReadSessionPayload {
  message: string
  signature: `0x${string}`
}

/**
 * The same session for a Solana wallet: wallets sign text, not EIP-4361, so the message follows the
 * CAIP-122 / Sign-In With Solana layout (what wallets already know how to show). The signature is
 * ed25519, base58 as wallets print it, and the payload says which family it is for.
 */
export interface SolanaReadSessionPayload {
  family: 'solana'
  message: string
  signature: string
}

export interface SolanaSessionFields {
  /** host[:port] of the website. */
  domain: string
  /** The wallet, base58. */
  address: string
  /** Fixed: READ_SESSION_STATEMENT. */
  statement: string
  uri: string
  /** CAIP-2 id of the Solana chain the session is for, e.g. `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`. */
  chainId: string
  nonce: string
  issuedAt: Date
  expirationTime: Date
}

/** The text the wallet signs. Parsing it again (parseSolanaSessionMessage) gives exactly these fields. */
export function createSolanaSessionMessage(f: SolanaSessionFields): string {
  return [
    `${f.domain} wants you to sign in with your Solana account:`,
    f.address,
    '',
    f.statement,
    '',
    `URI: ${f.uri}`,
    'Version: 1',
    `Chain ID: ${f.chainId}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt.toISOString()}`,
    `Expiration Time: ${f.expirationTime.toISOString()}`,
  ].join('\n')
}

/**
 * The fields of a Solana session message, or null when it is not exactly what createSolanaSessionMessage
 * writes — a message with anything extra or reordered is refused, so there is one way to say each thing.
 */
export function parseSolanaSessionMessage(text: string): SolanaSessionFields | null {
  const m =
    /^(\S+) wants you to sign in with your Solana account:\n([1-9A-HJ-NP-Za-km-z]{32,44})\n\n(.+)\n\nURI: (\S+)\nVersion: 1\nChain ID: (solana:[1-9A-HJ-NP-Za-km-z]{32})\nNonce: ([A-Za-z0-9]{8,64})\nIssued At: (\S+)\nExpiration Time: (\S+)$/.exec(text)
  if (!m) return null
  const issuedAt = new Date(m[7])
  const expirationTime = new Date(m[8])
  if (Number.isNaN(issuedAt.getTime()) || Number.isNaN(expirationTime.getTime())) return null
  const fields: SolanaSessionFields = { domain: m[1], address: m[2], statement: m[3], uri: m[4], chainId: m[5], nonce: m[6], issuedAt, expirationTime }
  return createSolanaSessionMessage(fields) === text ? fields : null
}
