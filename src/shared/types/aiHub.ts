import { z } from 'zod'

/**
 * AI Hub — several providers, one browser.
 *
 * The browser is deliberately not coupled to a single vendor. Every provider is
 * a row in a catalogue with the same shape, so adding one is a table entry and a
 * `proposePlan` implementation rather than a change to anything that calls AI.
 *
 * **Credentials never reach the renderer.** The hub reports *whether* a provider
 * is connected, never the key. Keys live in the OS keychain via `safeStorage`
 * (DPAPI on Windows), and a machine with no keychain available is refused rather
 * than falling back to plaintext.
 */

export const AiProviderIdSchema = z.enum([
  'anthropic',
  'openai',
  'google',
  /** Any OpenAI-compatible endpoint: Ollama, LM Studio, vLLM, a proxy. */
  'local'
])
export type AiProviderId = z.infer<typeof AiProviderIdSchema>

export const AiProviderInfoSchema = z.object({
  id: AiProviderIdSchema,
  name: z.string(),
  /** One line on what this provider is, shown in the accounts list. */
  description: z.string(),
  /** Whether a key is stored for it. Never the key itself. */
  connected: z.boolean(),
  /** Model currently selected for this provider. */
  model: z.string(),
  /** Models known to work, offered as a list. Free text is still allowed. */
  suggestedModels: z.array(z.string()),
  /** Whether this provider needs an API key at all — local ones may not. */
  requiresKey: z.boolean(),
  /** Endpoint, shown and editable only for the local/compatible provider. */
  baseUrl: z.string().nullable(),
  /** Where to obtain a key, so the user is not left searching. */
  keyUrl: z.string().nullable(),
  /**
   * Whether this provider is *catalogued* as a local one.
   *
   * **Not a statement about where the request goes.** This is a property of the
   * provider id; the endpoint beside it is free text the user can point
   * anywhere. Use `destination` for anything the user will read as a promise —
   * rendering this flag as "nothing is sent to a third party" is exactly the
   * bug that made `loopback.ts` necessary.
   */
  local: z.boolean(),
  /**
   * Where requests to this provider actually go, checked rather than assumed.
   *
   * Derived from the stored endpoint by `loopbackVerdict`. The whole point of
   * listing local models beside cloud ones is that the user can see which is
   * which at the moment they choose — and that only works if the answer is
   * about the address, not about the label.
   */
  destination: z.enum(['loopback', 'remote', 'unparseable']),
  /** The host as it will be contacted, so the UI can name it. */
  destinationHost: z.string()
})
export type AiProviderInfo = z.infer<typeof AiProviderInfoSchema>

export const AiHubStatusSchema = z.object({
  providers: z.array(AiProviderInfoSchema),
  /** The provider AI features use, or null when none is connected. */
  defaultProvider: AiProviderIdSchema.nullable(),
  /**
   * Whether the OS offers a keychain.
   *
   * When false, connecting is refused outright — storing a provider key in
   * readable form beside the browsing history is not a trade this browser makes,
   * and silently degrading to plaintext would be worse than not supporting it.
   */
  secureStorageAvailable: z.boolean()
})
export type AiHubStatus = z.infer<typeof AiHubStatusSchema>

/** Catalogue defaults. Kept in shared so the UI can render before any IPC. */
export const AI_PROVIDER_CATALOGUE: ReadonlyArray<
  Omit<AiProviderInfo, 'connected' | 'model' | 'baseUrl' | 'destination' | 'destinationHost'> & {
    defaultModel: string
  }
> = [
  {
    id: 'anthropic',
    name: 'Claude',
    description: 'Anthropic’s models, via the Messages API.',
    defaultModel: 'claude-sonnet-5',
    suggestedModels: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    requiresKey: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    local: false
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT models, via the Chat Completions API.',
    defaultModel: 'gpt-4.1',
    suggestedModels: ['gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
    requiresKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    local: false
  },
  {
    id: 'google',
    name: 'Google AI',
    description: 'Gemini models, via the Generative Language API.',
    defaultModel: 'gemini-2.5-pro',
    suggestedModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    requiresKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    local: false
  },
  {
    id: 'local',
    name: 'Local model',
    description:
      'Any OpenAI-compatible endpoint on this machine — Ollama, LM Studio, vLLM. Nothing leaves your computer.',
    defaultModel: 'llama3.1',
    suggestedModels: ['llama3.1', 'qwen2.5', 'mistral-nemo'],
    requiresKey: false,
    keyUrl: null,
    local: true
  }
]

export const DEFAULT_LOCAL_BASE_URL = 'http://localhost:11434/v1'
