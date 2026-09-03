import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, net, safeStorage } from 'electron'
import type { RewardsSignInResult, RewardsStatus } from '@shared/types/rewards'
import {
  CoinProfileSchema,
  REWARDS_ANON_KEY_DEFAULT,
  REWARDS_URL_DEFAULT,
  type CoinProfile,
  type CoinProfileInput,
  type CoinProfileResult
} from '@shared/types/rewards'
import { checkProfile } from '@shared/profileRules'
import type { Database } from '../db/Database'
import type { SettingsStore } from '../settings/SettingsStore'
import { DEFAULT_DAILY_CAP_SECONDS, type ClosedInterval } from './earningRules'
import { checkCallback, extractCode } from './callbackCheck'
import { createLogger } from '../logger'

const log = createLogger('rewards')

/** Give up on a sign-in nobody completed rather than holding a port for ever. */
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000

/** Report no more often than this, however much has accumulated. */
const MIN_REPORT_INTERVAL_MS = 5 * 60 * 1000

/**
 * The ports the sign-in listener will use, in order.
 *
 * Fixed rather than ephemeral, and that is the whole point. The auth service
 * only redirects to an address on its allow list, and an ephemeral port means
 * that entry has to carry a wildcard in the port position. That pattern
 * matched in one code path and evidently not in the OAuth one: the browser was
 * sent to the service's own site address instead, which answers nothing.
 *
 * A short list of exact addresses can be allow-listed literally, with no glob
 * to be wrong about. Several of them because a single fixed port is a single
 * point of failure the moment anything else on the machine is using it.
 */
export const SIGN_IN_PORTS = [8613, 8614, 8615, 8616, 8617] as const

/** The server refuses more than 500; stay well inside it. */
const MAX_BATCH = 200

interface Session {
  refreshToken: string
  accessToken: string
  /** Epoch ms. */
  expiresAt: number
  email: string
}

/**
 * Slash Coin: signing in, and reporting qualifying time.
 *
 * **Sign-in goes through the system browser, not a window here.** Google's
 * FedCM is not implemented in Electron — the same wall that breaks
 * `claude.ai/login` in this browser — so an in-app Google button cannot work,
 * and a button that cannot work is worse than no button. This is the loopback
 * PKCE flow every desktop application uses: a one-shot listener on 127.0.0.1,
 * the real browser for the actual sign-in, and the listener shut the moment the
 * code arrives.
 *
 * **The refresh token never touches settings or a renderer.** It is encrypted
 * with `safeStorage` (DPAPI on Windows, the same mechanism as `PasswordVault`)
 * and written beside the profile. No secure store means no sign-in, rather than
 * a fallback that writes a long-lived credential in readable text next to the
 * browsing history.
 *
 * **Nothing here computes a balance.** It posts closed intervals and displays
 * whatever the server returns. Every rule that decides what those intervals may
 * claim lives in `earningRules`; every rule about whether to believe them lives
 * in Postgres, where the client cannot reach it.
 */
export class RewardsService {
  private session: Session | null = null
  private listener: Server | null = null
  /** The port the listener is on, so its own callback can be left to it. */
  private listenPort = 0
  /**
   * The refresh currently in flight, shared by every caller.
   *
   * Supabase **rotates** refresh tokens: presenting one twice makes the second
   * attempt a 400, and this class used to treat that as "the session has ended"
   * and delete it. At launch `refreshState()` and the activity tracker's first
   * `report()` both ask for a token within the same instant, so the second one
   * spent a token the first had already rotated — and a user who signed in
   * yesterday was silently signed out today. One shared promise means one
   * refresh, however many callers arrive together.
   */
  private refreshing: Promise<string> | null = null
  /**
   * The verifier for a sign-in that has been started but not finished.
   *
   * Held beyond the listener's life so `completeSignIn` can still exchange a
   * code the loopback never received — the browser landed somewhere else, the
   * flow finished in a different browser than it began in, or the listener had
   * already closed. Without this the only recourse is to start again, which is
   * the same dead end a second time.
   */
  private pending: { verifier: string; startedAt: number } | null = null
  private lastReportAt = 0
  private reporting = false

