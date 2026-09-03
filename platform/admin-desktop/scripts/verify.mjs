import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Parses everything this app executes, before it is packaged.
 *
 * A syntax error in main.js once meant the app never loaded at all — a blank
 * window, and nothing in any log, because the file that would have written the
 * log was the file that failed to parse. The inline script in setup.html is
 * the same class of failure and worse: it is a string as far as every build
 * step is concerned, so nothing checks it, and an operator sees a screen with
 * fields that do nothing.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const modules = ['main.js', 'preload.js', 'credentials.js']
const pages = ['setup.html', 'starting.html']

for (const file of modules) {
  execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'inherit' })
  console.log('ok  ' + file)
}

for (const page of pages) {
  const html = readFileSync(join(root, page), 'utf8')
  const open = '<script>'
  const close = '</' + 'script>'
  let from = html.indexOf(open)
  let scripts = 0

  while (from !== -1) {
    const end = html.indexOf(close, from)
    if (end === -1) throw new Error(page + ' has a <script> that is never closed.')
    // Function, not eval: this checks that the source parses without running a
    // line of it, and the page's globals do not exist here.
    new Function(html.slice(from + open.length, end))
    scripts += 1
    from = html.indexOf(open, end)
  }

  console.log('ok  ' + page + ' (' + scripts + ' inline script' + (scripts === 1 ? '' : 's') + ')')
}
