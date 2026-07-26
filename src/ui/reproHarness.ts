/**
 * #185 reproduction harness — THROWAWAY BRANCH, never merge.
 *
 * Runs itself on boot with no console, no touch and no inspector, and paints
 * the verdict full-screen so `xcrun simctl io <udid> screenshot` reads it.
 *
 * Leading hypothesis (from the MapKit bundle): MapKit JS 6 renders in WebGL
 * and has NO context-loss handling anywhere — zero `webglcontextlost`, zero
 * `isContextLost` across all 39 chunks. When `getContext` fails it runs a
 * silent teardown that removes its canvas and nulls its context but leaves
 * `destroyed = false`, which is exactly the measured contradiction: a map
 * whose rect is NaN while its DOM element is perfectly sized. WebKit caps
 * live WebGL contexts and force-loses the OLDEST — which would explain why
 * the app's map (oldest context) dies while every probe map stays healthy.
 *
 * Experiments, each independent:
 *   A  lose the map's own GL context explicitly (WEBGL_lose_context)
 *   B  exhaust WebGL contexts until WebKit evicts the oldest
 *   C  padding write + container resize in one frame, rect refresh suppressed
 */

import { loadMapKit } from "./map/mapkit/loader";

const CONTEXT_FLOOD = 24;
const CYCLES = 20;

const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function paint(poisoned: boolean, lines: string[]) {
  const el = document.createElement("div");
  el.style.cssText = `position:fixed;inset:0;z-index:2147483647;background:${
    poisoned ? "#c00" : "#060"
  };color:#fff;font:600 12px/1.25 ui-monospace,monospace;padding:60px 8px 8px;white-space:pre-wrap;overflow:hidden`;
  el.textContent = (poisoned ? "REPRODUCED\n\n" : "not reproduced\n\n") + lines.join("\n");
  document.body.appendChild(el);
  document.title = poisoned ? "REPRO:YES" : "REPRO:NO";
}

interface MapLike {
  center: { latitude: number };
  element?: HTMLElement;
  destroy(): void;
}

function health(map: MapLike): string {
  try {
    const c = map.center;
    return `ok ${c.latitude.toFixed(2)}`;
  } catch (error) {
    return `POISONED ${String(error).slice(0, 70)}`;
  }
}

/** MapKit's renderer canvas is the container's aria-hidden first child. */
function canvasState(host: HTMLElement): string {
  const canvas = host.querySelector('canvas[aria-hidden="true"]');
  if (!canvas) return "canvas GONE (silent teardown)";
  const gl =
    (canvas as HTMLCanvasElement).getContext("webgl2") ??
    (canvas as HTMLCanvasElement).getContext("webgl");
  if (!gl) return "canvas present, no GL context";
  return `canvas present, contextLost=${(gl as WebGLRenderingContext).isContextLost()}`;
}

function makeHost(hidden: boolean): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = `position:fixed;left:0;top:0;width:375px;height:714px;${
    hidden ? "visibility:hidden" : ""
  }`;
  document.body.appendChild(el);
  return el;
}

async function newMap(mk: typeof mapkit): Promise<[MapLike, HTMLElement]> {
  const host = makeHost(true);
  const map = new mk.Map(host, {
    isRotationEnabled: true,
    center: new mk.Coordinate(39.8, -98.5),
  }) as unknown as MapLike;
  await wait(1500);
  return [map, host];
}

/** A: take the map's own context away, the way WebKit would. */
async function loseOwnContext(mk: typeof mapkit): Promise<string> {
  const [map, host] = await newMap(mk);
  const before = health(map);
  const canvas = host.querySelector("canvas") as HTMLCanvasElement | null;
  const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
  const ext = (gl as WebGLRenderingContext | null)?.getExtension(
    "WEBGL_lose_context",
  ) as { loseContext(): void } | null;
  if (!ext) {
    host.remove();
    return `A: no WEBGL_lose_context (before=${before})`;
  }
  ext.loseContext();
  await wait(1200);
  const after = health(map);
  const state = canvasState(host);
  map.destroy();
  host.remove();
  return `A loseCtx: b=${before} a=${after} ${state}`;
}

/** B: flood contexts so WebKit evicts the oldest — which is the map's. */
async function floodContexts(mk: typeof mapkit): Promise<string> {
  const [map, host] = await newMap(mk);
  const hogs: HTMLCanvasElement[] = [];
  for (let i = 0; i < CONTEXT_FLOOD; i++) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    c.getContext("webgl2") ?? c.getContext("webgl");
    hogs.push(c);
    await frame();
  }
  await wait(1200);
  const after = health(map);
  const state = canvasState(host);
  map.destroy();
  host.remove();
  return `B flood: a=${after} ${state}`;
}

