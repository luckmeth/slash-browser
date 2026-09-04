import { useCallback, useEffect, useRef, useState } from 'react'
import { useBrowserStore } from '../../stores/browserStore'

/**
 * The drag handle between two split panes.
 *
 * It can live in the chrome document — unlike a panel over a page — because it
 * sits in the *gutter*, the strip of chrome deliberately left uncovered between
 * the two native page views. There is no page above it to composite over, which
 * is the one place in the content area where CSS is safe.
 *
 * Its position comes from the main process rather than being recomputed here.
 * The panes are native views laid out in DIP by `layoutPanes`, so a second copy
 * of that arithmetic in React would drift from the real seam.
 */
export function SplitDivider(): React.JSX.Element | null {
  const split = useBrowserStore((s) => s.split)
  const [dragging, setDragging] = useState(false)
  // The last fraction we sent. Dragging is a stream of positions and each one
  // is an IPC round trip that moves two native views; sending a duplicate is a
  // relayout that changes nothing.
  const lastSent = useRef<number | null>(null)

  const geometry = split.splitGeometry
  const orientation = split.splitOrientation

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      if (!geometry) return
      const { content } = geometry
      const fraction =
        orientation === 'vertical'
          ? (event.clientX - content.x) / Math.max(1, content.width)
          : (event.clientY - content.y) / Math.max(1, content.height)

      const rounded = Math.round(fraction * 200) / 200
      if (lastSent.current === rounded) return
      lastSent.current = rounded
      void window.browser.invoke('tabs:setSplitFraction', { fraction: rounded })
    },
    [geometry, orientation]
  )

  useEffect(() => {
    if (!dragging) return
    const stop = (): void => setDragging(false)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', stop)
    // A drag that ends outside the window still has to end. Without this the
    // divider keeps following the cursor after the button is released.
    window.addEventListener('pointercancel', stop)
    window.addEventListener('blur', stop)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      window.removeEventListener('blur', stop)
    }
  }, [dragging, onPointerMove])

  if (!geometry || !split.splitTabId) return null

  const vertical = orientation === 'vertical'
  const { divider } = geometry

  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label="Resize split panes"
      tabIndex={0}
      onPointerDown={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onKeyDown={(event) => {
        // Keyboard resize, because a drag handle that only takes a mouse is not
        // reachable at all for some users.
        const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -0.02 : 0.02
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
        event.preventDefault()
        void window.browser.invoke('tabs:setSplitFraction', {
          fraction: split.splitFraction + step
        })
      }}
      style={{
        position: 'fixed',
        left: divider.x,
        top: divider.y,
        width: divider.width,
        height: divider.height,
        cursor: vertical ? 'col-resize' : 'row-resize'
      }}
      className="group z-30 flex items-center justify-center"
    >
      <div
        className={`rounded-full bg-white/20 transition group-hover:bg-[var(--color-accent)] ${
          dragging ? 'bg-[var(--color-accent)]' : ''
        } ${vertical ? 'h-10 w-[3px]' : 'h-[3px] w-10'}`}
      />
    </div>
  )
}
