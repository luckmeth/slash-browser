import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { analyseBoundary, isUnportable, specifiersOf } from './boundary'

const ROOT = resolve(__dirname, '../..')

/**
 * The Android and iOS shells rewrite only Slash's I/O half. These tests are what
 * keeps that true.
 *
 * A boundary that is documented but not enforced lasts until the first hurried
 * import. The failure mode is quiet in the worst way: `npm run typecheck` passes,
 * every desktop test passes, the mobile bundle builds — and then the core throws
 * on a device at the first call, months after the import was written.
 */
describe('core boundary', () => {
  describe('specifier classification', () => {
    it('rejects electron and the native modules', () => {
      expect(isUnportable('electron')).toBe(true)
      expect(isUnportable('better-sqlite3')).toBe(true)
      expect(isUnportable('sqlite-vec')).toBe(true)
      expect(isUnportable('@huggingface/transformers')).toBe(true)
    })

    it('rejects node builtins in both spellings', () => {
      // A JS engine embedded in a native shell provides neither form, and
      // `node:path` alone blocks more files than electron does.
      expect(isUnportable('path')).toBe(true)
      expect(isUnportable('node:path')).toBe(true)
      expect(isUnportable('node:crypto')).toBe(true)
      expect(isUnportable('node:fs')).toBe(true)
    })

    it('accepts application code and portable packages', () => {
      expect(isUnportable('@shared/types/downloadEngine')).toBe(false)
      expect(isUnportable('./segmentSplitting')).toBe(false)
      expect(isUnportable('zod')).toBe(false)
    })

    it('does not mistake a longer name for a builtin', () => {
      // `pathe` and `crypto-js` are ordinary packages; a prefix match would
      // have banned them and quietly shrunk the core.
      expect(isUnportable('pathe')).toBe(false)
      expect(isUnportable('crypto-js')).toBe(false)
      expect(isUnportable('electron-log')).toBe(false)
    })
  })

  describe('import extraction', () => {
    it('finds static, type-only, re-exported and dynamic imports', () => {
      const source = [
        "import { a } from './a'",
        "import type { B } from '@shared/b'",
        "export { c } from './c'",
        "const d = await import('./d')",
        "const e = require('./e')"
      ].join('\n')
      expect(specifiersOf(source).sort()).toEqual(
        ['./a', './c', './d', './e', '@shared/b'].sort()
      )
    })
  })

  describe('the mobile core entry', () => {
    // The single guard that matters. Everything reachable from the bundle the
    // shells load must be portable, transitively.
    const report = analyseBoundary(ROOT, { entries: ['mobile/core/entry.ts'] })

    it('reaches nothing unportable', () => {
      const offenders = report.blocked.map(
        (b) => `${b.file} — ${b.specifier}${b.via === b.file ? '' : ` (via ${b.via})`}`
      )
      expect(offenders).toEqual([])
    })

    it('actually pulled in the modules it claims to expose', () => {
      // A guard over an empty graph passes trivially. If the entry stops
      // importing the engine, this fails rather than silently proving nothing.
      const files = report.portable.join('\n')
      expect(files).toContain('src/main/downloads/engine/segmentSplitting.ts')
      expect(files).toContain('src/main/downloads/engine/mediaFilename.ts')
      expect(files).toContain('src/main/media/mediaIdentity.ts')
      expect(files).toContain('src/main/downloads/engine/retryPolicy.ts')
    })
  })

  describe('the portable core as a whole', () => {
    const report = analyseBoundary(ROOT)

    it('is large enough to be worth sharing', () => {
      // Phase A rests on the core being substantial. If a refactor drags most
      // of it back behind `electron`, the mobile plan needs revisiting and this
      // is where that shows up.
      const source = report.portable.filter((f) => !/\.test\.tsx?$/.test(f))
      expect(source.length).toBeGreaterThan(100)
    })

    it('never reports a file as both portable and blocked', () => {
      const both = report.portable.filter((f) => report.blocked.some((b) => b.file === f))
      expect(both).toEqual([])
    })

    it('names the file that actually carries each unportable import', () => {
      // `via` is what makes a failure actionable: the offending import is often
      // three hops away from the file that can no longer be shared.
      for (const blocker of report.blocked) {
        expect(blocker.specifier).not.toBe('')
        expect(blocker.via).not.toBe('')
      }
    })
  })
})
