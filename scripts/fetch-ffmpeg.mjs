/**
 * Fetches the ffmpeg build that ships with Slash.
 *
 *   npm run fetch:ffmpeg
 *
 * ## Why a fetch script rather than a committed binary
 *
 * It is ~80 MB. Committing that to git makes every clone carry it forever and
 * every future version carry the old one too, because git keeps history. So the
 * repository holds this script and the checksum, and the binary lands in
 * `resources/ffmpeg/`, which is gitignored and packaged via `extraResources`.
 *
 * ## Why bundled rather than downloaded on first use
 *
 * Same reason as `resources/models/`: fetching it when somebody first presses
 * Download would turn a local feature into an outbound request to a third party,
 * on a machine whose owner was told nothing leaves it unless they said so. It
 * ships, or the feature says it is unavailable. It does not phone home.
 *
 * ## Why the checksum is not optional
 *
 * This downloads an executable that will be shipped to users inside a signed
 * installer. Verifying it is the difference between bundling a known binary and
 * bundling whatever a URL served that day.
 */

import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import https from 'node:https'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'resources', 'ffmpeg')
const exe = join(target, 'ffmpeg.exe')

/**
 * A specific, pinned build.
 *
 * `latest` would mean the installer's contents changing without a commit, which
 * makes a build unreproducible and a signature meaningless.
 */
const RELEASE = {
  url: 'https://github.com/GyanD/codexffmpeg/releases/download/7.1/ffmpeg-7.1-essentials_build.zip',
  /**
   * Filled in on first run and committed.
   *
   * Empty means "record what you got and tell me" — deliberately not "trust
   * whatever arrives". A build with no expected hash prints the hash and stops,
   * so somebody has to look at it before it can ship.
   */
  sha256: 'fa7d4d7e795db0e2503f49f105f46ed5852386f0cfdd819899be3b65ebde24fc',
  /** Path inside the archive. */
  member: 'ffmpeg-7.1-essentials_build/bin/ffmpeg.exe'
}

if (existsSync(exe)) {
  const size = (statSync(exe).size / 1e6).toFixed(1)
  console.log(`ffmpeg.exe already present (${size} MB) — delete it to re-fetch.`)
  process.exit(0)
}

mkdirSync(target, { recursive: true })
const archive = join(target, 'ffmpeg.zip')

console.log(`Fetching ${RELEASE.url}`)
await download(RELEASE.url, archive)

const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
if (RELEASE.sha256 === '') {
  console.log(
    `\nNo expected checksum is pinned yet.\n` +
      `  sha256: ${digest}\n\n` +
      `Put that in RELEASE.sha256 in this script and commit it, then run again.\n` +
      `Shipping an executable nobody checked is not a thing this build does.`
  )
  rmSync(archive)
  process.exit(1)
}
if (digest !== RELEASE.sha256) {
  rmSync(archive)
  console.error(`Checksum mismatch.\n  expected ${RELEASE.sha256}\n  got      ${digest}`)
  process.exit(1)
}

// PowerShell's Expand-Archive is on every supported Windows and needs no
// dependency. The whole archive is extracted and the one file kept, because
// extracting a single member portably is more code than deleting the rest.
console.log('Extracting…')
const staging = join(target, '_staging')
rmSync(staging, { recursive: true, force: true })
execFileSync('powershell', [
  '-NoProfile',
  '-Command',
  `Expand-Archive -Path '${archive}' -DestinationPath '${staging}' -Force`
])

const extracted = join(staging, ...RELEASE.member.split('/'))
if (!existsSync(extracted)) {
  console.error(`Archive did not contain ${RELEASE.member}`)
  process.exit(1)
}
execFileSync('powershell', ['-NoProfile', '-Command', `Move-Item '${extracted}' '${exe}' -Force`])
rmSync(staging, { recursive: true, force: true })
rmSync(archive)

console.log(`\nWrote ${exe} (${(statSync(exe).size / 1e6).toFixed(1)} MB)`)
console.log('It is gitignored and packaged through extraResources.')

function download(url, destination, hop = 0) {
  return new Promise((res, rej) => {
    if (hop > 5) {
      rej(new Error('Too many redirects'))
      return
    }
    https
      .get(url, { headers: { 'user-agent': 'slash-build' } }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume()
          download(new URL(response.headers.location, url).toString(), destination, hop + 1).then(
            res,
            rej
          )
          return
        }
        if (response.statusCode !== 200) {
          rej(new Error(`Server answered ${response.statusCode}`))
          return
        }

        const total = Number(response.headers['content-length'] ?? 0)
        let seen = 0
        response.on('data', (chunk) => {
          seen += chunk.length
          if (total > 0) {
            process.stdout.write(`\r  ${((seen / total) * 100).toFixed(0)}%   `)
          }
        })

        const file = createWriteStream(destination)
        response.pipe(file)
        file.on('finish', () => file.close(() => res(undefined)))
        file.on('error', rej)
      })
      .on('error', rej)
  })
}
