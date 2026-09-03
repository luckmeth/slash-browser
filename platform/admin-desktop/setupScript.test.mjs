import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The setup screen's inline script.
 *
 * It is a string as far as every build step is concerned: no typecheck, no
 * lint and no bundler ever looks inside it, so a typo'd property or a wrong
 * branch ships as a screen whose fields quietly do nothing. Same reasoning as
 * the browser's `extractScript.test.ts`, and the same method — run the real
 * source out of the real file against stand-ins for the page globals, rather
 * than a copy that can drift out of step with it.
 */

const here = dirname(fileURLToPath(import.meta.url))
const html = readFileSync(join(here, 'setup.html'), 'utf8')
const CLOSE = '</' + 'script>'
const source = html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf(CLOSE))

function element(id) {
  return {
    id,
    textContent: '',
    value: '',
    placeholder: '',
    className: '',
    hidden: false,
    disabled: false,
    focused: false,
    handlers: {},
    focus() {
      this.focused = true
    },
    addEventListener(type, handler) {
      this.handlers[type] = handler
    },
    async fire(type, event) {
      await this.handlers[type](event ?? {})
    }
  }
}

/** Runs the real script against a stubbed page, and reports what it touched. */
async function render(current, save = async () => ({ ok: true, problem: '' })) {
  const elements = new Map()
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, element(id))
    return elements.get(id)
  }

  const calls = []
  const win = {
    operations: {
      current: async () => current,
      save: async (fields) => {
        calls.push(fields)
        return save(fields)
      },
      cancel: async () => {
        calls.push('cancel')
        return true
      }
    }
  }

  new Function('document', 'window', source)({ getElementById: byId }, win)
  // describe() is async and the script starts it without awaiting; two turns
  // of the microtask queue is what the page itself gets before paint.
  await Promise.resolve()
  await Promise.resolve()

  return { get: byId, calls }
}

const nothingStored = { hasServiceKey: false, hasResendKey: false, emailFrom: '', running: false }
const fullyStored = {
  hasServiceKey: true,
  hasResendKey: true,
  emailFrom: 'Slash <ads@slash.test>',
  running: true
}

describe('the setup screen, on first run', () => {
  it('leaves the markup alone and offers no way out', async () => {
    const { get } = await render(nothingStored)
    // Nothing is stored, so every "a key is stored" rewrite must NOT happen:
    // these read as the markup's own wording, checked below.
    expect(get('heading').textContent).toBe('')
    expect(get('lede').textContent).toBe('')
    expect(get('key-state').textContent).toBe('')
    expect(get('save').textContent).toBe('')
    expect(get('key').placeholder).toBe('')
    // Nothing to cancel back to: the server has never started.
    expect(get('cancel').hidden).toBe(true)
    expect(get('key').focused).toBe(true)
  })

  it('shows email delivery as off, with empty fields', async () => {
    const { get } = await render(nothingStored)
    expect(get('email-state').textContent).toBe('— off')
    expect(get('email-state').className).toContain('off')
    expect(get('from').value).toBe('')
    expect(get('resend').placeholder).toBe('')
  })
})

describe('the markup the script leaves alone', () => {
  it('carries the first-run wording, which the script only overwrites', () => {
    expect(html).toContain('<h1 id="heading">Connect to your database</h1>')
    expect(html).toContain('<button id="save" type="button">Save and start</button>')
  })

  it('carries the placeholders for a screen with nothing stored', () => {
    // The script only overwrites these when something IS stored, so on first
    // run they are the only hint of what to paste.
    expect(html).toContain('placeholder="eyJhbGciOi… or sb_secret_…"')
    expect(html).toContain('placeholder="re_…"')
  })

  it('names every element the script reaches for', () => {
    for (const id of [
      'heading', 'lede', 'key-state', 'key', 'email-state', 'from', 'resend',
      'save', 'cancel', 'error'
    ]) {
      expect(html).toContain('id="' + id + '"')
    }
  })
})

