import { LLM_MAX_CALLS_PER_AGENT_PER_HOUR } from './config.ts'

const HOUR_MS = 60 * 60_000
const calls = new Map<string, number[]>()

/**
 * Sliding one-hour window per agent (spec §6.3). Returns false when the agent
 * already used its budget, the caller then takes its deterministic fallback.
 * In memory: a restart resets the window, which only ever allows more calls.
 */
export function takeLLMSlot(agentId: string, now = Date.now(), limit = LLM_MAX_CALLS_PER_AGENT_PER_HOUR): boolean {
  const recent = (calls.get(agentId) ?? []).filter((t) => now - t < HOUR_MS)
  if (recent.length >= limit) {
    calls.set(agentId, recent)
    return false
  }
  recent.push(now)
  calls.set(agentId, recent)
  return true
}

/** Test helper. */
export function resetLLMSlots(): void {
  calls.clear()
}
