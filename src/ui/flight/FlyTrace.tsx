import { useEffect, useRef, useState } from "react";

import type { Fix } from "../../engine/types";
import { getTrack } from "../../storage/db";
import { projectTrack } from "./traceGeometry";
import {
  createTraceRenderer,
  type TraceRenderer,
  type TraceTheme,
} from "./traceRenderer";
import { useLatestFlight } from "./useLatestFlight";

import styles from "./FlyTrace.module.css";

// One full cycle: the comet flies the track (phase 0..1), drains off the
// end, and a dark beat separates the relaunch (..1.25). See traceRenderer.
const CYCLE_MS = 24000;
const PHASE_SPAN = 1.25;

function parseP3(value: string): [number, number, number] {
  const m = /display-p3\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(value);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [1, 1, 1];
}

// The palette flip lives in the module's custom properties; the canvas
// just reads the winners. Glow (emissive) in dark, ink (pigment) in
// light — additive light is invisible on white.
function readTheme(canvas: HTMLCanvasElement): TraceTheme {
  const style = getComputedStyle(canvas);
  const ghostAlpha = Number.parseFloat(
    style.getPropertyValue("--trace-ghost-alpha"),
  );
  return {
    mode: document.documentElement.classList.contains("ion-palette-dark")
      ? "glow"
      : "ink",
    body: parseP3(style.getPropertyValue("--trace-body")),
    head: parseP3(style.getPropertyValue("--trace-head")),
    ghost: parseP3(style.getPropertyValue("--trace-ghost")),
    // Not `|| fallback`: an authored alpha of 0 is a legitimate "no
    // ghost" and must not be resurrected to the default.
    ghostAlpha: Number.isFinite(ghostAlpha) ? ghostAlpha : 0.09,
  };
}

