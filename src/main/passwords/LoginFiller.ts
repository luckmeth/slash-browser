import type { WebContents } from 'electron'
import { CONTENT_COMMAND_CHANNEL } from '../tabs/contentSignals'
import { createLogger } from '../logger'
import type { PasswordVault } from './PasswordVault'

const log = createLogger('vault')

/**
 * Types a saved sign-in into a page.
 *
 * **How the password reaches the page, and why this way.**
 *
 * The obvious implementations are both wrong for this browser:
 *
 *  - `executeJavaScript("field.value = '...'")` puts the password into a string
 *    of source code executed in the page's own world. It is also the mechanism
 *    the YouTube filter uses, which CLAUDE.md records as the *only* main-world
 *    execution in Slash — widening that to "and also passwords" is not a change
 *    worth making for a fill.
 *  - Sending the password to the content preload over IPC hands it to a process
 *    hosting untrusted web content, for no gain: the page is where it ends up
 *    either way, but this route also puts it on our own IPC surface.
 *
 * Instead the preload is asked to *focus* the field it already found — a
 * command carrying no secret and no description of the page — and the value
 * goes in through `webContents.insertText`, which is Chromium's own input
 * pipeline. The page sees ordinary keystrokes, so framework-controlled inputs
 * (React and friends) update correctly, and the password never exists as script
 * source, as an IPC payload, or in any renderer we control.
 */
export class LoginFiller {
  constructor(private readonly vault: PasswordVault) {}

  /**
   * Fills one saved sign-in into the given page.
   *
   * @returns why it failed, or null on success.
   */
  async fill(
    contents: WebContents,
    loginId: number,
    form: { hasUsernameField: boolean; hasPasswordField: boolean }
  ): Promise<string | null> {
    if (contents.isDestroyed()) return 'That tab is gone.'
    if (!form.hasPasswordField) return 'There is no sign-in field on this page.'

    const login = this.vault.list().find((entry) => entry.id === loginId)
    if (!login) return 'That saved sign-in no longer exists.'

    const password = this.vault.passwordFor(loginId)
    if (password === null) {
      return 'Slash could not read that saved password. It may have been saved by a different Windows account.'
    }

    try {
      if (form.hasUsernameField && login.username !== '') {
        contents.send(CONTENT_COMMAND_CHANNEL, { kind: 'focus-login-field', which: 'username' })
        // The focus has to land before the text is inserted; these are separate
        // trips into the renderer and there is no acknowledgement to wait on.
        await delay(60)
        contents.insertText(login.username)
      }

      contents.send(CONTENT_COMMAND_CHANNEL, { kind: 'focus-login-field', which: 'password' })
      await delay(60)
      contents.insertText(password)
    } finally {
      // The local binding is the only decrypted copy; nothing here keeps one.
      // Deliberately not logged, not returned, and not cached.
    }

    this.vault.markUsed(loginId)
    log.info(`filled a saved sign-in for ${login.host}`)
    return null
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
