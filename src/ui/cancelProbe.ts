/**
 * #185 cancel probe — THROWAWAY BRANCH, never merged.
 *
 * Hypothesis under test, read out of Apple's shipped bundle: MapKit's pan
 * recognizer has an EMPTY `touchesCancelled`, and `enterCancelledState()` is
 * reachable from nowhere but the `enabled` setter. So when iOS steals a touch
 * that began on the map, the recognizer stays armed with an empty touch list,
 * `locationInElement()` divides by zero, and `Camera.translate()` writes NaN
 * into `camera.center` through an unvalidated `Object.create(MapPoint)`.
 *
 * The device repro (Reachability, then the app switcher) is a way of putting a
 * system gesture on top of the map. A simulator cannot do Reachability, but any
 * screen-edge gesture steals a touch the same way, so that is what this probe
 * measures: the pointer stream, and whether `map.center` still reads.
 *
 * Paints its state so a screenshot is enough, and latches the first poisoning
 * into localStorage so the verdict survives a terminate.
 */

const VERDICT_KEY = "wingover.cancel.verdict";
const TRAIL = 60;

interface Step {
  t: number;
  type: string;
  x: number;
  y: number;
  target: string;
}

const trail: Step[] = [];
// Both families: MapKit's gesture layer may be on touch events, in which case
// WebKit's `touchcancel` is the signal and the pointer counters read zero while
// the theft is happening in plain sight.
const counts: Record<string, number> = {
  pointerdown: 0,
  pointermove: 0,
  pointercancel: 0,
  pointerup: 0,
  touchstart: 0,
  touchmove: 0,
  touchend: 0,
  touchcancel: 0,
};

/** The last cancel seen, whichever family it came from. */
let lastCancel: string = "-";
/**
 * Moves in the CURRENT touch. A cancel that arrives after two moves cancels a
 * gesture MapKit's pan recognizer never began, which is a different experiment
 * from cancelling a pan in flight.
 */
let movesThisTouch = 0;

/** A touch event carries its point in `changedTouches`; a pointer event does not. */
function pointOf(event: Event): { x: number; y: number } {
  const touch = (event as TouchEvent).changedTouches?.[0];
  const source = touch ?? (event as PointerEvent);
  return { x: Math.round(source.clientX ?? 0), y: Math.round(source.clientY ?? 0) };
}

/** Live maps, pushed by the mapkit adapter (this branch only). */
function maps(): Set<{ center: unknown }> {
  const w = window as unknown as Record<string, unknown>;
  w.__wingoverMaps ??= new Set();
  return w.__wingoverMaps as Set<{ center: unknown }>;
}

interface Health {
  ok: number;
  dead: number;
  error: string | null;
  /** The last readable centre, so a drill can see whether a pan ENGAGED. */
  centre: string;
}

function health(): Health {
  let ok = 0;
  let dead = 0;
  let error: string | null = null;
  let centre = "-";
  for (const map of maps()) {
    try {
      const c = map.center as { latitude: number; longitude: number };
      centre = `${c.latitude.toFixed(3)},${c.longitude.toFixed(3)}`;
      ok++;
    } catch (e) {
      dead++;
      error ??= String(e);
    }
  }
  return { ok, dead, error, centre };
}

let latched = false;

function latch(state: ReturnType<typeof health>) {
  if (latched) return;
  latched = true;
  const verdict = {
    at: new Date().toISOString(),
    error: state.error,
    counts: { ...counts },
    trail: trail.slice(),
  };
  try {
    localStorage.setItem(VERDICT_KEY, JSON.stringify(verdict));
  } catch {
    // Quota or no store. The painted line below is still the signal.
  }
  console.error("WINGOVER-CANCEL", JSON.stringify(verdict));
}

function line(state: ReturnType<typeof health>): string {
  const c = counts;
  const status = state.dead > 0 ? "POISONED" : "OK";
  return [
    `PROBE p${c.pointerdown}/${c.pointermove}/${c.pointercancel}/${c.pointerup}`,
    `t${c.touchstart}/${c.touchmove}/${c.touchend}/${c.touchcancel}`,
    `x${lastCancel}`,
    `@${state.centre}`,
    `maps${state.ok + state.dead}`,
    status,
  ].join(" ");
}

/**
 * A real mapkit.Map docked to the BOTTOM EDGE of the screen.
 *
 * The device repro needs Reachability only to slide the app down so that the
 * swipe which ends it — from the bottom of the screen, over the app — begins on
 * the map instead of the tab bar. Owner-confirmed: end Reachability with the
 * close button, or with a swipe in the empty half ABOVE the app, and it never
 * reproduces.
 *
 * A simulator cannot slide the app, but it can put a map where the slide would
 * have put one. The bottom edge is also the one place a system gesture is
 * MEASURED to deliver `touchcancel` to this webview (the sweep: top-edge
 * gestures deliver nothing at all). So this is the mechanism with the ceremony
 * removed.
 */
async function dockMapAtBottomEdge() {
  const { loadMapKit } = await import("./map/mapkit/loader");
  await loadMapKit();
  const host = document.createElement("div");
  host.setAttribute("data-docked-map", "");
  host.style.cssText =
    "position:fixed;left:0;right:0;bottom:0;height:280px;z-index:2147483646";
  document.body.append(host);
  const map = new mapkit.Map(host, {
    center: new mapkit.Coordinate(39.8, -98.5),
    showsCompass: mapkit.FeatureVisibility.Hidden,
    showsScale: mapkit.FeatureVisibility.Hidden,
    showsZoomControl: false,
    showsMapTypeControl: false,
  });
  maps().add(map);
}

export function installCancelProbe() {
  const banner = document.createElement("div");
  banner.setAttribute("data-cancel-probe", "");
  // Never intercepts: the whole point is to watch real touches reach the map.
  banner.style.cssText = [
    "position:fixed",
    "left:0",
    "right:0",
    "top:64px",
    "z-index:2147483647",
    "pointer-events:none",
    "font:700 15px ui-monospace,monospace",
    "padding:4px 6px",
    "background:#000",
    "color:#0f0",
    "white-space:pre-wrap",
  ].join(";");
  document.body.append(banner);

  for (const type of Object.keys(counts)) {
    window.addEventListener(
      type,
      (event) => {
        counts[type]!++;
        const point = pointOf(event);
        const target = event.target as Element | null;
        const where = target?.className?.toString().slice(0, 24) ?? "?";
        if (type === "touchstart" || type === "pointerdown") movesThisTouch = 0;
        if (type === "touchmove" || type === "pointermove") movesThisTouch++;
        if (type.endsWith("cancel")) {
          lastCancel = `${type[0]}@${point.x},${point.y}:${where}/mv${movesThisTouch}`;
        }
        trail.push({
          t: Math.round(performance.now()),
          type,
          x: point.x,
          y: point.y,
          target: where,
        });
        if (trail.length > TRAIL) trail.shift();
      },
      { capture: true, passive: true },
    );
  }

  setInterval(() => {
    const state = health();
    if (state.dead > 0) latch(state);
    banner.textContent = latched ? `${line(state)} LATCHED` : line(state);
  }, 200);

  void dockMapAtBottomEdge().catch((error) => {
    console.error("WINGOVER-CANCEL dock failed", String(error));
  });

  // Whatever the previous run latched, surfaced on this one.
  try {
    const saved = localStorage.getItem(VERDICT_KEY);
    if (saved) console.error("WINGOVER-CANCEL previous:", saved);
  } catch {
    // No store; nothing to surface.
  }
}
