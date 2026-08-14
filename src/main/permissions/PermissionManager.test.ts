import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PermissionManager, toPermissionKinds, isSilentlyGranted } from './PermissionManager'
import type { PermissionRepository } from '../db/repositories/PermissionRepository'
import type { PermissionGrant, PermissionKind, PermissionPolicy } from '@shared/types/permission'

/**
 * In-memory stand-in for the repository, so the decision logic is tested without
 * a database. It reproduces the one behaviour that matters for correctness here:
 * an expired grant does not answer.
 */
class FakeRepository {
  grants = new Map<string, PermissionGrant>()
  events: Array<{ kind: PermissionKind; action: string }> = []
  private nextId = 1

  private key(partition: string, origin: string, kind: string): string {
    return `${partition}|${origin}|${kind}`
  }

  find(partition: string, origin: string, kind: PermissionKind): PermissionGrant | null {
    const found = this.grants.get(this.key(partition, origin, kind))
    if (!found) return null
    if (found.expiresAt !== null && found.expiresAt <= Date.now()) {
      this.grants.delete(this.key(partition, origin, kind))
      return null
    }
    return found
  }

  upsert(grant: Omit<PermissionGrant, 'id' | 'createdAt'>): void {
    this.grants.set(this.key(grant.partition, grant.origin, grant.kind), {
      ...grant,
      id: this.nextId++,
      createdAt: Date.now()
    })
  }

  list(): PermissionGrant[] {
    return [...this.grants.values()]
  }

  deleteFor(partition: string, origin: string, kind: PermissionKind): void {
    this.grants.delete(this.key(partition, origin, kind))
  }

  sweepExpired(now: number): PermissionGrant[] {
    const expired = [...this.grants.values()].filter(
      (g) => g.expiresAt !== null && g.expiresAt <= now
    )
    for (const grant of expired) this.deleteFor(grant.partition, grant.origin, grant.kind)
    return expired
  }

  logEvent(
    _partition: string,
    _origin: string,
    kind: PermissionKind,
    action: string,
    _policy: PermissionPolicy | null
  ): void {
    this.events.push({ kind, action })
  }

  listEvents(): [] {
    return []
  }

  clearEvents(): void {}
  deleteById(): void {}
}

const PARTITION = 'default'
const ORIGIN = 'https://example.com'

