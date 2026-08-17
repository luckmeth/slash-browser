import readabilitySource from '@mozilla/readability/Readability.js?raw'

/**
 * The script injected to extract an article for reader mode.
 *
 * Separate from the memory extractor even though both run Readability, because
 * they want different things from it: the indexer wants one flat string to feed
 * a search index, and the reader needs the shape of the document — which
 * paragraph is a heading, which is a quote — to be worth reading.
 *
 * Returns **text blocks only**. Readability's own `content` is HTML, and the
 * document that would render it is our privileged overlay; see
 * `shared/types/reader.ts` for why that is not a trade worth making.
 *
 * Runs in the page's isolated world and returns plain data, re-validated in main.
 */
export function buildReaderScript(): string {
  return `(() => {
    try {
      ${readabilitySource}

      // Readability mutates what it parses, so it gets a clone — otherwise
      // opening the reader visibly destroys the live page behind it.
      const documentClone = document.cloneNode(true);
      const article = new Readability(documentClone, { charThreshold: 200 }).parse();
      if (!article || !article.content) return null;

      // The parsed markup is walked in a detached container. It is never
      // inserted into a live document, so nothing in it runs.
      const holder = document.createElement('div');
      holder.innerHTML = article.content;

      const blocks = [];
      const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim();

      const walk = (node) => {
        for (const child of node.children) {
          const tag = child.tagName.toLowerCase();

          if (/^h[1-6]$/.test(tag)) {
            const text = clean(child.textContent);
            if (text) blocks.push({ kind: 'heading', level: Number(tag[1]), text });
            continue;
          }
          if (tag === 'p') {
            const text = clean(child.textContent);
            if (text) blocks.push({ kind: 'paragraph', level: 1, text });
            continue;
          }
          if (tag === 'blockquote') {
            const text = clean(child.textContent);
            if (text) blocks.push({ kind: 'quote', level: 1, text });
            continue;
          }
          if (tag === 'pre') {
            // Whitespace is the content in code, so it is not collapsed here.
            const text = (child.textContent || '').replace(/\\s+$/, '');
            if (text.trim()) blocks.push({ kind: 'code', level: 1, text });
            continue;
          }
          if (tag === 'li') {
            const text = clean(child.textContent);
            if (text) blocks.push({ kind: 'list-item', level: 1, text });
            continue;
          }
          if (tag === 'figure' || tag === 'img' || tag === 'figcaption') continue;

          // Containers — div, section, article, ul, ol — carry the real content
          // one level down.
          if (child.children.length > 0) walk(child);
          else {
            const text = clean(child.textContent);
            if (text) blocks.push({ kind: 'paragraph', level: 1, text });
          }
        }
      };
      walk(holder);

      const wordCount = blocks.reduce(
        (total, block) => total + (block.text ? block.text.split(' ').length : 0),
        0
      );

      return {
        url: location.href,
        title: clean(article.title) || document.title || '',
        siteName: clean(article.siteName) || null,
        byline: clean(article.byline) || null,
        wordCount,
        readingMinutes: Math.max(1, Math.round(wordCount / 230)),
        blocks: blocks.slice(0, 2000)
      };
    } catch (error) {
      // A page that defeats extraction is reported as "not an article" rather
      // than as a crash — the user asked for a reading view, not a stack trace.
      return null;
    }
  })()`
}
