const { cpSync, existsSync } = require('node:fs')
const { join } = require('node:path')

/**
 * Copies the embedded server into the packed application.
 *
 * Done here rather than through `extraResources` because electron-builder
 * strips `node_modules` out of those, whatever filter you give it. That is a
 * sensible default for an app directory and wrong for this one, where
 * node_modules IS the payload — the app packaged cleanly and then died on
 * launch with "Cannot find module 'next'", which is a failure that only shows
 * up on a machine that has never had the sources.
 *
 * Runs after the unpacked directory exists and before the installers are built,
 * so both the NSIS and the portable target pick it up.
 */
exports.default = async function afterPack(context) {
  const from = join(__dirname, '..', 'server')
  const to = join(context.appOutDir, 'resources', 'server')

  if (!existsSync(join(from, 'admin', 'server.js'))) {
    throw new Error(`No assembled server at ${from}. Run "npm run build:server" first.`)
  }

  cpSync(from, to, { recursive: true })

  // Asserted rather than assumed: the whole reason this hook exists is that a
  // silent partial copy is indistinguishable from a working build until launch.
  const proof = join(to, 'node_modules', 'next', 'package.json')
  if (!existsSync(proof)) {
    throw new Error(`The server copy is missing its dependencies (${proof}).`)
  }

  console.log(`  • embedded server copied  to=${to}`)
}
