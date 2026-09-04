import { app } from 'electron'
import type { BrowserWindowController } from '../windows/BrowserWindowController'
import { createLogger } from '../logger'

const log = createLogger('spike')

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface TogglesProbeHooks {
  settings: () => Record<string, unknown>
}

/**
 * Does clicking a switch actually change the setting?
 *
 * The settings screen was rebuilt around a pill switch, and a switch that looks
 * right and does nothing is worse than the checkbox it replaced. This clicks
 * every one on a category and compares the settings object either side, which
 * is the only check that distinguishes "the control moved" from "the value
 * changed" — and those came apart.
 */
export async function runTogglesProbe(
  window: BrowserWindowController,
  hooks: TogglesProbeHooks
): Promise<void> {
  let failures = 0
  const check = (name: string, passed: boolean, detail: string): void => {
    if (!passed) failures += 1
    log[passed ? 'info' : 'error'](`toggles probe [${name}]: ${passed ? 'PASS' : 'FAIL'} — ${detail}`)
  }

  const chrome = window.privilegedContents()[0]
  if (!chrome) {
    log.error('toggles probe: FAIL — no chrome view')
    app.quit()
    return
  }

  try {
    await chrome.executeJavaScript(
      `window.browser.invoke('settings:update', { onboardingCompleted: true })`
    )
    await delay(600)

    const overlay = window.overlay.webContents
    if (overlay) {
      await overlay
        .executeJavaScript(
          `(() => { const s = [...document.querySelectorAll('button')].find((b) => /skip/i.test(b.textContent||'')); if (s) { s.click(); return true } return false })()`
        )
        .catch(() => false)
      await delay(500)
    }

    for (const contents of window.privilegedContents()) {
      contents.send('ui:command', { command: 'open-settings' })
    }
    await delay(2000)

    for (const category of ['Privacy & security', 'Browsing', 'Appearance']) {
      await chrome.executeJavaScript(
        `(() => {
           const b = [...document.querySelectorAll('nav button')].find((x) => (x.textContent||'').trim() === ${JSON.stringify(
             category
           )});
           if (b) b.click();
           return !!b
         })()`
      )
      await delay(900)

      const found = (await chrome.executeJavaScript(`
        (() => {
          const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
          return boxes.map((b) => {
            const row = b.closest('label');
            return {
              label: row ? (row.textContent || '').slice(0, 44).trim() : '?',
              checked: b.checked,
              disabled: b.disabled
            };
          });
        })()
      `)) as { label: string; checked: boolean; disabled: boolean }[]

      const live = found.filter((entry) => !entry.disabled)
      log.info(`toggles probe: ${category} — ${live.length} switch(es)`)
      if (live.length === 0) continue

      const before = { ...hooks.settings() }
      // Counted per click, not by how many distinct keys moved. Several
      // switches legitimately write to the *same* key — the toolbar-button
      // toggles all edit `hiddenToolbarButtons` — so "four clicks changed four
      // keys" is the wrong question. "Did each click change something" is the
      // right one.
      let clicksThatDidNothing = 0
      let previous = { ...before }

      // One at a time, slowly, reporting what the DOM did and what the settings
      // did. Clicking eight in a tick told me only that something was wrong.
      for (let index = 0; index < Math.min(live.length, 4); index += 1) {
        const step = (await chrome.executeJavaScript(`
          (() => {
            const boxes = [...document.querySelectorAll('input[type="checkbox"]')].filter((b) => !b.disabled);
            const box = boxes[${index}];
            if (!box) return { ok: false };
            const row = box.closest('label');
            const wasChecked = box.checked;
            // What a pointer actually lands on: the visible track, not the
            // hidden input and not the whole row.
            // The visible track is the span immediately after the input.
            const track = box.nextElementSibling;
            const mode = ${JSON.stringify(process.env['SLASH_TOGGLE_TARGET'] ?? 'track')};
            const target = mode === 'track' ? (track || box) : (row || box);
            target.click();
            return {
              ok: true,
              tag: target.tagName + (target.className ? '.' + String(target.className).split(' ')[0] : ''),
              label: row ? (row.textContent || '').slice(0, 40).trim() : '?',
              hasFor: row ? !!row.getAttribute('for') : false,
              wasChecked,
              nowChecked: box.checked
            };
          })()
        `)) as {
          ok: boolean
          tag?: string
          label?: string
          hasFor?: boolean
          wasChecked?: boolean
          nowChecked?: boolean
        }

        await delay(500)
        const now = hooks.settings()
        const sinceLast = Object.keys(now).filter(
          (key) => JSON.stringify(now[key]) !== JSON.stringify(previous[key])
        )
        if (sinceLast.length === 0) clicksThatDidNothing += 1
        previous = { ...now }
        const diff = Object.keys(now).filter(
          (key) => JSON.stringify(now[key]) !== JSON.stringify(before[key])
        )
        const watched = ['blockAds', 'blockMaliciousSites', 'allowPageScripts', 'blockYouTubeVideoAds']
        const values = watched.map((key) => `${key}=${String(now[key])}`).join(' ')
        log.info(
          `toggles probe:   [${index}] "${step.label?.slice(0, 28)}" ` +
            `dom ${step.wasChecked}->${step.nowChecked} · ${values} · diff: ${diff.join(', ') || 'none'}`
        )
      }

      const after = hooks.settings()
      const changed = Object.keys(after).filter(
        (key) => JSON.stringify(after[key]) !== JSON.stringify(before[key])
      )
      const clicked = Math.min(live.length, 4)
      log.info(
        `toggles probe: ${category} — clicked ${clicked}, ${changed.length} setting(s) changed: ${changed.join(', ') || 'none'}`
      )
      check(
        `${category}-switches-work`,
        clicksThatDidNothing === 0,
        clicksThatDidNothing === 0
          ? `all ${clicked} clicks changed a setting (${changed.length} distinct key(s))`
          : `${clicksThatDidNothing} of ${clicked} clicks changed nothing at all`
      )

      // Put them back, so the next category starts from a known place and the
      // profile is not left with everything inverted.
      await chrome.executeJavaScript(`
        (() => {
          const boxes = [...document.querySelectorAll('input[type="checkbox"]')].filter((b) => !b.disabled);
          for (const box of boxes) { const row = box.closest('label'); if (row) row.click(); }
          return true;
        })()
      `)
      await delay(1200)
    }
  } catch (error) {
    check('ran', false, error instanceof Error ? error.message : String(error))
  }

  log.info(`toggles probe: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
  if (process.env['SLASH_PROBE_EXIT']) app.quit()
}
