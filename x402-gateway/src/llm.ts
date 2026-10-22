/** A minimal client for any OpenAI-compatible chat endpoint (Nebius Token Factory, Groq, OpenAI...). No SDK, one fetch. */
export interface ModelConfig {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs?: number
}

export async function chatJson(cfg: ModelConfig, system: string, user: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const res = await fetchImpl(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000),
  })
  if (!res.ok) throw new Error(`model endpoint answered HTTP ${res.status}`)
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  const content = json.choices?.[0]?.message?.content
  if (!content) throw new Error('the model returned no content')
  return JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ''))
}
