import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { YtDlpService } from '../downloads/external/YtDlpService'
import { createLogger } from '../logger'

const log = createLogger('spike')

const TARGET =
  process.env['SLASH_YT_URL'] ?? 'https://www.youtube.com/watch?v=vRgWHE9e7mI'

/**
 * The managed install, run for real against the official releases.
 *
 * This is the one path in the feature that cannot be faked usefully. It fetches
 * a release document, picks an asset out of it, downloads roughly eighteen
 * megabytes, verifies a SHA-512 against the published sums, writes an
 * executable to disk and then runs it. A fixture would prove the plumbing and
 * none of the things that actually go wrong — a redirect chain that drops the
 * user agent, a checksum file whose format moved, an asset name that changed.
 *
 * It finishes by asking the freshly installed binary what the target page is
 * available as, because "the installer ran" and "you can now download a video"
 * are different claims and only the second one matters.
 */
export async function runInstallProbe(): Promise<void> {
  let failures = 0
  const check = (name: string, passed: boolean, detail: string): void => {
    if (!passed) failures += 1
    log[passed ? 'info' : 'error'](`install probe [${name}]: ${passed ? 'PASS' : 'FAIL'} — ${detail}`)
  }

  // Empty configured path, so this exercises the managed location.
  const service = new YtDlpService(() => '')

  try {
    const before = await service.status()
    log.info(`install probe: before — ${JSON.stringify(before)}`)

    const result = await service.install()
    check('installs', result.ok, result.ok ? result.note : `failed: ${result.note}`)
    if (!result.ok) throw new Error(result.note)

    // The bytes, not the return value.
    const path = service.managedPath()
    const stat = await fs.stat(path).catch(() => null)
    check(
      'file-on-disk',
      stat !== null && stat.size > 4 * 1024 * 1024,
      stat === null ? 'nothing at the managed path' : `${stat.size} bytes at ${path}`
    )

    const after = await service.status()
    check(
      'reports-itself-installed',
      after.installed && after.managed,
      `installed=${after.installed} managed=${after.managed} version=${after.version}`
    )
    check(
      'the-binary-runs',
      after.version !== null && after.version !== '',
      after.version !== null ? `yt-dlp reports ${after.version}` : 'it would not report a version'
    )

    // The claim that matters: can it now list what the page offers?
    log.info(`install probe: listing ${TARGET}`)
    const listed = await service.listFormats(TARGET)
    check(
      'lists-a-real-page',
      listed.ok && listed.choices.length > 0,
      listed.ok
        ? `${listed.choices.length} rows — ${listed.choices.map((c) => c.label).join(' | ')}`
        : `failed: ${listed.error}`
    )
    if (listed.ok) {
      const best = listed.choices[0]
      check(
        'offers-above-360p',
        (best?.height ?? 0) > 360,
        // The complaint this whole feature exists to answer.
        best ? `best available is ${best.label} (${best.sizeText})` : 'nothing offered'
      )
    }
  } catch (error) {
    check('ran', false, error instanceof Error ? error.message : String(error))
  }

  log.info(`install probe: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
  if (process.env['SLASH_PROBE_EXIT']) app.quit()
}
