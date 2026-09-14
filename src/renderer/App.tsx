import { useEffect, useState } from 'react'
import {
  SETTINGS_URL,
  NEW_TAB_URL,
  ADVERTISE_URL,
  REWARDS_URL,
  TERMS_URL,
  PRIVACY_URL,
  isInternalUrl
} from '@shared/types/tab'
import {
  CHROME_HEIGHT,
  TITLE_BAR_HEIGHT,
  TOOLBAR_HEIGHT,
  VERTICAL_TAB_STRIP_WIDTH,
  WINDOW_CONTROLS_WIDTH,
  WORKSPACE_BAR_HEIGHT
} from '@shared/constants'

/**
 * Chrome left on screen when it is hidden, so the pointer has somewhere to
 * arrive. See the note on `chromeShown`.
 */
/**
 * Whether the launch sequence has already played in this process.
 *
 * Module-level rather than state: React can remount `App` — a hot reload in
 * development, a future error boundary — and replaying the boot animation on a
 * browser somebody is already using would read as a crash and recovery.
 */
let bootPlayed = false

const AUTO_HIDE_PEEK = 6
import { FindBar, FIND_BAR_HEIGHT } from './features/find/FindBar'
import { HandoffNotice, HANDOFF_NOTICE_HEIGHT } from './features/handoff/HandoffNotice'
import { PopupBlockedNotice, POPUP_NOTICE_HEIGHT } from './features/shield/PopupBlockedNotice'
import { NavigationBlockedNotice, NAV_NOTICE_HEIGHT } from './features/shield/NavigationBlockedNotice'
import type { PopupBlocked, NavigationNotice } from '@shared/types/blocking'
import { handoffHintFor } from '@shared/externalHandoff'
import { useBrowserStore } from './stores/browserStore'
import { TabStrip } from './features/tabs/TabStrip'
import { Toolbar } from './features/omnibox/Toolbar'
import { NewTabPage } from './features/newtab/NewTabPage'
import { ErrorPage } from './features/errors/ErrorPage'
import { SettingsPanel } from './features/panels/SettingsPanel'
import { SplitDivider } from './features/split/SplitDivider'
import { SidePanel } from './features/panels/SidePanel'
import { AdvertisePage } from './features/newtab/AdvertisePage'
import { RewardsPage } from './features/newtab/RewardsPage'
import { CoinChip } from './features/rewards/CoinChip'
import { BrandMark } from './components/BrandMark'
import { WorkspaceRail } from './features/workspaces/WorkspaceRail'
import { useWorkspaceTheme } from './features/workspaces/useWorkspaceTheme'
import { useAppearance } from './features/settings/useAppearance'
import { PrivateNotice, PRIVATE_NOTICE_HEIGHT } from './features/private/PrivateNotice'
import { Icon } from './components/Icon'
import { UpdateChip } from './features/updates/UpdateChip'
import { LegalPage } from './features/legal/LegalPage'

/**
 * Browser chrome.
 *
 * This document spans the whole window. The region below the toolbar is the
 * "content hole": when the active tab has a live page, a native `WebContentsView`
 * is composited over that region and whatever is rendered here is hidden. When
 * the tab is an internal page or has crashed, no view is attached and this
 * document shows through — which is how the new tab page and the sad-tab screen
 * are drawn without any page of their own.
 */