// The newest flight's track, keyed on the FLIGHT ID, not array identity:
// getTrack returns a fresh array every call, and the change feed fires
// on any flight-doc write (renames, deletes of other flights, sync
// pulls). Rebuilding the GPU world for those flashed the backdrop blank;
// only a genuinely different flight should reload anything.
function useLastTrack(): Fix[] | null {
  const flightId = useLatestFlight()?.id ?? null;
  const [loaded, setLoaded] = useState<{ id: string; fixes: Fix[] } | null>(
    null,
  );
  useEffect(() => {
    if (!flightId) return;
    let alive = true;
    void getTrack(flightId)
      .then((fixes) => {
        if (alive && fixes.length >= 2) setLoaded({ id: flightId, fixes });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [flightId]);
  // Derived, not synced: an id mismatch (flight deleted, logbook
  // emptied, load still in flight) is null without a setState.
  return flightId && loaded?.id === flightId ? loaded.fixes : null;
}

/**
 * The idle backdrop on BOTH shells (the phone frame's fixed slot and the
 * desktop shell's fly section): a WebGPU comet with shader bloom
 * retracing the pilot's LAST FLIGHT over the page's own background —
 * and, on HDR displays (rgba16float + extended tone mapping, see
 * traceRenderer), a head that burns brighter than SDR white. An EMPTY
 * logbook renders nothing at all, deliberately: the animation is the
 * reward for the first flight (per Alex), not wallpaper — no track, no
 * GPU device, no cost. Same testid as the old splash: the (possibly
 * inert) canvas IS the splash backdrop to e2e.
 *
 * No fallback by design (per Alex): where WebGPU is missing the page
 * simply keeps its quiet greeting + facts + Start pill. Device loss
 * (the WebGPU analogue of context loss, surfaced as the renderer's
 * `lost` promise — it also resolves on our own destroy, hence the
 * disposed/identity guards) re-boots the renderer from scratch.
 *
 * The loop is EVENT-DRIVEN, never polled: rAF only exists while the
 * canvas is on screen (IntersectionObserver — covers Ionic's
 * display: none'd hidden tabs and the desktop shell's hidden sections),
 * the document visible, and motion allowed. Parked means zero wakeups
 * and zero GPU work; rAF is per-document, so the browser would NOT stop
 * it for a merely display: none'd element on its own. Reduced motion
 * holds a single mid-flight still frame, repainted only on
 * resize/theme/track changes.
 */
export default function FlyTrace() {
  const track = useLastTrack();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !track) return;

    let disposed = false;
    let renderer: TraceRenderer | null = null;
    let raf = 0;
    let running = false;
    let intersecting = false;
    let lastW = 0;
    let lastH = 0;
    let lastDpr = 0;
    const started = performance.now();
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

    // The reduced-motion (or otherwise parked-but-visible) single frame.
    const still = () => {
      if (renderer && !running && intersecting && !document.hidden) {
        renderer.render(0.55);
      }
    };

    const frame = () => {
      renderer?.render(
        (((performance.now() - started) % CYCLE_MS) / CYCLE_MS) * PHASE_SPAN,
      );
      raf = requestAnimationFrame(frame);
    };

    const sync = () => {
      const shouldRun =
        renderer !== null &&
        intersecting &&
        !document.hidden &&
        !reducedMotion.matches;
      if (shouldRun === running) return;
      running = shouldRun;
      if (running) {
        raf = requestAnimationFrame(frame);
      } else {
        cancelAnimationFrame(raf);
        still();
      }
    };

    // ResizeObserver misses one real-world resize: a dpr change with an
    // unchanged CSS box (window dragged to another monitor). A re-armed
    // resolution media query catches exactly that.
    let dprWatcher: MediaQueryList | null = null;
    const onDprChange = () => fit();
    const watchDpr = () => {
      dprWatcher?.removeEventListener("change", onDprChange);
      dprWatcher = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprWatcher.addEventListener("change", onDprChange);
    };

    const fit = () => {
      if (!renderer) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      // Spurious observer fires must not churn GPU targets.
      if (w === lastW && h === lastH && dpr === lastDpr) return;
      lastW = w;
      lastH = h;
      lastDpr = dpr;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      renderer.resize(w, h, dpr);
      // A box too small to project into clears the path — never leave a
      // ribbon fitted to the previous box on screen.
      renderer.setPath(projectTrack(track, w, h) ?? new Float32Array(0));
      watchDpr();
      still();
    };

    const applyTheme = () => {
      if (!renderer) return;
      renderer.setTheme(readTheme(canvas));
      still();
    };
    // Gate on the palette class actually flipping: documentElement takes
    // unrelated class churn, and readTheme costs a style resolution.
    let dark = document.documentElement.classList.contains("ion-palette-dark");
    const themeWatcher = new MutationObserver(() => {
      const nowDark =
        document.documentElement.classList.contains("ion-palette-dark");
      if (nowDark === dark) return;
      dark = nowDark;
      applyTheme();
    });
    themeWatcher.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    // Async bring-up, re-entered on device loss. Everything below (the
    // observers) is attached exactly once and reads `renderer` through
    // the closure, so a re-boot swaps the renderer under them in place.
    let retryTimer = 0;
    const boot = async (retryOnFail = false) => {
      const created = await createTraceRenderer(canvas);
      if (disposed) {
        created?.destroy();
        return;
      }
      if (!created) {
        // A reboot can race the very GPU reset that caused it: the
        // adapter may be momentarily unavailable, and bailing here
        // would leave the backdrop blank forever. One delayed retry
        // self-heals; the initial mount stays fail-quiet (no WebGPU =
        // no backdrop, by design).
        if (retryOnFail) {
          retryTimer = window.setTimeout(() => void boot(true), 3000);
        }
        return;
      }
      renderer = created;
      // Debuggability + the on-device HDR probe: one glance at the DOM
      // answers "did extended-range configuration take".
      canvas.dataset.hdr = String(created.hdr);
      void created.lost.then(() => {
        // Resolves on true device loss AND on our own destroy(); only
        // the former (this renderer still current, not unmounting)
        // warrants a re-boot.
        if (disposed || renderer !== created) return;
        renderer = null;
        running = false;
        cancelAnimationFrame(raf);
        lastW = lastH = lastDpr = 0;
        void boot(true);
      });
      applyTheme();
      fit();
      sync();
    };

    // The refit trigger for every box change — including 0x0 -> real
    // box when Ionic un-hides the tab. Load-bearing: if this effect
    // (re)ran while the page was display: none, boot's fit() bailed on
    // a 0x0 box, and THIS observer's fire on un-hide is what finally
    // sizes the buffer and projects the path.
    const resizeWatcher = new ResizeObserver(fit);
    resizeWatcher.observe(canvas);

    const viewWatcher = new IntersectionObserver((entries) => {
      intersecting = entries[entries.length - 1].isIntersecting;
      sync();
      still();
    });
    viewWatcher.observe(canvas);
    document.addEventListener("visibilitychange", sync);
    reducedMotion.addEventListener("change", sync);

    void boot();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", sync);
      reducedMotion.removeEventListener("change", sync);
      dprWatcher?.removeEventListener("change", onDprChange);
      themeWatcher.disconnect();
      resizeWatcher.disconnect();
      viewWatcher.disconnect();
      renderer?.destroy();
      renderer = null;
    };
  }, [track]);

  return (
    <canvas
      ref={canvasRef}
      slot="fixed"
      className={styles.trace}
      data-testid="fly-splash"
      aria-hidden="true"
    />
  );
}
