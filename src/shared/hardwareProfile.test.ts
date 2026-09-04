import { describe, expect, it } from 'vitest'
import { describeDecision, describeMachine, type Machine } from './hardwareProfile'

const GB = 1024 * 1024 * 1024

const machine = (over: Partial<Machine> = {}): Machine => ({
  totalMemoryBytes: 16 * GB,
  cpuCount: 8,
  onBattery: false,
  ...over
})

describe('what a machine is judged to be', () => {
  it('calls a workstation capable and holds nothing back', () => {
    const profile = describeMachine(machine())
    expect(profile.tier).toBe('capable')
    expect(profile.effects).toBe('full')
    expect(profile.suggestedMode).toBe('balanced')
    expect(profile.embeddingsAdvisable).toBe(true)
  })

  it('calls 4 GB low, whatever the processor', () => {
    // Memory decides whether tabs survive; a fast chip does not help a machine
    // that is swapping.
    const profile = describeMachine(machine({ totalMemoryBytes: 3.8 * GB, cpuCount: 16 }))
    expect(profile.tier).toBe('low')
    expect(profile.effects).toBe('reduced')
    expect(profile.suggestedMode).toBe('aggressive')
  })

  it('calls two cores low, whatever the memory', () => {
    // Cores decide whether the window keeps up with the pointer: an animated
    // blur competes with the page for the only thread that can paint it.
    const profile = describeMachine(machine({ cpuCount: 2, totalMemoryBytes: 32 * GB }))
    expect(profile.tier).toBe('low')
    expect(profile.effects).toBe('reduced')
  })

  it('has a middle tier, so it is not one cliff', () => {
    const profile = describeMachine(machine({ totalMemoryBytes: 6 * GB, cpuCount: 4 }))
    expect(profile.tier).toBe('modest')
    // Plugged in, a modest machine still gets the full interface.
    expect(profile.effects).toBe('full')
  })

  it('drops effects on a modest machine once it is on battery', () => {
    const profile = describeMachine({ totalMemoryBytes: 6 * GB, cpuCount: 4, onBattery: true })
    expect(profile.effects).toBe('reduced')
  })

  it('does not demote a capable machine for being unplugged', () => {
    // Battery is a reason to spend less, not a reason to pretend the machine
    // is something it is not.
    const profile = describeMachine(machine({ onBattery: true }))
    expect(profile.tier).toBe('capable')
    expect(profile.effects).toBe('full')
  })
})

describe('what follows from the tier', () => {
  it('scales download connections rather than using one number everywhere', () => {
    expect(describeMachine(machine({ cpuCount: 2 })).downloadConnections).toBe(4)
    expect(describeMachine(machine({ cpuCount: 4 })).downloadConnections).toBe(6)
    expect(describeMachine(machine()).downloadConnections).toBe(8)
  })

  it('advises against the embedding model on a machine short of memory', () => {
    expect(describeMachine(machine({ totalMemoryBytes: 3 * GB })).embeddingsAdvisable).toBe(false)
    expect(describeMachine(machine()).embeddingsAdvisable).toBe(true)
  })
})

describe('when the numbers are missing', () => {
  it('assumes capable rather than crippling a machine it could not measure', () => {
    // `os.totalmem()` returning 0 is a failure to measure, not a tiny machine.
    // Guessing "low" would quietly degrade a good computer for ever.
    const profile = describeMachine({ totalMemoryBytes: 0, cpuCount: 0, onBattery: false })
    expect(profile.tier).toBe('capable')
    expect(profile.reasons).toEqual([])
  })
})

describe('the sentence shown in Settings', () => {
  it('names what was measured', () => {
    const said = describeDecision(describeMachine(machine({ cpuCount: 2 })), true)
    expect(said).toContain('Low-powered')
    expect(said).toContain('2 processor threads')
  })

  it('says plainly when it is switched off', () => {
    expect(describeDecision(describeMachine(machine()), false)).toContain('Off')
  })

  it('reads as one thread on a single-core machine', () => {
    expect(describeMachine(machine({ cpuCount: 1 })).reasons).toContain('1 processor thread')
  })
})
