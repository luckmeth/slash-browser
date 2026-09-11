import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { Tab } from '@shared/types/tab'
import type { TabGroup } from '@shared/types/tabGroup'
import { internalPageTitle, isInternalUrl } from '@shared/types/tab'
import { hostOf } from '@shared/url'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'
import { COLOR_CLASSES } from '../workspaces/workspaceColors'
import { TabGroupChip } from './TabGroupChip'

const MAX_TAB_WIDTH = 220
/** The `+` button at the end of the run. */
const NEW_TAB_BUTTON_WIDTH = 40
/** `px-2` on the strip: 8px each side. */
const STRIP_PADDING = 16

const MIN_TAB_WIDTH = 44
const PINNED_TAB_WIDTH = 42

/**
 * The tab strip, which doubles as the window's title bar.
 *
 * Two consequences of living in the title bar:
 *  - every interactive element needs `app-no-drag`, or the window-drag handler
 *    swallows the click before it arrives
 *  - tabs shrink to fit rather than scrolling, the way Chrome and Edge do. A
 *    horizontally scrolling strip is a desktop-app pattern; browsers compress.
 *
 * Compression has a floor, though, and past it the strip **scrolls** rather
 * than clipping. That is not a softening of the rule above but a bug fix: with
 * `overflow-hidden` and a 44px minimum, the thirtieth tab and everything after
 * it was drawn outside the container and could not be clicked at all. Shrinking
 * first and scrolling only when shrinking has run out keeps the browser
 * behaviour and stops tabs becoming unreachable.
 *
 * Vertical is not a restyling of the same thing: horizontal tabs share a fixed
 * width between them, whereas a vertical list gives every tab a full-width
 * label and scrolls from the start. So the width maths applies only to the
 * horizontal case, and the vertical case deliberately has none.
 */
