import { DOWNLOADABLE_MEDIA_EXTENSIONS } from '@shared/types/downloadGuardian'

/**
 * The script injected to inventory a page's download links and media.
 *
 * Runs in the page's isolated world, reads the DOM, returns plain data. It makes
 * no decisions — classification happens in main against `linkAnalysis.ts`, where
 * it is testable and where the page cannot influence it.
 *
 * Injected on demand rather than living in the content preload, for the same
 * reason as the memory extractor: this cost should land on pages the user
 * actually asked about, not on every page load.
 */
export function buildScanScript(): string {
  const extensions = JSON.stringify([...DOWNLOADABLE_MEDIA_EXTENSIONS])

  return `(() => {
    const DOWNLOADABLE = new Set(${extensions});
    const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim();

    /**
     * Whether an element sits inside advertising markup.
     *
     * Structural evidence only — an ancestor iframe, or a class/id naming an ad
     * slot. Deliberately not a guess about the link's content: that judgement
     * belongs in main where it is tested.
     */
    const insideAd = (element) => {
      let node = element;
      let depth = 0;
      while (node && depth < 12) {
        if (node.tagName === 'IFRAME') return true;
        const marker = ((node.className || '') + ' ' + (node.id || '')).toLowerCase();
        if (typeof marker === 'string' && /(^|[-_ ])(ad|ads|advert|advertisement|sponsor|promo|banner|doubleclick|adslot)([-_ ]|$)/.test(marker)) {
          return true;
        }
        node = node.parentElement;
        depth++;
      }
      // An ad in a cross-origin frame is unreachable from here; the frame itself
      // is the signal, which the IFRAME check above catches from inside.
      return window !== window.top;
    };

    const links = [];
    for (const anchor of Array.from(document.querySelectorAll('a[href]')).slice(0, 400)) {
      const href = anchor.getAttribute('href');
      if (!href) continue;
      let absolute;
      try {
        absolute = new URL(href, location.href).toString();
      } catch (error) {
        continue;
      }
      links.push({
        url: absolute,
        // The download attribute is an explicit declaration by the page that
        // this link is a file, which is worth carrying across.
        label: clean(anchor.textContent) || clean(anchor.getAttribute('aria-label')) || (anchor.hasAttribute('download') ? 'Download' : ''),
        insideAdMarkup: insideAd(anchor)
      });
    }

    /**
     * Media the page exposes as a plain file.
     *
     * blob: and MediaSource-driven playback are skipped outright, as are
     * adaptive manifests. Reassembling those means working around a platform's
     * technical protections, which this browser does not do — so they are not
     * offered rather than offered and failing.
     */
    const media = [];
    const seen = new Set();
    const addMedia = (rawUrl, kind, element, typeAttr) => {
      if (!rawUrl) return;
      let url;
      try {
        url = new URL(rawUrl, location.href);
      } catch (error) {
        return;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      const key = url.toString();
      if (seen.has(key)) return;

      const match = /\\.([a-z0-9]{1,8})(?=$|[?#])/i.exec(url.pathname);
      const extension = match ? match[1].toLowerCase() : null;
      if (!extension || !DOWNLOADABLE.has(extension)) return;

      seen.add(key);
      media.push({
        url: key,
        kind,
        container: extension,
        resolution:
          element && element.videoWidth ? element.videoWidth + '×' + element.videoHeight : null,
        sizeBytes: null,
        label: clean(element && element.getAttribute('title')) || url.pathname.split('/').pop() || key
      });
    };

    let sawProtectedMedia = false;
    for (const element of Array.from(document.querySelectorAll('video, audio')).slice(0, 40)) {
      const kind = element.tagName.toLowerCase() === 'video' ? 'video' : 'audio';
      const direct = element.currentSrc || element.getAttribute('src') || '';

      // A blob: or MediaSource src means the bytes are assembled by script, and
      // an adaptive manifest means the same. Both are recorded as "not
      // downloadable" rather than skipped silently.
      if (direct.startsWith('blob:') || direct.startsWith('data:')) sawProtectedMedia = true;
      if (/\\.(m3u8|mpd)(?=$|[?#])/i.test(direct)) sawProtectedMedia = true;

      addMedia(direct, kind, element, null);
      for (const source of Array.from(element.querySelectorAll('source'))) {
        const src = source.getAttribute('src') || '';
        if (/\\.(m3u8|mpd)(?=$|[?#])/i.test(src)) sawProtectedMedia = true;
        addMedia(src, kind, element, source.getAttribute('type'));
      }
    }

    return {
      pageUrl: location.href,
      links,
      media,
      sawProtectedMedia,
      mediaElementCount: document.querySelectorAll('video, audio').length
    };
  })()`
}
