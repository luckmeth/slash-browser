import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Assembles what the desktop build ships.
 *
 * Next's standalone output is deliberately incomplete: it omits `.next/static`
 * and `public/`, because in a normal deployment a CDN serves those. Embedded in
 * a desktop app there is no CDN, and without this copy every page loads with no
 * stylesheet and no JavaScript — which looks like a broken app rather than a
 * missing build step.
 */

const here = dirname(fileURLToPath(import.meta.url))
const desktop = join(here, '..')
const admin = join(desktop, '..', 'admin')
const standalone = join(admin, '.next', 'standalone')
const out = join(desktop, 'server')

if (!existsSync(join(standalone, 'admin', 'server.js'))) {
  console.error('No standalone build found. Run `npm run build` in platform/admin first.')
  process.exit(1)
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
cpSync(standalone, out, { recursive: true })

// The two things standalone leaves out.
cpSync(join(admin, '.next', 'static'), join(out, 'admin', '.next', 'static'), { recursive: true })
if (existsSync(join(admin, 'public'))) {
  cpSync(join(admin, 'public'), join(out, 'admin', 'public'), { recursive: true })
}

/**
 * The public half of the configuration, read from the admin app's own env file.
 *
 * Only the project URL and the anon key. The service-role key is deliberately
 * not here and never enters the build: it bypasses every access rule in the
 * database, so an executable carrying one hands the database to anyone who
 * copies the file. The app asks for it on first run instead.
 */
const envPath = join(admin, '.env.local')
if (!existsSync(envPath)) {
  console.error(`No ${envPath}. The build needs the project URL and anon key.`)
  process.exit(1)
}

const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
    .map((line) => {
      const at = line.indexOf('=')
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()]
    })
)

const url = env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
if (url === '' || anon === '') {
  console.error('NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is missing.')
  process.exit(1)
}
if (/service_role/.test(anon) || anon.startsWith('sb_secret_')) {
  // A guard, not paranoia: pasting the service key into the anon slot would ship
  // it inside every copy of the executable, silently.
  console.error('That looks like a secret key in the anon slot. Refusing to build.')
  process.exit(1)
}

writeFileSync(
  join(desktop, 'public-config.json'),
  JSON.stringify(
    { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_ANON_KEY: anon },
    null,
    2
  )
)

console.log(`server/ assembled and public-config.json written for ${url}`)
