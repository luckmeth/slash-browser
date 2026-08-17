import { createLogger } from '../logger'

const log = createLogger('ai')

export interface PlanRequest {
  system: string
  /** The user's words, verbatim. */
  userRequest: string
  /** Context assembled by ContextBuilder — the only data that leaves the machine. */
  context: string
  /** JSON Schema the provider must produce. */
  outputSchema: Record<string, unknown>
  signal?: AbortSignal
}

export interface LLMProvider {
  readonly id: 'anthropic' | 'openai-compatible' | 'google'
  readonly model: string
  /** Returns the raw structured object; the caller validates it with zod. */
  proposePlan(request: PlanRequest): Promise<unknown>
}

/** Network timeout. A hung request must not leave the UI waiting forever. */
const REQUEST_TIMEOUT_MS = 60_000

/**
 * Anthropic Messages API, over plain fetch.
 *
 * Deliberately not the SDK. The privacy claim — that only what the user approved
 * is sent — is far easier to audit when the exact request body is constructed in
 * one visible place, with no client library free to attach telemetry, retries
 * with different payloads, or metadata of its own.
 *
 * Structured output comes from a forced tool call rather than "please reply with
 * JSON", which is the difference between a guarantee and a hope.
 */
export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic' as const

  constructor(
    private readonly apiKey: string,
    readonly model: string
  ) {}

  async proposePlan(request: PlanRequest): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    request.signal?.addEventListener('abort', () => controller.abort())

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01'
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          max_tokens: 2048,
          system: request.system,
          tools: [
            {
              name: 'propose_actions',
              description:
                'Propose browser actions for the user to review. This is the only way to act.',
              input_schema: request.outputSchema
            }
          ],
          // Forces the structured shape rather than hoping for well-formed JSON.
          tool_choice: { type: 'tool', name: 'propose_actions' },
          messages: [
            {
              role: 'user',
              content: `${request.context}\n\nRequest: ${request.userRequest}`
            }
          ]
        })
      })

      if (!response.ok) {
        const body = await response.text()
        // Key material must never reach a log or the renderer.
        throw new Error(`Anthropic API ${response.status}: ${body.slice(0, 300)}`)
      }

      const payload = (await response.json()) as {
        content?: Array<{ type: string; name?: string; input?: unknown }>
      }
      const toolUse = payload.content?.find(
        (block) => block.type === 'tool_use' && block.name === 'propose_actions'
      )
      if (!toolUse?.input) throw new Error('Model did not return a plan')
      return toolUse.input
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Any OpenAI-compatible endpoint — Ollama, LM Studio, llama.cpp's server.
 *
 * The point of this adapter is that the whole AI layer can run without anything
 * leaving the machine at all.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly id = 'openai-compatible' as const

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    readonly model: string
  ) {}

  async proposePlan(request: PlanRequest): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    request.signal?.addEventListener('abort', () => controller.abort())

    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Local servers usually ignore this; sending it keeps hosted
          // OpenAI-compatible gateways working too.
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: `${request.context}\n\nRequest: ${request.userRequest}` }
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: 'propose_actions',
                description: 'Propose browser actions for the user to review.',
                parameters: request.outputSchema
              }
            }
          ],
          tool_choice: { type: 'function', function: { name: 'propose_actions' } }
        })
      })

      if (!response.ok) {
        throw new Error(`Provider returned ${response.status}`)
      }

      const payload = (await response.json()) as {
        choices?: Array<{
          message?: { tool_calls?: Array<{ function?: { arguments?: string } }> }
        }>
      }
      const args = payload.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments
      if (!args) throw new Error('Model did not return a plan')
      return JSON.parse(args)
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Google's Generative Language API (Gemini).
 *
 * Structured output comes from `responseSchema` with a JSON mime type, which is
 * Gemini's equivalent of a forced tool call — a guarantee rather than a request
 * to please reply with JSON.
 *
 * The key goes in a header rather than the query string: a URL carrying a
 * credential ends up in logs and crash reports, and this browser is not going to
 * be the thing that puts it there.
 */
export class GoogleProvider implements LLMProvider {
  readonly id = 'google' as const

  constructor(
    private readonly apiKey: string,
    readonly model: string
  ) {}

  async proposePlan(request: PlanRequest): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    request.signal?.addEventListener('abort', () => controller.abort())

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': this.apiKey
          },
          signal: controller.signal,
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.system }] },
            contents: [
              { role: 'user', parts: [{ text: `${request.userRequest}

${request.context}` }] }
            ],
            generationConfig: {
              responseMimeType: 'application/json',
              responseSchema: toGeminiSchema(request.outputSchema)
            }
          })
        }
      )

      if (!response.ok) {
        throw new Error(`Google returned ${response.status}`)
      }

      const body = (await response.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[]
      }
      const text = body.candidates?.[0]?.content?.parts?.[0]?.text
      if (!text) throw new Error('Google returned no content')
      return JSON.parse(text)
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Strips a JSON Schema down to the subset Gemini accepts.
 *
 * It rejects `additionalProperties`, `$schema` and several other standard keys
 * outright with a 400, so they are removed rather than sent and hoped for.
 */
function toGeminiSchema(schema: Record<string, unknown>): unknown {
  const rejected = new Set(['additionalProperties', '$schema', 'definitions', '$defs', 'default'])
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk)
    if (node === null || typeof node !== 'object') return node
    const output: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) {
      if (rejected.has(key)) continue
      output[key] = walk(value)
    }
    return output
  }
  return walk(schema)
}

export function describeProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('aborted')) return 'The request timed out.'
  if (message.includes('401') || message.includes('403')) {
    return 'The provider rejected the API key.'
  }
  if (message.includes('429')) return 'The provider is rate limiting; try again shortly.'
  if (message.includes('ENOTFOUND') || message.includes('fetch failed')) {
    return 'Could not reach the provider. Check the address, or that your local model is running.'
  }
  log.warn(`provider error: ${message}`)
  return 'The provider could not produce a plan.'
}
