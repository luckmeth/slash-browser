import { app, shell } from 'electron'
import type { SettingsStore } from '../settings/SettingsStore'
import { shouldOfferDefault } from './defaultBrowserRules'
import { createLogger } from '../logger'

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
 * `app.setAsDefaultProtocolClient` is still called, because it registers the
 * per-user protocol handler that makes the entry complete. It does not change
 * the default, and no copy here claims it does.
 */
export class DefaultBrowserService {
  constructor(private readonly settings: SettingsStore) {}

  /**
   * Registers Slash as a handler for `http`/`https`.
   *
   * Called at startup, not only when the user asks: a browser installed by
   * copying a folder, or run from a development build, was never through the
   * installer and would otherwise be invisible to the whole mechanism.
   *
   * Explicitly **not** a way of becoming the default. It only makes Slash
   * eligible to be chosen.
   */
  register(): void {
    if (process.platform !== 'win32') return
    for (const scheme of ['http', 'https']) {
      if (!app.setAsDefaultProtocolClient(scheme)) {
        log.debug(`could not register as a handler for ${scheme}`)
      }
    }
  }

  status(now = Date.now()): DefaultBrowserStatus {
    if (process.platform !== 'win32') {
      return { isDefault: false, shouldOffer: false, supported: false }
    }

    const isDefault = app.isDefaultProtocolClient('http')
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