/** C: padding write + container resize in one frame, rect refresh suppressed. */
async function padAndResize(mk: typeof mapkit, skip: boolean): Promise<string> {
  const [map, host] = await newMap(mk);
  type Impl = { setPadding?: (p: unknown, o: unknown) => void };
  const proto = Object.getPrototypeOf(map) as { _?: (k: unknown) => unknown };
  const accessor = proto._;
  let impl: Impl | null = null;
  if (typeof accessor === "function") {
    let key: unknown;
    proto._ = function (this: unknown, k: unknown) {
      key = k;
      return accessor.call(this, k);
    };
    try {
      void map.center;
    } finally {
      proto._ = accessor;
    }
    try {
      impl = (accessor.call(map, key) ?? null) as Impl | null;
    } catch {
      impl = null;
    }
  }
  if (!impl?.setPadding) {
    host.remove();
    return `C(skip=${skip}): no private impl`;
  }
  for (let i = 0; i < CYCLES; i++) {
    const on = i % 2 === 0;
    impl.setPadding(new mk.Padding(on ? 50 : 0, 0, 0, 0), {
      updateVisibleMapRect: !skip,
    });
    host.style.height = on ? "748px" : "714px";
    await frame();
    await frame();
    const state = health(map);
    if (state.startsWith("POISONED")) {
      host.remove();
      return `C(skip=${skip}): ${state} on cycle ${i}`;
    }
  }
  map.destroy();
  host.remove();
  return `C skip=${skip}: survived`;
}

/** D: a map whose context is already lost, then driven the way the app drives it. */
async function driveAfterContextLoss(mk: typeof mapkit): Promise<string> {
  const host = makeHost(false);
  host.style.height = "300px";
  const map = new mk.Map(host, {
    isRotationEnabled: true,
    center: new mk.Coordinate(39.8, -98.5),
  }) as unknown as MapLike;
  await wait(1800);

  const canvas = host.querySelector("canvas") as HTMLCanvasElement | null;
  const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
  const ext = (gl as WebGLRenderingContext | null)?.getExtension(
    "WEBGL_lose_context",
  ) as { loseContext(): void } | null;
  const steps0: string[] = [];
  ext?.loseContext();
  await wait(1000);
  steps0.push(`lost=${health(map)}`);

  // Now everything the app does that a probe never did, on a dead context.
  const steps: string[] = steps0;
  const m = map as unknown as Record<string, unknown> & {
    convertCoordinateToPointOnPage(c: unknown): unknown;
  };
  try {
    (m as unknown as { padding: unknown }).padding = new mk.Padding(50, 0, 0, 0);
    steps.push(`pad=${health(map)}`);
  } catch (e) {
    steps.push(`pad threw ${String(e).slice(0, 40)}`);
  }
  host.style.height = "340px";
  await frame();
  await frame();
  steps.push(`resize=${health(map)}`);
  try {
    const c = (map as unknown as { center: { latitude: number; longitude: number } }).center;
    m.convertCoordinateToPointOnPage(new mk.Coordinate(c.latitude, c.longitude));
    m.convertCoordinateToPointOnPage(new mk.Coordinate(c.latitude, c.longitude + 0.02));
    steps.push(`project=${health(map)}`);
  } catch (e) {
    steps.push(`project threw ${String(e).slice(0, 50)}`);
  }
  try {
    (m as unknown as { isRotationEnabled: boolean }).isRotationEnabled = false;
    steps.push(`rotGate=${health(map)}`);
  } catch (e) {
    steps.push(`rotGate threw ${String(e).slice(0, 40)}`);
  }
  const out = `D afterLoss: ${steps.join(" ")}`;
  // Leave the map on screen so the screenshot shows whether it is grey.
  return out;
}

