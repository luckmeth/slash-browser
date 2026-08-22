import { describe, it, expect } from 'vitest'
import {
  acceleratorFromEvent,
  applyOverrides,
  collectShortcuts,
  commandId,
  findConflicts,
  isValidAccelerator,
  pruneOverrides,
  type MenuNode
} from './shortcutMap'

const template: MenuNode[] = [
  {
    label: '&File',
    submenu: [
      { label: 'New Tab', accelerator: 'CommandOrControl+T' },
      { label: 'New Window', accelerator: 'CommandOrControl+N' },
      { label: 'Exit', role: 'quit' }
    ]
  },
  {
    label: '&View',
    submenu: [
      { label: 'Find in Page…', accelerator: 'CommandOrControl+F' },
      { label: 'Reader Mode', accelerator: 'F9' },
      { type: 'separator' } as MenuNode
    ]
  }
]

describe('commandId', () => {
  it('derives a stable id from the menu path', () => {
    expect(commandId('&File', 'New Tab')).toBe('file:new-tab')
  })

  it('ignores the mnemonic ampersand and a trailing ellipsis', () => {
    // Otherwise "Find in Page…" and "Find in Page" would be different commands,
    // and adding an ellipsis to a label would orphan the user's binding.
    expect(commandId('&View', 'Find in Page…')).toBe('view:find-in-page')
    expect(commandId('View', 'Find in Page')).toBe('view:find-in-page')
  })
})

describe('collectShortcuts', () => {
  it('lists only items that already have an accelerator', () => {
    // A command with no default is not offered for binding: inventing keys for
    // it would be this module, rather than the menu, deciding what the browser
    // can do.
    const rows = collectShortcuts(template)
    expect(rows.map((row) => row.id)).toEqual([
      'file:new-tab',
      'file:new-window',
      'view:find-in-page',
      'view:reader-mode'
    ])
  })

  it('reports the bound accelerator and the default separately', () => {
    const rows = collectShortcuts(template, { 'file:new-tab': 'CommandOrControl+Alt+T' })
    const newTab = rows.find((row) => row.id === 'file:new-tab')
    expect(newTab?.accelerator).toBe('CommandOrControl+Alt+T')
    expect(newTab?.defaultAccelerator).toBe('CommandOrControl+T')
  })
})

describe('applyOverrides', () => {
  it('rebinds only the overridden item', () => {
    const result = applyOverrides(template, { 'view:reader-mode': 'F8' })
    expect(result[1]?.submenu?.[1]?.accelerator).toBe('F8')
    expect(result[0]?.submenu?.[0]?.accelerator).toBe('CommandOrControl+T')
  })

  it('does not mutate the template it was given', () => {
    // The menu is rebuilt from source on every settings change. A mutating
    // version works right up until something caches the template.
    applyOverrides(template, { 'file:new-tab': 'CommandOrControl+Alt+T' })
    expect(template[0]?.submenu?.[0]?.accelerator).toBe('CommandOrControl+T')
  })

  it('leaves items without accelerators alone', () => {
    const result = applyOverrides(template, {})
    expect(result[0]?.submenu?.[2]).toEqual({ label: 'Exit', role: 'quit' })
  })
})

