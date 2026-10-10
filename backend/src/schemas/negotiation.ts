import { z } from 'zod'

const UUID = z.string().uuid()

export const createNegotiationSchema = z.object({
  buyerAgentId: UUID,
  sellerAgentId: UUID,
  capability: z.string().min(1),
  price: z.number().nonnegative(),
  // Why this move (spec §9): the model's reason, or null for rule-based moves.
  reason: z.string().max(280).nullable().optional(),
  // ai | rule: AgentEco's hosted agents. agent: a self-hosted agent's own logic (it decides its own moves).
  source: z.enum(['ai', 'rule', 'agent']).default('rule'),
  adjusted: z.boolean().default(false),
})

export const negotiationMessageSchema = z.object({
  side: z.enum(['buyer', 'seller']),
  action: z.enum(['counter', 'accept', 'reject']),
  price: z.number().nonnegative().optional(),
  // Why this move (spec §9): the model's reason, or null for rule-based moves.
  reason: z.string().max(280).nullable().optional(),
  // ai | rule: AgentEco's hosted agents. agent: a self-hosted agent's own logic (it decides its own moves).
  source: z.enum(['ai', 'rule', 'agent']).default('rule'),
  adjusted: z.boolean().default(false),
})

export const listNegotiationsQuerySchema = z.object({
  agentId: UUID.optional(),
  status: z.enum(['open', 'accepted', 'rejected', 'expired']).optional(),
  // One chain's negotiations only (CAIP-2 id, network name or EVM chain id).
  chain: z.string().min(1).optional(),
})
