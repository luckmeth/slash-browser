import { z } from 'zod'

export const SuggestionKindSchema = z.enum([
  /** Navigate to what was typed, treated as a URL. */
  'navigate',
  /** Run it as a search query. */
  'search',
  'history',
  'bookmark',
  /** A tab already open on this URL — switch instead of opening a duplicate. */
  'open-tab',
  /**
   * A page from browsing memory, matched on what was *on* it.
   *
   * Distinct from 'history', which only ever matches a title or an address. This
   * is the row that answers "that article about database indexes" when the word
   * "article" appears nowhere and you never knew the title.
   */
  'memory'
])
export type SuggestionKind = z.infer<typeof SuggestionKindSchema>

export const SuggestionSchema = z.object({
  id: z.string(),
  kind: SuggestionKindSchema,
  /** Bold line — the page title, or the query for a search. */
  title: z.string(),
  /** Muted line — usually the URL. */
  subtitle: z.string(),
  /** Where accepting this suggestion goes. For 'open-tab' it identifies the tab. */
  url: z.string(),
  tabId: z.string().nullable(),
  faviconUrl: z.string().nullable()
})
export type Suggestion = z.infer<typeof SuggestionSchema>

/**
 * State the overlay needs to draw the dropdown.
 *
 * The dropdown lives in the overlay view rather than the chrome document because
 * it must appear *over* page content, and the page is a native view composited
 * above the DOM. `bounds` is where the overlay should sit — sized to the list
 * only, so the rest of the page stays clickable (overlay hit-testing is
 * rectangular, not per-pixel).
 */
export const OmniboxStateSchema = z.object({
  query: z.string(),
  suggestions: z.array(SuggestionSchema),
  selectedIndex: z.number().int(),
  bounds: z.object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int(),
    height: z.number().int()
  })
})
export type OmniboxState = z.infer<typeof OmniboxStateSchema>

export const SUGGESTION_ROW_HEIGHT = 44
export const SUGGESTION_LIST_PADDING = 8
export const MAX_SUGGESTIONS = 8
