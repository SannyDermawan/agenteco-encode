import { prisma } from './db.ts'
import { capabilityStats, emptyStats } from './capabilityStats.ts'
import { CAPABILITIES, isCapabilityId } from '../../agent-runtime/src/shared/capabilities/definitions.ts'
import { platformCapabilities, validateWithSchema, type CapabilityInfo } from '../../agent-runtime/src/shared/capabilities/custom.ts'

/**
 * Looks capabilities up across the open registry: the four platform ones
 * (built into the code) and community ones (the capabilities table). A
 * published capability never changes, so lookups are cached for good.
 */

const PLATFORM = new Map(platformCapabilities().map((c) => [c.id, c]))
const cache = new Map<string, CapabilityInfo>()

function fromRow(row: {
  id: string
  name: string
  description: string
  category: string
  inputSchema: unknown
  outputSchema: unknown
  rubric: string
  examples?: unknown
  ownerWallet: string
  createdAt: Date
}): CapabilityInfo {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    inputSchema: row.inputSchema as Record<string, unknown>,
    outputSchema: row.outputSchema as Record<string, unknown>,
    rubric: row.rubric,
    examples: Array.isArray(row.examples) ? (row.examples as CapabilityInfo['examples']) : [],
    source: 'community',
    ownerWallet: row.ownerWallet,
    createdAt: row.createdAt.toISOString(),
  }
}

/** A capability by id, platform or community; null when nobody published it. */
export async function getCapability(id: string): Promise<CapabilityInfo | null> {
  const known = PLATFORM.get(id) ?? cache.get(id)
  if (known) return known
  if (isCapabilityId(id)) return null
  const row = await prisma.capability.findUnique({ where: { id } })
  if (!row) return null
  const info = fromRow(row)
  cache.set(id, info)
  return info
}

/** The ids in `ids` that are neither platform nor published capabilities. */
export async function unknownCapabilities(ids: string[]): Promise<string[]> {
  const unknown: string[] = []
  for (const id of ids) if (!(await getCapability(id))) unknown.push(id)
  return unknown
}

/**
 * Every capability with its marketplace statistics. `top` (default) puts the
 * best-rated, least-disputed, most-used and available ones first, see rankScore;
 * `new` lists the newest first, platform ones last.
 */
export async function listCapabilities(sort: 'top' | 'new' = 'top'): Promise<CapabilityInfo[]> {
  const [rows, stats] = await Promise.all([prisma.capability.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }), capabilityStats()])
  const all = [...PLATFORM.values(), ...rows.map(fromRow)].map((c) => ({ ...c, stats: stats.get(c.id) ?? emptyStats() }))
  if (sort === 'new') {
    return [...all.filter((c) => c.source === 'community'), ...all.filter((c) => c.source === 'platform')]
  }
  // Ties (a new capability next to a new one) keep the platform ones first, then the newer.
  return all
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.stats.score - a.c.stats.score || a.i - b.i)
    .map(({ c }) => c)
}

/**
 * Whether a delivered result has the shape its capability promises: platform
 * capabilities by their zod output schema, community ones by their published
 * JSON Schema. A result that fails is never published, so the buyer is never
 * shown (or asked to pay for) something that can't be what was ordered.
 */
export async function checkResultShape(capabilityId: string, result: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  if (isCapabilityId(capabilityId)) {
    const checked = CAPABILITIES[capabilityId].output.safeParse(result)
    return checked.success ? { ok: true } : { ok: false, error: checked.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ') }
  }
  const info = await getCapability(capabilityId)
  if (!info) return { ok: false, error: `unknown capability "${capabilityId}"` }
  const checked = validateWithSchema(info.outputSchema, result)
  return checked.ok ? { ok: true } : checked
}
