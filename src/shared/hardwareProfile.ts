/**
 * What this machine can comfortably do, and what to stop doing when it cannot.
 *
 * Slash is built on Chromium, and Chromium on a 4 GB laptop with two cores and
 * integrated graphics is a different program from Chromium on a workstation.
 * The browser already had a `performanceMode` for sleeping background tabs;
 * this is the other half — deciding, from the machine rather than from a
 * preference, whether to spend GPU time on blur and animation and how much
 * work to run at once.
 *
 * Pure, and every input passed in, for the usual reason: the interesting cases
 * are machines nobody testing this has, and the only way to check the rules is
 * to describe those machines to a function.
 *
 * **It never overrides an explicit choice.** A person who sets the performance
 * mode by hand keeps it. This decides what happens when nobody has said, which
 * on a low-end machine is the difference between a browser that feels slow and
 * one that does not.
 */

export interface Machine {
  /** `os.totalmem()`. */
  totalMemoryBytes: number
  /** `os.cpus().length`. Hyper-threaded siblings count, as they do for work. */
  cpuCount: number
  /** From `powerMonitor.onBatteryPower`. */
  onBattery: boolean
}

export type Tier = 'low' | 'modest' | 'capable'

export interface HardwareProfile {
  tier: Tier
  /** Whether the chrome may spend GPU time on blur, aurora and animation. */
  effects: 'full' | 'reduced'
  /** The tab-sleeping mode to use when the user has expressed no preference. */
  suggestedMode: 'off' | 'balanced' | 'aggressive'
  /** A sensible ceiling for parallel download connections on this machine. */
  downloadConnections: number
  /** Whether loading the local embedding model is a good idea here. */
  embeddingsAdvisable: boolean
  /** Plain sentences naming what was measured. Shown in Settings. */
  reasons: string[]
}

const GB = 1024 * 1024 * 1024

/**
 * Thresholds, chosen from what the parts actually cost rather than roundness.
 *
 * 4 GB is where Chromium and a handful of tabs start swapping on Windows, and
 * two cores is where compositing an animated blur competes with the page for
 * the only thread that can paint it. 8 GB / 4 cores is the point at which the
 * full experience stops being noticeable, which is why the middle tier exists
 * rather than a single on/off.
 */
export const LOW_MEMORY_BYTES = 4 * GB
export const MODEST_MEMORY_BYTES = 8 * GB
export const LOW_CPU_COUNT = 2
export const MODEST_CPU_COUNT = 4

export function describeMachine(machine: Machine): HardwareProfile {
  const memory = machine.totalMemoryBytes
  const cores = machine.cpuCount
  const reasons: string[] = []

  const lowMemory = memory > 0 && memory < LOW_MEMORY_BYTES
  const lowCpu = cores > 0 && cores <= LOW_CPU_COUNT
  const modestMemory = memory > 0 && memory < MODEST_MEMORY_BYTES
  const modestCpu = cores > 0 && cores <= MODEST_CPU_COUNT

  // Either one is enough to make the machine feel slow: memory decides whether
  // tabs survive, cores decide whether the window keeps up with the pointer.
  const tier: Tier = lowMemory || lowCpu ? 'low' : modestMemory || modestCpu ? 'modest' : 'capable'

  if (memory > 0) reasons.push(`${(memory / GB).toFixed(1)} GB of memory`)
  if (cores > 0) reasons.push(`${cores} processor ${cores === 1 ? 'thread' : 'threads'}`)
  if (machine.onBattery) reasons.push('running on battery')

  // Battery does not change the tier — a capable laptop is still capable — but
  // it does mean spending less on decoration and on parallel work, because the
  // cost of both is measured in minutes of use rather than milliseconds.
  const effects: HardwareProfile['effects'] =
    tier === 'low' || (tier === 'modest' && machine.onBattery) ? 'reduced' : 'full'

  const suggestedMode: HardwareProfile['suggestedMode'] =
    tier === 'low' ? 'aggressive' : 'balanced'

  const downloadConnections = tier === 'low' ? 4 : tier === 'modest' ? 6 : 8

  return {
    tier,
    effects,
    suggestedMode,
    downloadConnections,
    // The model is ~23 MB on disk and considerably more once the ONNX runtime
    // has it resident. On a machine already short of memory that is a swap
    // storm for a search feature that works without it.
    embeddingsAdvisable: tier !== 'low',
    reasons
  }
}

/** One sentence for the settings screen, from the same decision. */
export function describeDecision(profile: HardwareProfile, enabled: boolean): string {
  if (!enabled) {
    return 'Off — Slash uses the full interface and your own performance mode, whatever this machine is.'
  }
  const seen = profile.reasons.join(', ')
  if (profile.tier === 'capable') {
    return `This machine is comfortable (${seen}), so nothing is being held back.`
  }
  if (profile.tier === 'modest') {
    return profile.effects === 'reduced'
      ? `Modest machine on battery (${seen}) — background blur and animation are off to save it.`
      : `Modest machine (${seen}) — the full interface is on, and background tabs sleep sooner.`
  }
  return `Low-powered machine (${seen}) — background blur and animation are off, background tabs sleep sooner, and downloads use fewer connections.`
}

/**
 * The tab-sleeping mode to actually run in.
 *
 * `off` is never overridden. It is the one setting that means "leave my
 * background tabs alone", and a machine being small is not a reason to
 * overrule somebody who said that — they may have a form half-filled in a tab
 * they have not looked at for an hour.
 *
 * Otherwise, on a machine measured as low-powered, sleeping sooner is the
 * single change that most affects whether the browser feels usable, so the
 * measurement wins over the default. On anything else the stored mode stands.
 */
export function effectiveMode(
  stored: 'off' | 'balanced' | 'aggressive',
  profile: HardwareProfile,
  enabled: boolean
): 'off' | 'balanced' | 'aggressive' {
  if (stored === 'off') return 'off'
  if (!enabled) return stored
  return profile.tier === 'low' ? 'aggressive' : stored
}