describe('PermissionManager', () => {
  let repo: FakeRepository
  let manager: PermissionManager
  let shown: string[]

  beforeEach(() => {
    repo = new FakeRepository()
    shown = []
    manager = new PermissionManager(repo as unknown as PermissionRepository, {
      showPrompt: (request) => {
        shown.push(request.requestId)
        return true
      },
      dismissPrompt: () => {},
      onGrantsChanged: () => {}
    })
  })

  /** Answers whatever prompt is currently open. */
  function answer(policy: PermissionPolicy): void {
    const id = shown[shown.length - 1]
    if (id) manager.respond(id, policy)
  }

  describe('check (synchronous)', () => {
    it('denies by default — an unknown permission is a no', () => {
      expect(manager.check(PARTITION, ORIGIN, 'camera', null)).toBe(false)
    })

    it('never prompts', async () => {
      manager.check(PARTITION, ORIGIN, 'camera', 'tab-1')
      expect(shown).toHaveLength(0)
    })

    it('reports a stored always-allow', () => {
      repo.upsert({
        partition: PARTITION,
        origin: ORIGIN,
        kind: 'camera',
        policy: 'always-allow',
        expiresAt: null,
        tabId: null
      })
      expect(manager.check(PARTITION, ORIGIN, 'camera', null)).toBe(true)
    })

    it('does not report an always-block as allowed', () => {
      repo.upsert({
        partition: PARTITION,
        origin: ORIGIN,
        kind: 'camera',
        policy: 'always-block',
        expiresAt: null,
        tabId: null
      })
      expect(manager.check(PARTITION, ORIGIN, 'camera', null)).toBe(false)
    })

    it('stops reporting a lapsed allow-until', () => {
      repo.upsert({
        partition: PARTITION,
        origin: ORIGIN,
        kind: 'geolocation',
        policy: 'allow-until',
        expiresAt: Date.now() - 1,
        tabId: null
      })
      expect(manager.check(PARTITION, ORIGIN, 'geolocation', null)).toBe(false)
    })
  })

  describe('request', () => {
    it('prompts, then resolves with the answer', async () => {
      const pending = manager.request(PARTITION, ORIGIN, ['camera'], 'tab-1', 'Example')
      expect(shown).toHaveLength(1)
      answer('allow-once')
      await expect(pending).resolves.toBe(true)
    })

    it('resolves false when refused', async () => {
      const pending = manager.request(PARTITION, ORIGIN, ['camera'], 'tab-1', 'Example')
      answer('block')
      await expect(pending).resolves.toBe(false)
    })

    it('auto-denies an always-blocked permission without prompting', async () => {
      repo.upsert({
        partition: PARTITION,
        origin: ORIGIN,
        kind: 'camera',
        policy: 'always-block',
        expiresAt: null,
        tabId: null
      })
      await expect(
        manager.request(PARTITION, ORIGIN, ['camera'], 'tab-1', 'Example')
      ).resolves.toBe(false)
      expect(shown).toHaveLength(0)
    })

    it('does not re-prompt once always-allowed', async () => {
      const first = manager.request(PARTITION, ORIGIN, ['camera'], 'tab-1', 'Example')
      answer('always-allow')
      await first

      await expect(
        manager.request(PARTITION, ORIGIN, ['camera'], 'tab-1', 'Example')
      ).resolves.toBe(true)
      expect(shown).toHaveLength(1)
    })

    it('denies when no window can show the prompt', async () => {
      // A UI failure must never become an accidental grant.
      manager.setHooks({
        showPrompt: () => false,
        dismissPrompt: () => {},
        onGrantsChanged: () => {}
      })
      await expect(
        manager.request(PARTITION, ORIGIN, ['camera'], 'tab-1', 'Example')
      ).resolves.toBe(false)
    })
  })

  describe('scoping', () => {
    it('keeps allow-for-tab off disk and confined to that tab', async () => {
      const pending = manager.request(PARTITION, ORIGIN, ['camera'], 'tab-1', 'Example')
      answer('allow-for-tab')
      await pending

      expect(manager.check(PARTITION, ORIGIN, 'camera', 'tab-1')).toBe(true)
      expect(manager.check(PARTITION, ORIGIN, 'camera', 'tab-2')).toBe(false)
      // A deliberately temporary grant must not become durable.
      expect(repo.grants.size).toBe(0)
    })

    it('drops a tab grant when the tab goes away', async () => {
      const pending = manager.request(PARTITION, ORIGIN, ['camera'], 'tab-1', 'Example')
      answer('allow-for-tab')
      await pending

      manager.cancelForTab('tab-1')
      expect(manager.check(PARTITION, ORIGIN, 'camera', 'tab-1')).toBe(false)
    })

    it('denies a pending request when its tab closes', async () => {
      const pending = manager.request(PARTITION, ORIGIN, ['camera'], 'tab-1', 'Example')
      manager.cancelForTab('tab-1')
      await expect(pending).resolves.toBe(false)
    })

    it('keeps allow-for-session off disk but across tabs', async () => {
      const pending = manager.request(PARTITION, ORIGIN, ['microphone'], 'tab-1', 'Example')
      answer('allow-for-session')
      await pending

      expect(manager.check(PARTITION, ORIGIN, 'microphone', 'tab-9')).toBe(true)
      expect(repo.grants.size).toBe(0)
    })

    it('does not leak a grant across session partitions', async () => {
      const pending = manager.request(PARTITION, ORIGIN, ['camera'], 'tab-1', 'Example')
      answer('always-allow')
      await pending

      // An isolated workspace has its own partition and must ask again.
      expect(manager.check('persist:ws-work', ORIGIN, 'camera', 'tab-1')).toBe(false)
    })

    it('does not leak a grant across origins', async () => {
      const pending = manager.request(PARTITION, ORIGIN, ['camera'], 'tab-1', 'Example')
      answer('always-allow')
      await pending

      expect(manager.check(PARTITION, 'https://evil.example', 'camera', 'tab-1')).toBe(false)
    })
  })

  describe('combined camera + microphone', () => {
    it('answers both with one decision, because Chromium gives one callback', async () => {
      const pending = manager.request(
        PARTITION,
        ORIGIN,
        ['camera', 'microphone'],
        'tab-1',
        'Example'
      )
      answer('always-allow')
      await expect(pending).resolves.toBe(true)

      expect(manager.check(PARTITION, ORIGIN, 'camera', null)).toBe(true)
      expect(manager.check(PARTITION, ORIGIN, 'microphone', null)).toBe(true)
    })

    it('re-prompts when only one of the pair is already allowed', async () => {
      const first = manager.request(PARTITION, ORIGIN, ['camera'], 'tab-1', 'Example')
      answer('always-allow')
      await first

      const second = manager.request(
        PARTITION,
        ORIGIN,
        ['camera', 'microphone'],
        'tab-1',
        'Example'
      )
      expect(shown).toHaveLength(2)
      answer('block')
      await second
    })
  })

  it('settles pending requests as denied on shutdown', async () => {
    const pending = manager.request(PARTITION, ORIGIN, ['camera'], 'tab-1', 'Example')
    manager.stop()
    await expect(pending).resolves.toBe(false)
  })

  it('revoking removes the grant and logs it', async () => {
    const pending = manager.request(PARTITION, ORIGIN, ['camera'], 'tab-1', 'Example')
    answer('always-allow')
    await pending

    manager.revoke(PARTITION, ORIGIN, 'camera')
    expect(manager.check(PARTITION, ORIGIN, 'camera', null)).toBe(false)
    expect(repo.events.some((e) => e.action === 'revoked')).toBe(true)
  })

  it('logs the request before it is answered', async () => {
    const pending = manager.request(PARTITION, ORIGIN, ['camera'], 'tab-1', 'Example')
    expect(repo.events.some((e) => e.action === 'requested')).toBe(true)
    answer('block')
    await pending
    expect(repo.events.some((e) => e.action === 'denied')).toBe(true)
  })
})

