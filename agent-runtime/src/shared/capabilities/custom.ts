import { z } from 'zod'
import { CAPABILITIES, CAPABILITY_IDS, isCapabilityId, type CapabilityId } from './definitions.ts'

/**
 * The open capability registry: besides the four platform capabilities
 * (./definitions.ts), developers publish their own, an id, what it does, a
 * JSON Schema for the buyer's brief and one for the result, and the rubric a
 * verifier judges a delivery by. Self-hosted sellers (the SDK) can then offer
 * them, and buyers hire them like any other: the brief is checked against the
 * input schema before the escrow is created, the result against the output
 * schema before it is accepted.
 *
 * Schemas are plain JSON Schema (draft 2020-12 subset), compiled to zod with
 * z.fromJSONSchema. A capability is immutable once published, tasks commit to
 * it, so a changed schema is a new id (e.g. "sentiment_v2").
 */

export const CUSTOM_CAPABILITY_ID = /^[a-z][a-z0-9_]{2,39}$/
/** Largest JSON Schema accepted, serialized. */
export const MAX_SCHEMA_CHARS = 8_000

export const CUSTOM_CATEGORIES = ['Research', 'Data', 'Content', 'Automation'] as const

/** A JSON Schema whose root describes an object, small and self-contained. */
const jsonSchemaObject = z
  .record(z.string(), z.unknown())
  .superRefine((schema, ctx) => {
    if (JSON.stringify(schema).length > MAX_SCHEMA_CHARS) {
      ctx.addIssue({ code: 'custom', message: `schema is larger than ${MAX_SCHEMA_CHARS} characters` })
      return
    }
    if (schema.type !== 'object') {
      ctx.addIssue({ code: 'custom', message: 'the schema root must be {"type": "object", …}' })
      return
    }
    const compiled = compileSchema(schema)
    if (!compiled.ok) ctx.addIssue({ code: 'custom', message: compiled.error })
  })

/** A worked example: a brief and the result a good seller delivers for it. */
export const capabilityExampleSchema = z.object({
  title: z.string().trim().min(3).max(80),
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()),
})

export type CapabilityExample = z.infer<typeof capabilityExampleSchema>

export const MAX_EXAMPLES = 5
const MAX_EXAMPLE_CHARS = 2_000

export const registerCapabilitySchema = z.object({
  id: z
    .string()
    .regex(CUSTOM_CAPABILITY_ID, 'id: 3–40 characters, lowercase letters, digits and _, starting with a letter')
    .refine((id) => !isCapabilityId(id), 'that id belongs to a platform capability'),
  name: z.string().trim().min(3).max(60),
  description: z.string().trim().min(10).max(500),
  category: z.enum(CUSTOM_CATEGORIES).default('Automation'),
  inputSchema: jsonSchemaObject,
  outputSchema: jsonSchemaObject,
  rubric: z.string().trim().min(10).max(1000),
  /**
   * Worked examples. Each input must fit the input schema and each output the
   * output schema, so an example can never contradict the capability. Buyers
   * use them to write a brief; the AI arbiter reads them as references of a
   * correct delivery when a dispute is judged.
   */
  examples: z.array(capabilityExampleSchema).max(MAX_EXAMPLES).default([]),
}).superRefine((cap, ctx) => {
  cap.examples.forEach((example, i) => {
    for (const side of ['input', 'output'] as const) {
      if (JSON.stringify(example[side]).length > MAX_EXAMPLE_CHARS) {
        ctx.addIssue({ code: 'custom', path: ['examples', i, side], message: `is larger than ${MAX_EXAMPLE_CHARS} characters` })
        continue
      }
      const checked = validateWithSchema(side === 'input' ? cap.inputSchema : cap.outputSchema, example[side])
      if (!checked.ok) {
        ctx.addIssue({ code: 'custom', path: ['examples', i, side], message: `does not match the ${side} schema (${checked.error})` })
      }
    }
  })
})

export type RegisterCapabilityInput = z.input<typeof registerCapabilitySchema>

/** A capability as the registry lists it, platform or community. */
export interface CapabilityInfo {
  id: string
  name: string
  description: string
  category: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  rubric: string
  /** Worked examples (community capabilities); the buyer's starting point and the arbiter's reference. */
  examples: CapabilityExample[]
  /** Marketplace statistics and the ranking score (listing only). */
  stats?: CapabilityStats
  /** 'platform' = built in (hosted agents can run it); 'community' = published through the registry. */
  source: 'platform' | 'community'
  /** Who published it (community capabilities only). */
  ownerWallet?: string
  createdAt?: string
}

