/**
 * Read sessions: a Sign-In with Ethereum (EIP-4361) message the website signs
 * once, so the API can show a wallet its own orders without a signature
 * prompt on every request. Shared by the frontend (creates it) and the
 * backend (verifies it, backend/src/session.ts).
 */

/** Request header carrying base64(JSON { message, signature }). */
export const READ_SESSION_HEADER = 'x-agenteco-session'

/** Fixed statement, the backend accepts no other, so a sign-in for another app never works here. */
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

/**
 * Phantom (and wallets that follow its Sign-In With Solana rules) refuse to show a message whose Chain ID is a full
 * CAIP-2 id ("signature request cannot be shown due to invalid formatting"); they accept the cluster name. The API reads
 * both forms and treats a cluster name as the CAIP-2 id of that cluster.
 */
const CLUSTER_LABELS: Record<string, string> = {
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'mainnet',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'devnet',
}
const CLUSTER_IDS: Record<string, string> = Object.fromEntries(Object.entries(CLUSTER_LABELS).map(([id, label]) => [label, id]))

/** The Chain ID wallets like Phantom accept for a CAIP-2 id: `devnet` or `mainnet`; any other id is returned unchanged. */
export function solanaChainLabel(chainId: string): string {
  return CLUSTER_LABELS[chainId] ?? chainId
}

/**
 * The text the wallet signs. Parsing it again (parseSolanaSessionMessage) gives exactly these fields.
 * `chainId` is written as given: a CAIP-2 id, or the cluster name from solanaChainLabel.
 */
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
 * writes, a message with anything extra or reordered is refused, so there is one way to say each thing.
 * The Chain ID may be a CAIP-2 id or the cluster name `devnet` / `mainnet` (see solanaChainLabel); the returned
 * `chainId` is always the CAIP-2 id.
 */
export function parseSolanaSessionMessage(text: string): SolanaSessionFields | null {
  const m =
    /^(\S+) wants you to sign in with your Solana account:\n([1-9A-HJ-NP-Za-km-z]{32,44})\n\n(.+)\n\nURI: (\S+)\nVersion: 1\nChain ID: (solana:[1-9A-HJ-NP-Za-km-z]{32}|mainnet|devnet)\nNonce: ([A-Za-z0-9]{8,64})\nIssued At: (\S+)\nExpiration Time: (\S+)$/.exec(text)
  if (!m) return null
  const issuedAt = new Date(m[7])
  const expirationTime = new Date(m[8])
  if (Number.isNaN(issuedAt.getTime()) || Number.isNaN(expirationTime.getTime())) return null
  const written = m[5]
  const fields: SolanaSessionFields = { domain: m[1], address: m[2], statement: m[3], uri: m[4], chainId: CLUSTER_IDS[written] ?? written, nonce: m[6], issuedAt, expirationTime }
  // Re-create it exactly as it was written (name or id) so only that one spelling is read.
  return createSolanaSessionMessage({ ...fields, chainId: written }) === text ? fields : null
}
