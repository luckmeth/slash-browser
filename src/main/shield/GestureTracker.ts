/**
 * When each tab was last genuinely touched by the user.
 *
 * Both guards need this and neither owns it: the popup guard asks "did a click
 * cause this window?", the redirect guard asks "did a click cause this jump?".
 * Keeping it in one place means there is one answer to "was this the user?"
 * rather than two that can disagree.
 *
 * The timestamp is taken **here**, when the message arrives, never from the
 * page — a renderer does not get to claim when it was clicked. The content
 * preload reports only that a trusted event happened; see `preload/content.ts`.
 */
export class GestureTracker {
  private readonly last = new Map<number, { at: number; spent: number }>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  note(webContentsId: number): void {
    this.last.set(webContentsId, { at: this.now(), spent: 0 })
  }

  /** Milliseconds since the last trusted gesture, or null if there has been none. */
  msSince(webContentsId: number): number | null {
    const entry = this.last.get(webContentsId)
    return entry ? this.now() - entry.at : null
  }

  /**
   * How many windows have already been opened against the current gesture.
   *
   * One click should produce one window. This is what lets the second window
   * from a single click be recognised as the pop-under it usually is.
   */
  spentFor(webContentsId: number): number {
    return this.last.get(webContentsId)?.spent ?? 0
  }

  spend(webContentsId: number): void {
    const entry = this.last.get(webContentsId)
    if (entry) entry.spent += 1
  }

  forget(webContentsId: number): void {
    this.last.delete(webContentsId)
  }
}
