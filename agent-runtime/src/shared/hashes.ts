import { keccak256, toHex, type Hex } from 'viem'
import { normalizeWallet } from './wallets.ts'

/**
 * Hash conventions shared by the backend, the frontend and standalone agents
 * (spec §5). Long texts live off-chain; only these hashes go on-chain, so
 * anyone can recompute a hash from the text the API returns and compare.
 *
 * Every hash is keccak256 over the UTF-8 bytes of a *preimage string*. Store
 * and serve that exact string: Postgres jsonb reorders object keys, so
 * re-stringifying a stored JSON object would not reproduce the hash.
 */

/** keccak256 of a preimage string's UTF-8 bytes. */
export function hashPreimage(preimage: string): Hex {
  return keccak256(toHex(preimage))
}

/**
 * Returns `value` with every object's keys sorted, recursively, so the same
 * data always serializes to the same string regardless of how it was built.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = canonicalize(v)
    }
    return out
  }
  return value
}

/** "0.250" → "0.25", "1.0" → "1", "001.5" → "1.5". Throws on anything that is not a plain decimal. */
export function normalizePrice(price: string | number): string {
  const raw = typeof price === 'number' ? price.toString() : price.trim()
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(`Price must be a plain decimal string, got: ${raw}`)
  const [int, frac = ''] = raw.split('.')
  const intPart = int.replace(/^0+(?=\d)/, '')
  const fracPart = frac.replace(/0+$/, '')
  return fracPart ? `${intPart}.${fracPart}` : intPart
}

// -------------------------------------------------------------------------
// taskHash, committed by createEscrow
// -------------------------------------------------------------------------

export interface TaskPreimageInput {
  capability: string
  /** Capability-specific brief object (see ./capabilities). Keys are canonicalized. */
  brief: unknown
  /** Acceptance criteria; empty string when not given. */
  criteria?: string | null
  /** Agreed price as a decimal string, e.g. "0.25". */
  price: string | number
  buyer: string
  seller: string
  /** Random UUID so two identical tasks never share a hash. */
  nonce: string
}

/** The exact JSON string whose hash is the escrow's taskHash. Key order is fixed. */
export function buildTaskPreimage(input: TaskPreimageInput): string {
  return JSON.stringify({
    v: 1,
    capability: input.capability,
    brief: canonicalize(input.brief),
    criteria: input.criteria ?? '',
    price: normalizePrice(input.price),
    buyer: normalizeWallet(input.buyer),
    seller: normalizeWallet(input.seller),
    nonce: input.nonce,
  })
}

export function taskHash(input: TaskPreimageInput): Hex {
  return hashPreimage(buildTaskPreimage(input))
}

// -------------------------------------------------------------------------
// resultHash, committed by markDelivered (unchanged convention)
// -------------------------------------------------------------------------

/** The exact JSON string whose hash is the escrow's resultHash. */
export function buildResultPreimage(result: unknown): string {
  return JSON.stringify(result)
}

export function resultHash(result: unknown): Hex {
  return hashPreimage(buildResultPreimage(result))
}

// -------------------------------------------------------------------------
// reasonHash / responseHash, raw dispute texts
// -------------------------------------------------------------------------

/** Hash of a raw text (buyer's dispute reason, seller's response). */
export function textHash(text: string): Hex {
  return hashPreimage(text)
}

// -------------------------------------------------------------------------
// rationaleHash, committed by resolveDisputeFor*
// -------------------------------------------------------------------------

export type ArbiterVerdict = 'seller' | 'buyer'
export type DecidedBy = 'ai-auto' | 'arbiter-manual'

export interface RationaleInput {
  verdict: ArbiterVerdict
  /** 0..100 */
  confidence: number
  rationale: string
  decidedBy: DecidedBy
}

/** The exact JSON string whose hash is the escrow's resolutionHash. Key order is fixed. */
export function buildRationalePreimage(input: RationaleInput): string {
  return JSON.stringify({
    v: 1,
    verdict: input.verdict,
    confidence: input.confidence,
    rationale: input.rationale,
    decidedBy: input.decidedBy,
  })
}

export function rationaleHash(input: RationaleInput): Hex {
  return hashPreimage(buildRationalePreimage(input))
}
