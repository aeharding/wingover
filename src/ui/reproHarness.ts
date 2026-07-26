/**
 * #185 reproduction harness — THROWAWAY BRANCH, never merge.
 *
 * Hypothesis under test: the Plan map dies because a padding write and a
 * container RESIZE land in the same frame while `updateVisibleMapRect: false`
 * suppresses the reconciliation between them. Plan is the only map whose
 * height tracks a safe-area inset (ion-tab-bar is content-box with
 * padding-bottom: var(--ion-safe-area-bottom) and a pinned 64px height), and
 * its subtree zeroes that same inset so the padding probe never sees it.
 *
 * Runs with no console, no touch and no inspector: it paints the verdict as a
 * full-screen colour so `xcrun simctl io <udid> screenshot` can read it.
 *   GREEN  = survived
 *   RED    = POISONED (reproduced)
 *   YELLOW = could not run (no mapkit, no private impl)
 */

const TOP_INSET = 50;
// The tab-bar delta: 64px pinned height + a 34px home-indicator inset.
const TALL = 748;
const SHORT = 714;
const CYCLES = 20;

type Verdict = "survived" | "POISONED" | "cannot-run";

function paint(verdict: Verdict, detail: string) {
  const colour =
    verdict === "POISONED"
      ? "#c00"
      : verdict === "survived"
        ? "#080"
        : "#cc0";
  const el = document.createElement("div");
  el.style.cssText = `position:fixed;inset:0;z-index:2147483647;background:${colour};color:#fff;font:700 22px/1.3 system-ui;padding:80px 24px;white-space:pre-wrap`;
  el.textContent = `${verdict}\n\n${detail}`;
  document.body.appendChild(el);
  // Also on the title, for any readout that can see it.
  document.title = `REPRO:${verdict}`;
}

function grabImpl(map: unknown): { setPadding?: unknown } | null {
  const proto = Object.getPrototypeOf(map) as { _?: (k: unknown) => unknown };
  const accessor = proto._;
  if (typeof accessor !== "function") return null;
  let key: unknown;
  proto._ = function (this: unknown, k: unknown) {
    key = k;
    return accessor.call(this, k);
  };
  try {
    void (map as { center: unknown }).center;
  } finally {
    proto._ = accessor;
  }
  try {
    return key !== undefined
      ? ((accessor.call(map, key) ?? null) as { setPadding?: unknown })
      : null;
  } catch {
    return null;
  }
}

const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

/**
 * @param skipRectUpdate the arm under test. false is the control.
 */
async function run(skipRectUpdate: boolean): Promise<string> {
  const mapkit = (window as unknown as { mapkit?: Record<string, unknown> })
    .mapkit;
  if (!mapkit) return "no mapkit";

  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:0;top:0;width:375px;height:${SHORT}px;visibility:hidden`;
  document.body.appendChild(host);

  const Map_ = mapkit.Map as new (el: HTMLElement, o?: unknown) => unknown;
  const Coordinate = mapkit.Coordinate as new (a: number, b: number) => unknown;
  const Padding = mapkit.Padding as new (
    a: number,
    b: number,
    c: number,
    d: number,
  ) => unknown;

  // Same construction options the app uses — a bare map is not the app's map.
  const map = new Map_(host, {
    isRotationEnabled: true,
    center: new Coordinate(39.8, -98.5),
  });
  await new Promise((r) => setTimeout(r, 1200));

  const impl = grabImpl(map);
  if (!impl?.setPadding) {
    host.remove();
    return "no private impl";
  }
  const setPadding = impl.setPadding as (p: unknown, o: unknown) => void;

  for (let i = 0; i < CYCLES; i++) {
    const on = i % 2 === 0;
    // The two events Reachability delivers together, in one frame.
    setPadding(new Padding(on ? TOP_INSET : 0, 0, 0, 0), {
      updateVisibleMapRect: !skipRectUpdate,
    });
    host.style.height = `${on ? TALL : SHORT}px`;
    await frame();
    await frame();
    try {
      void (map as { center: { latitude: number } }).center;
    } catch (error) {
      host.remove();
      return `POISONED on cycle ${i}: ${String(error).slice(0, 90)}`;
    }
  }
  host.remove();
  return `survived ${CYCLES} cycles`;
}

export async function runReproHarness() {
  try {
    const skip = await run(true); // the app's arm
    const control = await run(false); // rect refresh allowed
    const poisoned = skip.startsWith("POISONED");
    paint(
      poisoned ? "POISONED" : skip.includes("no ") ? "cannot-run" : "survived",
      `skipRectUpdate:\n  ${skip}\n\ncontrol (rect refreshed):\n  ${control}`,
    );
  } catch (error) {
    paint("cannot-run", String(error).slice(0, 200));
  }
}
