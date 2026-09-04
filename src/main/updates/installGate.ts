import type { UpdateState } from '@shared/types/updates'

/**
 * Whether installing can start from the state the updater is in.
 *
 * This exists because the guard it replaces was wrong in the one state that
 * matters. It read `state !== 'update-available'` and refused everything else
 * -- including **`ready`**, which is precisely "the package is downloaded and
 * its checksum matches, install it". Auto-download is on by default, so the
 * normal path is `update-available` -> `downloading` -> `ready`, and by the
 * time anybody could click, installing was refused.
 *
 * It presented as a button that did nothing at all: the chip invoked the
 * channel, the service returned `There is no update to install.`, and the chip
 * discarded the result without showing it. Nothing threw, nothing logged at a
 * level anybody reads, and the browser sat there saying "Restart to update"
 * for ever.
 *
 * Pure and exhaustive so the next state added to `UpdateState` has to be
 * classified here rather than falling into a default that happens to refuse.
 */
export type InstallGate = { readonly ok: true } | { readonly ok: false; readonly detail: string }

export function installGate(state: UpdateState): InstallGate {
  switch (state) {
    // `ready`: the package is on disk and its checksum matches -- what the chip
    // means by "Restart to update", and the state the old guard rejected.
    // `update-available`: nothing fetched yet, so it downloads first.
    case 'ready':
    case 'update-available':
      return { ok: true }

    case 'downloading':
      return {
        ok: false,
        detail: 'The update is still downloading. It will be ready in a moment.'
      }
    case 'checking':
      return { ok: false, detail: 'Slash is still checking for an update.' }
    case 'up-to-date':
      return { ok: false, detail: 'Slash is already up to date.' }
    case 'no-channel':
      return {
        ok: false,
        detail: 'No release feed is configured, so there is nothing to install.'
      }
    case 'error':
      return {
        ok: false,
        detail: 'The last check failed, so there is no verified update to install.'
      }
    case 'idle':
      return { ok: false, detail: 'Check for an update first.' }
  }
}
