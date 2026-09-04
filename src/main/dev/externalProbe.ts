import { app } from 'electron'
import { execFile } from 'node:child_process'
import { mkdtempSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { YtDlpService } from '../downloads/external/YtDlpService'
import { DownloadQueue } from '../downloads/engine/DownloadQueue'
import type { EngineDownload } from '@shared/types/downloadEngine'
import { createLogger } from '../logger'

const log = createLogger('spike')

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The external-downloader path, end to end, without the real yt-dlp.
 *
 * yt-dlp is not installed here and Slash must never install it, so this stands
 * up a fake that speaks the same protocol: `--version`, `--dump-single-json`,
 * the `--progress-template` this project defined, and the `after_move` filename
 * print. Everything under test is real — the service, the argument
 * construction, the line splitting, the adoption into `DownloadQueue`.
 *
 * The fake is a **`.cmd` shim** on purpose. That is how scoop and npm install
 * yt-dlp on Windows, Node refuses to spawn one directly, and a `.exe` fixture
 * would have tested the one case that was already working.
 */
export async function runExternalProbe(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'slash-external-'))
  const downloads = join(work, 'out')
  await fs.mkdir(downloads, { recursive: true })

  let failures = 0
  const check = (name: string, passed: boolean, detail: string): void => {
    if (!passed) failures += 1
    log[passed ? 'info' : 'error'](`external probe [${name}]: ${passed ? 'PASS' : 'FAIL'} — ${detail}`)
  }

  try {
    const shim = await writeFakeTool(work)
    const service = new YtDlpService(() => shim)

    // ---- 1. finding it --------------------------------------------------
    const located = await service.locate()
    check('locates-the-tool', located === shim, located === shim ? `found ${located}` : 'not found')

    // A direct run first, so a spawn failure below reports the tool's own words
    // rather than only an exit code.
    await new Promise<void>((resolve) => {
      execFile(
        `"${shim}" --no-playlist -f "bv*[height=2160]+ba/b[height<=2160]" -P "${downloads}"`,
        [],
        { shell: true, timeout: 20_000 },
        (error, stdout, stderr) => {
          log.debug(
            `external probe: direct run -> code=${(error as { code?: unknown } | null)?.code ?? 0} ` +
              `stdout=${JSON.stringify(stdout.slice(0, 200))} stderr=${JSON.stringify(stderr.slice(0, 300))}`
          )
          resolve()
        }
      )
    })
    await fs.rm(join(downloads, 'Probe_Video.mkv'), { force: true }).catch(() => {})

    // ---- 2. listing ------------------------------------------------------
    const listed = await service.listFormats('https://www.youtube.com/watch?v=probe')
    check(
      'lists-formats',
      listed.ok && listed.choices.length > 0,
      listed.ok
        ? `${listed.choices.length} rows: ${listed.choices.map((c) => c.label).join(' | ')}`
        : `failed: ${listed.error}`
    )
    check(
      'best-first-and-deduped',
      listed.choices[0]?.label.includes('2160p') === true &&
        listed.choices.filter((c) => c.height === 1080).length === 1,
      `top row "${listed.choices[0]?.label}", ${listed.choices.filter((c) => c.height === 1080).length} row(s) at 1080p`
    )

    // ---- 3. downloading, adopted into the real queue ---------------------
    let latest: EngineDownload[] = []
    const queue = new DownloadQueue(
      () => downloads,
      () => 4,
      () => 0,
      (items) => {
        latest = items
      }
    )

    const selector = listed.choices[0]?.selector ?? 'b'
    let handle: { cancel: () => void } | null = null
    const adopted = queue.adoptExternal({
      url: 'https://www.youtube.com/watch?v=probe',
      filename: 'Probe Video',
      directory: downloads,
      connectionNote: 'via yt-dlp',
      onCancel: () => handle?.cancel()
    })

    let sawProgress = 0
    let peak = 0
    const finished = new Promise<{ ok: boolean; error: string | null; file: string | null }>(
      (resolve) => {
        handle = service.start('https://www.youtube.com/watch?v=probe', selector, downloads, {
          onProgress: (progress) => {
            sawProgress += 1
            peak = Math.max(peak, progress.downloadedBytes)
            adopted.progress(progress.downloadedBytes, progress.totalBytes, progress.bytesPerSecond)
          },
          onDone: (result) => {
            adopted.finish(result)
            resolve(result)
          }
        })
      }
    )

    check('starts', handle !== null, handle !== null ? 'the tool was spawned' : 'spawn returned null')

    const result = await Promise.race([
      finished,
      delay(45_000).then(() => ({ ok: false, error: 'timed out', file: null }))
    ])

    check('reports-progress', sawProgress >= 3, `${sawProgress} progress line(s), peak ${peak} bytes`)
    check('completes', result.ok, result.ok ? `finished, file=${result.file}` : `failed: ${result.error}`)

    // The bytes, not the status. A completed row with no file is the failure
    // this exists to catch.
    const onDisk = await fs.readdir(downloads)
    check(
      'file-exists',
      onDisk.length === 1,
      onDisk.length === 1 ? `wrote ${onDisk[0]}` : `expected one file, found ${JSON.stringify(onDisk)}`
    )
    if (result.file) {
      const bytes = await fs.readFile(result.file).catch(() => Buffer.alloc(0))
      check('file-has-content', bytes.length > 0, `${bytes.length} bytes at the reported path`)
    }

    // ---- 4. it shows up in the one downloads list ------------------------
    const row = latest.find((item) => item.id === adopted.id)
    check(
      'appears-in-the-list',
      row?.state === 'completed',
      `state=${row?.state} note="${row?.connectionNote}" name="${row?.filename}"`
    )
    check(
      'says-who-did-it',
      (row?.connectionNote ?? '').includes('yt-dlp'),
      // A download the browser could not make itself must not appear
      // indistinguishable from ones it did.
      `note reads "${row?.connectionNote}"`
    )

    queue.dispose()
  } catch (error) {
    check('ran', false, error instanceof Error ? error.message : String(error))
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {})
  }

  log.info(`external probe: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
  if (process.env['SLASH_PROBE_EXIT']) app.quit()
}

/**
 * A stand-in that answers the three things the service asks for.
 *
 * Written as a Node script behind a `.cmd`, because that is the shape a real
 * scoop or npm install of yt-dlp has on Windows.
 */
async function writeFakeTool(directory: string): Promise<string> {
  const script = join(directory, 'fake-ytdlp.js')
  const shim = join(directory, 'yt-dlp.cmd')

  await fs.writeFile(
    script,
    `
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)

