/**
 * Crash diagnostics for #185 — DIAGNOSTIC BRANCH, not for merge.
 *
 * The black screen is an uncaught MapKit TypeError unmounting React. The page
 * survives, so the console still holds the evidence — but only if someone is
 * attached when it happens. This records enough state to diagnose it from a
 * console attached AFTERWARDS, or from the next launch.
 *
 * Three properties it must have, because the crash is what it is watching:
 *  - React-free and module-scoped, so an unmounted tree cannot take it down.
 *  - Never throws. Every reader is wrapped; a diagnostic that crashes while
 *    reporting a crash is worse than none.
 *  - Persisted before anything else, so a force-quit does not lose the report.
 */

const RING = 120;
const STORE_KEY = "wingover.diag.lastCrash";

interface Crumb {
  t: number;
  tag: string;
  data?: unknown;
}

const crumbs: Crumb[] = [];
const probes = new Map<string, () => unknown>();

export function breadcrumb(tag: string, data?: unknown) {
  crumbs.push({ t: Math.round(performance.now()), tag, data });
  if (crumbs.length > RING) crumbs.shift();
}

/**
 * A named state reader, called only when a report is built. The map adapters
 * register these so diag never has to know what a MapKit rect is — and so a
 * reader that throws (which is the whole bug) is caught here rather than
 * adding a second crash on top of the first.
 */
export function registerDiagProbe(name: string, read: () => unknown) {
  probes.set(name, read);
  return () => probes.delete(name);
}

function safely(read: () => unknown): unknown {
  try {
    return read();
  } catch (error) {
    return { threw: String(error) };
  }
}

function element(selector: string): unknown {
  return safely(() => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      clientWidth: (el as HTMLElement).clientWidth,
      clientHeight: (el as HTMLElement).clientHeight,
      rect: [rect.x, rect.y, rect.width, rect.height].map(Math.round),
      offsetParent: (el as HTMLElement).offsetParent !== null,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
    };
  });
}

function snapshot(): Record<string, unknown> {
  const readings: Record<string, unknown> = {};
  for (const [name, read] of probes) readings[name] = safely(read);
  return {
    at: new Date().toISOString(),
    since: Math.round(performance.now()),
    visibility: safely(() => document.visibilityState),
    hidden: safely(() => document.hidden),
    viewport: safely(() => [window.innerWidth, window.innerHeight]),
    dpr: safely(() => window.devicePixelRatio),
    url: safely(() => location.href),
    rootChildren: safely(
      () => document.getElementById("root")?.childElementCount,
    ),
    mapContainer: element('[data-testid="map-container"]'),
    mkMapView: element(".mk-map-view"),
    probes: readings,
  };
}

function report(kind: string, error: unknown, extra?: unknown) {
  const payload = {
    kind,
    message: safely(() => String((error as Error)?.message ?? error)),
    stack: safely(() => (error as Error)?.stack),
    extra,
    snapshot: snapshot(),
    crumbs: crumbs.slice(),
  };
  // Persisted FIRST: a force-quit before anyone attaches must not lose it.
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(payload));
  } catch {
    // Quota or a disabled store; the console copy below still stands.
  }
  console.error("WINGOVER-DIAG", JSON.stringify(payload, null, 2));
  return payload;
}

/**
 * Dump on demand from an attached console: `__wingoverDiag()`.
 * `__wingoverDiag(true)` re-prints the crash saved from a previous launch.
 */
function expose() {
  (window as unknown as Record<string, unknown>).__wingoverDiag = (
    previous?: boolean,
  ) => {
    if (previous) return safely(() => localStorage.getItem(STORE_KEY));
    return { snapshot: snapshot(), crumbs: crumbs.slice() };
  };
}

export function installDiagnostics() {
  expose();

  // The crash from a previous launch, surfaced loudly on this one — the whole
  // point being that nobody has to be attached at the moment it happens.
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved) {
      console.error("WINGOVER-DIAG previous crash:", saved);
      localStorage.removeItem(STORE_KEY);
    }
  } catch {
    // Nothing saved, or no store. Not worth reporting.
  }

  window.addEventListener("error", (event) => {
    report("error", event.error ?? event.message, {
      source: `${event.filename}:${event.lineno}:${event.colno}`,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    report("unhandledrejection", event.reason);
  });

  // React reports render/commit errors through console.error rather than
  // throwing to the window, so this is the only way to catch the one that
  // actually unmounts the tree. Recorded, never suppressed.
  const realError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const first = String(args[0] ?? "");
    if (!first.startsWith("WINGOVER-DIAG")) {
      breadcrumb("console.error", first.slice(0, 300));
    }
    realError(...(args as []));
  };

  for (const type of [
    "visibilitychange",
    "pagehide",
    "pageshow",
    "freeze",
    "resume",
  ]) {
    window.addEventListener(type, () =>
      breadcrumb(
        type,
        safely(() => document.visibilityState),
      ),
    );
  }
  window.addEventListener("resize", () =>
    breadcrumb(
      "resize",
      safely(() => [window.innerWidth, window.innerHeight]),
    ),
  );

  breadcrumb("boot");
}
