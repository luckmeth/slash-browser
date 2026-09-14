import { describe, it, expect } from 'vitest'
import { archiveRefusal, archivePreview, type ArchiveContext } from './workspaceArchive'

const context = (over: Partial<ArchiveContext> = {}): ArchiveContext => ({
  workspace: { id: 'ws-1', name: 'Japan Trip', archivedAt: null },
  activeWorkspaceId: 'default',
  defaultWorkspaceId: 'default',
  tabCount: 4,
  ...over
})

describe('archiveRefusal', () => {
  it('allows an ordinary workspace with tabs in it', () => {
    expect(archiveRefusal(context())).toBeNull()
  })

  it('refuses the default workspace', () => {
    // Structural rather than a preference: a tab must always have somewhere to
    // live, so this is checked before anything else.
    const refusal = archiveRefusal(
      context({ workspace: { id: 'default', name: 'Personal', archivedAt: null } })
    )
    expect(refusal).toContain('somewhere to live')
  })

  it('refuses the workspace you are standing in', () => {
    // The tabs it would close are the ones on screen.
    const refusal = archiveRefusal(context({ activeWorkspaceId: 'ws-1' }))
    expect(refusal).toContain('Switch to another workspace first')
  })

  it('refuses one that is already archived', () => {
    const refusal = archiveRefusal(
      context({ workspace: { id: 'ws-1', name: 'Japan Trip', archivedAt: 1 } })
    )
    expect(refusal).toContain('already archived')
  })

  it('refuses one with nothing open in it', () => {
    // Archiving into an empty restore point would look like it worked and
    // restore nothing.
    expect(archiveRefusal(context({ tabCount: 0 }))).toContain('nothing to archive')
  })

  it('checks the default before anything else', () => {
    // The default workspace is also usually the active one; the structural
    // reason is the more useful thing to say.
    const refusal = archiveRefusal(
      context({
        workspace: { id: 'default', name: 'Personal', archivedAt: null },
        activeWorkspaceId: 'default'
      })
    )
    expect(refusal).toContain('somewhere to live')
  })

  it('gives a sentence for every refusal, never a bare false', () => {
    const refusals = [
      archiveRefusal(context({ workspace: { id: 'default', name: 'P', archivedAt: null } })),
      archiveRefusal(context({ activeWorkspaceId: 'ws-1' })),
      archiveRefusal(context({ workspace: { id: 'ws-1', name: 'J', archivedAt: 1 } })),
      archiveRefusal(context({ tabCount: 0 }))
    ]
    for (const refusal of refusals) {
      // A sentence somebody can act on: long enough to explain, and ending like
      // prose rather than like an error code.
      expect(refusal!.length, refusal ?? '').toBeGreaterThan(20)
      expect(refusal, 'refusals are sentences').toMatch(/\.$/)
    }
  })
})

describe('archivePreview', () => {
  it('says what will happen before it happens', () => {
    const preview = archivePreview(4)
    expect(preview).toContain('4 tabs')
    expect(preview).toContain('keeps its name and notes')
    expect(preview).toContain('back history')
  })

  it('says "1 tab", not "1 tabs"', () => {
    expect(archivePreview(1)).toContain('1 tab will')
  })
})
