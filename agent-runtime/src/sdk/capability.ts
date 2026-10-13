import { CAPABILITIES, isCapabilityId } from '../shared/capabilities/definitions.ts'
import { validateWithSchema, type CapabilityInfo } from '../shared/capabilities/custom.ts'

/**
 * A capability the SDK can check briefs and results against: a platform one
 * (zod schemas in the code) or a community one from the open registry (its
 * published JSON Schemas, fetched once, they never change).
 */
export interface ResolvedCapability {
  id: string
  name: string
  rubric: string
  examples: { title: string; input: unknown; output: unknown }[]
  source: 'platform' | 'community'
  checkBrief(brief: unknown): { ok: true; brief: unknown } | { ok: false; error: string }
  checkResult(result: unknown): { ok: true; result: Record<string, unknown> } | { ok: false; error: string }
}

const cache = new Map<string, ResolvedCapability>()

function issues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => (i.path.length ? `${i.path.map(String).join('.')}: ${i.message}` : i.message)).join('; ')
}

export async function resolveCapability(apiUrl: string, id: string): Promise<ResolvedCapability> {
  const known = cache.get(id)
  if (known) return known

  let resolved: ResolvedCapability
  if (isCapabilityId(id)) {
    const def = CAPABILITIES[id]
    resolved = {
      id,
      name: def.label,
      rubric: def.rubric,
      examples: [],
      source: 'platform',
      checkBrief: (brief) => {
        const r = def.input.safeParse(brief)
        return r.success ? { ok: true, brief: r.data } : { ok: false, error: issues(r.error) }
      },
      checkResult: (result) => {
        const r = def.output.safeParse(result)
        return r.success ? { ok: true, result: r.data as Record<string, unknown> } : { ok: false, error: issues(r.error) }
      },
    }
  } else {
    const res = await fetch(`${apiUrl}/capabilities/${encodeURIComponent(id)}`)
    if (res.status === 404) throw new Error(`Capability "${id}" is not in the registry, publish it first (POST /capabilities, or the Capabilities page).`)
    if (!res.ok) throw new Error(`Reading capability "${id}" failed (${res.status}): ${await res.text()}`)
    const info = (await res.json()) as CapabilityInfo
    resolved = {
      id,
      name: info.name,
      rubric: info.rubric,
      examples: info.examples ?? [],
      source: 'community',
      checkBrief: (brief) => {
        const r = validateWithSchema(info.inputSchema, brief)
        return r.ok ? { ok: true, brief: r.data } : r
      },
      checkResult: (result) => {
        const r = validateWithSchema(info.outputSchema, result)
        return r.ok ? { ok: true, result: r.data as Record<string, unknown> } : r
      },
    }
  }
  cache.set(id, resolved)
  return resolved
}
