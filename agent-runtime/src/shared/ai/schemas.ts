import { z } from 'zod'

/**
 * The shapes an AI must answer in, validated before anything acts on them
 * (spec §6.2). Shared by the backend and the SDK.
 */

// Execution, only the parts the model writes; code supplies the numbers.
export const translationExecution = z.object({
  translatedText: z.string().min(1),
  notes: z.string().max(500).optional(),
})

export const dataAnalysisExecution = z.object({
  insights: z.array(z.string().max(400)).max(8),
  summary: z.string().min(1).max(1200),
})

export const cryptoBriefExecution = z.object({
  brief: z.string().min(1).max(2000),
})

export const txExplainerExecution = z.object({
  explanation: z.string().min(1).max(2000),
})

export const verification = z.object({
  score: z.number().int().min(0).max(100),
  verdict: z.enum(['accept', 'dispute']),
  rationale: z.string().min(1).max(1000),
})

export const sellerDefense = z.object({
  response: z.string().min(1).max(1000),
})

export const arbiterRecommendation = z.object({
  verdict: z.enum(['seller', 'buyer']),
  confidence: z.number().int().min(0).max(100),
  rationale: z.string().min(1).max(1000),
})
