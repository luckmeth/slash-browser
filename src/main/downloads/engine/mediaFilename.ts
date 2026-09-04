/**
 * Basenames that identify an endpoint rather than a video.
 *
 * Streaming sites name the manifest after its role in the protocol, not after
 * the film: `index.m3u8`, `master.m3u8`, `playlist.m3u8`, and on YouTube every
 * single stream is called `videoplayback`. Deriving a filename from the path
 * then fills a downloads folder with identically-named files nobody can tell
 * apart - which is exactly what shipped, and why a two-hour film arrived called
 * `index.ts`.
 */
const UNINFORMATIVE = /^(index|master|playlist|manifest|video|audio|stream|chunklist|videoplayback|media|out|output|prog|hls|dash|seg(ment)?)([-_.]?\d+)?$/i

/** Site furniture on the end of a page title, which is never part of the name. */
const TITLE_TAIL =
  /\s*[|–—-]\s*(youtube|watch online free.*|123movies.*|streamm4u.*|full movie.*|hd)\s*$/i

/**
 * A filename for a piece of detected media, preferring the page's own title.
 *
 * The URL is consulted only when it carries something meaningful. That is the
 * opposite of the usual order and it is deliberate: for ordinary files the path
 * *is* the name, but detected media is nearly always fetched from an endpoint
 * whose path describes the protocol.
 *
 * Pure, and no extension is added. The container is not known until the
 * manifest has been read, and `withExtension` puts it on later once it is - so
 * a name chosen here must not guess one.
 */
export function mediaFilename(pageTitle: string, url: string, fallback = 'video'): string {
  const fromUrl = basenameOf(url)
  const title = cleanTitle(pageTitle)

  // A path that names the file wins, because it is the most specific thing
  // available - `The.Matrix.1999.1080p.mp4` beats any page title.
  if (fromUrl !== '' && !UNINFORMATIVE.test(stripExtension(fromUrl))) {
    return fromUrl
  }
  if (title !== '') return title
  if (fromUrl !== '') return fromUrl
  return fallback
}

function basenameOf(url: string): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
    return last.trim()
  } catch {
    return ''
  }
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/**
 * The page title, with the site's own branding taken off the end.
 *
 * Capped well below any filesystem limit: the whole path has to fit, and a
 * YouTube title can run to a hundred characters before the extension and the
 * folder are added.
 */
function cleanTitle(raw: string): string {
  const trimmed = raw.replace(TITLE_TAIL, '').trim()
  return trimmed.length > 120 ? trimmed.slice(0, 120).trimEnd() : trimmed
}
