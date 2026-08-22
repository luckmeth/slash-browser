import express from 'express'
import { openDatabase } from './db.js'
import { currentCompany, hashPassword, newSessionToken, verifyPassword } from './auth.js'
import { adminQueue, authForm, dashboard, landing, page } from './views.js'

const db = openDatabase(process.env.PORTAL_DB)
const app = express()

// Creatives arrive as data URLs in a form field, which is why the body limit is
// generous. Uploads are capped at 500 KB in the browser and again below.
app.use(express.urlencoded({ extended: false, limit: '2mb' }))
app.use(express.json({ limit: '2mb' }))

/** How long a served batch stays valid. The browser caps this at 7 days anyway. */
const BATCH_TTL_MS = 6 * 60 * 60 * 1000
const MAX_IMAGE_BYTES = 700_000

const now = () => Date.now()
const requireCompany = (req, res) => {
  const company = currentCompany(db, req)
  if (!company) {
    res.redirect('/login')
    return null
  }
  return company
}

// --- public ----------------------------------------------------------------

app.get('/', (req, res) => {
  const company = currentCompany(db, req)
  if (company) return res.redirect('/dashboard')
  res.send(page({ title: 'Advertise', company: null, body: landing() }))
})

app.get('/signup', (req, res) =>
  res.send(page({ title: 'Create an account', company: null, body: authForm({ mode: 'signup' }) }))
)