  private cached = {
    balance: 0,
    secondsToday: 0,
    coinsPerHour: 0,
    dailyCapSeconds: DEFAULT_DAILY_CAP_SECONDS,
    campaignEndsAt: 0,
    coinToUsd: null as number | null,
    launchAt: 0,
    /**
     * Whether the scheme is running at all, from the server's config.
     *
     * **Starts true**, and an answer that does not mention it stays true. A
     * browser that has never fetched, or one talking to a deployment older
     * than the pause switch, must not tell somebody their time is being
     * discarded -- "not yet known" is not "paused".
     */
    earningActive: true,
    suspended: false
  }

  constructor(
    private readonly db: Database,
    private readonly settings: SettingsStore,
    private readonly onChanged: () => void,
    /**
     * Called once a sign-in has actually produced a session.
     *
     * Fired from here rather than inferred by the renderer because the code can
     * arrive on either of two paths — the loopback listener or a redirect the
     * navigation watcher caught — and only this class knows when the exchange
     * behind either of them succeeded.
     */
    private readonly onSignedIn: () => void = () => {}
  ) {
    this.restore()
  }

  // --- configuration --------------------------------------------------------

  private get baseUrl(): string {
    const override = this.settings.getAll().rewardsEndpoint.trim()
    return (override === '' ? REWARDS_URL_DEFAULT : override).replace(/\/+$/, '')
  }

  private get anonKey(): string {
    return REWARDS_ANON_KEY_DEFAULT
  }

  /**
   * Whether earning is switched on for everybody, as the server last said.
   *
   * Read by the activity tracker, which turns it into a blocker -- so a pause
   * stops time accruing locally rather than only changing a sentence. The
   * server refuses the credit either way; this is what stops the browser
   * banking hours it will be told to throw away.
   */
  get earningActive(): boolean {
    return this.cached.earningActive
  }

  get enabled(): boolean {
    return this.settings.getAll().rewardsEnabled
  }

  get available(): boolean {
    return safeStorage.isEncryptionAvailable() && this.baseUrl !== ''
  }

  /** Where the auth service lives, so a redirect through it can be skipped. */
  get providerUrl(): string {
    return this.baseUrl
  }

  /**
   * Is this the address the loopback listener is already answering?
   *
   * The navigation watcher exists for redirects that land somewhere *else* —
   * the provider's site address, most often. When the redirect arrives at this
   * listener as intended, the watcher must keep out of the way: it sees the
   * navigation *before* the HTTP request is made, and finishing the sign-in
   * from there closes the listener microseconds before the browser knocks on
   * it. The sign-in then succeeds while the tab shows a connection refused,
   * which is a confusing way to win and an outright failure if the exchange
   * does not land first.
   */
  isOwnCallback(url: string): boolean {
    if (this.listenPort === 0) return false
    try {
      const parsed = new URL(url)
      return parsed.hostname === '127.0.0.1' && parsed.port === String(this.listenPort)
    } catch {
      return false
    }
  }

  /** A sign-in has been started and is still waiting for its code. */
  get awaitingCode(): boolean {
    return this.pending !== null
  }

  get signedIn(): boolean {
    return this.session !== null
  }

  get dailyCapSeconds(): number {
    return this.cached.dailyCapSeconds
  }

  get secondsToday(): number {
    return this.cached.secondsToday
  }

  // --- the stored session ---------------------------------------------------

  private get sessionPath(): string {
    return join(app.getPath('userData'), 'rewards.session')
  }

