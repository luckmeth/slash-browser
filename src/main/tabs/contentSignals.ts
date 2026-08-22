import { ipcMain, type IpcMainEvent } from 'electron'
import { z } from 'zod'
import { createLogger } from '../logger'
import type { Tab } from './Tab'

const log = createLogger('content')

/**
 * The one channel web content may send on.
 *
 * Kept out of `IpcRegistry` on purpose. That registry is the privileged surface:
 * it allowlists senders and refuses anything that is not our own chrome or
 * overlay view. This is the opposite case — the sender IS untrusted web content,
 * by design — so it gets its own listener with its own rules:
 *
 *   - one-way `send`, never `invoke`; there is no reply channel to abuse
 *   - the payload is schema-validated and reduced to a single boolean
 *   - the message can only ever affect the tab it came from, resolved by
 *     WebContents id rather than by anything the payload claims
 *
 * Worst case for a fully compromised renderer: it keeps its own tab awake.
 */
const CONTENT_STATE_CHANNEL = 'content:state'

/**
 * Main → page-preload commands.
 *
 * The only command is "focus one of the login fields you already found", which
 * carries no secret and no description of the page. Filling then happens
 * through `webContents.insertText`, so the password travels the browser's own
 * input pipeline rather than an IPC payload or a string of injected script.
 */
export const CONTENT_COMMAND_CHANNEL = 'content:command'

const ContentStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unsaved-input'), hasUnsavedInput: z.boolean() }),
  // Carries no data at all. The fact of the message is the signal, and the time
  // is taken here rather than from the page — a renderer does not get to claim
  // when it was clicked.
  z.object({ kind: z.literal('user-gesture') }),
  // Whether this page has a sign-in form. Booleans only — the preload reports
  // that fields exist, never what is in them.
  z.object({
    kind: z.literal('login-form'),
    hasPasswordField: z.boolean(),
    hasUsernameField: z.boolean()
  }),
  // Which KINDS of address field this page has — never their contents. The
  // preload holds the element references; main only ever learns that a "city"
  // box exists somewhere on the page.
  z.object({
    kind: z.literal('address-form'),
    fields: z.array(z.string().max(40)).max(30)
  })
])

export type ResolveTabBySender = (webContentsId: number) => Tab | null

export interface ContentSignalHooks {
  /** A trusted click or keypress happened in this tab. */
  onUserGesture?: (webContentsId: number) => void
  /** This page has (or no longer has) a sign-in form. */
  onLoginForm?: (
    webContentsId: number,
    form: { hasPasswordField: boolean; hasUsernameField: boolean }
  ) => void
  /** Which kinds of address field this page offers. */
  onAddressForm?: (webContentsId: number, fields: readonly string[]) => void
}

export function installContentSignalListener(
  resolveTab: ResolveTabBySender,
  hooks: ContentSignalHooks = {}
): () => void {
  const listener = (event: IpcMainEvent, raw: unknown): void => {
    const parsed = ContentStateSchema.safeParse(raw)
    if (!parsed.success) {
      log.warn(`malformed content:state from wc=${event.sender.id}`)
      return
    }

    // Identity comes from the sender, never from the payload. A page cannot
    // name another tab.
    const tab = resolveTab(event.sender.id)
    if (!tab) return

    if (parsed.data.kind === 'user-gesture') {
      hooks.onUserGesture?.(event.sender.id)
      return
    }

    if (parsed.data.kind === 'login-form') {
      hooks.onLoginForm?.(event.sender.id, {
        hasPasswordField: parsed.data.hasPasswordField,
        hasUsernameField: parsed.data.hasUsernameField
      })
      return
    }

    if (parsed.data.kind === 'address-form') {
      hooks.onAddressForm?.(event.sender.id, parsed.data.fields)
      return
    }

    tab.setHasUnsavedInput(parsed.data.hasUnsavedInput)
  }

  ipcMain.on(CONTENT_STATE_CHANNEL, listener)
  return () => ipcMain.removeListener(CONTENT_STATE_CHANNEL, listener)
}
