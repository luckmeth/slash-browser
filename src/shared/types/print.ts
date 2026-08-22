import { z } from 'zod'

/**
 * What the print preview is showing, and therefore what will print.
 *
 * The preview renders with exactly these choices, so the two cannot disagree —
 * which is the entire value of having a preview at all.
 */
export const PaperSizeSchema = z.enum(['A4', 'A3', 'Letter', 'Legal', 'Tabloid'])
export type PaperSize = z.infer<typeof PaperSizeSchema>

export const PrintChoicesSchema = z.object({
  landscape: z.boolean().default(false),
  paperSize: PaperSizeSchema.default('A4'),
  /** Percent; 100 is actual size. Clamped to 10–200 before use. */
  scale: z.number().default(100),
  /**
   * Off by default, as in every other browser. Backgrounds turn a readable
   * article into a solid block of toner, and whoever wants them knows they do.
   */
  printBackground: z.boolean().default(false),
  headerFooter: z.boolean().default(false),
  copies: z.number().int().default(1),
  /** Empty means every page. `"1-3, 5, 8-"` is understood. */
  pageRangeText: z.string().default('')
})
export type PrintChoices = z.infer<typeof PrintChoicesSchema>

export const PrintPreviewSchema = z.object({
  /** A file:// path to the rendered PDF, shown in Chromium's own viewer. */
  path: z.string(),
  /**
   * Null when it could not be determined.
   *
   * Reported honestly rather than guessed: a wrong count would clamp a valid
   * page range to nothing, and the wrong pages would print with no explanation.
   */
  pageCount: z.number().int().nullable(),
  /** The page being printed, for the title and the suggested filename. */
  title: z.string()
})
export type PrintPreview = z.infer<typeof PrintPreviewSchema>
