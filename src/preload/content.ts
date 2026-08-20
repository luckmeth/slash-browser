import { ipcRenderer } from 'electron'
import { countsAsUnsavedWork } from '../shared/unsavedInput'

/** Kept in step with `main/tabs/contentSignals.ts`. Duplicated as a literal so
 * this bundle stays free of imports that would drag zod into a preload. */
const CONTENT_COMMAND_CHANNEL = 'content:command'

/**
 * Preload for web content. Runs in every page the user visits.
 *
 * It exposes NOTHING to the page — no `contextBridge.exposeInMainWorld`, no
 * bridge object of any kind. A page gets the web platform and nothing more.
 *
 * It sends a small set of messages on one channel, and accepts one command back.
 * The main process treats every payload as untrusted input and validates it as
 * carefully as anything arriving from the network: a compromised renderer can
 * say whatever it likes here, and the worst it can achieve is keeping its own
 * tab awake.
 *
 * The one inbound command is "focus the sign-in field you already found". It
 * carries no secret. Passwords are never sent here — filling happens through
 * `webContents.insertText` in the main process, so the value travels Chromium's
 * own input pipeline instead of an IPC payload or a string of injected script.
 *
 * ------------------------------------------------------------------------
 * IT NEVER READS WHAT THE USER TYPED.
 *
 * This file runs on every page, including sign-in forms and payment pages. An
 * earlier version answered "does this tab hold unsaved work?" by walking every
 * `input` and `textarea` and comparing `field.value` to `field.defaultValue` —
 * password fields included. The boolean it derived was all that crossed IPC, but
 * the *capability* was there in a script injected into every page in the
 * browser, and a bug or a future edit in this file would have been a credential
 * disclosure rather than a wrong sleep decision.
 *
 * The signal is now the `input` event itself. That an event fired tells us the
 * user edited something; the target's tag and type tell us whether the edit was
 * text. Neither requires reading a value, so this file has no access to page
 * contents to leak. It is also strictly more accurate: script assigning
 * `element.value` does not fire an `input` event, so a prefilled form no longer
 * registers as unsaved work the way a value/defaultValue comparison could.
 * ------------------------------------------------------------------------
 */

/** Page → main only. Never used for anything privileged. */
const CONTENT_STATE_CHANNEL = 'content:state'

/** Reporting is throttled; typing must not produce an IPC message per keystroke. */
const REPORT_INTERVAL_MS = 1500

let hasUnsavedInput = false
let lastReported: string | null = null
let timer: ReturnType<typeof setTimeout> | null = null

function report(): void {
  // Only the boolean crosses the boundary. There is no code path in this file
  // that can read field contents, so there is nothing else it could carry.
  const payload = JSON.stringify({ hasUnsavedInput })
  if (payload === lastReported) return
  lastReported = payload
  ipcRenderer.send(CONTENT_STATE_CHANNEL, { kind: 'unsaved-input', hasUnsavedInput })
}

/**
 * Trusted user gestures, for Slash Shield's popup guard.
 *
 * `setWindowOpenHandler` in the main process receives no activation flag, so
 * without this a browser cannot tell the popup you asked for from the one the
 * page opened while you were reading. This reports *that* a real click or
 * keypress happened and nothing else — no coordinates, no target element, no
 * key, no content. The main process timestamps it on arrival rather than
 * trusting a time from the page.
 *
 * `event.isTrusted` is the whole point: it is false for anything script
 * dispatched, so a page cannot manufacture consent for its own popup by firing
 * a synthetic click first.
 */
const GESTURE_THROTTLE_MS = 250
let lastGestureSent = 0

function reportGesture(event: Event): void {
  if (!event.isTrusted) return
  const now = Date.now()
  if (now - lastGestureSent < GESTURE_THROTTLE_MS) return
  lastGestureSent = now
  ipcRenderer.send(CONTENT_STATE_CHANNEL, { kind: 'user-gesture' })
}

for (const type of ['pointerdown', 'keydown', 'click'] as const) {
  document.addEventListener(type, reportGesture, { capture: true, passive: true })
}

function scheduleReport(): void {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    report()
  }, REPORT_INTERVAL_MS)
}