describe('toPermissionKinds', () => {
  it('splits media by mediaTypes', () => {
    expect(toPermissionKinds('media', ['video'])).toEqual(['camera'])
    expect(toPermissionKinds('media', ['audio'])).toEqual(['microphone'])
    expect(toPermissionKinds('media', ['video', 'audio'])).toEqual(['camera', 'microphone'])
  })

  it('assumes both when Chromium does not say which', () => {
    // Assuming less would under-state what the page is asking for.
    expect(toPermissionKinds('media')).toEqual(['camera', 'microphone'])
    expect(toPermissionKinds('media', [])).toEqual(['camera', 'microphone'])
  })

  it('maps an unrecognised permission to "unknown" rather than allowing it', () => {
    expect(toPermissionKinds('some-future-capability')).toEqual(['unknown'])
  })

  it('treats harmless capabilities as needing no prompt', () => {
    expect(toPermissionKinds('clipboard-sanitized-write')).toEqual([])
    expect(isSilentlyGranted('clipboard-sanitized-write')).toBe(true)
    expect(isSilentlyGranted('media')).toBe(false)
  })
})

describe('expiry sweep', () => {
  it('removes lapsed grants and announces the change', () => {
    const repo = new FakeRepository()
    const onGrantsChanged = vi.fn()
    const manager = new PermissionManager(repo as unknown as PermissionRepository, {
      showPrompt: () => true,
      dismissPrompt: () => {},
      onGrantsChanged
    })

    repo.upsert({
      partition: PARTITION,
      origin: ORIGIN,
      kind: 'geolocation',
      policy: 'allow-until',
      expiresAt: Date.now() - 1000,
      tabId: null
    })

    manager.start()
    manager.stop()

    expect(repo.grants.size).toBe(0)
    expect(onGrantsChanged).toHaveBeenCalled()
  })
})