if (args.includes('--version')) {
  process.stdout.write('2026.08.01\\n')
  process.exit(0)
}

if (args.includes('--dump-single-json')) {
  process.stdout.write(JSON.stringify({
    title: 'Probe Video',
    formats: [
      { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', filesize: 3500000 },
      { format_id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', height: 1080, filesize: 45000000 },
      { format_id: '248', ext: 'webm', vcodec: 'vp9', acodec: 'none', height: 1080, filesize: 40000000 },
      { format_id: '271', ext: 'webm', vcodec: 'vp9', acodec: 'none', height: 1440, filesize: 90000000 },
      { format_id: '313', ext: 'webm', vcodec: 'vp9', acodec: 'none', height: 2160, filesize: 200000000 },
      { format_id: '136', ext: 'mp4', vcodec: 'avc1.4d401f', acodec: 'none', height: 720, filesize: 20000000 }
    ]
  }))
  process.exit(0)
}

// A download. Honour -P for the folder, then emit progress in the template's
// shape and print the final path the way --print after_move does.
const dirAt = args.indexOf('-P')
const dir = dirAt === -1 ? process.cwd() : args[dirAt + 1]
const file = path.join(dir, 'Probe_Video.mkv')
const total = 5 * 1024 * 1024

let written = 0
const chunk = Buffer.alloc(512 * 1024, 7)
fs.writeFileSync(file, Buffer.alloc(0))

const tick = () => {
  written += chunk.length
  fs.appendFileSync(file, chunk)
  const done = written >= total
  process.stdout.write(
    'SLASH|' + Math.min(written, total) + '|' + total + '|NA|1048576.0|' +
      (done ? 'finished' : 'downloading') + '\\n'
  )
  if (!done) return setTimeout(tick, 60)
  process.stdout.write('SLASHFILE|' + file + '\\n')
  process.exit(0)
}
setTimeout(tick, 60)
`,
    'utf8'
  )

  await fs.writeFile(
    shim,
    // Plain `node`, not `process.execPath`. This process is Electron, which
    // launches as a GUI application when handed a script and exits -1 rather
    // than running it — the first version of this fixture failed for that
    // reason and looked like a bug in the service. Any environment that can
    // build this repo has node on PATH.
    `@echo off\r\nnode "%~dp0fake-ytdlp.js" %*\r\n`,
    'utf8'
  )
  return shim
}