function getImpl(map: MapLike): Record<string, unknown> | null {
  const proto = Object.getPrototypeOf(map) as { _?: (k: unknown) => unknown };
  const accessor = proto._;
  if (typeof accessor !== "function") return null;
  let key: unknown;
  proto._ = function (this: unknown, k: unknown) {
    key = k;
    return accessor.call(this, k);
  };
  try {
    void map.center;
  } finally {
    proto._ = accessor;
  }
  try {
    return (accessor.call(map, key) ?? null) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

/** E: what atomicPanZoom does — REMOVE a field from Apple's object. */
async function deleteVisibleMapRect(mk: typeof mapkit): Promise<string> {
  const [map, host] = await newMap(mk);
  const impl = getImpl(map);
  if (!impl) {
    host.remove();
    return "E: no impl";
  }
  const had = Object.prototype.hasOwnProperty.call(impl, "_visibleMapRect");
  delete impl._visibleMapRect;
  const after = health(map);
  // and again after a resize, which forces a recompute
  host.style.height = "640px";
  await frame();
  await frame();
  const afterResize = health(map);
  map.destroy();
  host.remove();
  return `E delete _visibleMapRect (own=${had}): after=${after} afterResize=${afterResize}`;
}

/** F: drive a context-lost map harder — fitBounds / animated region. */
async function regionOnDeadContext(mk: typeof mapkit): Promise<string> {
  const [map, host] = await newMap(mk);
  const canvas = host.querySelector("canvas") as HTMLCanvasElement | null;
  const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
  (
    (gl as WebGLRenderingContext | null)?.getExtension("WEBGL_lose_context") as
      | { loseContext(): void }
      | null
  )?.loseContext();
  await wait(800);
  const steps: string[] = [];
  const m = map as unknown as Record<string, unknown>;
  try {
    (m as { setRegionAnimated(r: unknown, a: boolean): void }).setRegionAnimated(
      new mk.CoordinateRegion(
        new mk.Coordinate(43.0, -89.4),
        new mk.CoordinateSpan(0.2, 0.2),
      ),
      true,
    );
    await wait(900);
    steps.push(`region=${health(map)}`);
  } catch (e) {
    steps.push(`region threw ${String(e).slice(0, 45)}`);
  }
  // a degenerate, zero-span region — fitBounds can produce this
  try {
    (m as { setRegionAnimated(r: unknown, a: boolean): void }).setRegionAnimated(
      new mk.CoordinateRegion(
        new mk.Coordinate(43.0, -89.4),
        new mk.CoordinateSpan(0, 0),
      ),
      false,
    );
    await wait(600);
    steps.push(`zeroSpan=${health(map)}`);
  } catch (e) {
    steps.push(`zeroSpan threw ${String(e).slice(0, 45)}`);
  }
  map.destroy();
  host.remove();
  return `F dead-context region: ${steps.join(" ")}`;
}

/** G: lose the context DURING a resize rather than at rest. */
async function loseDuringResize(mk: typeof mapkit): Promise<string> {
  const [map, host] = await newMap(mk);
  const canvas = host.querySelector("canvas") as HTMLCanvasElement | null;
  const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
  const ext = (gl as WebGLRenderingContext | null)?.getExtension(
    "WEBGL_lose_context",
  ) as { loseContext(): void } | null;
  host.style.height = "420px";
  ext?.loseContext(); // same frame as the resize
  await frame();
  const mid = health(map);
  await wait(900);
  host.style.height = "714px";
  await frame();
  await frame();
  const after = health(map);
  map.destroy();
  host.remove();
  return `G lose during resize: mid=${mid} after=${after}`;
}

/**
 * Leaves a real map alive on screen with a health band that updates twice a
 * second, so the state can be read from a screenshot at any moment while
 * gestures are driven from outside (Device > App Switcher / Home / Rotate).
 */
async function liveWatch(mk: typeof mapkit) {
  const host = makeHost(false);
  host.style.cssText =
    "position:fixed;left:0;right:0;top:120px;bottom:120px;z-index:2147483000";
  const map = new mk.Map(host, {
    isRotationEnabled: true,
    center: new mk.Coordinate(39.8, -98.5),
  }) as unknown as MapLike;

  const band = document.createElement("div");
  band.style.cssText =
    "position:fixed;left:0;right:0;top:0;height:120px;z-index:2147483647;color:#fff;font:700 26px/1.2 ui-monospace,monospace;padding:52px 10px 0;background:#060";
  document.body.appendChild(band);

  let poisonedAt = 0;
  let ticks = 0;
  setInterval(() => {
    ticks++;
    const state = health(map);
    const dead = state.startsWith("POISONED");
    if (dead && !poisonedAt) poisonedAt = ticks;
    band.style.background = dead ? "#c00" : "#060";
    const canvas = host.querySelector('canvas[aria-hidden="true"]');
    const gl = canvas
      ? ((canvas as HTMLCanvasElement).getContext("webgl2") ??
        (canvas as HTMLCanvasElement).getContext("webgl"))
      : null;
    const lost = gl ? (gl as WebGLRenderingContext).isContextLost() : "no-gl";
    band.textContent = `${dead ? "POISONED" : "OK"} t=${ticks} lost=${lost} vp=${window.innerWidth}x${window.innerHeight}`;
  }, 500);
}

/**
 * H: THE mechanism. iOS steals a touch mid-pan (Reachability, app switcher),
 * MapKit's recognizer never unwinds on pointercancel — touchesCancelled is an
 * empty method and enterCancelledState is only reachable from the `enabled`
 * setter — so it stays armed with an empty touch list. The next stray move
 * divides by zero touches, and Camera.translate writes the NaN straight into
 * camera.center via Object.create, bypassing every validator.
 */
async function cancelledGesture(mk: typeof mapkit, mode: string): Promise<string> {
  const [map, host] = await newMap(mk);
  host.style.visibility = "visible";
  const startLat = (map as unknown as { center: { latitude: number } }).center.latitude;

  // MapKit binds pointerdown on its own interaction surface; dispatch on the
  // container and let it bubble, with the button state a real touch carries.
  const target: HTMLElement = host;
  const pe = (type: string, x: number, y: number, id: number) =>
    new PointerEvent(type, {
      pointerId: id,
      pointerType: "touch",
      isPrimary: true,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: type === "pointerdown" ? 0 : -1,
      buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
      pressure: type === "pointerup" || type === "pointercancel" ? 0 : 0.5,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
  const te = (type: string, x: number, y: number, id: number, empty = false) => {
    const t = new Touch({
      identifier: id,
      target,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      pageX: x,
      pageY: y,
    });
    const list = empty ? [] : [t];
    return new TouchEvent(type, {
      touches: list,
      targetTouches: list,
      changedTouches: [t],
      bubbles: true,
      cancelable: true,
      composed: true,
    });
  };

  const usePointer = mode.startsWith("ptr");
  const send = (type: string, x: number, y: number, id = 1, empty = false) => {
    const ev = usePointer ? pe(type, x, y, id) : te(type, x, y, id, empty);
    target.dispatchEvent(ev);
    window.dispatchEvent(ev.constructor === PointerEvent ? pe(type, x, y, id) : te(type, x, y, id, empty));
  };

  const down = usePointer ? "pointerdown" : "touchstart";
  const move = usePointer ? "pointermove" : "touchmove";
  const cancel = usePointer ? "pointercancel" : "touchcancel";

  send(down, 180, 300);
  await frame();
  for (let i = 1; i <= 4; i++) {
    send(move, 180 + i * 18, 300 + i * 14);
    await frame();
  }
  const panned =
    Math.abs(
      (map as unknown as { center: { latitude: number } }).center.latitude - startLat,
    ) > 1e-9;

  send(cancel, 250, 356);
  await frame();

  if (mode.endsWith("guard")) {
    (map as unknown as { isScrollEnabled: boolean }).isScrollEnabled = false;
    (map as unknown as { isScrollEnabled: boolean }).isScrollEnabled = true;
    await frame();
  }

  // A stray move with nothing tracked — the detonator.
  send(move, 300, 400, 9, true);
  await frame();
  send(move, 340, 440, 9, true);
  await frame();
  await wait(800);

  const after = health(map);
  let repaired = "n/a";
  if (after.startsWith("POISONED")) {
    try {
      (map as unknown as { center: unknown }).center = new mk.Coordinate(39.8, -98.5);
      await wait(600);
      repaired = health(map);
    } catch (e) {
      repaired = `threw ${String(e).slice(0, 30)}`;
    }
  }
  map.destroy();
  host.remove();
  return `H ${mode}: panned=${panned} a=${after} repair=${repaired}`;
}

export async function runReproHarness() {
  const lines: string[] = [];
  try {
    const mk = await loadMapKit();
    lines.push(`mapkit ${(mk as unknown as { version?: string }).version ?? "?"}`);
    for (const run of [
      () => loseOwnContext(mk),
      () => floodContexts(mk),
      () => padAndResize(mk, true),
      () => padAndResize(mk, false),
      () => driveAfterContextLoss(mk),
      () => deleteVisibleMapRect(mk),
      () => regionOnDeadContext(mk),
      () => loseDuringResize(mk),
      () => cancelledGesture(mk, "ptr"),
      () => cancelledGesture(mk, "touch"),
      () => cancelledGesture(mk, "touch+guard"),
    ]) {
      try {
        lines.push(await run());
      } catch (error) {
        lines.push(`threw: ${String(error).slice(0, 90)}`);
      }
    }
  } catch (error) {
    lines.push(`loadMapKit failed: ${String(error).slice(0, 120)}`);
  }
  paint(
    lines.some((l) => l.includes("after=POISONED") || l.includes(": POISONED")),
    lines,
  );
  // Hand over to the live map only after the verdict has been readable for a
  // while — the screenshot has to catch the results, not the watcher.
  await wait(150000);
  try {
    document.querySelectorAll("div").forEach((d) => {
      if (d.style.zIndex === "2147483647") d.remove();
    });
    const mk = await loadMapKit();
    await liveWatch(mk);
  } catch {
    // nothing to watch
  }
}
