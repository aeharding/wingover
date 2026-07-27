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
const counts: Record<string, number> = {
  pointerdown: 0,
  pointermove: 0,
  pointercancel: 0,
  pointerup: 0,
};

/** Live maps, pushed by the mapkit adapter (this branch only). */
function maps(): Set<{ center: unknown }> {
  const w = window as unknown as Record<string, unknown>;
  w.__wingoverMaps ??= new Set();
  return w.__wingoverMaps as Set<{ center: unknown }>;
}

function health(): { ok: number; dead: number; error: string | null } {
  let ok = 0;
  let dead = 0;
  let error: string | null = null;
  for (const map of maps()) {
    try {
      void map.center;
      ok++;
    } catch (e) {
      dead++;
      error ??= String(e);
    }
  }
  return { ok, dead, error };
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
  return `PROBE d${c.pointerdown} m${c.pointermove} c${c.pointercancel} u${c.pointerup} maps${state.ok + state.dead} ${status}`;
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
        const pe = event as PointerEvent;
        const target = event.target as Element | null;
        trail.push({
          t: Math.round(performance.now()),
          type,
          x: Math.round(pe.clientX),
          y: Math.round(pe.clientY),
          target: target?.className?.toString().slice(0, 24) ?? "?",
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

  // Whatever the previous run latched, surfaced on this one.
  try {
    const saved = localStorage.getItem(VERDICT_KEY);
    if (saved) console.error("WINGOVER-CANCEL previous:", saved);
  } catch {
    // No store; nothing to surface.
  }
}
