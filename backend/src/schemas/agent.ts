import { z } from 'zod'
import { CAPABILITIES, LIMITS, isCapabilityId } from '../../../agent-runtime/src/shared/capabilities/definitions.ts'
import { CUSTOM_CAPABILITY_ID } from '../../../agent-runtime/src/shared/capabilities/custom.ts'

const CATEGORIES = ['Research', 'Data', 'Content', 'Automation'] as const
const WALLET_REGEX = /^0x[a-fA-F0-9]{40}$/

const baseAgentSchema = z.object({
  name: z.string().trim().min(1).max(100),
  // Optional here — a buyer doesn't need a description of what it offers
  // (it isn't offering anything). Capability stays required for both roles
  // below: for a seller it's what they offer, for a buyer (esp. a hosted
  // task) it's what the host runtime searches the registry for.
  description: z.string().trim().min(1).max(1000).optional(),
  role: z.enum(['buyer', 'seller']),
  category: z.enum(CATEGORIES).optional(),
  service: z.string().trim().min(1).max(100).optional(),
  // Platform capability ids, or community ones from the open registry (checked in the route).
  capabilities: z.array(z.string().regex(CUSTOM_CAPABILITY_ID, 'not a capability id')).max(10).optional(),
  price: z.number().nonnegative(),
  minimumPrice: z.number().nonnegative().optional(),
  maxBudget: z.number().nonnegative().optional(),
  walletAddress: z.string().regex(WALLET_REGEX).optional(),
  endpoint: z
    .string()
    .url()
    .max(500)
    .refine((url) => /^https?:\/\//i.test(url), 'endpoint must be an http(s) URL')
    .optional(),
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional(),
  isOnline: z.boolean().default(true),
  // Hosted buyer task seller-selection filters — "Recommended" leaves all
  // three unset (no filtering beyond price/budget); "Custom" sets any/all.
  minSuccessRate: z.number().min(0).max(100).optional(),
  minCompletedJobs: z.number().int().nonnegative().optional(),
  minReputation: z.number().min(0).max(100).optional(),
  // Seller only: AgentEco generates and holds this agent's wallet and runs
  // it from the host runtime (see host/sellerTaskHost.ts). Off by default so
  // self-custody sellers (seller-agent/) keep registering their own wallet.
  hosted: z.boolean().optional(),
  // Seller: style and focus for its model — never schema or safety (spec §8.3).
  customInstructions: z.string().trim().max(LIMITS.textChars).optional(),
  // Hosted buyer: what to buy (validated against the capability's input
  // schema below) and what a good result must satisfy (spec §8.2).
  taskBrief: z.unknown().optional(),
  acceptanceCriteria: z.string().trim().max(LIMITS.textChars).optional(),
  // Links this listing to the owner's listings of the same agent on other chains
  // (any UUID the owner picks; null unlinks). chainId itself is fixed at creation.
  groupId: z.string().uuid().nullable().optional(),
  // ownerWallet is NOT accepted here — it's derived from the verified
  // signature (see src/auth.ts), not trusted from the request body.
})

export const createAgentSchema = baseAgentSchema
  .superRefine((data, ctx) => {
    if (!data.capabilities || data.capabilities.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['capabilities'],
        message:
          data.role === 'seller'
            ? 'capabilities is required for a seller agent'
            : 'capabilities is required for a buyer agent (what should it search for?)',
      })
    }
    if (data.role === 'seller' && !data.description) {
      ctx.addIssue({ code: 'custom', path: ['description'], message: 'description is required for a seller agent' })
    }
    // Hosted agents run on AgentEco's own executors, which only know the platform
    // capabilities. Community ones (open registry) are for self-hosted agents.
    const hostedAgent = data.role === 'buyer' ? data.hosted !== false : data.hosted === true
    for (const cap of data.capabilities ?? []) {
      if (hostedAgent && !isCapabilityId(cap)) {
        ctx.addIssue({ code: 'custom', path: ['capabilities'], message: `"${cap}" is a community capability — hosted agents run platform capabilities only; serve it from a self-hosted agent (the SDK).` })
      }
    }
    const capability = data.capabilities?.[0]
    if (data.role === 'buyer' && data.hosted !== false && capability && isCapabilityId(capability)) {
      if (data.taskBrief === undefined) {
        ctx.addIssue({ code: 'custom', path: ['taskBrief'], message: 'taskBrief is required for a hosted buyer (what should it buy?)' })
      } else {
        const brief = CAPABILITIES[capability].input.safeParse(data.taskBrief)
        if (!brief.success) {
          for (const issue of brief.error.issues) {
            ctx.addIssue({ code: 'custom', path: ['taskBrief', ...issue.path.map(String)], message: issue.message })
          }
        }
      }
    }
    if (data.role !== 'seller' && data.customInstructions) {
      ctx.addIssue({ code: 'custom', path: ['customInstructions'], message: 'customInstructions only apply to seller agents' })
    }
    if (data.role === 'buyer' && data.maxBudget === undefined) {
      ctx.addIssue({ code: 'custom', path: ['maxBudget'], message: 'maxBudget is required for a buyer agent (it sets the required deposit)' })
    }
  })
  .transform((data) => ({
    ...data,
    description: data.description ?? 'Buyer agent on the AgentEco network.',
    capabilities: data.capabilities ?? [],
  }))

// role and hosted are fixed at creation: flipping them would give an agent a
// wallet, deposit or brief that doesn't match what it does.
export const updateAgentSchema = baseAgentSchema.omit({ hosted: true, role: true }).partial()

export const listAgentsQuerySchema = z.object({
  role: z.enum(['buyer', 'seller']).optional(),
  isOnline: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  capability: z.string().min(1).optional(),
  ownerWallet: z.string().regex(WALLET_REGEX).optional(),
  taskStatus: z.enum(['awaiting_deposit', 'active', 'completed', 'refunded']).optional(),
  // Free-text keyword match across name/description/service — separate from
  // `capability`, which matches an exact capability tag. Per §10: "Mulai
  // dengan keyword matching, capability matching, dan filtering."
  q: z.string().min(1).optional(),
  // One chain's agents only (CAIP-2 id, network name or EVM chain id); default: every served chain.
  chain: z.string().min(1).optional(),
  // One logical agent's listings across chains.
  groupId: z.string().uuid().optional(),
})

export const heartbeatSchema = z.object({ online: z.boolean().default(true) })
