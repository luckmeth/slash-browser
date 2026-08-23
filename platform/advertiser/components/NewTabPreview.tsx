import { BrandMark } from './BrandMark'

/**
 * A scale model of the Slash start page, with an advert in it.
 *
 * The most persuasive thing this site can do is show the product. A page that
 * describes a placement in prose is asking a buyer to imagine it; one that
 * draws it lets them see the thing they would be paying for, including how
 * prominent it is and how it is labelled.
 *
 * Built in markup rather than shipped as a screenshot for two reasons: a
 * screenshot goes stale the first time the browser's start page changes, and it
 * cannot be re-rendered live with the advertiser's own headline and image while
 * they type them into the campaign form.
 */
export function NewTabPreview({
  headline = 'Your headline, on every new tab',
  body = 'A supporting line in your own words.',
  sponsor = 'Your company',
  image = null,
  chromeless = false
}: {
  headline?: string
  body?: string
  sponsor?: string
  /** A data: or blob: URL. Absent, a neutral gradient stands in. */
  image?: string | null
  /** Drop the fake window frame, for use inside a form. */
  chromeless?: boolean
}): React.JSX.Element {
  return (
    <div className={chromeless ? 'preview-shell chromeless' : 'preview-shell'}>
      {!chromeless && (
        <div className="preview-titlebar">
          <span className="preview-tab active">New tab</span>
          <span className="preview-tab">Docs</span>
          <span className="preview-tab">Mail</span>
        </div>
      )}

      <div className="preview-body">
        {/* The advertiser's image, or a stand-in that is obviously a stand-in. */}
        <div
          className="preview-backdrop"
          style={
            image
              ? { backgroundImage: `url(${image})` }
              : {
                  background:
                    'radial-gradient(60% 80% at 20% 0%, rgba(94,234,212,0.22), transparent 60%),' +
                    'radial-gradient(55% 70% at 85% 10%, rgba(129,140,248,0.26), transparent 62%),' +
                    'radial-gradient(50% 60% at 50% 100%, rgba(56,189,248,0.18), transparent 65%),' +
                    '#0d0f14'
                }
          }
        />
        {/* The scrim the browser applies, so what is shown here is what runs. */}
        <div className="preview-scrim" />

        <div className="preview-content">
          <BrandMark size={26} />
          <p className="preview-greeting">Good afternoon</p>
          <div className="preview-omnibox">Search or enter address</div>
          <div className="preview-stats">
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>

        {/* The advert. Exactly the shape the browser draws. */}
        <div className="preview-ad">
          <span className="preview-ad-label">Sponsored</span>
          <span className="preview-ad-sponsor">{sponsor}</span>
          <span className="preview-ad-headline">{headline}</span>
          {body !== '' && <span className="preview-ad-body">{body}</span>}
        </div>
      </div>
    </div>
  )
}
