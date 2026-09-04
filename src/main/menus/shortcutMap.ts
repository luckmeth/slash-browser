/**
 * Remapping keyboard shortcuts, as pure functions.
 *
 * Split out of `menu.ts` for the reason `PopupPolicy` is split out of
 * `PopupGuard`: that module imports `electron`, which the test runner cannot
 * load. What is left here is the part where being wrong is invisible — a
 * shortcut that silently stops working, or two commands quietly bound to the
 * same keys with only one of them ever firing.
 *
 * Overrides are keyed by a **derived** id rather than one written at each of the
 * 46 menu items. Deriving it from the menu path means new items get one for free
 * and none can be forgotten; the cost is that renaming a menu item orphans any
 * override saved against it, which `pruneOverrides` cleans up rather than
 * leaving to rot in the settings row.
 */

import { isValidAccelerator } from '@shared/keys'

// Re-exported so callers have one import for "shortcuts", while the rules
// themselves live in shared/ — the settings screen and the menu must agree on
// what is bindable, and two copies would eventually not.
export { acceleratorFromEvent, isValidAccelerator, prettifyAccelerator } from '@shared/keys'

/** The minimum shape of a menu template node, so this file need not import electron. */
export interface MenuNode {
  label?: string
  accelerator?: string
  submenu?: MenuNode[]
  role?: string
}

export interface ShortcutRow {
  /** Stable id derived from the menu path, e.g. `file:new-tab`. */
  id: string
  group: string
  label: string
  accelerator: string
  /** The accelerator this command ships with, whatever it is bound to now. */
  defaultAccelerator: string
}

export type Overrides = Readonly<Record<string, string>>

const slug = (value: string): string =>
  value
    .replace(/&/g, '')
    .replace(/[……]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/** `('&View', 'Reader Mode')` → `view:reader-mode`. */
export function commandId(group: string, label: string): string {
  return `${slug(group)}:${slug(label)}`
}

/**
 * Every remappable command in a menu template.
 *
 * Only items that already have an accelerator. A command with no default is not
 * offered for binding — giving one keys here would mean this file, rather than
 * the menu, deciding what the browser can do.
 */
export function collectShortcuts(template: readonly MenuNode[], overrides: Overrides = {}): ShortcutRow[] {
  const rows: ShortcutRow[] = []
  for (const top of template) {
    if (!top.label || !top.submenu) continue
    const group = top.label.replace(/&/g, '')
    for (const item of top.submenu) {
      if (!item.label || !item.accelerator) continue
      const id = commandId(group, item.label)
      rows.push({
        id,
        group,
        label: item.label.replace(/&/g, '').replace(/[……]/g, '').trim(),
        accelerator: overrides[id] ?? item.accelerator,
        defaultAccelerator: item.accelerator
      })
    }
  }
  return rows
}

/**
 * A copy of the template with overrides applied.
 *
 * Returns new objects rather than mutating: the template is rebuilt from source
 * on every settings change, and a mutating version would work exactly until
 * something cached it.
 */
export function applyOverrides<T extends MenuNode>(template: readonly T[], overrides: Overrides): T[] {
  return template.map((top) => {
    if (!top.label || !top.submenu) return { ...top }
    const group = top.label.replace(/&/g, '')
    return {
      ...top,
      submenu: top.submenu.map((item) => {
        if (!item.label || !item.accelerator) return { ...item }
        const custom = overrides[commandId(group, item.label)]
        return custom ? { ...item, accelerator: custom } : { ...item }
      })
    }
  }) as T[]
}

/**
 * Which commands would end up sharing keys.
 *
 * Electron does not complain about a duplicate accelerator — it simply fires
 * whichever menu item it reaches first, so the other command stops working with
 * no error anywhere. Detecting it is the only way the user finds out.
 *
 * @returns accelerator → the ids bound to it, for accelerators with more than one.
 */
export function findConflicts(rows: readonly ShortcutRow[]): Map<string, string[]> {
  const byAccelerator = new Map<string, string[]>()
  for (const row of rows) {
    const existing = byAccelerator.get(row.accelerator)
    if (existing) existing.push(row.id)
    else byAccelerator.set(row.accelerator, [row.id])
  }
  for (const [accelerator, ids] of byAccelerator) {
    if (ids.length < 2) byAccelerator.delete(accelerator)
  }
  return byAccelerator
}

/**
 * Overrides with the dead and the pointless removed.
 *
 * Drops ids no longer in the menu (a renamed item), invalid accelerators (a
 * settings row edited by hand), and any binding that merely restates the
 * default — which would otherwise pin a shortcut to today's value and silently
 * ignore a future change to it.
 */
export function pruneOverrides(overrides: Overrides, rows: readonly ShortcutRow[]): Overrides {
  const defaults = new Map(rows.map((row) => [row.id, row.defaultAccelerator]))
  const cleaned: Record<string, string> = {}
  for (const [id, accelerator] of Object.entries(overrides)) {
    if (!defaults.has(id)) continue
    if (!isValidAccelerator(accelerator)) continue
    if (defaults.get(id) === accelerator) continue
    cleaned[id] = accelerator
  }
  return cleaned
}
