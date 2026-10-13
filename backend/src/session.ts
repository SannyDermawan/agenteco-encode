import { recoverMessageAddress, type Address } from 'viem'
import { parseSiweMessage } from 'viem/siwe'
import { verifySolanaSignature } from '../../agent-runtime/src/chain/solana.ts'
import {
  READ_SESSION_MAX_AGE_MS,
  READ_SESSION_STATEMENT,
  parseSolanaSessionMessage,
  type ReadSessionPayload,
  type SolanaReadSessionPayload,
} from '../../agent-runtime/src/shared/session.ts'
import type { AuthResult } from './auth.ts'

// Clock drift allowed between the signer's browser and this server.
const CLOCK_SKEW_MS = 5 * 60 * 1000
const MAX_HEADER_LENGTH = 4096

export interface SessionRules {
  /** host[:port] values the message's domain must be one of. */
  domains: string[]
  /** The EVM chain(s) a session may be signed for: every EVM chain this backend serves. */
  chainId: number | number[]
  /** The Solana chains (CAIP-2 ids) a Solana session may be signed for: every Solana chain this backend serves. */
  solanaChainIds?: string[]
  now?: number
}

/**
 * Verifies a read session (see agent-runtime/src/shared/session.ts): a SIWE
 * message (or, for a Solana wallet, its CAIP-122 equivalent) for one of our frontend domains and
 * one of our chains, with our statement, not expired, living at most 24 h, and signed by the
 * address it names.
 * Proves who is asking, whether they may see a given order is checked
 * separately (access.ts).
 */
export async function verifyReadSession(headerValue: string, rules: SessionRules): Promise<AuthResult> {
  if (headerValue.length > MAX_HEADER_LENGTH) return { ok: false, error: 'Session header too large' }

  let payload: ReadSessionPayload | SolanaReadSessionPayload
  try {
    payload = JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8')) as ReadSessionPayload | SolanaReadSessionPayload
  } catch {
    return { ok: false, error: 'Malformed session' }
  }
  if (typeof payload?.message !== 'string' || typeof payload?.signature !== 'string') {
    return { ok: false, error: 'Malformed session' }
  }
  if ('family' in payload && payload.family === 'solana') return verifySolanaSession(payload, rules)
  payload = payload as ReadSessionPayload

  const fields = parseSiweMessage(payload.message)
  const now = rules.now ?? Date.now()
  const issuedAt = fields.issuedAt?.getTime()
  const expiresAt = fields.expirationTime?.getTime()

  if (!fields.address || !fields.domain || !fields.uri || fields.version !== '1') return { ok: false, error: 'Malformed session' }
  if (!rules.domains.includes(fields.domain.toLowerCase())) return { ok: false, error: 'Session was signed for another website' }
  const chainIds = Array.isArray(rules.chainId) ? rules.chainId : [rules.chainId]
  if (fields.chainId === undefined || !chainIds.includes(fields.chainId)) return { ok: false, error: 'Session was signed for another chain' }
  if (fields.statement !== READ_SESSION_STATEMENT) return { ok: false, error: 'Unexpected session statement' }
  if (issuedAt === undefined || expiresAt === undefined || Number.isNaN(issuedAt) || Number.isNaN(expiresAt)) {
    return { ok: false, error: 'Session has no issue or expiry time' }
  }
  if (issuedAt > now + CLOCK_SKEW_MS) return { ok: false, error: 'Session is issued in the future' }
  if (expiresAt - issuedAt > READ_SESSION_MAX_AGE_MS + CLOCK_SKEW_MS) return { ok: false, error: 'Session lasts too long' }
  if (expiresAt <= now) return { ok: false, error: 'Session expired, sign in again' }
  if (fields.notBefore && fields.notBefore.getTime() > now + CLOCK_SKEW_MS) return { ok: false, error: 'Session is not valid yet' }

  try {
    const recovered = await recoverMessageAddress({ message: payload.message, signature: payload.signature })
    if (recovered.toLowerCase() !== fields.address.toLowerCase()) return { ok: false, error: 'Session signature does not match its address' }
  } catch {
    return { ok: false, error: 'Malformed session signature' }
  }
  return { ok: true, wallet: fields.address as Address }
}

async function verifySolanaSession(payload: SolanaReadSessionPayload, rules: SessionRules): Promise<AuthResult> {
  const fields = parseSolanaSessionMessage(payload.message)
  if (!fields || fields.uri.length > 200) return { ok: false, error: 'Malformed session' }
  const now = rules.now ?? Date.now()
  const issuedAt = fields.issuedAt.getTime()
  const expiresAt = fields.expirationTime.getTime()

  if (!rules.domains.includes(fields.domain.toLowerCase())) return { ok: false, error: 'Session was signed for another website' }
  if (!rules.solanaChainIds?.includes(fields.chainId)) return { ok: false, error: 'Session was signed for another chain' }
  if (fields.statement !== READ_SESSION_STATEMENT) return { ok: false, error: 'Unexpected session statement' }
  if (issuedAt > now + CLOCK_SKEW_MS) return { ok: false, error: 'Session is issued in the future' }
  if (expiresAt - issuedAt > READ_SESSION_MAX_AGE_MS + CLOCK_SKEW_MS) return { ok: false, error: 'Session lasts too long' }
  if (expiresAt <= now) return { ok: false, error: 'Session expired, sign in again' }

  if (!(await verifySolanaSignature({ address: fields.address, message: payload.message, signature: payload.signature }))) {
    return { ok: false, error: 'Session signature does not match its address' }
  }
  return { ok: true, wallet: fields.address }
}
