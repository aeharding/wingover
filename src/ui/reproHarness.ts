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
  };color:#fff;font:600 19px/1.35 ui-monospace,monospace;padding:70px 18px;white-space:pre-wrap;overflow:auto`;
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
  return `A lose own context: before=${before} after=${after} | ${state}`;
}

/** B: flood contexts so WebKit evicts the oldest — which is the map's. */
async function floodContexts(mk: typeof mapkit): Promise<string> {
  const [map, host] = await newMap(mk);
  const before = health(map);
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
  return `B flood ${CONTEXT_FLOOD} contexts: before=${before} after=${after} | ${state}`;
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
  return `C(skip=${skip}): survived ${CYCLES}`;
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
}
