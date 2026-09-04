/**
 * Keyboard accelerators, in the form Electron accepts.
 *
 * In `shared/` because both sides need the identical rules: the settings screen
 * decides whether to show "that cannot be used" as you press, and the main
 * process decides whether to hand the string to `Menu.setApplicationMenu`. Two
 * copies of this would eventually disagree, and the disagreement would show up
 * as a shortcut the UI accepted and the menu then threw on — taking every
 * shortcut in the browser down with it.
 *
 * Zero imports, deliberately. This is reachable from the renderer.
 */

/** Modifier names Electron accepts. */
const MODIFIERS = [
  'CommandOrControl',
  'Control',
  'Alt',
  'AltGr',
  'Shift',
  'Super',
  'Meta'
] as const

const NAMED_KEYS = new Set([
  'Plus', 'Space', 'Tab', 'Capslock', 'Numlock', 'Scrolllock', 'Backspace', 'Delete', 'Insert',
  'Return', 'Enter', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Escape',
  'Esc', 'VolumeUp', 'VolumeDown', 'VolumeMute', 'MediaNextTrack', 'MediaPreviousTrack',
  'MediaStop', 'MediaPlayPause', 'PrintScreen'
])

const isFunctionKey = (key: string): boolean => /^F([1-9]|1[0-9]|2[0-4])$/.test(key)
const isSingleChar = (key: string): boolean => /^[A-Z0-9]$/.test(key)

/**
 * Whether Electron will accept this string, and whether it is safe to bind.
 *
 * Two rejections matter beyond mere syntax:
 *
 *  - **A bare letter or digit.** `T` with no modifier would fire while the user
 *    is typing into a page, making the browser unusable in a way that is very
 *    hard to attribute back to a settings screen.
 *  - **An unknown key name.** Electron throws on `Menu.setApplicationMenu` for a
 *    malformed accelerator, and that throw takes the entire menu — and therefore
 *    every shortcut in the browser — with it.
 */
export function isValidAccelerator(accelerator: string): boolean {
  const parts = accelerator.split('+').filter((part) => part !== '')
  if (parts.length === 0) return false

  const key = parts[parts.length - 1]!
  const mods = parts.slice(0, -1)

  if (mods.some((mod) => !MODIFIERS.includes(mod as (typeof MODIFIERS)[number]))) return false
  if (new Set(mods).size !== mods.length) return false

  const keyIsNamed = NAMED_KEYS.has(key) || isFunctionKey(key)
  if (!keyIsNamed && !isSingleChar(key)) return false

  // Function keys and named keys stand alone safely; a letter or digit must
  // carry a modifier or it fires mid-sentence on every web page.
  if (isSingleChar(key) && mods.length === 0) return false

  return true
}

/**
 * An Electron accelerator from a keydown, or null if the press is not one.
 *
 * `event.key` rather than `event.code`, so a binding matches the character
 * printed on the key the user actually pressed rather than its position on a US
 * keyboard.
 */
export function acceleratorFromEvent(event: {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}): string | null {
  const raw = event.key
  if (raw === 'Control' || raw === 'Alt' || raw === 'Shift' || raw === 'Meta') return null

  const parts: string[] = []
  if (event.ctrlKey || event.metaKey) parts.push('CommandOrControl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')

  let key: string
  if (raw === ' ') key = 'Space'
  else if (raw === 'ArrowUp') key = 'Up'
  else if (raw === 'ArrowDown') key = 'Down'
  else if (raw === 'ArrowLeft') key = 'Left'
  else if (raw === 'ArrowRight') key = 'Right'
  else if (raw.length === 1) key = raw.toUpperCase()
  else key = raw.charAt(0).toUpperCase() + raw.slice(1)

  parts.push(key)
  const accelerator = parts.join('+')
  return isValidAccelerator(accelerator) ? accelerator : null
}

/** `CommandOrControl+Shift+A` → `Ctrl + Shift + A`, which is what the key says. */
export function prettifyAccelerator(accelerator: string): string {
  return accelerator.replace(/CommandOrControl/g, 'Ctrl').split('+').join(' + ')
}