describe('isValidAccelerator', () => {
  it('accepts ordinary modified keys', () => {
    expect(isValidAccelerator('CommandOrControl+T')).toBe(true)
    expect(isValidAccelerator('CommandOrControl+Shift+A')).toBe(true)
    expect(isValidAccelerator('Alt+Left')).toBe(true)
  })

  it('accepts a bare function key', () => {
    expect(isValidAccelerator('F9')).toBe(true)
    expect(isValidAccelerator('F24')).toBe(true)
    expect(isValidAccelerator('F25')).toBe(false)
  })

  it('refuses a bare letter or digit', () => {
    // It would fire while somebody is typing into a web page, which makes the
    // browser unusable in a way nobody traces back to a settings screen.
    expect(isValidAccelerator('T')).toBe(false)
    expect(isValidAccelerator('5')).toBe(false)
  })

  it('refuses an unknown key name', () => {
    // Electron throws on setApplicationMenu for a malformed accelerator, which
    // would take the whole menu — and every shortcut in the browser — with it.
    expect(isValidAccelerator('CommandOrControl+Banana')).toBe(false)
    expect(isValidAccelerator('Ctrl+T')).toBe(false)
  })

  it('refuses a repeated modifier and an empty string', () => {
    expect(isValidAccelerator('Shift+Shift+T')).toBe(false)
    expect(isValidAccelerator('')).toBe(false)
    expect(isValidAccelerator('CommandOrControl+')).toBe(false)
  })
})

describe('acceleratorFromEvent', () => {
  const press = (over: Partial<Parameters<typeof acceleratorFromEvent>[0]>) =>
    acceleratorFromEvent({
      key: 'a',
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      ...over
    })

  it('builds an accelerator from a modified press', () => {
    expect(press({ key: 'k', ctrlKey: true })).toBe('CommandOrControl+K')
    expect(press({ key: 'A', ctrlKey: true, shiftKey: true })).toBe('CommandOrControl+Shift+A')
  })

  it('names the arrow and space keys the way Electron does', () => {
    expect(press({ key: 'ArrowLeft', altKey: true })).toBe('Alt+Left')
    expect(press({ key: ' ', ctrlKey: true })).toBe('CommandOrControl+Space')
  })

  it('returns null while only a modifier is held', () => {
    // Recording starts the moment a key goes down, and the first key down is
    // almost always Ctrl. Treating that as the binding would capture every
    // attempt as "Control".
    expect(press({ key: 'Control', ctrlKey: true })).toBeNull()
    expect(press({ key: 'Shift', shiftKey: true })).toBeNull()
  })

  it('returns null for a press that would not be a safe binding', () => {
    expect(press({ key: 'a' })).toBeNull()
  })

  it('takes a bare function key', () => {
    expect(press({ key: 'F9' })).toBe('F9')
  })
})

describe('findConflicts', () => {
  const row = (id: string, accelerator: string) => ({
    id,
    group: 'File',
    label: id,
    accelerator,
    defaultAccelerator: accelerator
  })

  it('finds two commands sharing keys', () => {
    // Electron does not complain — it fires whichever item it reaches first and
    // the other command silently stops working.
    const conflicts = findConflicts([
      row('a', 'CommandOrControl+T'),
      row('b', 'CommandOrControl+T'),
      row('c', 'CommandOrControl+N')
    ])
    expect([...conflicts.keys()]).toEqual(['CommandOrControl+T'])
    expect(conflicts.get('CommandOrControl+T')).toEqual(['a', 'b'])
  })

  it('is empty when everything is distinct', () => {
    expect(findConflicts([row('a', 'CommandOrControl+T'), row('b', 'F9')]).size).toBe(0)
  })
})

describe('pruneOverrides', () => {
  const rows = collectShortcuts(template)

  it('drops a binding for a command that no longer exists', () => {
    expect(pruneOverrides({ 'file:removed-thing': 'F7' }, rows)).toEqual({})
  })

  it('drops an invalid accelerator rather than passing it to Electron', () => {
    expect(pruneOverrides({ 'file:new-tab': 'Ctrl+Banana' }, rows)).toEqual({})
  })

  it('drops a binding that merely restates the default', () => {
    // Keeping it would pin the shortcut to today's value and silently ignore a
    // future change to the default.
    expect(pruneOverrides({ 'file:new-tab': 'CommandOrControl+T' }, rows)).toEqual({})
  })

  it('keeps a genuine override', () => {
    expect(pruneOverrides({ 'view:reader-mode': 'F8' }, rows)).toEqual({ 'view:reader-mode': 'F8' })
  })
})
