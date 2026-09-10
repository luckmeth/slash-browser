import { z } from 'zod'

/**
 * Configuration the publisher of this build can change without shipping one.
 *
 * In `shared/` rather than beside the service, because `shared` may never import
 * from `main` — the renderer would then pull the whole main-process tree in.
 *
 * **Inert by default.** `remoteConfigEndpoint` is empty on a fresh install, so
 * no request is ever made and every value here is the local default. A browser
 * that asks a server how to behave on launch is doing precisely what this one is
 * sold as not doing, so it happens only when whoever built the installer set it
 * up.
 */
export const RemoteConfigSchema = z.object({
  /** Whether the start page offers the "Advertise on Slash" entry point. */
  showAdvertiseCta: z.boolean(),
  /** A message from whoever publishes this build. Empty means nothing to say. */
  notice: z.object({
    message: z.string(),
    level: z.enum(['info', 'warn', 'urgent']),
    /** https only, or empty. A link put in front of every user is not an http link. */
    url: z.string()
  }),
  /**
   * The YouTube ad strip's rules, served rather than compiled in.
   *
   * This is the cadence gap, and it is the whole of what separates this blocker
   * from Brave's. The technique is identical — both prune the same fields out of
   * the same player responses — but Brave's rules are refreshed continuously by
   * a community that notices within hours when a site changes shape, and these
   * were compiled into a binary that has no auto-update because it is unsigned.
   * A field YouTube renames therefore meant: cut a release, and hope everybody
   * reinstalls.
   *
   * Served, it means: edit a document, and every browser has it on its next
   * check. Empty arrays mean "use what shipped", so a config that cannot be
   * reached, or one that says nothing about the shield, changes nothing.
   */
  shield: z
    .object({
      /** Extra field names to prune, on top of the built-in list. */
      adFields: z.array(z.string().min(1).max(64)).max(32).default([]),
      /**
       * Extra innertube endpoints to intercept.
       *
       * Patterns, not URLs — they are handed to CDP's `Fetch.enable`. Bounded
       * in count and length because each one is a response the browser pauses
       * and buffers, which is a cost paid on real navigations.
       */
      playerUrlPatterns: z.array(z.string().min(4).max(200)).max(8).default([])
    })
    .default({ adFields: [], playerUrlPatterns: [] }),
  /** Rollout flags. An unknown or missing flag is off. */
  flags: z.record(z.string(), z.boolean()),
  /**
   * The advertising rate card, served rather than compiled in.
   *
   * Prices change more often than the browser ships — and this browser has no
   * auto-update, so a rate compiled into a build would be wrong for everyone
   * who installed it before the change and unfixable without a reinstall. The
   * operator edits these; the values below are only the fallback for a build
   * that cannot reach the config.
   */
  advertising: z.object({
    /** Where a request goes. Empty means the page says there is nowhere yet. */
    contactEmail: z.string().default(''),
    /**
     * What the audience actually is, in the operator's own words.
     *
     * Deliberately a *string the operator writes* rather than a number this
     * computes. Slash cannot measure its own audience — impression counts
     * arrive aggregated, hours late, and only from browsers that were reopened
     * — so a figure generated here would be a guess presented as a metric.
     * Empty renders as "no audience figure published yet", which is the honest
     * answer for a browser that does not yet have one.
     */
    reachNote: z.string().default(''),
    placements: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          what: z.string(),
          concurrency: z.string(),
          rate: z.string()
        })
      )
      .default([])
  })
})
export type RemoteConfig = z.infer<typeof RemoteConfigSchema>

export const DEFAULT_REMOTE_CONFIG: RemoteConfig = {
  shield: { adFields: [], playerUrlPatterns: [] },
  showAdvertiseCta: true,
  notice: { message: '', level: 'info', url: '' },
  flags: {},
  advertising: {
    contactEmail: 'slashdevelopments@gmail.com',
    reachNote: '',
    placements: [
      {
        id: 'background',
        name: 'Start page takeover',
        what: 'Your image behind the whole start page, every new tab.',
        concurrency: 'Exclusive — one advertiser at a time',
        rate: '$12 / hour · 24 hour minimum'
      },
      {
        id: 'notice',
        name: 'Browsing notice',
        what: "A dismissible card in the browser's own chrome while somebody browses.",
        concurrency: 'Up to 2 at once, capped per reader per day',
        rate: '$6 / hour · 24 hour minimum'
      },
      {
        id: 'banner',
        name: 'Banner',
        what: 'A wide panel under the start page content. Visible without owning the page.',
        concurrency: 'Up to 2 at once',
        rate: '$4 / hour · 24 hour minimum'
      },
      {
        id: 'rail',
        name: 'Side card',
        what: 'A card in the margin beside the start page. Uses space that was otherwise empty.',
        concurrency: 'Up to 2 at once — left and right',
        rate: '$2.50 / hour · 24 hour minimum'
      },
      {
        id: 'tile',
        name: 'Tile',
        what: 'A small labelled card among the shortcuts, in rotation.',
        concurrency: 'Up to 6 in rotation',
        rate: '$2.50 / hour · 24 hour minimum'
      }
    ]
  }
}
