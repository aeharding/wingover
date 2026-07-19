import type { PositionSource, SourcePosition } from "./real";

/**
 * A recording source backed by a real GPX track, replayed compressed on the
 * wall clock and then HELD at the final point. The GPX is expected to already
 * be clipped to a mid-flight moment (do that to the file, not here), so the
 * aircraft ends up sitting still with a trailing track while the instruments
 * show that moment's derived speed/course/climb (the engine derives those from
 * consecutive positions — see real.ts normalizeFix — so the GPX only supplies
 * lat/lon/alt/time).
 *
 * Strictly opt-in via ?mock-gpx (dev/screenshots only): deterministic framing
 * from a genuine flight, and holding at the end means the map settles with no
 * follow-drift. Not wired on any real platform.
 */
export function createGpxSource(
  gpxUrl: string,
  compression: number,
): PositionSource {
  return {
    watch(onPositions, onError, options) {
      const since = options?.since;
      let cancelled = false;
      let timer: ReturnType<typeof setInterval> | undefined;

      void (async () => {
        let fixes: SourcePosition[];
        try {
          const response = await fetch(gpxUrl);
          if (!response.ok) throw new Error(`GPX ${response.status}`);
          fixes = parseGpx(await response.text());
        } catch (error) {
          onError({
            permissionDenied: false,
            message: `GPX load failed: ${(error as Error).message}`,
          });
          return;
        }
        if (cancelled || fixes.length < 2) return;

        const t0 = fixes[0].timestamp;
        const startWall = Date.now();
        let emitted = 0;

        timer = setInterval(
          () => {
            if (cancelled) return;
            const elapsedSim = (Date.now() - startWall) * compression;
            const batch: SourcePosition[] = [];
            while (
              emitted < fixes.length &&
              fixes[emitted].timestamp - t0 <= elapsedSim
            ) {
              const fix = fixes[emitted++];
              if (since != null && fix.timestamp <= since) continue;
              batch.push(fix);
            }
            if (batch.length > 0) onPositions(batch);
            if (emitted >= fixes.length && timer) {
              clearInterval(timer); // hold at the final (mid-flight) point
              timer = undefined;
            }
          },
          Math.max(50, 1000 / compression),
        );
      })();

      return () => {
        cancelled = true;
        if (timer) clearInterval(timer);
      };
    },
  };
}

function parseGpx(xml: string): SourcePosition[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const points = Array.from(doc.querySelectorAll("trkpt, rtept"));
  const out: SourcePosition[] = [];
  points.forEach((point, index) => {
    const latitude = Number(point.getAttribute("lat"));
    const longitude = Number(point.getAttribute("lon"));
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    const eleText = point.querySelector("ele")?.textContent;
    const altitude = eleText != null && eleText !== "" ? Number(eleText) : null;
    const timeText = point.querySelector("time")?.textContent;
    const parsed = timeText ? Date.parse(timeText) : NaN;
    out.push({
      // No/'' timestamps: synthesize 1s cadence so derived speed stays sane.
      timestamp: Number.isFinite(parsed) ? parsed : index * 1000,
      coords: {
        latitude,
        longitude,
        accuracy: 5,
        altitude:
          altitude != null && Number.isFinite(altitude) ? altitude : null,
        altitudeAccuracy: 5,
        speed: null, // engine derives from consecutive positions
        heading: null, // engine derives
      },
    });
  });
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}
