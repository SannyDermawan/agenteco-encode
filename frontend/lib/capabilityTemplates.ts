import { CAPABILITIES, CAPABILITY_IDS, type CapabilityId } from '@shared/capabilities/definitions'
import type { AgentCategory } from './agenteco-data'

/**
 * The four platform capabilities, as the forms and cards show them, read
 * from the shared definitions (agent-runtime/src/shared/capabilities), so the
 * frontend, the API and every seller agree on the same ids and schemas.
 */
export interface CapabilityTemplate {
  key: CapabilityId
  label: string
  category: AgentCategory
  description: string
}

export const CAPABILITY_TEMPLATES: CapabilityTemplate[] = CAPABILITY_IDS.map((id) => ({
  key: id,
  label: CAPABILITIES[id].label,
  category: CAPABILITIES[id].category,
  description: CAPABILITIES[id].description,
}))

/**
 * "data_analysis" → "Data Analysis". Community capabilities (open registry)
 * get their id title-cased: "sentiment_score" → "Sentiment Score".
 */
export function capabilityLabel(id: string): string {
  return (
    CAPABILITY_TEMPLATES.find((t) => t.key === id)?.label ??
    id
      .split('_')
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(' ')
  )
}
