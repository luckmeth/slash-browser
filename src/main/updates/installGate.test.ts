import { describe, expect, it } from 'vitest'
import { installGate } from './installGate'
import { UpdateStateSchema, type UpdateState } from '@shared/types/updates'

describe('the state that broke', () => {
  it('allows installing when the package is downloaded and verified', () => {
    // The regression this file exists for. `ready` is what the chip calls
    // "Restart to update"; the old guard demanded 'update-available' and so
    // refused the only state a user could realistically click in.
    expect(installGate('ready')).toEqual({ ok: true })
  })

  it('allows installing before anything is fetched, which then downloads first', () => {
    expect(installGate('update-available')).toEqual({ ok: true })
  })
})

describe('states that are not an install', () => {
  it('refuses mid-download, and says it is coming rather than that it is absent', () => {
    const gate = installGate('downloading')
    expect(gate.ok).toBe(false)
    expect(gate.ok === false && gate.detail).toContain('still downloading')
  })

  it('gives each refusal its own reason', () => {
    // "There is no update to install" was the single message for every one of
    // these, which is how a downloaded, verified update read as an absent one.
    const details = new Set<string>()
    for (const state of ['downloading', 'checking', 'up-to-date', 'no-channel', 'error', 'idle'] as const) {
      const gate = installGate(state)
      expect(gate.ok).toBe(false)
      if (!gate.ok) details.add(gate.detail)
    }
    expect(details.size).toBe(6)
  })
})

describe('every state is classified', () => {
  it('answers for each member of the enum', () => {
    // Exhaustive rather than defaulting: a state added later must be decided
    // here, not fall into a branch that happens to refuse.
    for (const state of UpdateStateSchema.options as UpdateState[]) {
      const gate = installGate(state)
      expect(typeof gate.ok).toBe('boolean')
      if (!gate.ok) expect(gate.detail.length).toBeGreaterThan(0)
    }
  })
})
