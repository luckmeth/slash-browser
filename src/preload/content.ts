import { ipcRenderer } from 'electron'
import { countsAsUnsavedWork } from '../shared/unsavedInput'

/**
 * Preload for web content. Runs in every page the user visits.
 *
 * It exposes NOTHING to the page — no `contextBridge.exposeInMainWorld`, no
 * bridge object of any kind. A page gets the web platform and nothing more.
 *
 * It sends exactly one kind of message, one-way, on one channel. The main
 * process treats that payload as untrusted input and validates it as carefully
 * as anything arriving from the network: a compromised renderer can say whatever
 * it likes here, and the worst it can achieve is keeping its own tab awake.
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
  ipcRenderer.send(CONTENT_STATE_CHANNEL, { hasUnsavedInput })
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
