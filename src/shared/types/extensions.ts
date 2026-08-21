import { z } from 'zod'

/**
 * A capability an extension asked for that Electron does not provide.
 *
 * Reported per-extension so the interface can say *why* something will not work
 * rather than leaving the user to discover it. Electron runs a subset of the
 * Chrome extension APIs, and the gaps are not obscure — they are exactly the
 * ones the most popular extensions are built on.
 */
export const ExtensionGapSchema = z.object({
  /** The manifest key or permission that will not be honoured. */
  capability: z.string(),
  /** Plain-language consequence, shown next to the extension. */
  detail: z.string()
})
export type ExtensionGap = z.infer<typeof ExtensionGapSchema>

export const LoadedExtensionSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  path: z.string(),
  manifestVersion: z.number().int(),
  /** Empty when nothing it asked for is missing. */
  gaps: z.array(ExtensionGapSchema),
  /** Set when the folder failed to load at all. */
  error: z.string().nullable()
})
export type LoadedExtension = z.infer<typeof LoadedExtensionSchema>

export const ExtensionsStatusSchema = z.object({
  extensions: z.array(LoadedExtensionSchema),
  /**
   * Whether this build can load extensions at all.
   *
   * False in a private window's session, where loading one would outlive the
   * window's promise to record nothing.
   */
  supported: z.boolean()
})
export type ExtensionsStatus = z.infer<typeof ExtensionsStatusSchema>
