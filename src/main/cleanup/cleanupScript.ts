import type { CleanupPlan } from './cleanupRules'
import { PRESERVE_SELECTORS } from './cleanupRules'

/** Marker on the injected style element, so cleanup can be undone precisely. */
const STYLE_ID = 'slash-cleanup-style'

/**
 * The script that performs a cleanup pass in the page.
 *
 * Hides by adding a class rather than by removing nodes. Removal would be
 * irreversible within the live document and would break scripts that expect
 * their elements to exist — a site whose consent script throws because we
 * deleted its banner can leave the whole page dead.
 *
 * Every candidate is checked against the preserve list, including its ancestors,
 * so a sticky element inside an article survives. The heuristics fire on shape,
 * and the shape of a newsletter bar is the shape of a site's own toolbar.
 */
export function buildCleanupScript(plan: CleanupPlan): string {
  const selectors = JSON.stringify(plan.selectors)
  const preserve = JSON.stringify([...PRESERVE_SELECTORS])

  return `(() => {
    try {
      const HIDE_CLASS = 'slash-cleanup-hidden';
      const PRESERVE = ${preserve};
      const SELECTORS = ${selectors};

      // Re-running must not double-count, so a previous pass is undone first.
      for (const previous of document.querySelectorAll('.' + HIDE_CLASS)) {
        previous.classList.remove(HIDE_CLASS);
      }
      document.getElementById(${JSON.stringify(STYLE_ID)})?.remove();

      const style = document.createElement('style');
      style.id = ${JSON.stringify(STYLE_ID)};
      // !important because the elements being hidden are frequently inline-styled
      // by their own scripts, which would otherwise win.
      style.textContent = '.' + HIDE_CLASS + ' { display: none !important; }';
      document.documentElement.appendChild(style);

      const isPreserved = (element) => {
        for (const selector of PRESERVE) {
          try {
            if (element.matches(selector) || element.closest(selector)) return true;
          } catch (error) {
            // An invalid selector must not abort the whole pass.
          }
        }
        return false;
      };

      /**
       * Whether hiding this element would take most of the page with it.
       *
       * A node covering nearly the whole viewport is either the content itself or
       * a full-screen overlay. Overlays are caught by their position; anything
       * else that large is content and is left alone.
       */
      const isTooLarge = (element) => {
        const rect = element.getBoundingClientRect();
        const area = rect.width * rect.height;
        const viewport = window.innerWidth * window.innerHeight;
        if (viewport === 0) return false;
        const position = getComputedStyle(element).position;
        const overlaying = position === 'fixed' || position === 'sticky';
        return area > viewport * 0.6 && !overlaying;
      };

      let hidden = 0;
      const hide = (element) => {
        if (!element || element === document.body || element === document.documentElement) return;
        if (element.classList.contains(HIDE_CLASS)) return;
        if (isPreserved(element) || isTooLarge(element)) return;
        element.classList.add(HIDE_CLASS);
        hidden++;
      };

      for (const selector of SELECTORS) {
        let matches;
        try {
          matches = document.querySelectorAll(selector);
        } catch (error) {
          // Some selectors use the case-insensitive attribute flag, which older
          // engines reject. Skipping one rule is fine; failing the pass is not.
          continue;
        }
        for (const element of Array.from(matches).slice(0, 400)) hide(element);
      }

      ${
        plan.hideFixed
          ? `
      // Aggressive only. Anything pinned to the screen that is not the page's own
      // navigation, and not large enough to be the content.
      for (const element of Array.from(document.body.querySelectorAll('*')).slice(0, 4000)) {
        const position = getComputedStyle(element).position;
        if (position !== 'fixed' && position !== 'sticky') continue;
        const rect = element.getBoundingClientRect();
        if (rect.width < 24 || rect.height < 24) continue;
        hide(element);
      }`
          : ''
      }

      // A page that locked scrolling to hold you on a modal stays locked once the
      // modal is hidden, which would leave the page unreadable — worse than the
      // overlay was.
      let scrollUnlocked = false;
      for (const node of [document.documentElement, document.body]) {
        const overflow = getComputedStyle(node).overflow;
        if (overflow === 'hidden') {
          node.style.setProperty('overflow', 'auto', 'important');
          scrollUnlocked = true;
        }
        if (getComputedStyle(node).position === 'fixed') {
          node.style.setProperty('position', 'static', 'important');
          scrollUnlocked = true;
        }
      }

      let paused = 0;
      ${
        plan.pauseMedia
          ? `
      for (const media of document.querySelectorAll('video, audio')) {
        // Only autoplaying media. Something the user started themselves is not an
        // interruption, and stopping it would be its own bug.
        if (media.paused || media.muted) continue;
        if (!media.autoplay && media.currentTime > 1.5) continue;
        media.pause();
        paused++;
      }`
          : ''
      }

      return { hidden, paused, scrollUnlocked };
    } catch (error) {
      return { hidden: 0, paused: 0, scrollUnlocked: false, error: String(error) };
    }
  })()`
}

/**
 * The script that undoes a cleanup pass.
 *
 * Only removes what cleanup added: the marker class, the injected stylesheet and
 * the two inline overflow overrides. Anything else on the page is untouched
 * because cleanup never touched it.
 */
export function buildRestoreScript(): string {
  return `(() => {
    try {
      let restored = 0;
      for (const element of document.querySelectorAll('.slash-cleanup-hidden')) {
        element.classList.remove('slash-cleanup-hidden');
        restored++;
      }
      document.getElementById(${JSON.stringify(STYLE_ID)})?.remove();
      for (const node of [document.documentElement, document.body]) {
        node.style.removeProperty('overflow');
        node.style.removeProperty('position');
      }
      return { restored };
    } catch (error) {
      return { restored: 0 };
    }
  })()`
}
