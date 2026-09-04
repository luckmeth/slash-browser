import { app } from 'electron'
import { mkdtempSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindowController } from '../windows/BrowserWindowController'
import { openTargetFromArgv } from '../system/defaultBrowserRules'
import { createLogger } from '../logger'

const log = createLogger('spike')

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Can Slash actually open a PDF it is handed?
 *
 * Two separate things get confused here and only one of them is ours. Being the
 * default *browser* registers `http`/`https` and nothing else — a PDF is a
 * **file** association, which Windows decides through its own UserChoice and no
 * application may set from code. So "I made Slash default and PDFs still open
 * elsewhere" is usually Windows, not Slash.
 *
 * What *is* ours is everything after Windows hands the path over: argv has to
 * recognise it, a tab has to load it, and Chromium's PDF viewer has to be
 * enabled. This checks that end, with a real file, so the answer to the user is
 * about the right half of the problem.
 */
export async function runPdfProbe(window: BrowserWindowController): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'slash-pdf-'))
  let failures = 0
  const check = (name: string, passed: boolean, detail: string): void => {
    if (!passed) failures += 1
    log[passed ? 'info' : 'error'](`pdf probe [${name}]: ${passed ? 'PASS' : 'FAIL'} — ${detail}`)
  }

  // The first tab is created on the chrome view's did-finish-load, so this has
  // to wait rather than assume one exists.
  for (let waited = 0; waited < 15000 && !window.tabs.snapshot().activeTabId; waited += 200) {
    await delay(200)
  }

  try {
    // A minimal but genuinely valid PDF: one page, one line of text.
    const pdf = [
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
      '4 0 obj<</Length 52>>stream',
      'BT /F1 18 Tf 30 120 Td (Slash PDF probe) Tj ET',
      'endstream endobj',
      '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
      'trailer<</Root 1 0 R>>',
      '%%EOF'
    ].join('\n')
    const file = join(work, 'probe.pdf')
    await fs.writeFile(file, pdf, 'latin1')

    // ---- 1. argv: does a PDF path even reach the browser? ------------------
    const target = openTargetFromArgv(['C:/Slash/Slash.exe', file])
    check(
      'argv-accepts-a-pdf',
      target !== null && target.startsWith('file:///'),
      target === null
        ? 'a .pdf handed over by Windows would be ignored — Slash would open to a blank tab'
        : `resolved to ${target}`
    )

    // ---- 2. does a tab actually render it? ---------------------------------
    const activeId = window.tabs.snapshot().activeTabId
    if (!activeId || target === null) {
      check('has-a-tab', false, 'no active tab to load into')
    } else {
      window.tabs.navigate(activeId, target)
      await delay(6000)

      const contents = window.tabs.activeTab?.contents ?? null
      const loaded = contents !== null && !contents.isDestroyed()
      const url = loaded ? contents.getURL() : ''
      check('tab-loaded-it', loaded && url.startsWith('file:///'), `tab url = ${url || 'none'}`)

      const record = window.tabs.allTabs().find((tab) => tab.id === activeId)
      check(
        'no-error-page',
        !record?.snapshot.error,
        record?.snapshot.error
          ? `Slash showed its own error page: ${record.snapshot.error}`
          : 'no error was recorded'
      )

      // Chromium renders a PDF in an internal plugin document, so the page's
      // own DOM is an <embed>. Its presence is the difference between "the
      // viewer ran" and "the file was downloaded instead".
      const shape = (await contents
        ?.executeJavaScript(
          `(() => {
             const embed = document.querySelector('embed');
             return JSON.stringify({
               type: embed ? embed.getAttribute('type') : null,
               contentType: document.contentType || ''
             });
           })()`
        )
        .catch(() => '{}')) as string
      const parsed = JSON.parse(shape || '{}') as { type?: string | null; contentType?: string }
      check(
        'pdf-viewer-ran',
        parsed.contentType === 'application/pdf' || parsed.type === 'application/pdf',
        `contentType=${parsed.contentType || 'none'} embed=${parsed.type ?? 'none'}`
      )
    }
  } catch (error) {
    check('ran', false, error instanceof Error ? error.message : String(error))
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {})
  }

  log.info(`pdf probe: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
  if (process.env['SLASH_PROBE_EXIT']) app.quit()
}