export function TabStrip({
  orientation = 'horizontal'
}: {
  orientation?: 'horizontal' | 'vertical'
} = {}): React.JSX.Element {
  const tabs = useBrowserStore((s) => s.tabs)
  const activeTabId = useBrowserStore((s) => s.activeTabId)
  const splitTabId = useBrowserStore((s) => s.split.splitTabId)
  const groups = useBrowserStore((s) => s.groups)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [stripWidth, setStripWidth] = useState(0)

  /**
   * Tracks the strip's own width, including while the window is being dragged.
   *
   * A ref callback alone only re-measures when React happens to re-render, so
   * resizing the window left every tab at its old width — and, once the strip
   * learned to scroll, left the overflow flag stale too, so it could fail to
   * scroll at exactly the moment it needed to. Tab snapshots re-render often
   * enough to hide this most of the time, which is what made it easy to miss.
   */
  const observerRef = useRef<ResizeObserver | null>(null)
  const stripRef = useRef<HTMLDivElement | null>(null)
  const measureStrip = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!node) return

    stripRef.current = node
    setStripWidth(node.clientWidth)
    const observer = new ResizeObserver(([entry]) => {
      // contentRect excludes padding, which is what the width maths already
      // assumes; clientWidth would double-count it.
      if (entry) setStripWidth(Math.round(entry.contentRect.width))
    })
    observer.observe(node)
    observerRef.current = observer
  }, [])

  const pinnedCount = tabs.filter((t) => t.isPinned).length
  const flexibleCount = tabs.length - pinnedCount
  // Leave room for the new-tab button, **and for the strip's own padding**.
  // `px-2` is 8px each side and was not being subtracted, so the strip believed
  // it had 16px more room than it has. That is enough to keep `overflowing`
  // false while the run genuinely does not fit — and the non-overflow branch
  // used to be `overflow-hidden`, so the tabs past the edge were clipped with
  // no way to scroll to them. They could not be clicked, switched to, or
  // closed.
  const available = Math.max(
    0,
    stripWidth - pinnedCount * (PINNED_TAB_WIDTH + 2) - NEW_TAB_BUTTON_WIDTH - STRIP_PADDING
  )
  const tabWidth =
    flexibleCount === 0
      ? MAX_TAB_WIDTH
      : Math.max(MIN_TAB_WIDTH, Math.min(MAX_TAB_WIDTH, Math.floor(available / flexibleCount) - 2))

  // Shrinking has bottomed out and the run still does not fit. Without
  // scrolling, every tab past this point is drawn outside the container and is
  // simply not clickable — which is how a tab becomes unreachable rather than
  // merely narrow.
  const predictedOverflow = stripWidth > 0 && flexibleCount * (tabWidth + 2) > available

  // Predicting overflow from widths is arithmetic about a layout that has not
  // happened yet, and it has been wrong. `scrollWidth > clientWidth` is the
  // layout's own answer, read after it settles, so the two are OR-ed: whichever
  // notices first wins, and neither can leave a tab unreachable on its own.
  const [measuredOverflow, setMeasuredOverflow] = useState(false)
  useEffect(() => {
    const node = stripRef.current
    if (!node) return
    const check = (): void => setMeasuredOverflow(node.scrollWidth > node.clientWidth + 1)
    check()
    const observer = new ResizeObserver(check)
    observer.observe(node)
    return () => observer.disconnect()
  }, [tabs.length, stripWidth])

  const overflowing = predictedOverflow || measuredOverflow

  // The ref callback disconnects when the node changes; this covers unmount.
  useEffect(() => () => observerRef.current?.disconnect(), [])

  async function handleDrop(index: number): Promise<void> {
    if (dragId) await window.browser.invoke('tabs:reorder', { tabId: dragId, toIndex: index })
    setDragId(null)
    setDropIndex(null)
  }

  const vertical = orientation === 'vertical'

  return (
    <div
      ref={measureStrip}
      className={
        vertical
          ? 'flex min-h-0 flex-1 flex-col items-stretch gap-0.5 overflow-y-auto px-1.5 py-1.5'
          : // Centred while the tabs fit, and left-aligned the moment they do
            // not. `justify-center` on a scrolling flex row is a trap: the
            // overflow spills equally both ways, so the first tab ends up at a
            // negative scroll offset that cannot be reached at all. Once the
            // strip scrolls, the run has to start at the left edge.
            // Always scrollable, never `overflow-hidden`. Centring is only a
            // preference; being able to reach a tab is not, so the failure mode
            // when the measurement is wrong has to be "scrolls" rather than
            // "clipped and gone".
            `flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto overflow-y-hidden px-2 pt-1.5 ${
              overflowing ? 'tab-strip-faded justify-start' : 'justify-center'
            }`
      }
      role="tablist"
      aria-label="Tabs"
    >
      {tabs.map((tab, index) => {
        const group = tab.groupId ? groups.find((g) => g.id === tab.groupId) : undefined
        // The chip is drawn before the first tab of each run. Membership implies
        // adjacency (TabManager gathers a group into one contiguous run), so
        // "previous tab has a different group" is exactly "this run starts here".
        const startsRun = group !== undefined && tabs[index - 1]?.groupId !== tab.groupId
        // A collapsed group keeps its tabs alive and simply stops drawing them.
        const hidden = group?.collapsed === true

        return (
          <Fragment key={tab.id}>
            {startsRun && group && (
              <TabGroupChip
                group={group}
                count={tabs.filter((t) => t.groupId === group.id).length}
                vertical={vertical}
              />
            )}
            {!hidden && (
        <TabItem
          tab={tab}
          group={group}
          vertical={vertical}
          // A vertical row is always full width; only the horizontal strip has
          // to divide a fixed space between however many tabs there are.
          width={vertical ? 0 : tab.isPinned ? PINNED_TAB_WIDTH : tabWidth}
          isActive={tab.id === activeTabId}
          isSplit={tab.id === splitTabId}
          splitActive={splitTabId !== null}
          isDropTarget={dropIndex === index}
          canAcceptDrop={
            dragId !== null &&
            (tabs.find((t) => t.id === dragId)?.isPinned ?? false) === tab.isPinned
          }
          onDragStart={() => setDragId(tab.id)}
          onDragEnd={() => {
            setDragId(null)
            setDropIndex(null)
          }}
          onDragOver={() => setDropIndex(index)}
          onDrop={() => void handleDrop(index)}
        />
            )}
          </Fragment>
        )
      })}

      <button
        type="button"
        title="New tab (Ctrl+T)"
        aria-label="New tab"
        onClick={() => void window.browser.invoke('tabs:create', { background: false })}
        className={`app-no-drag shrink-0 cursor-default rounded-md p-1.5 text-[var(--color-text-muted)] transition hover:bg-white/10 hover:text-[var(--color-text-primary)] ${
          vertical ? 'mt-0.5 flex items-center gap-2 px-2 text-xs' : 'mb-1'
        }`}
      >
        <Icon name="plus" size={15} />
        {vertical && <span>New tab</span>}
      </button>
    </div>
  )
}

