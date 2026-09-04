import { describe, expect, it } from 'vitest'
// `?raw` rather than `node:fs`: this file sits in the renderer tsconfig
// project, which has no Node types, and Vite's raw import is the portable way
// to read a source file as text from either project.
import SOURCE from './SettingsPanel.tsx?raw'

/**
 * Every settings group must be registered in `GROUP_META`.
 *
 * `Group` renders nothing when the title has no entry:
 *
 * ```ts
 * if (query.trim() === '' && GROUP_META[title]?.category !== category) return null
 * ```
 *
 * An unregistered title resolves to `undefined`, which equals no category, so
 * the group is **silently invisible** — it typechecks, it lints, it renders no
 * error, and the only symptom is that a finished feature cannot be found. That
 * is exactly what happened to the Slash Coin group: the section existed, the
 * switch worked, and there was no way to reach either.
 *
 * Asserted against the source text rather than by rendering, because these are
 * two literals in one file that have to agree, and a render test would need the
 * whole settings tree and every IPC channel behind it to prove a much smaller
 * point.
 */
/** Titles passed to `<Group title="…">`, single- and double-quoted. */
function groupTitles(source: string): string[] {
  const titles = new Set<string>()
  for (const match of source.matchAll(/<Group\s+title=(?:"([^"]+)"|\{'([^']+)'\})/g)) {
    const title = match[1] ?? match[2]
    if (title) titles.add(title)
  }
  return [...titles]
}

/** Keys of the `GROUP_META` record. */
function registeredTitles(source: string): string[] {
  const start = source.indexOf('const GROUP_META')
  expect(start).toBeGreaterThan(-1)
  const body = source.slice(start)
  const keys = new Set<string>()
  // Both `'Quoted key':` and bare `Appearance:` forms appear in the record.
  for (const match of body.matchAll(/^\s{2}(?:'([^']+)'|([A-Za-z][A-Za-z0-9]*)):\s*\{/gm)) {
    const key = match[1] ?? match[2]
    if (key) keys.add(key)
  }
  return [...keys]
}

describe('settings groups', () => {
  it('finds groups and registrations at all', () => {
    // Guards the test itself: if the regexes stop matching because the file was
    // restructured, this fails loudly rather than passing vacuously.
    expect(groupTitles(SOURCE).length).toBeGreaterThan(10)
    expect(registeredTitles(SOURCE).length).toBeGreaterThan(10)
  })

  it('registers every rendered group in GROUP_META', () => {
    const registered = new Set(registeredTitles(SOURCE))
    const missing = groupTitles(SOURCE).filter((title) => !registered.has(title))
    expect(missing, `these groups would render as nothing: ${missing.join(', ')}`).toEqual([])
  })

  it('puts Slash Coin in a category the rail actually lists', () => {
    // The specific regression: registered, but under a category name that the
    // rail does not offer, would be invisible in a different way.
    const rail = SOURCE.slice(SOURCE.indexOf('const CATEGORIES'))
    const categories = [...rail.matchAll(/'([^']+)'/g)].map((m) => m[1]).slice(0, 8)
    const meta = SOURCE.slice(SOURCE.indexOf("'Slash Coin': {"))
    const category = /category:\s*'([^']+)'/.exec(meta)?.[1]
    expect(category).toBeDefined()
    expect(categories).toContain(category)
  })
})