/** Describes the edited element by shape alone — tag, type, editability. */
function onEdit(event: Event): void {
  if (hasUnsavedInput) return

  const target = event.target
  if (!(target instanceof HTMLElement)) return

  const inputType = target instanceof HTMLInputElement ? target.type : undefined
  const disabled =
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      ? target.disabled
      : false
  const readOnly =
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      ? target.readOnly
      : false

  if (
    countsAsUnsavedWork({
      tagName: target.tagName,
      inputType,
      isContentEditable: target.isContentEditable,
      disabled,
      readOnly
    })
  ) {
    hasUnsavedInput = true
    scheduleReport()
  }
}

function clearUnsaved(): void {
  if (!hasUnsavedInput) return
  hasUnsavedInput = false
  scheduleReport()
}

// Capture phase so a page that stops propagation cannot hide typing from us.
document.addEventListener('input', onEdit, true)

// Submitted or reset work is no longer unsaved. A same-document navigation in an
// SPA is not treated as a save — the text may well still be on screen.
document.addEventListener('submit', clearUnsaved, true)
document.addEventListener('reset', clearUnsaved, true)

// A fresh document gets a fresh preload, so the initial false needs stating once
// for tabs the user opens and never types into.
window.addEventListener('DOMContentLoaded', () => report())

/**
 * Known limitation, deliberately chosen in the safe direction: typing into a
 * field and then deleting it again still reports unsaved work, because clearing
 * would require reading the value to know the field is now empty. The cost is a
 * tab that stays awake when it did not need to. The alternative cost is reading
 * everything the user types, which is not a trade this browser makes.
 */


/* ------------------------------------------------------------------------
 * Sign-in forms.
 *
 * Reports only that a password field EXISTS, never what is in it — the same
 * rule as the unsaved-input signal above, and for the same reason: this file
 * runs on every sign-in page there is. `type="password"` is a structural fact
 * about the document, which is all that leaves.
 *
 * The element references stay here. Main asks to focus "the password field"
 * rather than naming one, so no description of the page crosses either way.
 * ---------------------------------------------------------------------- */

let usernameField: HTMLInputElement | null = null
let passwordField: HTMLInputElement | null = null

/**
 * The username input belonging to a password field.
 *
 * Taken as the nearest preceding text-ish input inside the same form, which is
 * how sign-in forms are almost always built. When there is no form element the
 * document order is used instead, which covers the div-based ones.
 */
function findUsernameFor(password: HTMLInputElement): HTMLInputElement | null {
  const scope: ParentNode = password.form ?? document
  const candidates = [...scope.querySelectorAll('input')].filter((input) => {
    const type = (input.getAttribute('type') ?? 'text').toLowerCase()
    return type === 'text' || type === 'email' || type === 'tel' || type === ''
  })
  if (candidates.length === 0) return null

  // The last candidate before the password field, which beats "the first text
  // input on the page" on sites that put a search box in the header.
  let best: HTMLInputElement | null = null
  for (const candidate of candidates) {
    const position = candidate.compareDocumentPosition(password)
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) best = candidate
  }
  return best ?? candidates[0] ?? null
}

function scanLoginForm(): void {
  const password = document.querySelector<HTMLInputElement>('input[type="password"]')
  passwordField = password
  usernameField = password ? findUsernameFor(password) : null

  ipcRenderer.send(CONTENT_STATE_CHANNEL, {
    kind: 'login-form',
    hasPasswordField: password !== null,
    hasUsernameField: usernameField !== null
  })
}

/**
 * Focuses a field and selects whatever is already in it.
 *
 * Selecting matters: `insertText` inserts at the cursor, so without this a
 * second attempt would append to the first rather than replace it. Selecting is
 * not reading — the value is never inspected, only replaced.
 */
ipcRenderer.on(CONTENT_COMMAND_CHANNEL, (_event, raw: unknown) => {
  const command = raw as { kind?: string; which?: string } | null
  if (!command || command.kind !== 'focus-login-field') return

  const field = command.which === 'username' ? usernameField : passwordField
  if (!field || !field.isConnected) return
  field.focus()
  field.select()
})

// Sign-in forms often appear after the initial parse — a modal, a route change,
// a lazily hydrated component — so the document is rescanned as it settles
// rather than only once.
window.addEventListener('DOMContentLoaded', scanLoginForm)
window.addEventListener('load', scanLoginForm)
document.addEventListener('focusin', (event) => {
  // Cheap and well-timed: clicking into a sign-in form is exactly when the
  // fields are known to exist, and it costs nothing on pages without one.
  if ((event.target as HTMLElement | null)?.tagName === 'INPUT') scanLoginForm()
})
