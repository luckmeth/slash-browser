const { app, BrowserWindow, ipcMain, safeStorage, shell, dialog } = require('electron')
const { fork } = require('node:child_process')
const { createServer } = require('node:net')
const { appendFileSync, readFileSync, writeFileSync, existsSync, rmSync } = require('node:fs')
const { join } = require('node:path')

/**
 * Slash Operations — the advertising and browser management app, as a desktop
 * application.
 *
 * It embeds the same Next.js app that runs at localhost:3001 and nothing else:
 * one build, one set of pages, no second implementation to drift out of step.
 * The shell's whole job is to hold the service-role key safely, start the
 * server on a private port, and show it.
 *
 * **The service-role key is never baked into this executable.** It bypasses
 * every row-level security policy in the database, so an .exe carrying one is a
 * file that hands the whole database to anyone who copies it. It is asked for on
 * first run and kept encrypted by the operating system — DPAPI on Windows,
 * through Electron's `safeStorage` — which ties it to the Windows account that
 * entered it. Copying the exe to another machine gets you a setup screen, not a
 * database.
 */

/** Where the encrypted key lives. Outside the app directory, so an update cannot lose it. */
const credentialsFile = () => join(app.getPath('userData'), 'operations.credentials')

/**
 * Project URL and anon key, written at build time by scripts/prepare-server.mjs.
 *
 * Safe to ship: the anon key identifies the project and authorises nothing by
 * itself -- what a signed-in person may read is decided by row-level security,
 * server-side, on every request. It also HAS to be baked in: Next inlines
 * NEXT_PUBLIC_ values into the client bundle when the app is built, so asking
 * for it at runtime would change nothing about what the pages already contain.
 */
function publicConfig() {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'public-config.json')
    : join(__dirname, 'public-config.json')
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Appends to a log beside the credentials.
 *
 * A packaged Electron app on Windows is not attached to a console, so its
 * stdout goes nowhere. Without this, a failure to start leaves an operator
 * with a red sentence and no way to find out any more than it says.
 */
function logLine(text) {
  try {
    appendFileSync(join(app.getPath('userData'), 'operations.log'), new Date().toISOString() + ' ' + text + String.fromCharCode(10))
  } catch {
    /* logging must never be the thing that breaks startup */
  }
}

let serverProcess = null
let window = null

function readSecret() {
  const path = credentialsFile()
  if (!existsSync(path)) return null
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(readFileSync(path))
  } catch {
    // Written by a different Windows account, or the file is damaged. Treated as
    // absent so the setup screen appears, rather than failing to start with an
    // error nobody can act on.
    return null
  }
}

function writeSecret(value) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('This system cannot encrypt stored credentials, so the key will not be saved.')
  }
  writeFileSync(credentialsFile(), safeStorage.encryptString(value))
}

