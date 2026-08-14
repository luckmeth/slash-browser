import { ipcRenderer } from 'electron'

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
 */

/** Page → main only. Never used for anything privileged. */
const CONTENT_STATE_CHANNEL = 'content:state'

/** Reporting is throttled; typing must not produce an IPC message per keystroke. */
const REPORT_INTERVAL_MS = 1500

let hasUnsavedInput = false
let lastReported: string | null = null
let timer: ReturnType<typeof setTimeout> | null = null

/**
 * Whether the page holds text the user would lose.
 *
 * This is readable from the preload because `contextIsolation` separates the two
 * JavaScript contexts but they share one DOM — `input.value` reflects what the
 * user actually typed.
 *
 * Deliberately ignores fields the user did not fill in themselves: a page that
 * ships a prefilled hidden input is not unsaved work, and treating it as such
 * would make every tab permanently un-hibernatable.
 */
function detectUnsavedInput(): boolean {
  const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input, textarea'
  )
  for (const field of fields) {
    if (field.disabled || field.readOnly) continue
    if (field instanceof HTMLInputElement) {
      const type = field.type.toLowerCase()
      // Buttons and checkboxes carry no typed text to lose.
      if (['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file'].includes(type))
        continue
      // Password fields count: losing a half-typed password is still losing work,
      // and the *value* never leaves the page — only the boolean does.
      if (field.value !== field.defaultValue && field.value.length > 0) return true
    } else if (field.value !== field.defaultValue && field.value.length > 0) {
      return true
    }
  }

  for (const editable of document.querySelectorAll<HTMLElement>('[contenteditable="true"]')) {
    if ((editable.textContent ?? '').trim().length > 0) return true
  }

  return false
}

function report(): void {
  const next = detectUnsavedInput()
  hasUnsavedInput = next

  // Only the boolean crosses the boundary — never field contents.
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

// Capture phase so a page that stops propagation cannot hide typing from us.
document.addEventListener('input', scheduleReport, true)
document.addEventListener('change', scheduleReport, true)
document.addEventListener(
  'submit',
  () => {
    // Submitted work is no longer unsaved.
    hasUnsavedInput = false
    lastReported = null
    scheduleReport()
  },
  true
)

window.addEventListener('DOMContentLoaded', () => report())

/**
 * Later phases add to this file, always as one-way page → main messages:
 *   - Phase 5: Readability extraction, gated on the user's indexing settings.
 *   - Phase 6: scroll position capture and restore across a snapshot.
 *
 * None of them may ever reach the privileged `invoke` surface in `chrome.ts`.
 */
