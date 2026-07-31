/**
 * The one-automatic-heal-per-window budget, shared by every sanctioned
 * automatic reload (AppBoundary's crash heal, idbHeal's severed-storage
 * heal). Each failure class keys its own stamp: a crash heal must not
 * spend the storage heal's budget.
 *
 * The marker is PERSISTED, not held in a variable: the reload destroys
 * every value in the page, so an in-memory counter cannot enforce "once
 * per window" and the result is an unbounded reload loop.
 */
const HEAL_WINDOW_MS = 60_000;

/** The entire window policy, pure so it tests without a DOM or a reload. */
export function mayHeal(now: number, healedAt: number | null): boolean {
  if (healedAt === null) return true;
  return now - healedAt >= HEAL_WINDOW_MS;
}

/**
 * Takes one heal from the keyed budget, or refuses.
 *
 * Claiming means WRITING the marker, not just reading it, and the caller's
 * reload must be conditional on that write. An earlier version reloaded
 * even when the write threw, reasoning that nothing was on screen to fall
 * back to. On a full disk — `setItem` throws, `getItem` keeps returning
 * null — that never enforces the window: measured at 101 navigations in
 * 12 seconds, a hard reload every 90 ms during an active recording. A
 * broken screen is always better than that.
 */
export function takeHeal(key: string): boolean {
  try {
    const raw = localStorage.getItem(key);
    const at = raw === null ? null : Number(raw);
    if (!mayHeal(Date.now(), at !== null && Number.isFinite(at) ? at : null)) {
      return false;
    }
    // Written BEFORE the reload, or the next failure cannot see it.
    localStorage.setItem(key, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}