  private restore(): void {
    if (!safeStorage.isEncryptionAvailable()) return
    try {
      const raw = readFileSync(this.sessionPath)
      const decoded = JSON.parse(safeStorage.decryptString(raw)) as {
        refreshToken: string
        email: string
      }
      if (typeof decoded.refreshToken !== 'string' || decoded.refreshToken === '') return
      // Access token is deliberately not persisted: it is short-lived, and one
      // read from disk at launch is one more place it can be found. The refresh
      // exchange on first use costs a single request.
      this.session = {
        refreshToken: decoded.refreshToken,
        accessToken: '',
        expiresAt: 0,
        email: typeof decoded.email === 'string' ? decoded.email : ''
      }
    } catch {
      // No session, or one written by a different OS account. Either way the
      // user simply is not signed in.
    }
  }

  private persist(): void {
    if (!this.session) {
      try {
        rmSync(this.sessionPath, { force: true })
      } catch {
        /* nothing to remove */
      }
      return
    }
    try {
      const blob = safeStorage.encryptString(
        JSON.stringify({ refreshToken: this.session.refreshToken, email: this.session.email })
      )
      writeFileSync(this.sessionPath, blob, { mode: 0o600 })
    } catch (error) {
      log.warn(`could not store the rewards session: ${String(error)}`)
    }
  }

  // --- signing in -----------------------------------------------------------

  /**
   * Opens the system browser at Google, via Supabase, and waits for the code.
   *
   * The binding is **PKCE**, not the state: the verifier below is generated
   * here, never transmitted, and required to exchange the code — so a code fed
   * to this port by anything else is inert. The listener answers exactly one
   * request and closes, on an ephemeral port bound to 127.0.0.1.
   *
   * A `state` is still sent and still checked when it comes back, but Supabase
   * runs the Google leg itself and does not echo ours, so its absence cannot be
   * treated as a failure. See `checkCallback`.
   */
  async signIn(): Promise<RewardsSignInResult> {
    if (!safeStorage.isEncryptionAvailable()) {
      return {
        ok: false,
        problem:
          'This machine has no secure store, so a sign-in could not be kept safely. Slash will not save it in readable text.',
        url: ''
      }
    }
    if (this.listener) {
      return { ok: false, problem: 'A sign-in is already in progress.', url: '' }
    }

    const verifier = base64url(randomBytes(48))
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    this.pending = { verifier, startedAt: Date.now() }

    // Each in turn: a port already taken by something else must not end the
    // sign-in, it must move to the next one on the list.
    let port = 0
    let lastError: unknown = null
    for (const candidate of SIGN_IN_PORTS) {
      try {
        port = await this.listen(verifier, candidate)
        break
      } catch (error) {
        lastError = error
      }
    }
    if (port === 0) {
      this.pending = null
      return {
        ok: false,
        problem:
          'Could not open a local port for sign-in. Something else on this machine is using all of them.' +
          (lastError === null ? '' : ` (${String(lastError)})`),
        url: ''
      }
    }

    const authorize = new URL(`${this.baseUrl}/auth/v1/authorize`)
    authorize.searchParams.set('provider', 'google')
    authorize.searchParams.set('redirect_to', `http://127.0.0.1:${port}/callback`)
    authorize.searchParams.set('code_challenge', challenge)
    authorize.searchParams.set('code_challenge_method', 's256')
    // **No `state` parameter.**
    //
    // Supabase runs the Google leg itself and generates its own state for it.
    // Sending one here overwrote that: Google was handed *our* value, and when
    // it came back Supabase could not resolve a flow keyed by it and answered
    // `error_code=bad_oauth_state`. Before the site address pointed at this
    // listener that failure was invisible — it simply redirected to somewhere
    // that answered nothing, which is what made this look like a redirect
    // problem for so long.
    //
    // The binding for this flow is PKCE, and the verifier above never leaves
    // the process, so nothing is lost by letting the provider own its state.

    // Handed back for the renderer to open in a tab. Staying in one browser is
    // the whole fix: the provider keeps its flow state and the redirect lands
    // on the loopback listener this process is already running.
    return { ok: true, problem: '', url: authorize.toString() }
  }

