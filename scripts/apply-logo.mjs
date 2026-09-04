/**
 * Turns one logo file into every icon the build needs.
 *
 *   npm run logo -- path/to/logo.png
 *   npm run logo                        # uses build/logo-source.png
 *
 * The point is that there is exactly **one** place to put a new logo. Before
 * this, changing it meant producing a 1024px PNG and a multi-resolution ICO by
 * hand and remembering that the second one exists — which is how an application
 * ends up with a new logo everywhere except the installer and the uninstall
 * entry, six months after somebody thought they had changed it.
 *
 * `sharp` is already a dependency (transformers.js requires it at the top level
 * of its bundle), so this adds nothing to the install. It is a build-time
 * script and never runs in the app.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/**
 * Default source: the SVG the mark is actually authored in.
 *
 * An SVG rather than a PNG because sharp rasterises it at whatever size is
 * asked for, so the 16px icon is *rendered* at 16px rather than downsampled
 * from 1024 — which is the difference between a legible mark and a grey smear
 * in the taskbar. A PNG passed on the command line still works.
 */
const source = resolve(process.argv[2] ?? join(root, 'build', 'logo.svg'))

/**
 * Sizes Windows actually asks for.
 *
 * 16 and 32 are the taskbar and title bar; 48 is the desktop; 256 is the large
 * icon view and what the installer shows. Shipping fewer means Windows scales
 * one down itself, which is where a clean mark turns to mush at 16px.
 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

/** What electron-builder embeds in the exe, and what it derives other sizes from. */
const APP_ICON_SIZE = 1024

if (!existsSync(source)) {
  console.error(
    `No logo at ${source}.\n\n` +
      `Put the image there, or pass a path:\n` +
      `  npm run logo -- path/to/logo.png\n\n` +
      `A square PNG of at least 512x512 with a transparent background works best.`
  )
  process.exit(1)
}

const input = readFileSync(source)
const isVector = source.toLowerCase().endsWith('.svg')
const meta = await sharp(input).metadata()

if (!meta.width || !meta.height) {
  console.error(`${source} is not an image sharp can read.`)
  process.exit(1)
}
if (Math.abs(meta.width - meta.height) > 2) {
  // Not fatal — the resize below pads it — but a non-square source almost always
  // means somebody exported a wordmark, and a wordmark at 16px is a smudge.
  console.warn(
    `Warning: ${meta.width}x${meta.height} is not square. It will be padded, ` +
      `but an app icon wants the mark on its own, not a wordmark.`
  )
}
if (!isVector && meta.width < 256) {
  console.warn(`Warning: ${meta.width}px source. Upscaling to ${APP_ICON_SIZE} will look soft.`)
}

/**
 * Square, transparent-padded, at one size.
 *
 * A vector source is re-rasterised per size rather than downsampled from one
 * big bitmap. `density` is DPI against a 96-DPI baseline and the SVG declares
 * its own 1024px box, so this asks for four times the target and resizes down —
 * supersampling, which is what keeps the diagonal edges of the mark clean at
 * 16px instead of aliasing into a grey smear.
 *
 * Four times, not twelve: density is applied to the declared size, so a large
 * multiplier at 1024 asks for a bitmap big enough to trip sharp's pixel limit.
 */
const render = (size) => {
  const options = isVector ? { density: Math.max(8, Math.ceil((size / 1024) * 96 * 4)) } : {}
  return sharp(input, options)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

/**
 * A multi-size .ico.
 *
 * ICO is a 6-byte header, one 16-byte directory entry per image, then the
 * payloads. Every payload here is a PNG, which Windows has accepted at every
 * size since Vista — so no BMP/DIB encoding is needed and the alpha channel
 * survives intact.
 */
function buildIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(images.length, 4)

  const directory = Buffer.alloc(16 * images.length)
  let offset = header.length + directory.length

  images.forEach(({ size, data }, index) => {
    const at = index * 16
    // 256 is written as 0 — the field is one byte and 256 does not fit.
    directory.writeUInt8(size >= 256 ? 0 : size, at)
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1)
    directory.writeUInt8(0, at + 2) // palette size: 0 for truecolour
    directory.writeUInt8(0, at + 3) // reserved
    directory.writeUInt16LE(1, at + 4) // colour planes
    directory.writeUInt16LE(32, at + 6) // bits per pixel
    directory.writeUInt32LE(data.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += data.length
  })

  return Buffer.concat([header, directory, ...images.map((image) => image.data)])
}

const appIcon = join(root, 'build', 'icon.png')
writeFileSync(appIcon, await render(APP_ICON_SIZE))
console.log(`wrote ${appIcon} (${APP_ICON_SIZE}x${APP_ICON_SIZE})`)

const icoImages = []
for (const size of ICO_SIZES) icoImages.push({ size, data: await render(size) })

const icoPath = join(root, 'build', 'icon.ico')
writeFileSync(icoPath, buildIco(icoImages))
console.log(`wrote ${icoPath} (${ICO_SIZES.join(', ')})`)

console.log(
  `\nDone. Run \`npm run package\` to see it on the executable, the installer and the taskbar.\n` +
    `The in-app mark is separate: src/renderer/components/BrandMark.tsx draws it as SVG so it\n` +
    `recolours with the surrounding text. Update that by hand to match.`
)
