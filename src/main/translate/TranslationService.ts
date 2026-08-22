import {
  chunkBlocks,
  formatForTranslation,
  parseTranslation,
  worthTranslating,
  type Block
} from './translationChunks'
import type { ProviderRegistry } from '../ai/ProviderRegistry'
import type { SettingsStore } from '../settings/SettingsStore'
import { createLogger } from '../logger'

const log = createLogger('translate')

/** Characters per request. Comfortably inside every provider's context, with room for the reply. */
const CHUNK_CHARS = 6000

export type TranslationOutcome =
  | { ok: true; blocks: string[]; title: string }
  | { ok: false; reason: string }

/**
 * Translating an article.
 *
 * **This sends the page's text to whichever AI provider the user configured.**
 * There is no way around that: translation needs a language model, and this
 * browser deliberately ships only a small embedding model — a translation model
 * good enough to be worth using is gigabytes, and bundling one would quadruple
 * the installer for a feature most people never open.
 *
 * So it reuses the AI layer's existing consent rather than inventing a second
 * one. With no provider configured, this refuses and says why; it never reaches
 * for a default service, and there is no key hidden anywhere to reach for.
 *
 * It translates the **article**, not the page: the text comes from Readability,
 * the same extraction reader mode uses, and the result is shown in the reader.
 * Rewriting text inside the live page would mean scripting every site in its own
 * world, which is a much larger capability than this feature is worth.
 */
export class TranslationService {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly settings: SettingsStore
  ) {}

  /** Whether the feature can run at all, for the UI to say so before it is pressed. */
  available(): boolean {
    const settings = this.settings.getAll()
    return settings.aiMayReadPageContent && this.providers.active() !== null
  }

  async translate(
    blocks: readonly Block[],
    title: string,
    targetLanguage: string,
    signal?: AbortSignal
  ): Promise<TranslationOutcome> {
    // The gate that already exists for sending page text to a provider.
    // Translation is exactly that, so it uses the same switch rather than a
    // second one the user has to find and reason about separately.
    if (!this.settings.getAll().aiMayReadPageContent) {
      return {
        ok: false,
        reason:
          'Translating a page means sending its text to your AI provider. Turn on ' +
          '"Let AI read page content" in Settings first.'
      }
    }
    const provider = this.providers.active()
    if (!provider) {
      return {
        ok: false,
        reason: 'No AI provider is configured. Translation needs one — Slash does not ship a translation model.'
      }
    }
    if (!worthTranslating(blocks)) {
      return { ok: false, reason: 'There is not enough text on this page to translate.' }
    }

    const language = targetLanguage.trim() || 'English'
    const chunks = chunkBlocks(blocks, CHUNK_CHARS)
    const translated: string[] = []

    try {
      for (const [index, chunk] of chunks.entries()) {
        if (signal?.aborted) return { ok: false, reason: 'Cancelled.' }

        const reply = await provider.ask(prompt(chunk, language, index, chunks.length), signal)
        const parsed = parseTranslation(reply, chunk.length)

        if (!parsed) {
          // Refusing beats guessing. A partial or shifted result reads exactly
          // like a correct translation, and the reader has no way to tell.
          log.warn(`translation reply did not line up for chunk ${index + 1}/${chunks.length}`)
          return {
            ok: false,
            reason: 'The translation came back in a form Slash could not line up with the page, so none of it is shown. Trying again often works.'
          }
        }
        translated.push(...parsed)
      }
    } catch (error) {
      log.warn('translation failed', error)
      return { ok: false, reason: 'The AI provider could not be reached.' }
    }

    const translatedTitle = await this.translateTitle(title, language, signal)
    return { ok: true, blocks: translated, title: translatedTitle }
  }

  /** The title separately: it is one line, and losing it would be conspicuous. */
  private async translateTitle(
    title: string,
    language: string,
    signal?: AbortSignal
  ): Promise<string> {
    const provider = this.providers.active()
    if (!provider || title.trim() === '') return title
    try {
      const reply = await provider.ask(
        `Translate this headline into ${language}. Reply with the translation only, ` +
          `no quotes and no explanation.\n\n${title}`,
        signal
      )
      const cleaned = reply.trim().split('\n')[0]?.trim() ?? ''
      // A model that answered with a paragraph has misunderstood; keep the
      // original rather than putting an essay where a headline goes.
      return cleaned !== '' && cleaned.length < title.length * 4 ? cleaned : title
    } catch {
      return title
    }
  }
}

function prompt(chunk: readonly Block[], language: string, index: number, total: number): string {
  return [
    `Translate the following text into ${language}.`,
    '',
    'Rules:',
    `- Reproduce every marker line exactly as given, including the final one (<<<§${chunk.length}>>>).`,
    '- Translate only the text between markers. Do not merge, split, reorder or omit blocks.',
    '- Keep proper nouns, code and URLs unchanged.',
    '- Reply with the markers and translations only. No preamble, no commentary.',
    total > 1 ? `- This is part ${index + 1} of ${total}; translate only what is here.` : '',
    '',
    formatForTranslation(chunk)
  ]
    .filter((line) => line !== '')
    .join('\n')
}