function TabItem({
  tab,
  group,
  width,
  vertical = false,
  isActive,
  isSplit,
  splitActive,
  isDropTarget,
  canAcceptDrop,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop
}: {
  tab: Tab
  /** The group this tab belongs to, so the tab can carry its colour. */
  group?: TabGroup
  width: number
  vertical?: boolean
  isActive: boolean
  /** Showing in the second pane. Lit like the active tab, since it is on screen. */
  isSplit: boolean
  /** Split view is on, so "which of these two is active" needs saying. */
  splitActive: boolean
  isDropTarget: boolean
  canAcceptDrop: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onDragOver: () => void
  onDrop: () => void
}): React.JSX.Element {
  const internal = isInternalUrl(tab.url)
  const label =
    tab.title || (internal ? internalPageTitle(tab.url) : hostOf(tab.url)) || 'Untitled'
  // Below this the label is unreadable anyway, so show icon only — the same
  // thing Chrome does as tabs compress. A vertical row never compresses: it is
  // full width whatever else is open, which is the whole reason to use it.
  const compact = !vertical && width < 90

  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData('text/tab-id', tab.id)
        event.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        if (!canAcceptDrop) return
        event.preventDefault()
        onDragOver()
      }}
      onDrop={(event) => {
        if (!canAcceptDrop) return
        event.preventDefault()
        onDrop()
      }}
      onClick={() => void window.browser.invoke('tabs:activate', { tabId: tab.id })}
      onAuxClick={(event) => {
        if (event.button === 1) void window.browser.invoke('tabs:close', { tabId: tab.id })
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        void window.browser.invoke('menu:showTabContextMenu', { tabId: tab.id })
      }}
      role="tab"
      aria-selected={isActive}
      tabIndex={0}
      title={internal ? label : `${label}\n${tab.url}`}
      style={vertical ? undefined : { width }}
      className={[
        'app-no-drag group relative flex h-[31px] shrink-0 cursor-default items-center gap-2 px-2.5 text-[13px] transition-colors',
        // Horizontal tabs are pages hanging from the title bar, so they round at
        // the top only. A vertical row is a list item and rounds all the way.
        vertical ? 'w-full rounded-md' : 'rounded-t-lg',
        compact ? 'justify-center' : '',
        // A tab inside a group carries the group's colour. Until now only the
        // chip at the head of the run did, so the tabs *in* a group were
        // visually identical to ungrouped ones — which meant the grouping was
        // only legible if you could see where the run started, and on a
        // scrolled strip you often cannot.
        group ? `${COLOR_CLASSES[group.color].tint} ${COLOR_CLASSES[group.color].groupEdge}` : '',
        // The active tab gets a lit pane; inactive ones stay legible rather than
        // fading into the glass, which is what happened at lower contrast.
        // Both panes are visible pages, so both are lit rather than one looking
        // backgrounded while its page is on screen.
        // `slash-glow` transitions the shadow and background rather than
        // swapping them, so moving between tabs reads as the light following
        // rather than as two separate repaints. Named properties only — never
        // `all` — or the strip's own width changes would animate too.
        'slash-glow slash-tab-in',
        isActive || isSplit
          ? 'bg-[var(--glass-high)] text-[var(--color-text-primary)] shadow-[inset_0_1px_0_var(--glass-edge-strong)]'
          : 'text-[var(--color-text-muted)] hover:bg-white/[0.10]',
        isActive ? 'slash-glow-on' : '',
        // With two tabs lit, which one is *active* stops being obvious — and it
        // still decides where the omnibox, find bar and shortcuts land. The
        // marker appears only while split, so the normal strip is unchanged.
        splitActive && isActive ? 'ring-1 ring-[var(--color-accent)] ring-inset' : '',
        isDropTarget ? 'ring-2 ring-[var(--color-accent)] ring-inset' : ''
      ].join(' ')}
    >
      {/*
        In compact mode the icon and the close button occupy the same spot: the
        icon fades out on hover and the close fades in over it. There is no room
        for both, and the previous answer — drop the close button entirely below
        90px — meant that once enough tabs were open **no tab could be closed by
        clicking at all**. Middle-click and Ctrl+W still worked, but a browser
        whose close button vanishes exactly when you have too many tabs has
        removed the control at the moment it is needed most.
      */}
      <span className={compact ? 'relative flex items-center group-hover:opacity-0' : 'contents'}>
        <TabIcon tab={tab} internal={internal} />
      </span>

      {!compact && <span className="flex-1 truncate">{label}</span>}

      <button
        type="button"
        aria-label={`Close ${label}`}
        onClick={(event) => {
          event.stopPropagation()
          void window.browser.invoke('tabs:close', { tabId: tab.id })
        }}
        className={[
          'app-no-drag shrink-0 rounded p-0.5 opacity-0 transition group-hover:opacity-100 hover:bg-white/15 focus:opacity-100',
          // Invisible is not inert: an `opacity-0` element still takes clicks.
          // In compact mode this one sits *over the middle of the tab*, so
          // clicking a narrow tab to switch to it hit the close button instead
          // and shut it. Disabled until the pointer is actually on the tab.
          'pointer-events-none group-hover:pointer-events-auto focus:pointer-events-auto',
          compact ? 'absolute inset-0 m-auto size-4' : ''
        ].join(' ')}
      >
        <Icon name="close" size={11} />
      </button>
    </div>
  )
}

