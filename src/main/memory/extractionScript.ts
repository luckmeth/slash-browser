import readabilitySource from '@mozilla/readability/Readability.js?raw'
import { MAX_INDEXED_BODY_CHARS } from '@shared/types/memory'

/**
 * The script injected into a page to extract its readable text.
 *
 * Injected on demand from the main process rather than bundled into the content
 * preload. The preload runs in *every* page the user visits, and content
 * indexing is off by default — so paying ~50 KB of parse cost on every page load
 * for a feature most users never turn on would be the wrong trade. This way the
 * cost lands only on pages actually being indexed.
 *
 * Runs in the page's isolated world. It reads the DOM and returns a plain
 * object; it has no access to our IPC surface, and the value it returns is
 * treated as untrusted input and re-validated in main.
 */
export function buildExtractionScript(): string {
  return `(() => {
    try {
      ${readabilitySource}

      // Readability mutates the document it is given, which would visibly break
      // the live page. Parse a clone instead.
      const documentClone = document.cloneNode(true);
      const article = new Readability(documentClone, { charThreshold: 200 }).parse();

      const body = (article && article.textContent ? article.textContent : document.body.innerText || '')
        .replace(/\\s+/g, ' ')
        .trim()
        .slice(0, ${MAX_INDEXED_BODY_CHARS});

      return {
        url: location.href,
        title: (article && article.title) || document.title || '',
        siteName: (article && article.siteName) || null,
        excerpt: ((article && article.excerpt) || body.slice(0, 300)).trim(),
        body,
        wordCount: body ? body.split(' ').length : 0
      };
    } catch (error) {
      // A page that defeats extraction still deserves to be findable by title
      // and URL, so fall back rather than failing the whole visit.
      const fallback = (document.body ? document.body.innerText || '' : '')
        .replace(/\\s+/g, ' ')
        .trim()
        .slice(0, ${MAX_INDEXED_BODY_CHARS});
      return {
        url: location.href,
        title: document.title || '',
        siteName: null,
        excerpt: fallback.slice(0, 300),
        body: fallback,
        wordCount: fallback ? fallback.split(' ').length : 0
      };
    }
  })()`
}