  private listen(verifier: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/callback') {
          response.writeHead(404).end()
          return
        }

        // The provider reports its own failures here rather than sending a
        // code. Saying which one is the difference between a page somebody can
        // act on and "something did not match".
        const failure = url.searchParams.get('error_description') ?? ''
        const failureCode = url.searchParams.get('error_code') ?? ''
        // No state is sent any more, so there is nothing of ours to compare and
        // whatever the provider echoes belongs to its own leg of the flow.
        // Comparing it against an empty expectation would refuse a *valid*
        // callback. The binding is PKCE; see `signIn`.
        const verdict = checkCallback({
          code: url.searchParams.get('code') ?? '',
          state: '',
          expectedState: ''
        })
        const code = url.searchParams.get('code') ?? ''
        const matches = verdict.accept

        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(
          matches && code !== ''
            ? // Not "Signed in": the code has only just arrived and the exchange
              // that actually creates the session has not happened yet. This
              // page cannot be updated once sent, so it must not claim an
              // outcome it does not know - the Slash Coin page shows the truth
              // a moment later either way.
              PAGE(
                'Finishing sign-in…',
                'You can close this tab. Slash Coin will show your balance when it is done.'
              )
            : PAGE(
                'Sign-in failed',
                failure !== ''
                  ? `${failure}${failureCode === '' ? '' : ` (${failureCode})`}`
                  : 'No sign-in code arrived. Go back to Slash Coin and try again.'
              )
        )
        this.close()