function TabIcon({ tab, internal }: { tab: Tab; internal: boolean }): React.JSX.Element {
  if (tab.isLoading) {
    return (
      <span
        className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-[var(--color-text-muted)] border-t-transparent"
        aria-label="Loading"
      />
    )
  }

  if (tab.status === 'crashed') {
    return <Icon name="warning" size={14} className="shrink-0 text-[var(--color-bad)]" />
  }

  // A sleeping tab is dimmed rather than badged: it is still a normal tab, and a
  // loud indicator would imply something went wrong.
  const dimmed = tab.status === 'hibernated' ? 'opacity-40' : ''

  if (tab.isAudible || tab.isMuted) {
    return (
      <button
        type="button"
        aria-label={tab.isMuted ? 'Unmute tab' : 'Mute tab'}
        onClick={(event) => {
          event.stopPropagation()
          void window.browser.invoke('tabs:setMuted', { tabId: tab.id, muted: !tab.isMuted })
        }}
        className="app-no-drag shrink-0 rounded p-0.5 hover:bg-white/15"
      >
        <Icon name={tab.isMuted ? 'mute' : 'volume'} size={13} />
      </button>
    )
  }

  if (internal) return <Icon name="globe" size={14} className={`shrink-0 opacity-60 ${dimmed}`} />

  if (tab.faviconUrl) {
    return (
      <img
        src={tab.faviconUrl}
        width={32}
        height={32}
        alt=""
        className={`size-4 shrink-0 rounded-sm ${dimmed}`}
        onError={(event) => {
          event.currentTarget.style.visibility = 'hidden'
        }}
      />
    )
  }

  return <Icon name="globe" size={14} className={`shrink-0 opacity-60 ${dimmed}`} />
}
