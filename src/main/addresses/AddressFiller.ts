import type { WebContents } from 'electron'
import { fillableKinds, valueFor, type AddressFieldKind, type SavedAddress } from '@shared/addressFields'
import { CONTENT_COMMAND_CHANNEL } from '../tabs/contentSignals'
import { createLogger } from '../logger'

const log = createLogger('addresses')

/**
 * Types a saved address into a page.
 *
 * Exactly the route `LoginFiller` takes, and for the same reasons. Two obvious
 * alternatives are both worse:
 *
 *  - `executeJavaScript` would put the user's home address into script source
 *    running in the page's own world.
 *  - Sending the value to the content preload would hand it to a process that
 *    is running untrusted web content.
 *
 * So the command carries only *which field to focus*, and the text goes in
 * through `webContents.insertText` — Chromium's own input pipeline, the same
 * path a keystroke takes.
 */
export class AddressFiller {
  /**
   * @returns how many fields were filled.
   *
   * A short delay between fields: `insertText` is asynchronous with respect to
   * the focus command, and sites that reformat as you type (postcodes, phone
   * numbers) drop characters when the next field is focused too soon.
   */
  async fill(
    contents: WebContents | null,
    address: SavedAddress,
    present: readonly AddressFieldKind[]
  ): Promise<number> {
    if (!contents || contents.isDestroyed()) return 0

    const kinds = fillableKinds(address, present)
    let filled = 0

    for (const kind of kinds) {
      const value = valueFor(address, kind)
      if (value.trim() === '') continue

      try {
        contents.send(CONTENT_COMMAND_CHANNEL, { kind: 'focus-address-field', which: kind })
        await pause(35)
        contents.insertText(value)
        await pause(35)
        filled += 1
      } catch (error) {
        log.warn(`could not fill the ${kind} field`, error)
      }
    }

    return filled
  }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
