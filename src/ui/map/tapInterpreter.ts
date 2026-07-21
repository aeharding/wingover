/**
 * Classifies raw map-backend events into ONE gesture: the deliberate lone
 * tap. Shared by every adapter so the semantics (and their tests) can't
 * drift between backends. Everything here exists because the naive readings
 * are wrong in the field:
 *
 *  - A tap that lands while the map is coasting means "stop the inertia",
 *    not a tap. The backend processes that touch natively FIRST — the
 *    stop's scroll/move-end fires before the DOM down reaches us (measured
 *    on MapKit: same millisecond, that order) — so "stopped a scroll" is
 *    scroll-active OR scroll-end-an-instant-ago.
 *  - The tap AFTER a stop-tap is a real tap. Suppression must end the
 *    moment a clean down arrives, not on a timer alone.
 *  - Touch double-taps produce NO DOM dblclick on iOS WebKit, and
 *    MapLibre's zoom handler eats the second tap's click (preventDefault on
 *    its touchend). The only reliable double-tap tell at this layer is a
 *    second DOWN while a tap is still pending delivery.
 *
 * Pure and clock-injectable so the whole matrix is unit-testable.
 *
 * SCOPE: this machinery mounts with an `on("singletap")` subscription — the
 * flight-detail (logbook) page is the only subscriber, so other maps (Fly,
 * Plan) never get their touches intercepted. Keep it that way: a page that
 * subscribes to singletap is opting into stop-tap consumption too.
 */

export interface TapInterpreterOptions {
  /** Hold each tap this long before delivering, so a second tap (touch
   * double-tap → zoom) can cancel it. 0 for backends that disambiguate
   * natively (MapKit's single-tap). */
  deliverDelayMs: number;
  /** A down this soon after a scroll/move end is the touch that CAUSED the
   * end (native processing beats DOM dispatch — measured same-millisecond;
   * the margin stays small so a legit tap right after a pan-lift is NOT
   * mistaken for a stop-tap). */
  stopCorrelationMs?: number;
  /** Taps delivered within this window of a stop-tap are the stop-tap's own
   * echo — swallowed. Cleared early by the next clean down. */
  stopSwallowMs?: number;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => number;
  clearTimeout?: (id: number) => void;
  /** The one output: a deliberate, lone tap. */
  onTap: () => void;
}

export interface TapInterpreter {
  /** Backend reports scrolling/moving began (including inertia). */
  scrollStart(): void;
  /** Backend reports scrolling/moving ended (including inertia). */
  scrollEnd(): void;
  /**
   * A pointer/touch went down. A down that stopped a scroll arms the
   * suppression window; the touch itself must still flow to the map
   * library untouched (a consuming variant shipped briefly and made the
   * map untouchable during inertia).
   */
  down(): void;
  /** Backend reports a tap/click (its own recognizer's output). */
  tap(): void;
  /** Backend reports a double-tap/dblclick: cancel any pending delivery. */
  doubleTap(): void;
  dispose(): void;
}

export function createTapInterpreter(
  options: TapInterpreterOptions,
): TapInterpreter {
  const {
    deliverDelayMs,
    stopCorrelationMs = 50,
    stopSwallowMs = 700,
    now = () => performance.now(),
    setTimeout: schedule = (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: cancel = (id) => window.clearTimeout(id),
    onTap,
  } = options;

  let scrolling = false;
  let lastScrollEndAt = -Infinity;
  /** End of the current stop-tap suppression window; 0 when none. */
  let suppressUntil = 0;
  let pending: number | null = null;

  const cancelPending = () => {
    if (pending !== null) {
      cancel(pending);
      pending = null;
    }
  };

  return {
    scrollStart() {
      scrolling = true;
      // Scrolling began: any tap still held for delivery was actually the
      // start of a pan/pinch — never a lone tap.
      cancelPending();
    },
    scrollEnd() {
      scrolling = false;
      lastScrollEndAt = now();
    },
    down() {
      const at = now();
      // A second down while a tap is pending delivery = double-tap in
      // progress (the only reliable tell for touch — see header).
      cancelPending();
      if (scrolling || at - lastScrollEndAt < stopCorrelationMs) {
        suppressUntil = at + stopSwallowMs;
        return;
      }
      // A clean down begins a real gesture: whatever tap it produces must
      // deliver, even right after a stop-tap.
      suppressUntil = 0;
    },
    tap() {
      if (now() < suppressUntil) return;
      cancelPending();
      if (deliverDelayMs === 0) {
        onTap();
        return;
      }
      pending = schedule(() => {
        pending = null;
        // Defense only: with current call graphs a raised suppressUntil
        // always cancels the pending first (down() cancels before arming),
        // so this cannot fire today — kept as a cheap invariant.
        if (now() < suppressUntil) return;
        onTap();
      }, deliverDelayMs);
    },
    doubleTap() {
      cancelPending();
    },
    dispose() {
      cancelPending();
    },
  };
}
