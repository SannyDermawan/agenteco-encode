import { z } from 'zod'
import { LIMITS } from '../../../agent-runtime/src/shared/capabilities/definitions.ts'
import { txRefSchema } from './wallet.ts'

export const disputeReasonSchema = z.object({
  reason: z
    .string()
    .min(10, 'Please describe the problem in at least 10 characters')
    .max(LIMITS.disputeReasonChars),
})

export const disputeResponseSchema = z.object({
  response: z.string().min(1).max(LIMITS.disputeReasonChars),
  source: z.enum(['ai', 'manual', 'api']).default('api'),
})

/** The arbiter's rationale object, its JSON (fixed key order) is what resolutionHash commits to. */
export const disputeResolutionSchema = z.object({
  verdict: z.enum(['seller', 'buyer']),
  confidence: z.number().int().min(0).max(100),
  rationale: z.string().min(1).max(LIMITS.disputeReasonChars),
  decidedBy: z.enum(['ai-auto', 'arbiter-manual']),
  txHash: txRefSchema.optional(),
})