/** Compiles a JSON Schema to a zod validator, or explains why it can't be used. */
export function compileSchema(schema: unknown): { ok: true; schema: z.ZodType } | { ok: false; error: string } {
  try {
    return { ok: true, schema: z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]) }
  } catch (error) {
    return { ok: false, error: `invalid JSON Schema: ${(error as Error).message}` }
  }
}

/** Checks a value against a JSON Schema. */
export function validateWithSchema(schema: unknown, value: unknown): { ok: true; data: unknown } | { ok: false; error: string } {
  const compiled = compileSchema(schema)
  if (!compiled.ok) return compiled
  const parsed = compiled.schema.safeParse(value)
  if (parsed.success) return { ok: true, data: parsed.data }
  return {
    ok: false,
    error: parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '),
  }
}

/**
 * A starting value shaped like a schema, what a brief editor is prefilled
 * with: defaults and first enum values where given, else empty strings, 0,
 * false and []. Only the object's required fields are included.
 */
export function exampleFromSchema(schema: unknown, depth = 0): unknown {
  if (!schema || typeof schema !== 'object' || depth > 6) return null
  const s = schema as Record<string, unknown>
  if ('default' in s) return s.default
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0]
  if ('const' in s) return s.const
  switch (s.type) {
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, unknown>
      const required = Array.isArray(s.required) ? (s.required as string[]) : Object.keys(props)
      return Object.fromEntries(required.filter((k) => k in props).map((k) => [k, exampleFromSchema(props[k], depth + 1)]))
    }
    case 'array':
      return []
    case 'number':
    case 'integer':
      return typeof s.minimum === 'number' ? s.minimum : 0
    case 'boolean':
      return false
    case 'string':
      return ''
    default:
      return null
  }
}

/** The four platform capabilities, in the registry's shape (their zod schemas as JSON Schema). */
export function platformCapabilities(): CapabilityInfo[] {
  return CAPABILITY_IDS.map((id: CapabilityId) => {
    const c = CAPABILITIES[id]
    return {
      id,
      name: c.label,
      description: c.description,
      category: c.category,
      inputSchema: z.toJSONSchema(c.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>,
      outputSchema: z.toJSONSchema(c.output, { unrepresentable: 'any' }) as Record<string, unknown>,
      rubric: c.rubric,
      examples: [],
      source: 'platform' as const,
    }
  })
}

// ---------------------------------------------------------------------------
// Statistics and ranking
// ---------------------------------------------------------------------------

/** How a capability is doing in the marketplace (see backend/src/capabilityStats.ts). */
export interface CapabilityStats {
  sellers: number
  onlineSellers: number
  /** Escrows created for it. */
  hires: number
  /** Results delivered. */
  delivered: number
  disputes: number
  /** Buyer ratings counted (same-owner ratings excluded). */
  ratings: number
  /** Average rating 0–100, or null with none. */
  avgRating: number | null
  /** Disputes as a share of deliveries, or null before the first delivery. */
  disputeRatePct: number | null
  /** The ranking score; higher is better. */
  score: number
}

/** A neutral rating every capability starts from, worth this many real ratings. */
const PRIOR_RATING = 70
const PRIOR_WEIGHT = 3

/**
 * The ranking score, in three plain parts:
 *
 *   quality      the average rating, pulled toward a neutral 70 until enough
 *                real ratings exist (so one lucky 100 can't top the list)
 *   reliability  quality × (1 − half the dispute rate): disputes cost points
 *   bonuses      +10·log10(1 + hires) for being used, +5 when a seller is online,
 *                −20 when none is (nobody can fulfil it right now)
 *
 * Top of the list = rated well, rarely disputed, actually used, and available.
 */
export function rankScore(stats: Omit<CapabilityStats, 'score'>, ratingSum: number): number {
  const quality = (ratingSum + PRIOR_RATING * PRIOR_WEIGHT) / (stats.ratings + PRIOR_WEIGHT)
  const disputeRate = stats.delivered ? Math.min(1, stats.disputes / stats.delivered) : 0
  const score = quality * (1 - 0.5 * disputeRate) + 10 * Math.log10(1 + stats.hires) + (stats.onlineSellers > 0 ? 5 : -20)
  return Math.round(score * 10) / 10
}
