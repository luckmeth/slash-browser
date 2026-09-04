import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emits .next/standalone -- a server.js plus only the node_modules it
  // actually uses. That is what the desktop build embeds; the alternative is
  // shipping the whole workspace, which is hundreds of megabytes of things
  // this app never loads.
  output: 'standalone',
  // The workspace root, so tracing picks up files from ../node_modules.
  //
  // fileURLToPath, not URL.pathname: on Windows the latter yields
  // '/D:/Projects%20-%20Slash...' -- a leading slash and percent-encoded
  // spaces. Tracing then finds nothing and silently emits no standalone
  // build at all, with a successful-looking log.
  outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), '..'),
  // The shared package ships TypeScript source rather than a build step.
  transpilePackages: ['@slash/ad-shared'],
  // Creatives are delivered inline as data URLs, never as <img src> links,
  // so there is nothing here for the image optimiser to do.
  images: { unoptimized: true },
  eslint: { ignoreDuringBuilds: true }
}

export default nextConfig
