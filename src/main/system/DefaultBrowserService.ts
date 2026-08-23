import { execFile } from 'node:child_process'
import { app, shell } from 'electron'
import type { SettingsStore } from '../settings/SettingsStore'
import { isSlashProgId, parseUserChoiceProgId, shouldOfferDefault } from './defaultBrowserRules'
import { createLogger } from '../logger'

/** Where Windows records the choice the user made in Settings. */
const USER_CHOICE_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice'

const log = createLogger('default-browser')

export interface DefaultBrowserStatus {
  /** Windows reports Slash as the current handler for `http`. */
  isDefault: boolean
  /** Whether the chrome should offer to change that right now. */
  shouldOffer: boolean
  /** False on a platform where none of this applies. */
  supported: boolean
}

/**
 * Making Slash the default browser — as far as the operating system permits.
 *
 * **Windows will not let an application make itself the default, and has not
 * since Windows 8.** The association lives in a `UserChoice` registry key signed
 * with a hash tied to the user and the ProgId; writing it from code is
 * explicitly a supported-configuration violation, and Windows silently reverts
 * associations set that way. Every browser you have ever installed hits this,
 * which is why every one of them shows a screen that ends in *"click Slash in
 * the list"*.
 *
 * So this does the two things that genuinely work, and says so plainly rather
 * than presenting a button that appears to do more:
 *
 *  1. The installer registers Slash under `StartMenuInternet` and
 *     `RegisteredApplications`, which is what makes it *appear* in Windows'
 *     Default apps screen at all. Without it the button below would open a list
 *     Slash is not in — worse than not offering.
 *  2. This opens that screen, deep-linked to Slash's own page on Windows 11.
 *
 * **Slash deliberately does not call `app.setAsDefaultProtocolClient`.** It
 * writes `HKCU\Software\Classes\http`, which does not change the default — and
 * a check that reads those keys then answers "yes, you are the default" purely
 * because we registered. That made the offer never appear, on every machine,
 * with nothing logged: a failure indistinguishable from the feature having been
 * forgotten. The registration belongs to the installer, and the question is
 * asked of `UserChoice`, which is the key Windows itself consults and the one
 * key nothing we run can write.
 */
export class DefaultBrowserService {
  constructor(private readonly settings: SettingsStore) {}

  /**
   * Refreshes the cached answer to "is Slash the default".
   *
   * Called at startup and after the user visits the Windows screen. Asynchronous
   * because it shells out to `reg`, and cached because `status()` is called from
   * the start page and the settings panel, which must answer immediately.
   */
  async refresh(): Promise<boolean> {
    if (process.platform !== 'win32') return false

    const progId = await readUserChoiceProgId()
    if (progId !== null) {
      this.cachedIsDefault = isSlashProgId(progId)
      log.debug(`http UserChoice is ${progId} — Slash ${this.cachedIsDefault ? 'is' : 'is not'} default`)
      return this.cachedIsDefault
    }

    // No UserChoice key at all: a machine where nothing has ever been chosen.
    // Electron's own check is the fallback and is not wrong here, because
    // nothing has contaminated it — Slash no longer writes those keys itself.
    this.cachedIsDefault = app.isDefaultProtocolClient('http')
    return this.cachedIsDefault
  }

  private cachedIsDefault = false

  status(now = Date.now()): DefaultBrowserStatus {
    if (process.platform !== 'win32') {
      return { isDefault: false, shouldOffer: false, supported: false }
    }

    const isDefault = this.cachedIsDefault
    const settings = this.settings.getAll()
    return {
      isDefault,
      supported: true,
      shouldOffer: shouldOfferDefault(
        {
          isDefault,
          asks: settings.defaultBrowserAsks,
          lastAskedAt: settings.defaultBrowserAskedAt,
          suppressed: settings.defaultBrowserSuppressed
        },
        now
      )
    }
  }

  /** The offer was shown. Recorded so it is not shown again tomorrow. */
  recordAsked(now = Date.now()): void {
    const settings = this.settings.getAll()
    this.settings.update({
      defaultBrowserAsks: settings.defaultBrowserAsks + 1,
      defaultBrowserAskedAt: now
    })
  }

  /** "Don't ask again." Honoured permanently. */
  suppress(): void {
    this.settings.update({ defaultBrowserSuppressed: true })
  }

  /**
   * Opens Windows' Default apps screen.
   *
   * The deep link with `registeredAppUser` lands on Slash's own page on Windows
   * 11 22H2 and later. Older builds ignore the parameter and open the list,
   * which still works — so it is tried without a version check, and the plain
   * URI is the fallback if the shell refuses the first outright.
   */
  async openSystemSettings(): Promise<void> {
    if (process.platform !== 'win32') return
    try {
      await shell.openExternal('ms-settings:defaultapps?registeredAppUser=Slash')
    } catch {
      await shell.openExternal('ms-settings:defaultapps')
    }
  }
}

/**
 * Reads `UserChoice\ProgId` for `http`, or null if the key is not there.
 *
 * `reg.exe` rather than a native registry module: this project cannot add a
 * module that needs compiling (node-gyp refuses paths containing a space), and
 * one 40ms subprocess at startup is a fair price for the only answer Windows
 * actually honours.
 *
 * Never throws. A missing key, a locked registry, or `reg` being absent all
 * mean "we do not know", and the caller falls back rather than failing.
 */
function readUserChoiceProgId(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', USER_CHOICE_KEY, '/v', 'ProgId'],
      { timeout: 4000, windowsHide: true },
      (error, stdout) => {
        if (error && !stdout) {
          resolve(null)
          return
        }
        resolve(parseUserChoiceProgId(stdout))
      }
    )
  })
}
