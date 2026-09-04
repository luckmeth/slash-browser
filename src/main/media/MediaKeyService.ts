import { app, globalShortcut } from 'electron'
import { chooseMediaTarget, type MediaCandidate } from './mediaTargeting'
import type { SettingsStore } from '../settings/SettingsStore'
import type { Tab } from '../tabs/Tab'
import { createLogger } from '../logger'

const log = createLogger('media-keys')

interface WindowLike {
  readonly isPrivate?: boolean
  readonly tabs: {
    allTabs: () => readonly Tab[]
    snapshot: () => { activeTabId: string | null }
    activate: (id: string) => void
    tabById?: (id: string) => Tab | undefined
  }
}

/** What each key does once a target tab is chosen. */
const ACTIONS = {
  MediaPlayPause: `(() => {
    const media = [...document.querySelectorAll('video, audio')]
      .filter((el) => el.readyState > 0)
    if (media.length === 0) return false
    const playing = media.find((el) => !el.paused && !el.ended)
    if (playing) { playing.pause(); return true }
    const resume = media.find((el) => el.currentTime > 0) ?? media[0]
    resume.play().catch(() => {})
    return true
  })()`,
  MediaNextTrack: `(() => {
    if (navigator.mediaSession && navigator.mediaSession.metadata) {
      // Sites register their own handlers; firing a synthetic key is the only
      // way to reach them, since the action handlers are not callable directly.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'MediaTrackNext' }))
    }
    const media = [...document.querySelectorAll('video, audio')].find((el) => el.readyState > 0)
    if (!media) return false
    media.currentTime = Math.min(media.duration || 0, media.currentTime + 10)
    return true
  })()`,
  MediaPreviousTrack: `(() => {
    const media = [...document.querySelectorAll('video, audio')].find((el) => el.readyState > 0)
    if (!media) return false
    media.currentTime = Math.max(0, media.currentTime - 10)
    return true
  })()`,
  MediaStop: `(() => {
    const media = [...document.querySelectorAll('video, audio')].filter((el) => el.readyState > 0)
    media.forEach((el) => el.pause())
    return media.length > 0
  })()`
} as const

type MediaKey = keyof typeof ACTIONS

/**
 * Hardware media keys.
 *
 * Electron does not route them to the focused page — Chromium's own handling
 * lives above the layer Electron exposes — so they are registered here, and they
 * are registered **while Slash has focus and not otherwise**.
 *
 * That restriction is the whole design. `globalShortcut` is exactly that:
 * global. Holding these keys permanently would mean pressing pause while
 * listening to Spotify paused a YouTube tab in a minimised browser instead, and
 * the user would have no way to guess why. Registering on focus and releasing on
 * blur keeps the polite behaviour by default; `mediaKeysAlwaysOn` opts into the
 * rude one for people who genuinely use the browser as their music player, and
 * the settings copy says what it takes.
 */
export class MediaKeyService {
  private registered = false

  constructor(
    private readonly settings: SettingsStore,
    private readonly windows: () => readonly WindowLike[],
    private readonly focused: () => WindowLike | null
  ) {}

  start(): void {
    app.on('browser-window-focus', () => this.sync())
    app.on('browser-window-blur', () => {
      // Deferred a tick: moving between two Slash windows fires blur then
      // focus, and releasing in between would drop a keypress landing in the gap.
      setImmediate(() => this.sync())
    })
    this.sync()
  }

  /** Called when settings change, so switching the feature off takes effect now. */
  sync(): void {
    const wanted = this.settings.getAll().mediaKeysEnabled && (
      this.settings.getAll().mediaKeysAlwaysOn || this.focused() !== null
    )
    if (wanted === this.registered) return
    if (wanted) this.register()
    else this.release()
  }

  private register(): void {
    for (const key of Object.keys(ACTIONS) as MediaKey[]) {
      try {
        // Returns false when another application already holds the key. Not an
        // error: it means somebody else asked first, and taking it from them is
        // precisely what this service is written to avoid.
        const taken = globalShortcut.register(key, () => void this.dispatch(key))
        if (!taken) log.info(`${key} is held by another application; leaving it alone`)
      } catch (error) {
        log.warn(`could not register ${key}`, error)
      }
    }
    this.registered = true
  }

  private release(): void {
    for (const key of Object.keys(ACTIONS) as MediaKey[]) {
      try {
        globalShortcut.unregister(key)
      } catch {
        /* already gone, which is the state we wanted */
      }
    }
    this.registered = false
  }

  stop(): void {
    this.release()
  }

  /** Runs the action in whichever tab the press belongs to. */
  private async dispatch(key: MediaKey): Promise<void> {
    const candidates: { candidate: MediaCandidate; tab: Tab }[] = []

    for (const window of this.windows()) {
      const activeId = window.tabs.snapshot().activeTabId
      for (const tab of window.tabs.allTabs()) {
        const snap = tab.snapshot
        candidates.push({
          tab,
          candidate: {
            id: tab.id,
            isAudible: snap.isAudible,
            isMuted: snap.isMuted,
            lastAudibleAt: tab.lastAudibleAt,
            isActive: tab.id === activeId
          }
        })
      }
    }

    const targetId = chooseMediaTarget(candidates.map((entry) => entry.candidate))
    if (!targetId) return

    const target = candidates.find((entry) => entry.tab.id === targetId)?.tab
    const contents = target?.contents
    if (!contents || contents.isDestroyed()) return

    try {
      // A user gesture: some players refuse to start playback without one, and
      // pressing a physical media key is about as genuine as a gesture gets.
      await contents.executeJavaScript(ACTIONS[key], true)
    } catch (error) {
      log.warn(`media key ${key} did not reach the page`, error)
    }
  }
}
