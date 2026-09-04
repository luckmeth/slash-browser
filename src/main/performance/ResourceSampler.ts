import { app } from 'electron'
import { createLogger } from '../logger'

const log = createLogger('sampler')

export interface ProcessSample {
  pid: number
  cpuPercent: number | null
  memoryBytes: number | null
}

export interface SampleResult {
  /** Keyed by OS process id. */
  byPid: Map<number, ProcessSample>
  /** How many tabs each pid is serving, for attribution. */
  tabsPerPid: Map<number, number>
  available: boolean
  sampledAt: number
}

/**
 * Reads per-process resource usage and attributes it to tabs.
 *
 * **This is the honest-numbers problem.** `app.getAppMetrics()` reports per
 * *process*, and Chromium's site isolation means several same-site tabs share one
 * renderer. There is no API that gives per-tab CPU or memory, and there cannot be
 * one — the operating system accounts for a process, not for a tab inside it.
 *
 * So attribution divides a shared process's usage by the number of tabs on it and
 * marks the result as an estimate. The dashboard must render that mark. Presenting
 * a divided number as a measurement would be a fabricated figure, and users make
 * decisions about what to close based on it.
 *
 * *(Rust migration candidate: this is one of the two components the plan names.
 * It is invoked asynchronously through a plain interface, so swapping it for a
 * sidecar binary is a change of one class.)*
 */
export class ResourceSampler {
  private last: SampleResult = {
    byPid: new Map(),
    tabsPerPid: new Map(),
    available: false,
    sampledAt: 0
  }

  /**
   * @param pidsInUse OS process ids currently backing a tab, one entry per tab —
   *                  duplicates are meaningful, they are what reveals sharing.
   */
  sample(pidsInUse: readonly number[]): SampleResult {
    const tabsPerPid = new Map<number, number>()
    for (const pid of pidsInUse) tabsPerPid.set(pid, (tabsPerPid.get(pid) ?? 0) + 1)

    const byPid = new Map<number, ProcessSample>()
    let available = false

    try {
      for (const metric of app.getAppMetrics()) {
        // Only renderers matter here; GPU and network usage is not attributable
        // to any one tab and would be double counted if divided among them.
        if (metric.type !== 'Tab') continue

        const cpuPercent =
          typeof metric.cpu?.percentCPUUsage === 'number' ? metric.cpu.percentCPUUsage : null

        // `workingSetSize` is in kilobytes.
        const memoryBytes =
          typeof metric.memory?.workingSetSize === 'number'
            ? metric.memory.workingSetSize * 1024
            : null

        if (cpuPercent !== null || memoryBytes !== null) available = true
        byPid.set(metric.pid, { pid: metric.pid, cpuPercent, memoryBytes })
      }
    } catch (error) {
      // Metrics are a diagnostic, never a dependency. A failure here degrades the
      // dashboard to "not measurable" and must not disturb browsing.
      log.warn('getAppMetrics failed; reporting metrics as unavailable', error)
      available = false
    }

    this.last = { byPid, tabsPerPid, available, sampledAt: Date.now() }
    return this.last
  }

  get latest(): SampleResult {
    return this.last
  }

  /**
   * Usage attributable to a single tab.
   *
   * `shared` is the flag the UI must surface. When true these figures are the
   * process total divided by the tabs on it, not a measurement of this tab.
   */
  attribute(pid: number | null): {
    cpuPercent: number | null
    memoryBytes: number | null
    shared: boolean
    tabsOnProcess: number
  } {
    if (pid === null) {
      return { cpuPercent: null, memoryBytes: null, shared: false, tabsOnProcess: 0 }
    }

    const sample = this.last.byPid.get(pid)
    const tabsOnProcess = this.last.tabsPerPid.get(pid) ?? 1
    const shared = tabsOnProcess > 1

    if (!sample) {
      return { cpuPercent: null, memoryBytes: null, shared, tabsOnProcess }
    }

    return {
      cpuPercent: sample.cpuPercent === null ? null : sample.cpuPercent / tabsOnProcess,
      memoryBytes: sample.memoryBytes === null ? null : Math.round(sample.memoryBytes / tabsOnProcess),
      shared,
      tabsOnProcess
    }
  }

  /** Whole-process working set, used to record measured savings on hibernation. */
  processMemoryBytes(pid: number | null): number | null {
    if (pid === null) return null
    return this.last.byPid.get(pid)?.memoryBytes ?? null
  }
}
