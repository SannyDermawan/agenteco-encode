import type { LLMTask } from '../config.ts'

export interface CompletionRequest {
  task: LLMTask
  model: string
  system: string
  user: string
  timeoutMs: number
}

/** One LLM backend. `complete` returns the raw text the model produced (expected to be JSON). */
export interface LLMProvider {
  name: 'groq' | 'gemini' | string
  /** False when the provider has no API key, callLLM skips it. */
  available(): boolean
  modelFor(task: LLMTask): string
  complete(req: CompletionRequest): Promise<string>
}

/** A provider answered with an HTTP error. `retryAfterSec` is set for 429s that say when to retry. */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSec?: number
  ) {
    super(message)
  }
}
