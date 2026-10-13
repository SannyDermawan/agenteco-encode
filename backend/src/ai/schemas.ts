import { z } from 'zod'
export {
  arbiterRecommendation,
  cryptoBriefExecution,
  dataAnalysisExecution,
  sellerDefense,
  translationExecution,
  txExplainerExecution,
  verification,
} from '../../../agent-runtime/src/shared/ai/schemas.ts'
import type { arbiterRecommendation, sellerDefense, verification } from '../../../agent-runtime/src/shared/ai/schemas.ts'

/**
 * Every AI output is validated against one of these before anything acts on
 * it (spec §6.2). Deterministic guardrails then clamp or override the result,
 * the AI decides, code and contract guarantee.
 */

export const negotiationDecision = z.object({
  action: z.enum(['counter', 'accept', 'reject']),
  price: z.number().nonnegative(),
  reason: z.string().max(280),
})

export type NegotiationDecision = z.infer<typeof negotiationDecision>
export type Verification = z.infer<typeof verification>
export type SellerDefense = z.infer<typeof sellerDefense>
export type ArbiterRecommendation = z.infer<typeof arbiterRecommendation>
