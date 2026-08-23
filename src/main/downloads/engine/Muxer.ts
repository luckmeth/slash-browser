import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { createLogger } from '../../logger'

const log = createLogger('muxer')

/**
 * Joins a video track and an audio track into one playable file.
 *
 * ## Why this is needed at all
 *
 * Every adaptive streaming site above about 720p sends picture and sound as two
 * separate streams, chosen independently so the player can drop the video
 * quality without interrupting the audio. Downloading one gets you a silent
 * film; downloading both gets you two files. Joining them is the last thing
 * standing between this and a real download manager, and it is why every one of
 * those ships a copy of ffmpeg.
 *
 * ## Why ffmpeg, and why bundled
 *
 * The join is a **remux**, not a re-encode: the compressed streams are copied
 * into one container untouched. That is fast, lossless, and still a substantial
 * amount of container-format code — MP4 box rewriting, timestamp alignment,
 * codec-specific framing. Writing it would be months for a worse result.
 *
 * It ships with the installer rather than being fetched on first use, for the
 * same reason `resources/models/` does: downloading it when somebody presses a
 * button would turn a local feature into an outbound request to a third party,
 * on a machine whose owner was told nothing leaves it unless they said so.
 *
 * A missing binary is not a crash. `available()` is false, the picker offers the
 * two streams separately, and the reason is stated — which is exactly what
 * happened before this existed.
 */
export class Muxer {
  /**
   * Where the bundled binary lives.
   *
   * Beside `app.asar` rather than inside it: a packaged archive is not a
   * filesystem, and an executable cannot be run from within one. `extraResources`
   * puts it in the same place `resources/models/` goes, for the same reason.
   */
  private get binary(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe')
      : join(app.getAppPath(), 'resources', 'ffmpeg', 'ffmpeg.exe')
  }

  available(): boolean {
    return existsSync(this.binary)
  }

  /**
   * Copies both tracks into one file, then removes the parts.
   *
   * `-c copy` is the whole point: nothing is decoded or re-encoded, so a
   * two-hour film joins in a few seconds and comes out bit-identical to what
   * was downloaded. Re-encoding would take an hour and lose quality, and is
   * never what somebody pressing Download wanted.
   *
   * The parts are deleted only on success. A failed join leaves both files on
   * disk, because two playable halves are worth more than a tidy folder.
   */
  async join(videoPath: string, audioPath: string, outputPath: string): Promise<boolean> {
    if (!this.available()) {
      log.warn('no bundled ffmpeg — leaving the two streams as they are')
      return false
    }

    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      // Overwrite: the caller already picked a unique name, and a prompt from a
      // subprocess nobody can see would hang the download for ever.
      '-y',
      '-i',
      videoPath,
      '-i',
      audioPath,
      '-c',
      'copy',
      // Explicit stream mapping. Without it ffmpeg picks "best" from each input
      // and can quietly take the video input's silent audio track instead.
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      // Needed for AAC inside MP4 when the source was a transport stream.
      '-bsf:a',
      'aac_adtstoasc',
      outputPath
    ]

    try {
      await new Promise<void>((resolve, reject) => {
        execFile(this.binary, args, { windowsHide: true, maxBuffer: 1 << 20 }, (error, _out, err) => {
          if (error) {
            reject(new Error(err?.trim() || error.message))
            return
          }
          resolve()
        })
      })
    } catch (error) {
      // Reported, not thrown. A join that fails must leave the user with two
      // files that play rather than an error where their download was.
      log.warn('join failed; keeping the separate streams', error)
      return false
    }

    await Promise.all([
      rm(videoPath, { force: true }).catch(() => undefined),
      rm(audioPath, { force: true }).catch(() => undefined)
    ])
    log.info(`joined video and audio into ${outputPath}`)
    return true
  }
}
