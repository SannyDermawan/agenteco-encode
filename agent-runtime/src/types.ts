export type AgentRole = 'buyer' | 'seller'

export interface AgentConfig {
  name: string
  role: AgentRole
  capabilities: string[]
  description: string
  category?: string
  service?: string
  /** The agent's own asking price (seller) or initial offer (buyer). */
  basePrice: number
  /** Seller only: the lowest price this agent is allowed to settle for. */
  minimumPrice?: number
  /** Buyer only: the highest price this agent is allowed to pay. */
  maxBudget?: number
  /** Seller only: style and focus for its model (≤ 500 chars, spec §8.3). */
  customInstructions?: string
  /** Buyer only: what to buy, must match the capability's input schema. */
  taskBrief?: unknown
  /** Buyer only: what a good result must satisfy (≤ 500 chars). */
  acceptanceCriteria?: string
}

export type NegotiationDecision =
  | { action: 'accept' }
  | { action: 'counter'; price: number }
  | { action: 'reject' }
