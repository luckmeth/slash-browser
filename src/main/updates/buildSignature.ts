import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app } from 'electron'
import { createLogger } from '../logger'

const log = createLogger('updates')
const run = promisify(execFile)

/**
 * Whether this build is code-signed, and may therefore install updates.
 *
 * The install path is written and wired; it is gated on this, and this is the
 * only thing standing between the current build and self-updating. When a
 * certificate is bought and `CSC_LINK`/`CSC_KEY_PASSWORD` are set for the build,
 * this starts returning true on its own and the button becomes live. **No code
 * change is involved** — which is the point of asking the operating system
 * rather than baking a flag somebody would have to remember to flip.
 *
 * Answered by asking Windows to verify the executable's Authenticode signature.
 * Deliberately not by checking whether a certificate file was present at build
 * time: what matters is whether the binary *on this machine right now* carries a
 * valid signature, and those are different questions the moment anybody tampers
 * with it.
 */

let cached: boolean | null = null

export async function isSignedBuild(): Promise<boolean> {
  if (cached !== null) return cached

  // A development run is never signed and never should be: `npm run dev` must
  // not be able to install anything over itself.
  if (!app.isPackaged) {
    cached = false
    return false
  }

  if (process.platform !== 'win32') {
    // Only Windows is shipped today. Returning false is the safe answer: it
    // withholds the install path rather than assuming a signature nobody checked.
    cached = false
    return false
  }

  try {
    const { stdout } = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // Status is `Valid` only when the signature is present, intact, and
        // chains to a trusted root. `UnknownError`, `NotSigned` and
        // `HashMismatch` all correctly fail this.
        `(Get-AuthenticodeSignature -LiteralPath '${app.getPath('exe').replace(/'/g, "''")}').Status`
      ],
      { timeout: 8000, windowsHide: true }
    )
    cached = stdout.trim() === 'Valid'
    if (!cached) log.info(`build is not signed (${stdout.trim() || 'no status'}); updates stay check-only`)
    return cached
  } catch (error) {
    // Cannot tell, so the answer is no. An update path that opens because a
    // check failed is worse than one that never opens.
    log.warn('could not determine whether this build is signed', error)
    cached = false
    return false
  }
}

/** Forgets the cached answer. Tests only; the signature cannot change at runtime. */
export function resetSignatureCache(): void {
  cached = null
}
