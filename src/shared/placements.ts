import type { PLACEMENTS } from './types/sponsor'

export type PlacementShape = (typeof PLACEMENTS)[number]

/**
 * Which shape on the page a sale tier lands in.
 *
 * There are two vocabularies here and nothing bridged them. The database and the
 * advertiser portal talk in **sale tiers** — `newtab_background`,
 * `newtab_feature`, `home_banner` — because that is what somebody buys. The
 * browser talks in **shapes** — `background`, `banner`, `tile`, `rail`,
 * `notice` — because that is what it draws. The composer's select emits the
 * first; `PlacementPreview` and every sponsored component take the second.
 *
 * Without this, a booking form cannot show somebody what they are buying.
 *
 * **Deliberately a copy** of `placementFor` in `platform/shared/src/batch.ts`,
 * not an import: the platform is a separate codebase with its own build, and
 * the browser must be able to read a batch without it. The same reasoning
 * already applies to `acceptCreative`. The copy is kept honest by a test that
 * pins both to the same table rather than by anybody remembering.
 *
 * `default: 'tile'` matches the server exactly, including for an unknown tier —
 * a creative the browser cannot place is better rendered as a tile than
 * dropped, because the advertiser has already been charged for it.
 */
export function placementShapeFor(tier: string): PlacementShape {
  switch (tier) {
    case 'newtab_background':
      return 'background'
    case 'newtab_banner':
      return 'banner'
    case 'browser_notice':
      return 'notice'
    default:
      return 'tile'
  }
}
