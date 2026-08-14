import { join } from 'node:path'

/**
 * Resolves one of the renderer's HTML entry points.
 *
 * In dev, electron-vite serves every entry from one origin, so a document is a
 * path on that server. In production the same documents are files emitted next
 * to the main bundle. Loading a file needs `loadFile`, not `loadURL`, so callers
 * get a discriminated result rather than a string they might pass to the wrong
 * method.
 */
export type RendererEntry =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'file'; readonly path: string }

export function rendererEntry(document: 'index' | 'overlay'): RendererEntry {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) {
    return { kind: 'url', url: `${devServer}/${document}.html` }
  }
  return { kind: 'file', path: join(__dirname, `../renderer/${document}.html`) }
}
