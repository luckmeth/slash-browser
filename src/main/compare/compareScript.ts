/**
 * What a page says about itself, read out of the page's own world.
 *
 * Runs only when the user asks for a comparison — never on load, never on a
 * timer — and reads only what the document already contains. It takes no
 * screenshot, follows no link and sends nothing anywhere; the result travels to
 * main, is aligned by `alignFacts`, and is rendered.
 *
 * Three sources, in order of how much the page meant them:
 *
 *   1. **JSON-LD** (`application/ld+json`). Published by the site specifically
 *      to be read by machines, so it is the most reliable thing on the page.
 *   2. **Meta tags** — Open Graph and the product meta properties.
 *   3. **Two-column tables and definition lists**, which is how specification
 *      sheets are written when nobody has published structured data.
 *
 * Nothing is inferred from prose. A regex hunting for a price in body text finds
 * the shipping threshold and the crossed-out "was" price as readily as the real
 * one, and a comparison table is exactly where a wrong number does the most
 * damage — so this reads only fields the page has labelled itself.
 *
 * It is a **string**, so nothing else checks it: a syntax error or a typo'd
 * property fails no build and no typecheck, and the catch below turns it into
 * "nothing found" for ever. `compareScript.test.ts` runs it through
 * `new Function` against stand-ins, which is the house rule for every
 * string-of-code in this repository and was written after shipping that failure
 * twice elsewhere.
 */
export const COMPARE_SCRIPT = `(() => {
  try {
    const fields = {};
    const put = (key, value) => {
      if (typeof key !== 'string' || typeof value !== 'string') return;
      const k = key.trim();
      const v = value.trim();
      if (k === '' || v === '' || v.length > 200) return;
      /*
       * A field name has to look like one.
       *
       * Found by running this against two Wikipedia articles: the browser
       * timeline table is two columns, so every year became a "field" and the
       * comparison filled with rows like "2001 | Not detected | iCab 2.5
       * Internet Explorer 6 …". Accurate, in that the page does state it, and
       * useless — and it crowded out anything real. A key with no letter in it
       * is a row label, not a property, and a key longer than this is a
       * sentence that happened to sit in the first column.
       */
      if (!/[A-Za-z]/.test(k) || k.length > 40) return;
      if (Object.keys(fields).length >= 60) return;
      if (!(k in fields)) fields[k] = v;
    };

    // --- 1. JSON-LD ----------------------------------------------------------
    // Walked one level into objects so an Offer nested under a Product is read,
    // but no deeper: past that the keys stop being about the thing on the page.
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (let i = 0; i < scripts.length && i < 10; i += 1) {
      let data = null;
      try {
        data = JSON.parse(scripts[i].textContent || 'null');
      } catch (error) {
        continue;
      }
      const nodes = Array.isArray(data) ? data : [data];
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        for (const key of Object.keys(node)) {
          if (key.charAt(0) === '@') continue;
          const value = node[key];
          if (typeof value === 'string' || typeof value === 'number') {
            put(key, String(value));
          } else if (value && typeof value === 'object' && !Array.isArray(value)) {
            for (const inner of Object.keys(value)) {
              if (inner.charAt(0) === '@') continue;
              const nested = value[inner];
              if (typeof nested === 'string' || typeof nested === 'number') {
                put(inner, String(nested));
              }
            }
          }
        }
      }
    }

    // --- 2. meta tags --------------------------------------------------------
    const metas = document.querySelectorAll('meta[property], meta[itemprop]');
    for (let i = 0; i < metas.length && i < 60; i += 1) {
      const meta = metas[i];
      const name = meta.getAttribute('property') || meta.getAttribute('itemprop') || '';
      const content = meta.getAttribute('content') || '';
      // Only the product/offer namespace and itemprops. og:title and og:image
      // are about presentation, and the title is captured separately below.
      if (name.indexOf('product:') === 0 || name.indexOf('og:price') === 0) {
        put(name.replace(/^product:|^og:/, '').replace(/[:_]/g, ' '), content);
      } else if (!meta.hasAttribute('property')) {
        put(name.replace(/([a-z])([A-Z])/g, '$1 $2'), content);
      }
    }

    // --- 3. specification tables and definition lists ------------------------
    const rows = document.querySelectorAll('table tr');
    for (let i = 0; i < rows.length && i < 200; i += 1) {
      const cells = rows[i].children;
      // Exactly two columns. Three or more is a data table, where the first
      // column is a row label rather than a field name.
      if (cells.length !== 2) continue;
      put(cells[0].textContent || '', cells[1].textContent || '');
    }

    const terms = document.querySelectorAll('dl dt');
    for (let i = 0; i < terms.length && i < 100; i += 1) {
      const value = terms[i].nextElementSibling;
      if (value && value.tagName === 'DD') {
        put(terms[i].textContent || '', value.textContent || '');
      }
    }

    // --- the page's own identity ---------------------------------------------
    const metaContent = (selector) => {
      const found = document.querySelector(selector);
      return found ? found.getAttribute('content') : null;
    };

    const headings = [];
    const hs = document.querySelectorAll('h1, h2');
    for (let i = 0; i < hs.length && headings.length < 12; i += 1) {
      const text = (hs[i].textContent || '').trim().replace(/\\s+/g, ' ');
      if (text !== '' && text.length < 120) headings.push(text);
    }

    const body = document.body ? document.body.innerText || '' : '';

    return {
      title: document.title || '',
      description:
        metaContent('meta[name="description"]') || metaContent('meta[property="og:description"]'),
      siteName: metaContent('meta[property="og:site_name"]'),
      fields: fields,
      headings: headings,
      // A rough size, so the side-by-side view can say which page is the longer
      // read. Counted rather than estimated.
      wordCount: body ? body.split(/\\s+/).filter(Boolean).length : 0
    };
  } catch (error) {
    return null;
  }
})()`