/** A free port, asked of the operating system rather than guessed. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', reject)
    // Bound to loopback for the same reason the server is: nothing here should
    // be reachable from the network.
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

async function waitForServer(port, hasExited = () => false, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (hasExited()) return false
    try {
      const response = await fetch(`http://127.0.0.1:${port}/login`, { redirect: 'manual' })
      if (response.status > 0) return true
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

async function startServer(secret) {
  const port = await freePort()

  // In a packaged build the server sits beside app.asar, because Node cannot
  // require through the archive.
  const root = app.isPackaged
    ? join(process.resourcesPath, 'server')
    : join(__dirname, '..', 'admin', '.next', 'standalone')

  const entry = join(root, 'admin', 'server.js')
  if (!existsSync(entry)) {
    throw new Error(
      `The embedded server is missing (${entry}). Run "npm run build:server" in platform/admin-desktop.`
    )
  }

  serverProcess = fork(entry, [], {
    cwd: join(root, 'admin'),
    env: {
      ...process.env,
      // Without this the child is a second copy of THIS APP.
      //
      // fork() launches process.execPath, which in a packaged build is
      // electron.exe -- so it started another Electron instance that ignored
      // server.js entirely, and the only symptom was a thirty-second wait
      // ending in "did not start in time". ELECTRON_RUN_AS_NODE makes the
      // same binary behave as plain Node, which is what the server needs.
      ELECTRON_RUN_AS_NODE: '1',
      ...publicConfig(),
      SUPABASE_SERVICE_ROLE_KEY: secret,
      // Loopback only. Binding to 0.0.0.0 would put an app with a service-role
      // key on the local network, reachable by anything else on it.
      HOSTNAME: '127.0.0.1',
      PORT: String(port),
      NODE_ENV: 'production',
      NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${port}`
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })

  // Kept so a failure can say what happened. A thirty-second wait ending in
  // "did not start" tells the operator nothing they can act on.
  let output = ''
  const record = (chunk) => {
    output += chunk
    if (output.length > 4000) output = output.slice(-4000)
  }
  serverProcess.stdout?.on('data', (chunk) => { record(chunk); logLine('[server] ' + String(chunk).trimEnd()) })
  serverProcess.stderr?.on('data', (chunk) => { record(chunk); logLine('[server:err] ' + String(chunk).trimEnd()) })

  // A child that exits immediately must not be waited on for thirty seconds.
  let exited = null
  serverProcess.on('exit', (code, signal) => { exited = { code, signal } })

  const ready = await waitForServer(port, () => exited !== null)
  if (!ready) {
    const why = exited
      ? `It stopped immediately (exit code ${exited.code}).`
      : 'It did not answer in time.'
    // The tail of whatever the server printed, verbatim. No line splitting:
    // an operator needs the last thing it said, not a tidy summary of it.
    const tail = output.trim().slice(-500)
    throw new Error(why + (tail ? String.fromCharCode(10, 10) + tail : String()))
  }
  return port
}

function createWindow() {
  window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0d12',
    title: 'Slash Operations',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      // The same posture the browser takes with its own chrome. This window
      // loads a local server, but "local" is not a reason to hand it Node.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  // Anything not on the embedded server opens in the real browser rather than
  // inside an app holding a service-role key.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  return window
}

async function boot() {
  const secret = readSecret()

  if (!secret) {
    createWindow()
    await window.loadFile(join(__dirname, 'setup.html'))
    return
  }

  createWindow()
  await window.loadFile(join(__dirname, 'starting.html'))

  try {
    const port = await startServer(secret)
    await window.loadURL(`http://127.0.0.1:${port}`)
  } catch (error) {
    await dialog.showMessageBox(window, {
      type: 'error',
      title: 'Could not start',
      message: 'The operations server did not start.',
      detail: String(error && error.message ? error.message : error)
    })
    await window.loadFile(join(__dirname, 'setup.html'))
  }
}

ipcMain.handle('setup:save', async (_event, key) => {
  const trimmed = String(key ?? '').trim()
  // Both formats Supabase issues. Checked here so a pasted anon key — which
  // looks similar and would fail silently on every query — is caught now rather
  // than as an empty review queue later.
  if (!/^(eyJ|sb_secret_)/.test(trimmed)) {
    return { ok: false, problem: 'That does not look like a service_role key.' }
  }
  try {
    writeSecret(trimmed)
  } catch (error) {
    return { ok: false, problem: String(error.message) }
  }

  try {
    const port = await startServer(trimmed)
    await window.loadURL(`http://127.0.0.1:${port}`)
    return { ok: true, problem: '' }
  } catch (error) {
    return { ok: false, problem: String(error && error.message ? error.message : error) }
  }
})

ipcMain.handle('setup:forget', () => {
  rmSync(credentialsFile(), { force: true })
  return true
})

app.whenReady().then(boot)

app.on('window-all-closed', () => app.quit())

// The server is a child process; without this it outlives the window it was
// started for and holds the port until the machine is restarted.
app.on('before-quit', () => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill()
})
