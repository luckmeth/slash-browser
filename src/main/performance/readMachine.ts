import { cpus, totalmem } from 'node:os'
import { powerMonitor } from 'electron'
import type { Machine } from '@shared/hardwareProfile'

/**
 * What this machine is, measured once and cached.
 *
 * Memory and processor count do not change while the browser runs, and asking
 * the operating system on every settings read would be a syscall on a path
 * that is opened constantly. Battery state does change, so that one is read
 * each time.
 *
 * Everything here can fail: `os.cpus()` returns an empty array on some
 * containers, and `totalmem()` can report 0 where a hypervisor does not say.
 * Both are passed through as zero rather than guessed, because
 * `describeMachine` treats "could not measure" as *capable* — quietly
 * degrading a good computer for ever is a worse failure than not optimising a
 * small one.
 */
let fixed: { totalMemoryBytes: number; cpuCount: number } | null = null

export function readMachine(): Machine {
  if (fixed === null) {
    let memory = 0
    let cores = 0
    try {
      memory = totalmem()
      cores = cpus().length
    } catch {
      /* left at zero, which reads as "not measured" */
    }
    fixed = { totalMemoryBytes: memory, cpuCount: cores }
  }

  let onBattery = false
  try {
    onBattery = powerMonitor.isOnBatteryPower()
  } catch {
    // Not available on every platform or before the app is ready. A desktop
    // reads as plugged in, which is what it is.
  }

  return { ...fixed, onBattery }
}
