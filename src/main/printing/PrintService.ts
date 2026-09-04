import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { app, dialog, type BaseWindow, type WebContents } from 'electron'
import { countPdfPages } from './pdfPageCount'
import { toPdfOptions, toPrintOptions, type PrintChoices } from './printOptions'
import { createLogger } from '../logger'

const log = createLogger('print')

/**
 * Print preview.
 *
 * Slash previously called `webContents.print()`, which hands straight to the
 * operating system's dialog — no preview, no page range, no scale, and no way to
 * find out you were about to print forty pages of navigation furniture until it
 * was coming out of the tray.
 *
 * The preview is a real render: `printToPDF` with the same choices the print
 * will use, written to a temp file and shown in Chromium's own PDF viewer. It is
 * genuinely what will print, not an approximation of it — which matters, because
 * the entire value of a preview is that it does not lie.
 */
export class PrintService {
  /** Temp files written this session, deleted on quit and when replaced. */
  private previews = new Map<string, string>()

  /**
   * Renders a preview and returns where it was written.
   *
   * @returns the file path and page count, or null if the page could not render.
   *   Page count is null when it cannot be determined — the UI then omits the
   *   "of N" rather than showing a number that might clamp a range wrongly.
   */
  async preview(
    key: string,
    contents: WebContents | null,
    choices: PrintChoices
  ): Promise<{ path: string; pageCount: number | null } | null> {
    if (!contents || contents.isDestroyed()) return null

    try {
      const pdf = await contents.printToPDF(toPdfOptions(choices))
      const path = join(app.getPath('temp'), `slash-preview-${key}.pdf`)
      await writeFile(path, pdf)

      // Replacing an earlier preview for the same window: the old file is the
      // same path, so nothing leaks, but the map is kept so quit can clean up.
      this.previews.set(key, path)

      return { path, pageCount: countPdfPages(pdf) }
    } catch (error) {
      log.warn('could not render a print preview', error)
      return null
    }
  }

  /**
   * Sends the page to a printer.
   *
   * Never silent. A print that starts without the operating system's dialog is
   * a print nobody can cancel, and this is the one action in the browser that
   * consumes something the user cannot get back.
   */
  async print(
    contents: WebContents | null,
    choices: PrintChoices,
    pageCount: number
  ): Promise<{ ok: boolean; reason: string }> {
    if (!contents || contents.isDestroyed()) return { ok: false, reason: 'That page has gone.' }

    return new Promise((resolve) => {
      contents.print(toPrintOptions(choices, pageCount), (success, failureReason) => {
        // `success: false` with no reason is the user pressing Cancel, which is
        // not a failure and must not be reported as one.
        if (!success && failureReason) log.warn(`print failed: ${failureReason}`)
        resolve({ ok: success, reason: success ? '' : (failureReason ?? '') })
      })
    })
  }

  /** Saves the same render the preview showed, as a PDF the user chooses a home for. */
  async saveAsPdf(
    window: BaseWindow,
    contents: WebContents | null,
    choices: PrintChoices,
    suggestedName: string
  ): Promise<{ ok: boolean; path: string }> {
    if (!contents || contents.isDestroyed()) return { ok: false, path: '' }

    const result = await dialog.showSaveDialog(window, {
      title: 'Save as PDF',
      defaultPath: `${sanitise(suggestedName)}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (result.canceled || !result.filePath) return { ok: false, path: '' }

    try {
      const pdf = await contents.printToPDF(toPdfOptions(choices))
      await writeFile(result.filePath, pdf)
      return { ok: true, path: result.filePath }
    } catch (error) {
      log.warn('could not save the PDF', error)
      return { ok: false, path: '' }
    }
  }

  /** Removes the temp previews. Called at quit; failures are not worth reporting. */
  async cleanup(): Promise<void> {
    for (const path of this.previews.values()) {
      await unlink(path).catch(() => {})
    }
    this.previews.clear()
  }
}

/** A page title is not a filename. Strips what Windows refuses and trims the length. */
function sanitise(title: string): string {
  // Windows refuses these outright; control characters are stripped too, since
  // a page title is arbitrary text from a web page and not a filename.
  // Control characters are dropped by code point rather than by regex: a
  // character class containing literal control bytes is unreadable in source
  // and is exactly what no-control-regex exists to catch.
  const printable = Array.from(title)
    .filter((character) => character.charCodeAt(0) > 31)
    .join('')
  const cleaned = printable
    .replace(/[<>:"/\\|?*]/g, '')

    .replace(/\s+/g, ' ')
    .trim()
  return cleaned === '' ? 'page' : cleaned.slice(0, 80)
}