        if (failure !== '') {
          log.warn(`rewards sign-in refused by the provider: ${failureCode} ${failure}`)
        }
        if (matches && code !== '') {
          // The loopback won the race, so the paste fallback has nothing left
          // to finish. Leaving it armed would let a later paste re-send a code
          // that has already been spent.
          this.pending = null
          void this.exchange(code, verifier)
        } else {
          log.warn(
            `rewards sign-in callback refused: ${verdict.accept ? 'unknown' : verdict.reason}`
          )
        }
      })

      server.on('error', reject)
      // 127.0.0.1 specifically, never 0.0.0.0: this port must not be reachable
      // from anywhere but this machine.
      server.listen(port, '127.0.0.1', () => {
        const address = server.address()
        if (address === null || typeof address === 'string') {
          reject(new Error('no port'))
          return
        }
        this.listener = server
        this.listenPort = address.port
        setTimeout(() => this.close(), SIGN_IN_TIMEOUT_MS).unref()
        resolve(address.port)
      })
    })
  }

  private close(): void {
    this.listener?.close()
    this.listener = null
    this.listenPort = 0
  }

  private async exchange(code: string, verifier: string): Promise<boolean> {
    try {
      const response = await net.fetch(`${this.baseUrl}/auth/v1/token?grant_type=pkce`, {
        method: 'POST',
        headers: { apikey: this.anonKey, 'content-type': 'application/json' },
        body: JSON.stringify({ auth_code: code, code_verifier: verifier })
      })
      if (!response.ok) {
        log.warn(`rewards token exchange returned ${response.status}`)
        return false
      }
      const body = (await response.json()) as {
        access_token?: string
        refresh_token?: string
        expires_in?: number
        user?: { email?: string }
      }
      if (!body.access_token || !body.refresh_token) return false

      this.session = {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
        email: body.user?.email ?? ''
      }
      this.persist()

      // Says which kind of account this is, so a browser user does not appear
      // in the advertiser list. Supabase's OAuth endpoint carries no custom
      // signup metadata, so it cannot be done at signup.
      await this.rpc('mark_browser_account', {})
      await this.refreshState()
      this.onChanged()
      this.onSignedIn()
      return true
    } catch (error) {
      log.warn(`rewards sign-in failed: ${String(error)}`)
      return false
    }
  }

  /**
   * Finishes a sign-in from an address the user pasted.
   *
   * The loopback listener is the happy path and usually the only one needed.
   * It fails in ways that are not the user's fault and not diagnosable from
   * inside the browser: Supabase falls back to its own `site_url` when it
   * cannot resolve the flow, a sign-in begun in one browser and finished in
   * another loses the listener entirely, and a slow account chooser can outlast
   * it. Every one of those strands somebody on a page with a `code` in the
   * address bar and no way to hand it back.
   *
   * `gcloud` and most desktop OAuth tools carry the same escape hatch for the
   * same reason. The code is single-use and worthless without the verifier this
   * process is still holding, so accepting it here is no weaker than accepting
   * it on the loopback.
   */
  async completeSignIn(pasted: string): Promise<RewardsSignInResult> {
    if (!this.pending) {
      return {
        ok: false,
        problem: 'Start a sign-in first, then paste the address you were sent to.',
        url: ''
      }
    }
    if (Date.now() - this.pending.startedAt > SIGN_IN_TIMEOUT_MS) {
      this.pending = null
      return { ok: false, problem: 'That sign-in has expired. Start a new one.', url: '' }
    }

    const code = extractCode(pasted)
    if (code === '') {
      return {
        ok: false,
        problem:
          'No sign-in code in that address. Copy the whole address from the page you landed on.',
        url: ''
      }
    }

    const { verifier } = this.pending
    this.pending = null
    this.close()
    const ok = await this.exchange(code, verifier)
    return ok
      ? { ok: true, problem: '', url: '' }
      : { ok: false, problem: 'That code was refused. It may already have been used.', url: '' }
  }

  signOut(): void {
    this.session = null
    this.persist()
    // Unreported time stays on this machine but is bound to the account that
    // earned it, so signing into a different one cannot inherit it.
    this.cached = { ...this.cached, balance: 0, secondsToday: 0, suspended: false }
    this.onChanged()
  }

  // --- talking to the server ------------------------------------------------

  private async accessToken(): Promise<string> {
    if (!this.session) return ''
    if (this.session.accessToken !== '' && Date.now() < this.session.expiresAt - 60_000) {
      return this.session.accessToken
    }
    // Whoever gets here first performs the refresh; everybody else waits on it.
    if (this.refreshing) return await this.refreshing
    this.refreshing = this.performRefresh().finally(() => {
      this.refreshing = null
    })
    return await this.refreshing
  }

  private async performRefresh(): Promise<string> {
    if (!this.session) return ''
    try {
      const response = await net.fetch(`${this.baseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: this.anonKey, 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: this.session.refreshToken })
      })
      if (!response.ok) {
        // Only a token the server says it does not know is a session that has
        // ended. Any other 400 — a transient fault, a rate limit, a body that
        // failed to parse — must leave the stored session alone: deleting it
        // means a silent sign-out the user cannot explain, and re-signing-in is
        // the one thing they should not have to do repeatedly.
        const text = await response.text().catch(() => '')
        const gone = /refresh_token_not_found|invalid_grant|token has expired|already used/i.test(
          text
        )
        if (gone) {
          log.warn(`rewards session has ended; signing out (${response.status})`)
          this.signOut()
        } else {
          log.warn(`rewards token refresh failed with ${response.status}; keeping the session`)
        }
        return ''
      }
      const body = (await response.json()) as {
        access_token?: string
        refresh_token?: string
        expires_in?: number
        user?: { email?: string }
      }
      if (!body.access_token) return ''
      this.session = {
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? this.session.refreshToken,
        expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
        email: body.user?.email ?? this.session.email
      }
      this.persist()
      return this.session.accessToken
    } catch (error) {
      log.warn(`rewards token refresh failed: ${String(error)}`)
      return ''
    }
  }

  private async rpc(name: string, body: unknown): Promise<unknown> {
    const token = await this.accessToken()
    const response = await net.fetch(`${this.baseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: this.anonKey,
        authorization: `Bearer ${token === '' ? this.anonKey : token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    })
    if (!response.ok) throw new Error(`${name} returned ${response.status}`)
    return await response.json()
  }

  /**
   * The collector's own details, as the server holds them.
   *
   * Straight through: nothing is cached here. A profile is read when the page
   * asks and written when they save, which is a handful of calls in the life
   * of an account -- and holding a copy of somebody's address in a process
   * that does not need it is a copy that can leak.
   */
  async profile(): Promise<CoinProfile | null> {
    if (!this.signedIn) return null
    try {
      const raw = (await this.rpc('coin_profile', {})) as Record<string, unknown>
      return CoinProfileSchema.parse({
        ...raw,
        // The database returns a date and a null; the schema wants strings.
        dateOfBirth: typeof raw.dateOfBirth === 'string' ? raw.dateOfBirth : '',
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0
      })
    } catch (error) {
      log.warn(`could not read the profile: ${String(error)}`)
      return null
    }
  }

  /**
   * Saves it, refusing anything the rules refuse.
   *
   * Checked here as well as in the page, because the page is a renderer: it is
   * the friendly half of the answer and not the boundary. The database repeats
   * the bounds again as constraints, which is the half that still holds if
   * both of these are wrong.
   */
  async saveProfile(input: CoinProfileInput): Promise<CoinProfileResult> {
    if (!this.signedIn) {
      return { ok: false, problems: [{ field: 'fullName', problem: 'Sign in first.' }], profile: null }
    }

    const problems = checkProfile(input, Date.now())
    if (problems.length > 0) return { ok: false, problems, profile: null }

    try {
      const raw = (await this.rpc('save_coin_profile', { details: input })) as Record<string, unknown>
      const profile = CoinProfileSchema.parse({
        ...raw,
        dateOfBirth: typeof raw.dateOfBirth === 'string' ? raw.dateOfBirth : '',
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0
      })
      this.onChanged()
      return { ok: true, problems: [], profile }
    } catch (error) {
      // Named rather than swallowed: somebody has just typed eight fields in.
      return {
        ok: false,
        problems: [{ field: 'fullName', problem: `Could not save: ${String(error)}` }],
        profile: null
      }
    }
  }

  /** Pulls the balance, the day's total and the campaign settings. */
  async refreshState(): Promise<void> {
    if (!this.enabled) return
    try {
      const state = (await this.rpc('coin_state', {})) as Record<string, unknown>
      this.cached = {
        balance: num(state.balance),
        secondsToday: num(state.secondsToday),
        coinsPerHour: num(state.coinsPerHour),
        dailyCapSeconds: num(state.dailyCapSeconds) || DEFAULT_DAILY_CAP_SECONDS,
        campaignEndsAt: num(state.campaignEndsAt),
        // Absent or null means unpublished, and that has to survive as null all
        // the way to the screen rather than collapsing into a zero.
        coinToUsd:
          state.coinToUsd === null || state.coinToUsd === undefined
            ? null
            : num(state.coinToUsd),
        launchAt: num(state.launchAt),
        // Absent means an older deployment, which is running normally.
        earningActive: state.earningActive !== false,
        suspended: state.suspended === true
      }
      this.onChanged()
    } catch (error) {
      log.warn(`could not read the rewards state: ${String(error)}`)
    }
  }

  // --- the local outbox -----------------------------------------------------

  /** Records a closed interval against the account that earned it. */
  record(interval: ClosedInterval): void {
    if (!this.session) return
    this.db.connection
      .prepare(
        `INSERT INTO coin_intervals (started_at, ended_at, seconds, account)
         VALUES (?, ?, ?, ?)`
      )
      .run(interval.startedAt, interval.endedAt, interval.seconds, this.session.email)
    this.onChanged()
  }

  pendingCount(): number {
    const row = this.db.connection
      .prepare(`SELECT COUNT(*) AS n FROM coin_intervals WHERE reported_at IS NULL`)
      .get() as { n: number }
    return row.n
  }

  /**
   * Posts what has not been reported.
   *
   * Rows are deleted only once the server has *accepted* the batch. Marking
   * them on send would lose a day's browsing to a dropped response — the one
   * failure a user would notice and could never explain.
   */
  async report(force = false): Promise<void> {
    if (!this.enabled || !this.session || this.reporting) return
    if (!force && Date.now() - this.lastReportAt < MIN_REPORT_INTERVAL_MS) return

    const rows = this.db.connection
      .prepare(
        `SELECT id, started_at, ended_at, seconds FROM coin_intervals
         WHERE reported_at IS NULL AND account = ?
         ORDER BY started_at LIMIT ?`
      )
      .all(this.session.email, MAX_BATCH) as {
      id: number
      started_at: number
      ended_at: number
      seconds: number
    }[]
    if (rows.length === 0) return

    this.reporting = true
    this.lastReportAt = Date.now()
    try {
      const deviceId = this.deviceId()
      const result = (await this.rpc('record_coin_intervals', {
        entries: rows.map((row) => ({
          deviceId,
          startedAt: new Date(row.started_at).toISOString(),
          endedAt: new Date(row.ended_at).toISOString(),
          seconds: row.seconds
        }))
      })) as Record<string, unknown>

      // Accepted or rejected, the server has now seen them. A rejected
      // interval is one it will never take — an overlap, or something too old
      // — so retrying it for ever would be a loop with no exit.
      const remove = this.db.connection.prepare(`DELETE FROM coin_intervals WHERE id = ?`)
      const clear = this.db.connection.transaction((ids: number[]) => {
        for (const id of ids) remove.run(id)
      })
      clear(rows.map((row) => row.id))

      this.cached.balance = num(result.balance)
      await this.refreshState()
    } catch (error) {
      // Left in the outbox for the next attempt.
      log.warn(`could not report rewards intervals: ${String(error)}`)
    } finally {
      this.reporting = false
    }
  }

  /**
   * An opaque per-installation id.
   *
   * Not an identifier of the person and not sent anywhere except alongside a
   * ledger that is already tied to their account — it exists so that one
   * account farming across twenty fabricated machines is visible in the admin
   * application rather than invisible.
   */
  private deviceId(): string {
    const current = this.settings.getAll().rewardsDeviceId
    if (current !== '') return current
    const fresh = base64url(randomBytes(16))
    void this.settings.update({ rewardsDeviceId: fresh })
    return fresh
  }

  status(earning: boolean, note: string): RewardsStatus {
    return {
      enabled: this.enabled,
      available: this.available,
      signedIn: this.signedIn,
      email: this.session?.email ?? '',
      balance: this.cached.balance,
      secondsToday: this.cached.secondsToday,
      dailyCapSeconds: this.cached.dailyCapSeconds,
      coinsPerHour: this.cached.coinsPerHour,
      campaignEndsAt: this.cached.campaignEndsAt,
      coinToUsd: this.cached.coinToUsd,
      launchAt: this.cached.launchAt,
      earningActive: this.cached.earningActive,
      pending: this.pendingCount(),
      awaitingCode: this.awaitingCode,
      earning,
      note: this.cached.suspended
        ? 'This account is under review, so nothing is accruing at the moment.'
        : note,
      lastReportAt: this.lastReportAt
    }
  }

  dispose(): void {
    this.close()
  }
}

function num(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The page the system browser lands on. Deliberately plain and self-contained. */
const PAGE = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:15px system-ui;background:#0d1017;color:#e6e9ef;display:grid;place-items:center;height:100vh;margin:0">` +
  `<div style="text-align:center"><h1 style="font-size:19px;font-weight:600">${title}</h1>` +
  `<p style="color:#9aa3b2">${body}</p></div>`