describe('the setup screen, opened from the menu', () => {
  it('says a key is stored rather than asking for one again', async () => {
    const { get } = await render(fullyStored)
    expect(get('heading').textContent).toBe('Setup')
    expect(get('key-state').textContent).toContain('Leave the field blank to keep it')
    expect(get('key').placeholder).toBe('Stored — leave blank to keep')
    expect(get('save').textContent).toBe('Save and restart')
  })

  it('prefills the From address and reports delivery on', async () => {
    const { get } = await render(fullyStored)
    expect(get('from').value).toBe('Slash <ads@slash.test>')
    expect(get('resend').placeholder).toBe('Stored — leave blank to keep')
    expect(get('email-state').textContent).toBe('— on')
    expect(get('email-state').className).not.toContain('off')
    // The key is stored already, so the field worth typing in is the other one.
    expect(get('from').focused).toBe(true)
  })

  it('reports delivery off when only half of it is stored', async () => {
    const noKey = { ...fullyStored, hasResendKey: false }
    expect((await render(noKey)).get('email-state').textContent).toBe('— off')

    const noAddress = { ...fullyStored, emailFrom: '' }
    expect((await render(noAddress)).get('email-state').textContent).toBe('— off')
  })

  it('offers Cancel only while a server is running', async () => {
    expect((await render(fullyStored)).get('cancel').hidden).toBe(false)
    expect((await render({ ...fullyStored, running: false })).get('cancel').hidden).toBe(true)
  })
})

describe('saving', () => {
  it('sends all three fields, under the names main expects', async () => {
    const { get, calls } = await render(fullyStored)
    get('key').value = 'sb_secret_new'
    get('from').value = 'ads@slash.test'
    get('resend').value = 're_new'

    await get('save').fire('click')

    expect(calls).toEqual([
      { key: 'sb_secret_new', emailFrom: 'ads@slash.test', resendApiKey: 're_new' }
    ])
  })

  it('sends blank fields as blank, so main can read them as "keep"', async () => {
    const { get, calls } = await render(fullyStored)
    await get('save').fire('click')
    expect(calls).toEqual([{ key: '', emailFrom: 'Slash <ads@slash.test>', resendApiKey: '' }])
  })

  it('shows the problem and restores the button, wording included', async () => {
    const { get } = await render(fullyStored, async () => ({ ok: false, problem: 'No good.' }))
    await get('save').fire('click')

    expect(get('error').textContent).toBe('No good.')
    expect(get('save').disabled).toBe(false)
    // Not reset to the first-run wording: this screen restarts a server.
    expect(get('save').textContent).toBe('Save and restart')
  })

  it('leaves the button alone on success, because the window is navigating away', async () => {
    const { get } = await render(fullyStored)
    await get('save').fire('click')
    expect(get('save').disabled).toBe(true)
    expect(get('error').textContent).toBe('')
  })

  it('submits on Enter from any field, and on nothing else', async () => {
    for (const field of ['key', 'from', 'resend']) {
      const { get, calls } = await render(fullyStored)
      await get(field).fire('keydown', { key: 'Enter' })
      expect(calls).toHaveLength(1)

      await get(field).fire('keydown', { key: 'a' })
      expect(calls).toHaveLength(1)
    }
  })

  it('cancels back to the server', async () => {
    const { get, calls } = await render(fullyStored)
    await get('cancel').fire('click')
    expect(calls).toEqual(['cancel'])
  })
})

describe('when main cannot answer', () => {
  it('says so, instead of leaving a screen that looks ready', async () => {
    const elements = new Map()
    const byId = (id) => {
      if (!elements.has(id)) elements.set(id, element(id))
      return elements.get(id)
    }
    new Function('document', 'window', source)(
      { getElementById: byId },
      {
        operations: {
          current: async () => {
            throw new Error('no ipc')
          }
        }
      }
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(byId('error').textContent).toBe('no ipc')
  })
})
