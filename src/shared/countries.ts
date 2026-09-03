/**
 * Country codes, for the one place the browser asks somebody where they live.
 *
 * The **codes** are the data — ISO 3166-1 alpha-2, which is what the database
 * column holds and what a payment provider would want. The *names* are not
 * stored anywhere and are not listed here: `Intl.DisplayNames` is in both
 * Chromium and Node, so the label comes from the platform in the user's own
 * language rather than from a table in this repository that would be wrong in
 * every language but one, and stale in that one.
 */

const CODES =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR ' +
  'BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ ' +
  'EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW ' +
  'GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY ' +
  'KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV ' +
  'MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY ' +
  'QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG ' +
  'TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'

export const COUNTRY_CODES: readonly string[] = CODES.split(' ')

/** The country's name, or the code itself where the platform has no name. */
export function countryName(code: string): string {
  const upper = code.trim().toUpperCase()
  if (upper === '') return ''
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' }).of(upper) ?? upper
  } catch {
    // A runtime without the region data, or a code it refuses. The code is a
    // worse label and a correct one.
    return upper
  }
}

/** Every country, sorted by the name actually being shown. */
export function countryOptions(): ReadonlyArray<{ code: string; name: string }> {
  return COUNTRY_CODES.map((code) => ({ code, name: countryName(code) })).sort((a, b) =>
    a.name.localeCompare(b.name)
  )
}
