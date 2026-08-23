/**
 * The AI assistant docked beside a page.
 *
 * **This is a web page, not an integration, and that is the point.** There is no
 * public way for a third-party application to use somebody's Claude Pro or Max
 * subscription programmatically — no OAuth flow grants it, and the API is billed
 * separately from the subscription. An app claiming otherwise is either asking
 * for an API key (a different product you pay for again) or scraping a session
 * cookie out of a browser profile.
 *
 * So Slash does the honest version: it opens claude.ai in a real pane, in a
 * persistent session, and the user signs in the way they already do. The
 * subscription works because it is the actual site. There is no key to enter,
 * nothing to configure, and no message goes anywhere except where the user typed
 * it — Slash does not read the page and hand it over. That remains the AI action
 * layer's job, behind `aiMayReadPageContent`, which is a separate switch for a
 * separate thing.
 *
 * Pure so the URL and matching rules can be tested without a window. Picking the
 * wrong tab to dock is a quiet failure: a second Claude tab every time, or the
 * user's own claude.ai tab yanked into the side pane mid-conversation.
 */

export interface AssistantChoice {
  readonly id: string
  readonly label: string
  readonly url: string
  /**
   * Hosts that count as "this assistant already open".
   *
   * Sign-in and account flows live on neighbouring hosts, so an exact origin
   * match would fail to recognise a tab mid-login and open a second one.
   */
  readonly hosts: readonly string[]
}

export const ASSISTANTS: readonly AssistantChoice[] = [
  {
    id: 'claude',
    label: 'Claude',
    url: 'https://claude.ai/new',
    hosts: ['claude.ai']
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    url: 'https://chatgpt.com/',
    hosts: ['chatgpt.com', 'chat.openai.com']
  },
  {
    id: 'gemini',
    label: 'Gemini',
    url: 'https://gemini.google.com/app',
    hosts: ['gemini.google.com']
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    url: 'https://www.perplexity.ai/',
    hosts: ['perplexity.ai', 'www.perplexity.ai']
  },
  {
    id: 'mistral',
    label: 'Le Chat',
    url: 'https://chat.mistral.ai/chat',
    hosts: ['chat.mistral.ai']
  }
]

export const DEFAULT_ASSISTANT_ID = 'claude'

/** The chosen assistant, or a custom address the user typed. */
export function assistantUrlFor(id: string, customUrl: string): string | null {
  if (id === 'custom') {
    const trimmed = customUrl.trim()
    // https only. A docked pane is a persistent, signed-in session; sending
    // those cookies over plaintext is not a decision to leave to a text field.
    return /^https:\/\/\S+$/i.test(trimmed) ? trimmed : null
  }
  return ASSISTANTS.find((choice) => choice.id === id)?.url ?? null
}

export function assistantLabelFor(id: string): string {
  if (id === 'custom') return 'Assistant'
  return ASSISTANTS.find((choice) => choice.id === id)?.label ?? 'Assistant'
}

/** The host, lowercased, or '' if the URL will not parse. */
export function hostOfUrl(url: string): string {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Whether an open tab is already this assistant.
 *
 * Matched on host rather than the full URL: the assistant navigates constantly
 * within its own site, and an existing conversation is exactly the tab somebody
 * wants docked. Subdomains count — `claude.ai` matches `www.claude.ai` — because
 * a sign-in redirect that lands on one should not produce a duplicate.
 */
export function isAssistantUrl(url: string, id: string, customUrl: string): boolean {
  const host = hostOfUrl(url)
  if (host === '') return false

  if (id === 'custom') {
    const target = hostOfUrl(customUrl.trim())
    return target !== '' && (host === target || host.endsWith(`.${target}`))
  }

  const choice = ASSISTANTS.find((entry) => entry.id === id)
  if (!choice) return false
  return choice.hosts.some((known) => host === known || host.endsWith(`.${known}`))
}
