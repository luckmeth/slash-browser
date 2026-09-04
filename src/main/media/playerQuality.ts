/**
 * YouTube's own quality identifiers, worst to best.
 *
 * These are the strings its player uses and returns from
 * `getAvailableQualityLevels()`. Ordered here so a list can be sorted without
 * every caller knowing that `large` is 480p and `tiny` is 144p.
 */
const QUALITY_ORDER = [
  'tiny',
  'small',
  'medium',
  'large',
  'hd720',
  'hd1080',
  'hd1440',
  'hd2160',
  'highres'
] as const

const QUALITY_LABELS: Record<string, string> = {
  tiny: '144p',
  small: '240p',
  medium: '360p',
  large: '480p',
  hd720: '720p',
  hd1080: '1080p',
  hd1440: '1440p',
  hd2160: '2160p',
  highres: 'Highest'
}

export interface PlayerQuality {
  /** The identifier to hand back to the player. */
  readonly level: string
  /** What to show a person. */
  readonly label: string
  readonly current: boolean
}

/**
 * The qualities a player says it can switch to, best first.
 *
 * `auto` is dropped: it is a policy, not a quality, and selecting it would
 * leave the player free to fetch something other than what was asked for —
 * which is the whole problem this exists to solve.
 *
 * Unknown identifiers are kept rather than discarded. YouTube adding a tier
 * should show up as an option with its raw name, not vanish from the list.
 */
export function playerQualities(levels: readonly string[], current: string): PlayerQuality[] {
  return levels
    .filter((level) => level !== 'auto' && level !== '')
    .map((level) => ({
      level,
      label: QUALITY_LABELS[level] ?? level,
      current: level === current
    }))
    .sort((a, b) => rank(b.level) - rank(a.level))
}

function rank(level: string): number {
  const at = QUALITY_ORDER.indexOf(level as (typeof QUALITY_ORDER)[number])
  // Unknown tiers sort above everything known: a name we do not recognise is
  // more likely to be new and better than old and worse.
  return at === -1 ? QUALITY_ORDER.length : at
}

/**
 * Reads what the page's player offers.
 *
 * Evaluated in the page's own world, so — per the rule in CLAUDE.md — it is a
 * string of code with its own test rather than something only a live page can
 * check. Every property access is guarded: a missing player, a player that has
 * not finished initialising, and a player whose API has been renamed all have
 * to produce a shaped answer rather than a thrown error nobody sees.
 */
export const READ_QUALITIES_SCRIPT = `(() => {
  try {
    var p = document.querySelector('#movie_player');
    if (!p || typeof p.getAvailableQualityLevels !== 'function') {
      return { ok: false, levels: [], current: '', reason: 'no player' };
    }
    var levels = p.getAvailableQualityLevels() || [];
    var current = typeof p.getPlaybackQuality === 'function' ? p.getPlaybackQuality() : '';
    return {
      ok: true,
      levels: Array.prototype.slice.call(levels),
      current: String(current || ''),
      canSet: typeof p.setPlaybackQualityRange === 'function'
    };
  } catch (e) {
    return { ok: false, levels: [], current: '', reason: String(e) };
  }
})()`

/**
 * Asks the player to switch, using the call its own quality menu makes.
 *
 * Nothing is worked around here: this is the site's public player API, and the
 * effect is identical to choosing the quality by hand. It is a visible change
 * to what the person is watching, which is why it only ever runs from an
 * explicit choice in the picker and never on its own.
 *
 * `setPlaybackQualityRange` is the one that sticks — `setPlaybackQuality` alone
 * is advisory and the player's own adaptation overrides it within seconds.
 * Both are called because older players only have the second.
 */
export function requestQualityScript(level: string): string {
  // The level comes from `getAvailableQualityLevels`, but it crosses an IPC
  // boundary before it comes back here, so it is quoted rather than trusted:
  // this string is evaluated as code in the page.
  const quoted = JSON.stringify(String(level))
  return `(() => {
  try {
    var p = document.querySelector('#movie_player');
    if (!p) return { ok: false, reason: 'no player' };
    var level = ${quoted};
    if (typeof p.setPlaybackQualityRange === 'function') p.setPlaybackQualityRange(level, level);
    if (typeof p.setPlaybackQuality === 'function') p.setPlaybackQuality(level);
    return {
      ok: true,
      now: typeof p.getPlaybackQuality === 'function' ? p.getPlaybackQuality() : ''
    };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
})()`
}
