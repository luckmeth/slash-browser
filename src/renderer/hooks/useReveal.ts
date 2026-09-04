import { useEffect, useRef } from 'react'

/**
 * Reveals elements as they scroll into view.
 *
 * The rule this is written around: **content must never be left invisible.**
 * A reveal animation that depends on an observer firing is one bug away from a
 * blank page, and the two pages using it are the ones somebody reads to decide
 * whether to sign up or spend money. So:
 *
 *  - `.slash-reveal` is fully opaque by default in CSS. Only inside a
 *    `prefers-reduced-motion: no-preference` block does it start hidden.
 *  - If `IntersectionObserver` is missing, every element is marked revealed
 *    immediately rather than left waiting.
 *  - Anything already on screen at mount reveals on the observer's first
 *    callback, which fires synchronously for intersecting elements.
 *
 * One observer per page rather than one per card: a marketing page has thirty
 * of these, and thirty observers is thirty callbacks on every scroll frame.
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>(): React.RefObject<T | null> {
  const root = useRef<T>(null)

  useEffect(() => {
    const container = root.current
    if (!container) return

    const revealNow = (root: ParentNode): void => {
      for (const target of root.querySelectorAll<HTMLElement>('.slash-reveal')) {
        target.classList.add('is-in')
      }
    }

    if (typeof IntersectionObserver === 'undefined') {
      revealNow(container)
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          entry.target.classList.add('is-in')
          // Revealed once and then forgotten. Re-hiding on scroll-out makes a
          // long page flicker as it is read back through.
          observer.unobserve(entry.target)
        }
      },
      // A little before the element arrives, so it is finished animating by the
      // time it is properly in view rather than starting as it lands.
      { rootMargin: '0px 0px -8% 0px', threshold: 0.05 }
    )

    const observe = (root: ParentNode): void => {
      for (const target of root.querySelectorAll<HTMLElement>('.slash-reveal')) {
        observer.observe(target)
      }
    }
    observe(container)

    // Sections that appear *after* mount have to be picked up too.
    //
    // This page renders its balance, rates and countdown only once the status
    // arrives over IPC, which is always later than the first paint. A one-shot
    // scan therefore never saw them and they stayed hidden for ever — a blank
    // gap where the numbers should be, on the screen the whole feature is
    // about. Content must never be left invisible; that is the rule this hook
    // exists to keep, so it watches for new nodes rather than assuming the
    // tree is final.
    if (typeof MutationObserver === 'undefined') {
      revealNow(container)
      return () => observer.disconnect()
    }

    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        for (const added of record.addedNodes) {
          if (!(added instanceof HTMLElement)) continue
          if (added.classList.contains('slash-reveal')) observer.observe(added)
          observe(added)
        }
      }
    })
    mutations.observe(container, { childList: true, subtree: true })

    return () => {
      observer.disconnect()
      mutations.disconnect()
    }
  }, [])

  return root
}