app.post('/signup', (req, res) => {
  const name = String(req.body.name ?? '').trim()
  const email = String(req.body.email ?? '').trim().toLowerCase()
  const password = String(req.body.password ?? '')

  const fail = (error) =>
    res.status(400).send(
      page({ title: 'Create an account', company: null, body: authForm({ mode: 'signup', error }) })
    )

  if (name === '' || email === '') return fail('A company name and email are both needed.')
  if (password.length < 8) return fail('Passwords must be at least 8 characters.')
  if (db.prepare('SELECT 1 FROM companies WHERE email = ?').get(email)) {
    return fail('That email already has an account.')
  }

  // The first account to register administers the portal. Whoever stands this
  // up is its operator, and there is no one else to grant it to.
  const isFirst = db.prepare('SELECT COUNT(*) AS n FROM companies').get().n === 0
  const { salt, key } = hashPassword(password)
  const info = db
    .prepare(
      `INSERT INTO companies (name, email, password_key, salt, is_admin, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(name, email, key, salt, isFirst ? 1 : 0, now())

  startSession(res, Number(info.lastInsertRowid))
  res.redirect('/dashboard')
})

app.get('/login', (req, res) =>
  res.send(page({ title: 'Sign in', company: null, body: authForm({ mode: 'login' }) }))
)

app.post('/login', (req, res) => {
  const email = String(req.body.email ?? '').trim().toLowerCase()
  const password = String(req.body.password ?? '')
  const company = db.prepare('SELECT * FROM companies WHERE email = ?').get(email)

  // One message for both cases: saying which half was wrong tells an attacker
  // which addresses have accounts.
  if (!company || !verifyPassword(password, company.salt, company.password_key)) {
    return res.status(401).send(
      page({
        title: 'Sign in',
        company: null,
        body: authForm({ mode: 'login', error: 'That email and password do not match.' })
      })
    )
  }

  startSession(res, company.id)
  res.redirect('/dashboard')
})

app.post('/logout', (req, res) => {
  const company = currentCompany(db, req)
  if (company) db.prepare('DELETE FROM sessions WHERE company_id = ?').run(company.id)
  res.clearCookie('slash_portal')
  res.redirect('/')
})

// --- advertiser ------------------------------------------------------------

app.get('/dashboard', (req, res) => {
  const company = requireCompany(req, res)
  if (!company) return

  const campaigns = db
    .prepare('SELECT * FROM campaigns WHERE company_id = ? ORDER BY created_at DESC')
    .all(company.id)

  const totals = new Map()
  for (const row of db
    .prepare(
      `SELECT c.campaign_id, SUM(c.impressions) AS impressions, SUM(c.clicks) AS clicks
         FROM counts c JOIN campaigns m ON m.id = c.campaign_id
        WHERE m.company_id = ? GROUP BY c.campaign_id`
    )
    .all(company.id)) {
    totals.set(row.campaign_id, { impressions: row.impressions ?? 0, clicks: row.clicks ?? 0 })
  }

  res.send(
    page({ title: 'Campaigns', company, body: dashboard({ company, campaigns, totals }) })
  )
})

app.post('/campaigns', (req, res) => {
  const company = requireCompany(req, res)
  if (!company) return

  const name = String(req.body.name ?? '').trim()
  const headline = String(req.body.headline ?? '').trim()
  const body = String(req.body.body ?? '').trim()
  const clickUrl = String(req.body.clickUrl ?? '').trim()
  const image = String(req.body.image ?? '')

  const fail = (error) => {
    const campaigns = db
      .prepare('SELECT * FROM campaigns WHERE company_id = ? ORDER BY created_at DESC')
      .all(company.id)
    res
      .status(400)
      .send(
        page({
          title: 'Campaigns',
          company,
          body: dashboard({ company, campaigns, totals: new Map(), error })
        })
      )
  }

  if (name === '' || headline === '') return fail('A name and a headline are both needed.')

  // The same two rules the browser enforces, applied here so a campaign cannot
  // sit approved in the queue and then be silently dropped by every reader.
  if (!/^https:\/\//i.test(clickUrl)) return fail('The landing page must be an https:// address.')
  if (image !== '' && !image.startsWith('data:image/')) {
    return fail('The image must be uploaded, not linked from another server.')
  }
  if (image.length > MAX_IMAGE_BYTES) return fail('That image is too large. Keep it under 500 KB.')

  db.prepare(
    `INSERT INTO campaigns (company_id, name, headline, body, image, click_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(company.id, name, headline, body, image, clickUrl, now())

  res.redirect('/dashboard')
})

// --- operator --------------------------------------------------------------

app.get('/admin', (req, res) => {
  const company = requireCompany(req, res)
  if (!company) return
  if (!company.is_admin) return res.status(403).send(page({ title: 'Not allowed', company, body: '<h1>Not allowed</h1>' }))

  const pending = db
    .prepare(
      `SELECT m.*, c.name AS company_name FROM campaigns m
         JOIN companies c ON c.id = m.company_id
        WHERE m.status = 'pending' ORDER BY m.created_at`
    )
    .all()
  const recent = db
    .prepare(
      `SELECT m.headline, m.status, c.name AS company_name FROM campaigns m
         JOIN companies c ON c.id = m.company_id
        WHERE m.status != 'pending' ORDER BY m.reviewed_at DESC LIMIT 20`
    )
    .all()

  res.send(page({ title: 'Review queue', company, body: adminQueue({ pending, recent }) }))
})

app.post('/admin/:id/decide', (req, res) => {
  const company = requireCompany(req, res)
  if (!company) return
  if (!company.is_admin) return res.status(403).end()

  const decision = req.body.decision === 'approved' ? 'approved' : 'rejected'
  db.prepare('UPDATE campaigns SET status = ?, note = ?, reviewed_at = ? WHERE id = ?').run(
    decision,
    String(req.body.note ?? '').slice(0, 300),
    now(),
    Number(req.params.id)
  )
  res.redirect('/admin')
})

// --- what the browser talks to ---------------------------------------------

/**
 * The batch every copy of Slash fetches.
 *
 * Shape must match `SponsorBatchSchema` exactly; anything else is ignored
 * wholesale by the browser rather than partially applied. Deliberately
 * identical for every caller: there is no request body, no cookie and no
 * parameter to vary on, which is what makes the browser's privacy claim true.
 */
app.get('/tiles.json', (_req, res) => {
  const approved = db
    .prepare(
      `SELECT m.id, m.headline, m.body, m.image, m.click_url, c.name AS sponsor
         FROM campaigns m JOIN companies c ON c.id = m.company_id
        WHERE m.status = 'approved' ORDER BY m.id`
    )
    .all()

  res.set('cache-control', 'no-store').json({
    expiresAt: now() + BATCH_TTL_MS,
    tiles: approved.map((campaign) => ({
      id: String(campaign.id),
      sponsor: campaign.sponsor,
      headline: campaign.headline,
      body: campaign.body ?? '',
      image: campaign.image ?? '',
      clickUrl: campaign.click_url
    }))
  })
})

/**
 * Aggregate counts, posted back by each browser.
 *
 * Per creative, per day — that is all that arrives, so that is all that can be
 * recorded. Unknown ids are ignored rather than inserted: they would be billing
 * data for a campaign nobody served.
 */
app.post('/report', (req, res) => {
  const counts = Array.isArray(req.body?.counts) ? req.body.counts : []
  const known = new Set(db.prepare('SELECT id FROM campaigns').all().map((row) => String(row.id)))

  const record = db.prepare(
    `INSERT INTO counts (campaign_id, day, impressions, clicks) VALUES (?, ?, ?, ?)
     ON CONFLICT(campaign_id, day) DO UPDATE SET
       impressions = impressions + excluded.impressions,
       clicks = clicks + excluded.clicks`
  )

  const apply = db.transaction(() => {
    for (const entry of counts) {
      const id = String(entry?.tileId ?? '')
      const day = String(entry?.day ?? '')
      if (!known.has(id) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
      record.run(
        Number(id),
        day,
        Math.max(0, Number(entry.impressions) || 0),
        Math.max(0, Number(entry.clicks) || 0)
      )
    }
  })
  apply()

  res.json({ ok: true })
})

function startSession(res, companyId) {
  const token = newSessionToken()
  db.prepare('INSERT INTO sessions (token, company_id, created_at) VALUES (?, ?, ?)').run(
    token,
    companyId,
    now()
  )
  res.cookie('slash_portal', token, {
    httpOnly: true,
    sameSite: 'lax',
    // Set SECURE_COOKIES=1 behind HTTPS, which any real deployment will be.
    secure: process.env.SECURE_COOKIES === '1',
    maxAge: 30 * 24 * 60 * 60 * 1000
  })
}

const port = Number(process.env.PORT ?? 4000)
app.listen(port, () => {
  console.log(`Slash sponsor portal on http://localhost:${port}`)
  console.log(`Point the browser's sponsorEndpoint at http://localhost:${port}/tiles.json`)
})

export { app, db }
