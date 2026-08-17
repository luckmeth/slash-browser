/**
 * The script injected to collect what a page declares about itself.
 *
 * Gathers facts only — headings, links with their `rel`, meta description,
 * JSON-LD product data, visible text. Every judgement is made in main against
 * `insightAnalysis.ts`, where it is testable and where the page cannot influence
 * the outcome.
 *
 * Structured data is preferred wherever the page publishes it. `<meta name=
 * "description">` and `application/ld+json` are the page's own statements about
 * itself, which is a far better source than inferring the same thing from prose.
 */
export function buildInsightScript(): string {
  return `(() => {
    try {
      const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const attr = (selector, name) => {
        const node = document.querySelector(selector);
        return node ? clean(node.getAttribute(name)) : '';
      };

      // --- headings -------------------------------------------------------
      const outline = [];
      for (const heading of Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 60)) {
        const text = clean(heading.textContent);
        if (text) outline.push({ level: Number(heading.tagName[1]), text: text.slice(0, 140) });
      }

      // --- links ----------------------------------------------------------
      const links = [];
      for (const anchor of Array.from(document.querySelectorAll('a[href]')).slice(0, 500)) {
        let absolute;
        try {
          absolute = new URL(anchor.getAttribute('href'), location.href);
        } catch (error) {
          continue;
        }
        if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') continue;
        links.push({
          url: absolute.toString(),
          host: absolute.host,
          rel: clean(anchor.getAttribute('rel')).toLowerCase()
        });
      }

      // --- product data ---------------------------------------------------
      // Read from the page's own structured data. Inferring a price from prose
      // risks showing a number the page does not, which on a checkout screen is
      // the worst kind of bug.
      let productName = null;
      let price = null;
      let availability = null;

      for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 20)) {
        let data;
        try {
          data = JSON.parse(script.textContent || 'null');
        } catch (error) {
          continue;
        }
        const candidates = Array.isArray(data) ? data : [data, ...(data && data['@graph'] ? data['@graph'] : [])];
        for (const entry of candidates) {
          if (!entry || typeof entry !== 'object') continue;
          const type = entry['@type'];
          const isProduct = type === 'Product' || (Array.isArray(type) && type.includes('Product'));
          if (!isProduct) continue;
          productName = productName || clean(entry.name) || null;
          const offers = Array.isArray(entry.offers) ? entry.offers[0] : entry.offers;
          if (offers && typeof offers === 'object') {
            if (offers.price !== undefined && price === null) {
              const currency = clean(offers.priceCurrency);
              price = (currency ? currency + ' ' : '') + clean(String(offers.price));
            }
            if (offers.availability && availability === null) {
              availability = clean(String(offers.availability)).split('/').pop();
            }
          }
        }
      }

      // Microdata and Open Graph as fallbacks, still the page's own declarations.
      if (price === null) {
        const metaPrice = attr('meta[property="product:price:amount"]', 'content');
        const metaCurrency = attr('meta[property="product:price:currency"]', 'content');
        if (metaPrice) price = (metaCurrency ? metaCurrency + ' ' : '') + metaPrice;
      }
      if (price === null) {
        const itemprop = document.querySelector('[itemprop="price"]');
        if (itemprop) price = clean(itemprop.getAttribute('content') || itemprop.textContent);
      }
      if (productName === null) {
        productName = attr('meta[property="og:title"]', 'content') || null;
      }

      // --- text -----------------------------------------------------------
      const main = document.querySelector('main, article, [role="main"]') || document.body;
      const visibleText = clean(main.innerText).slice(0, 40000);
      const wordCount = visibleText ? visibleText.split(' ').length : 0;

      const declaredSummary =
        attr('meta[name="description"]', 'content') ||
        attr('meta[property="og:description"]', 'content');

      return {
        url: location.href,
        title: clean(document.title),
        siteName: attr('meta[property="og:site_name"]', 'content') || null,
        declaredSummary: declaredSummary || null,
        // The opening of the page, used only when it publishes no description.
        opening: visibleText.slice(0, 400),
        wordCount,
        outline,
        links,
        visibleText,
        product: { productName, price, availability },
        // Whether the page looks like a product page at all.
        looksLikeProduct:
          productName !== null &&
          (price !== null || /"@type"\\s*:\\s*"Product"/.test(document.documentElement.innerHTML.slice(0, 200000)))
      };
    } catch (error) {
      return null;
    }
  })()`
}