export function App(): React.JSX.Element {
  const hydrate = useBrowserStore((s) => s.hydrate)
  const activeTab = useBrowserStore((s) => s.activeTab())
  const setPanel = useBrowserStore((s) => s.setPanel)
  const togglePanel = useBrowserStore((s) => s.togglePanel)
  const openSettings = useBrowserStore((s) => s.openSettings)
  const requestOmniboxFocus = useBrowserStore((s) => s.requestOmniboxFocus)
  const refreshHistory = useBrowserStore((s) => s.refreshHistory)
  const openFind = useBrowserStore((s) => s.openFind)
  const settings = useBrowserStore((s) => s.settings)
  const focusOmniboxToken = useBrowserStore((s) => s.focusOmniboxToken)
  const findOpen = useBrowserStore((s) => s.findOpen)
  const handoffDismissedHost = useBrowserStore((s) => s.handoffDismissedHost)
  const workspaces = useBrowserStore((s) => s.workspaces)
  const activeWorkspaceId = useBrowserStore((s) => s.activeWorkspaceId)

  // The whole chrome takes the active workspace's accent, so switching context
  // is felt rather than read off a small highlight in the rail.
  const isPrivate = useBrowserStore((s) => s.isPrivate)
  const appearance = useBrowserStore((s) => s.settings)

  // Order matters: appearance writes the global accent, then the workspace tint
  // overwrites it while a coloured workspace is active. Telling contexts apart
  // is a stronger claim on the accent than a standing preference.
  useAppearance(appearance)
  // A private window keeps one fixed identity rather than following workspaces:
  // the colour is part of how you tell at a glance which window you are in, and
  // it must not shift under you.
  useWorkspaceTheme(
    isPrivate ? 'purple' : (workspaces.find((w) => w.id === activeWorkspaceId)?.color ?? null)
  )

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // The chrome grows when the find bar opens, so the native page view must inset
  // by the same amount — otherwise the bar would be drawn over the page it is
  // searching, and the page would be hidden underneath it.
  // Both the find bar and the hand-off notice are real chrome rows, so the page
  // view has to inset by whatever is currently showing.
  const handoffHint = handoffHintFor(activeTab?.url ?? '')
  const handoffShowing = handoffHint !== null && handoffDismissedHost !== handoffHint.host

  const [blockedPopup, setBlockedPopup] = useState<PopupBlocked | null>(null)
  const [blockedNav, setBlockedNav] = useState<NavigationNotice | null>(null)
  useEffect(() => {
    return window.browser.on('shield:popupBlocked', setBlockedPopup)
  }, [])

  // Media detection: pushed while the page plays, and re-asked on navigation.
  // Both are needed — a video usually starts several seconds after the page
  // settles, so asking once would miss it, and only listening would leave the
  // button up after switching to a tab that has nothing.
  const setDetectedMedia = useBrowserStore((s) => s.setDetectedMedia)
  useEffect(() => {
    return window.browser.on('media:found', ({ count }) => setDetectedMedia(count))
  }, [setDetectedMedia])
  useEffect(() => {
    setDetectedMedia(0)
    void window.browser.invoke('media:detected', undefined).then((result) => {
      if (result.ok) setDetectedMedia(result.value.count)
    })
  }, [activeTab?.id, activeTab?.url, setDetectedMedia])
  useEffect(() => {
    return window.browser.on('shield:navigationBlocked', setBlockedNav)
  }, [])

  // These belong to the page they happened on. Navigating away makes them stale,
  // and offering to open a popup from a page you have left would be worse than
  // dropping it.
  useEffect(() => {
    setBlockedPopup(null)
    setBlockedNav(null)
  }, [activeTab?.url])

  /**
   * Auto-hide: whether the chrome is currently showing.
   *
   * A sliver of chrome always remains — `AUTO_HIDE_PEEK` — and that sliver is
   * the entire mechanism. The page is a **native view composited above the
   * chrome document**, so once it covers the top of the window the chrome can
   * no longer see the pointer at all; there is no mouse event to listen for.
   * Leaving a few pixels of real chrome gives the pointer something to arrive
   * at, and is the only approach here that does not need main to poll the
   * cursor.
   *
   * That sliver must **not** be a drag region. `-webkit-app-region: drag` is
   * handled above the DOM — Chromium routes the pointer to the window move
   * handler and dispatches no mouse event at all — so the first version of
   * this, which reused the `app-drag` class from the row below, hid the chrome
   * and then had no way on earth to bring it back. Every other row here is a
   * drag region, which is exactly why the mistake looked right.
   */
  // Skipped entirely when the system asks for less motion, and skipped on every
  // remount after the first.
  const [booting, setBooting] = useState(() => {
    if (bootPlayed) return false
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true) return false
    bootPlayed = true
    return true
  })

  useEffect(() => {
    if (!booting) return
    // Matches the CSS: the mark fades in, draws, holds, then clears at 1390ms.
    const timer = setTimeout(() => setBooting(false), 1450)
    return () => clearTimeout(timer)
  }, [booting])

  const autoHide = settings?.autoHideChrome ?? false
  const [chromeShown, setChromeShown] = useState(false)
  const chromeHidden = autoHide && !chromeShown

  // Any reason to focus the address bar is a reason to bring the bars back —
  // otherwise Ctrl+L would put the caret in something that is not on screen.
  useEffect(() => {
    if (focusOmniboxToken > 0) setChromeShown(true)
  }, [focusOmniboxToken])

  // Turning the setting off must not leave the chrome hidden.
  useEffect(() => {
    if (!autoHide) setChromeShown(false)
  }, [autoHide])

  // Main watches for the pointer coming back, because the renderer cannot: the
  // top edge of the window is the OS resize border, so a hover strip there is
  // never delivered to any web content however it is styled. See
  // `BrowserWindowController.setChromeAutoHidden`.
  useEffect(() => {
    void window.browser.invoke('layout:setChromeHidden', { active: autoHide, hidden: chromeHidden })
  }, [autoHide, chromeHidden])

  useEffect(() => {
    void window.browser.invoke('layout:setChromeHeight', {
      height:
        (chromeHidden ? AUTO_HIDE_PEEK : CHROME_HEIGHT) +
        (findOpen ? FIND_BAR_HEIGHT : 0) +
        (handoffShowing ? HANDOFF_NOTICE_HEIGHT : 0) +
        (blockedPopup ? POPUP_NOTICE_HEIGHT : 0) +
        (blockedNav ? NAV_NOTICE_HEIGHT : 0) +
        (isPrivate ? PRIVATE_NOTICE_HEIGHT : 0)
    })
  }, [findOpen, handoffShowing, blockedPopup, blockedNav, isPrivate, chromeHidden])

  // Menu accelerators arrive here because a native view — usually the page —
  // holds keyboard focus, so the chrome document never sees the keystroke.
  useEffect(() => {
    return window.browser.on('ui:command', ({ command, arg }) => {
      switch (command) {
        case 'reveal-chrome':
          setChromeShown(true)
          break
        case 'hide-chrome':
          setChromeShown(false)
          break
        case 'focus-omnibox':
          requestOmniboxFocus()
          break
        case 'open-history':
          togglePanel('history')
          void refreshHistory()
          break
        case 'open-bookmarks':
          togglePanel('bookmarks')
          break
        case 'open-downloads':
          togglePanel('downloads')
          break
        case 'open-settings':
          openSettings(arg)
          break
        case 'open-performance':
          togglePanel('performance')
          break
        case 'open-find':
          openFind()
          break
        case 'open-permissions':
          togglePanel('permissions')
          break
        case 'open-timemachine':
          togglePanel('timemachine')
          break
        case 'open-memory':
          togglePanel('memory')
          break
        case 'open-tabbrain':
          togglePanel('tabbrain')
          break
        case 'open-insight':
          togglePanel('insight')
          break
        case 'open-redirects':
          togglePanel('redirects')
          break
        case 'open-mission':
          togglePanel('mission')
          break
        case 'open-ai':
          togglePanel('ai')
          break
        case 'close-panel':
          setPanel('none')
          break
        case 'open-reading':
          togglePanel('reading')
          break
        case 'bookmark-current-tab':
          void bookmarkCurrentTab()
          break
        case 'save-to-reading':
          void saveCurrentTabToReadingList()
          break
      }
    })
  }, [togglePanel, setPanel, requestOmniboxFocus, refreshHistory])

  const showNewTab = activeTab?.url === NEW_TAB_URL
  const showSettings = activeTab?.url === SETTINGS_URL
  const showAdvertise = activeTab?.url === ADVERTISE_URL
  const showRewards = activeTab?.url === REWARDS_URL
  // What this machine is, decided in main and applied here as one attribute.
  // Every expensive effect keys off it in CSS, so there is one switch rather
  // than a condition in twenty components.
  useEffect(() => {
    void window.browser.invoke('system:hardware', undefined).then((result) => {
      if (!result.ok) return
      document.documentElement.dataset.effects = result.value.effects
    })
  }, [])

  /*
   * The CSS half of `sharpText`.
   *
   * The main-process half decides whether the chrome view is transparent, which
   * is what actually enables subpixel antialiasing and only changes on a new
   * window. This attribute is what lets the stylesheet stop asking for
   * grayscale on the surfaces that now have an opaque backing, and it can
   * follow the setting immediately.
   */
  const sharpText = useBrowserStore((s) => s.settings?.sharpText ?? false)
  useEffect(() => {
    document.documentElement.dataset.sharpText = sharpText ? 'on' : 'off'
  }, [sharpText])

  const showTerms = activeTab?.url === TERMS_URL
  const showPrivacy = activeTab?.url === PRIVACY_URL
  // Main insets the native page view to match; the two read the same constant.
  const verticalTabs = appearance?.tabStripPosition === 'left'
  const crashed = activeTab?.status === 'crashed'
  // A hibernated tab has no view attached, so the chrome shows through the
  // content hole — the same mechanism that renders the new tab page.
  const hibernated = activeTab?.status === 'hibernated'
  // A crash has its own screen, so it must not also count as a failed load —
  // both set `error`, and the sad tab is the more specific of the two.
  const failed = !crashed && activeTab?.error ? activeTab.error : null

  return (
    // No opaque background: the window's acrylic is the backdrop, and each row
    // below adds its own translucent layer over it.
    <div
      className="flex h-full flex-col"
      onMouseLeave={() => {
        // Deliberately empty of auto-hide logic. Hiding used to happen here, on
        // the DOM `mouseleave`, which fires the instant the pointer crosses into
        // the page — so the bars vanished while the pointer was still on its way
        // to a tab, and the whole feature felt twitchy and unreliable.
        //
        // Main drives both directions now, from the real cursor position, with
        // a wide gap between the reveal and hide thresholds. See
        // `BrowserWindowController.setChromeAutoHidden`.
      }}
    >

      {/*
        The launch sequence. Sits over the chrome rather than replacing it, so
        the browser behind is already live and interactive the moment it clears
        — this is a reveal, not a loading screen.
      */}
      {booting && (
        <div
          className="slash-boot pointer-events-none fixed inset-0 z-50 grid place-items-center"
          aria-hidden="true"
        >
          <BrandMark
            size={132}
            draw
            className="text-[var(--color-accent)] drop-shadow-[0_0_28px_var(--color-accent)]"
          />
        </div>
      )}
      {/*
        A few pixels of chrome that never leave.

        Not the hit target - it cannot be one. The top edge of the window is the
        OS resize border, so nothing there reaches web content and `mouseenter`
        on this strip can never fire from a real mouse. Main watches the system
        cursor instead. This survives because the page view is inset by exactly
        this much, and a page starting flush against the window edge under a
        hidden toolbar looks like a rendering fault.
      */}
      {autoHide && (
        <div style={{ height: AUTO_HIDE_PEEK }} className="shrink-0" aria-hidden="true" />
      )}
      <div
        className={[
          // 260ms, matching the page view's own tween in
          // `setChromeHeight` — the two have to arrive together or the bars
          // fade in over a page that already moved.
          'flex min-h-0 flex-col overflow-hidden',
          'transition-[max-height,opacity,transform] duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
          chromeHidden
            ? 'pointer-events-none max-h-0 -translate-y-2 opacity-0'
            : 'max-h-[240px] translate-y-0 opacity-100'
        ].join(' ')}
      >
      {/*
        Row 1: the workspace switcher, and the window's drag region.

        This is also the title bar — the window has no OS one — so it reserves
        space on the right for the native minimise/maximise/close buttons
        Windows draws over it, and everything here must be `app-no-drag` or it
        cannot be clicked.
      */}
      <div
        className={`app-drag glass flex shrink-0 items-stretch${booting ? ' slash-row-1' : ''}`}
        style={{ height: WORKSPACE_BAR_HEIGHT, paddingRight: WINDOW_CONTROLS_WIDTH }}
      >
        <WorkspaceRail />
        {/* Right of the workspaces, left of the window controls the row already
            reserves space for. `ml-auto` inside the chip pushes it there. */}
        <UpdateChip />
        <CoinChip />
      </div>

      {/*
        Row 2: the tabs, centred across the whole window.

        Genuinely centred, because this row no longer has to reserve space for
        the window controls — those sit in the row above. Centring in a row that
        reserved 138px on one side would have put the tabs visibly off-centre.
      */}
      <div
        className={`app-drag glass flex shrink-0 items-stretch${booting ? ' slash-row-2' : ''}`}
        style={{ height: TITLE_BAR_HEIGHT }}
      >
        {!verticalTabs && <TabStrip />}
      </div>

      {/*
        Row 3 is the toolbar. It spans the whole window, and the address field
        inside it is centred and capped in width rather than stretched edge to
        edge — a 2,000px-wide text field is harder to read, not easier.

        The rule the chrome follows: full width means global — the tab strip and
        the omnibox belong to the browser, not to the page — while anything
        inset to the right of the rail is about the page you are looking at.
        That is why the find bar and the blocked-popup notices below stay in the
        content column: they describe this page, and lining them up with it says
        so without a word of explanation.

        This costs the page view nothing. `ViewLayoutManager` insets it by
        `chromeHeight` from the top and `sidebarWidth` from the left, and both
        are unchanged — the toolbar simply occupies the strip it was already
        occupying, over the rail's column as well as its own.
      */}
      <div
        className="glass glass-divide-b relative shrink-0"
        style={{ height: TOOLBAR_HEIGHT }}
      >
        <Toolbar />
        {/*
          Loading indicator. Chromium reports no load percentage, so an
          indeterminate sweep is the honest form — a fake percentage that
          creeps to 90% and waits is worse than none.
        */}
        {activeTab?.isLoading && (
          <div className="absolute inset-x-0 -bottom-px h-0.5 overflow-hidden">
            <div className="h-full w-1/3 animate-[loading_1.1s_ease-in-out_infinite] bg-[var(--color-accent)]" />
          </div>
        )}
      </div>

      </div>

      {/* Row 4: the page. Nothing insets it from the left any more unless the
          tab strip is vertical — the workspace rail that used to cost 56px of
          every page is now the row at the top. */}
      <div className="flex min-h-0 flex-1">

        {verticalTabs && (
          <div
            className="glass glass-divide-r flex shrink-0 flex-col"
            style={{ width: VERTICAL_TAB_STRIP_WIDTH }}
          >
            <TabStrip orientation="vertical" />
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          {isPrivate && <PrivateNotice />}
          <FindBar />
          <HandoffNotice />
          <PopupBlockedNotice blocked={blockedPopup} onDismiss={() => setBlockedPopup(null)} />
          <NavigationBlockedNotice notice={blockedNav} onDismiss={() => setBlockedNav(null)} />

          <div className="flex min-h-0 flex-1">
            <main className="min-w-0 flex-1">
              {crashed ? (
                <SadTab />
              ) : hibernated ? (
                <HibernatedTab />
              ) : failed && activeTab ? (
                // The view is detached while an error is showing, so this is
                // what occupies the content hole.
                <ErrorPage error={failed} tabId={activeTab.id} />
              ) : showNewTab ? (
                <NewTabPage />
              ) : showSettings ? (
                <div className="glass-page h-full overflow-y-auto">
                  <SettingsPanel />
                </div>
              ) : showAdvertise ? (
                <AdvertisePage />
              ) : showRewards ? (
                <RewardsPage />
              ) : showTerms ? (
                <LegalPage which="terms" />
              ) : showPrivacy ? (
                <LegalPage which="privacy" />
              ) : null}
            </main>
            <SidePanel />
          </div>
          {/* In the gutter between the two native panes — the one strip of the
              content area no page view covers. */}
          <SplitDivider />
        </div>
      </div>
    </div>
  )
}

/**
 * Queues the active tab to read later.
 *
 * Refuses internal pages for the same reason bookmarking does: the new tab page
 * is not a page you can come back to, and an entry pointing at one would be a
 * dead row the user has to clear by hand.
 *
 * Unlike bookmarking, this is not a toggle. Saving a page already queued moves
 * it back to unread, which is what saving it again means.
 */
async function saveCurrentTabToReadingList(): Promise<void> {
  const tab = useBrowserStore.getState().activeTab()
  if (!tab || isInternalUrl(tab.url)) return
  await window.browser.invoke('reading:add', {
    url: tab.url,
    title: tab.title || tab.url,
    faviconUrl: tab.faviconUrl
  })
  useBrowserStore.getState().setPanel('reading')
}

async function bookmarkCurrentTab(): Promise<void> {
  const { activeTab, bookmarks } = useBrowserStore.getState()
  const tab = activeTab()
  if (!tab || isInternalUrl(tab.url)) return

  const existing = bookmarks.find((b) => !b.isFolder && b.url === tab.url)
  if (existing) {
    await window.browser.invoke('bookmarks:delete', { id: existing.id })
    return
  }
  await window.browser.invoke('bookmarks:create', {
    url: tab.url,
    title: tab.title || tab.url,
    faviconUrl: tab.faviconUrl,
    parentId: null,
    isFolder: false
  })
}

/**
 * Placeholder for a hibernated tab.
 *
 * Activating one normally rebuilds it automatically, so this is only seen if the
 * rebuild is still in flight. It states plainly what hibernation cost — page
 * state is gone, navigation history is not — rather than implying the tab was
 * merely paused.
 */
function HibernatedTab(): React.JSX.Element {
  const activeTab = useBrowserStore((s) => s.activeTab())

  return (
    <div className="glass-page flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <Icon name="clock" size={28} className="text-violet-400" />
      <div>
        <h2 className="text-lg font-semibold">{activeTab?.title || 'This tab is asleep'}</h2>
        <p className="mt-1 max-w-md text-sm text-[var(--color-text-muted)]">
          Its memory was released to speed up the rest of the browser. Reloading restores the page
          and your back/forward history — anything typed into the page is gone.
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          if (activeTab) {
            void window.browser.invoke('performance:restore', { tabId: activeTab.id })
          }
        }}
        className="cursor-pointer rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-4 py-2 text-sm transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
      >
        Wake this tab
      </button>
    </div>
  )
}

/**
 * Shown when a tab's renderer process dies.
 *
 * A crashed tab keeps its place in the strip and its URL, so Reload rebuilds the
 * view and navigates back — the alternative, a silently blank page, gives the
 * user nothing to act on.
 */
function SadTab(): React.JSX.Element {
  const activeTab = useBrowserStore((s) => s.activeTab())

  return (
    <div className="glass-page flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <Icon name="warning" size={32} className="text-[var(--color-bad)]" />
      <div>
        <h2 className="text-lg font-semibold">This tab stopped working</h2>
        <p className="mt-1 max-w-md text-sm text-[var(--color-text-muted)]">
          {activeTab?.error?.description ?? 'The page process ended unexpectedly.'} Reloading starts
          it again — anything you had typed on the page is gone.
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          if (activeTab) {
            void window.browser.invoke('nav:reload', { tabId: activeTab.id, ignoreCache: false })
          }
        }}
        className="cursor-pointer rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-4 py-2 text-sm transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
      >
        Reload page
      </button>
    </div>
  )
}
