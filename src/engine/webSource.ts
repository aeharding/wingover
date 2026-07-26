import { coordsLookReduced, IMPRECISE_SUSTAIN_MS } from "../flight/takeoff";
import type { PositionSource, SourceError } from "./real";

// A DIAGNOSIS, not a platform answer: the browser Geolocation API exposes
// no accuracy authorization to ask about, so the only evidence is the
// shape of the fixes. One good fix disproves it, and the engine clears the
// takeover on that fix (handlePositions).
const IMPRECISE: SourceError = {
  permissionDenied: false,
  imprecise: true,
  message:
    "Kilometer-coarse fixes with no altitude; Precise Location is likely off.",
};

// The browser source: navigator.geolocation plus the two things only a
// browser needs. Both are wall-clock, and both are private to this file —
// the engine holds no platform story (ARCHITECTURE.md).
//
//   - The reduced-accuracy latch. With Precise Location off the browser
//     pins to a grid tile and may deliver ONE coarse fix then go silent,
//     so a count of arrivals never accumulates: acquiring would hang
//     forever with no explanation. Nothing here can be asked, so it is
//     timed instead.
//   - revive. The platform can kill a watch with no callback at all
//     (Safari while the page is backgrounded, which a Settings trip is),
//     and a browser cannot be asked whether a watch would succeed. Running
//     a fresh one is the only way to find out, so revive reports null and
//     lets the engine bounce.
//
// A factory rather than a singleton: the latch and the live report channel
// are per-source state, and two engines in one page must not share them.
export function createNavigatorSource(): PositionSource {
  // The current watch's report channel. revive speaks through it, so a
  // source with no watch running has nothing to say.
  let report: ((refusal: SourceError | null) => void) | null = null;

  return {
    watch(onPositions, onRefusal) {
      if (!("geolocation" in navigator)) {
        onRefusal({
          permissionDenied: false,
          message: "no geolocation support",
        });
        return () => {};
      }

      // The diagnosis, as three states: undiagnosed with no window
      // running, undiagnosed with one (latch !== null), and diagnosed —
      // reached either by a fix that disproves it or by the window
      // expiring. Diagnosed is final for this watch.
      let diagnosed = false;
      let latch: ReturnType<typeof setTimeout> | null = null;

      const disarm = () => {
        if (latch === null) return;
        clearTimeout(latch);
        latch = null;
      };

      const arm = () => {
        if (diagnosed || latch !== null) return;
        latch = setTimeout(() => {
          latch = null;
          diagnosed = true;
          onRefusal(IMPRECISE);
        }, IMPRECISE_SUSTAIN_MS);
      };

      const disprove = () => {
        diagnosed = true;
        disarm();
      };

      const id = navigator.geolocation.watchPosition(
        (position) => {
          // Judged BEFORE delivery: handlePositions clears the watch when
          // the flight finalizes, so delivery can synchronously run this
          // watch's teardown — and teardown is what disarms. Arming after
          // it would leave a timer nothing can clear.
          if (coordsLookReduced(position.coords)) arm();
          else disprove();
          onPositions([position]);
        },
        (error) =>
          onRefusal({
            permissionDenied: error.code === error.PERMISSION_DENIED,
            message: error.message,
          }),
        { enableHighAccuracy: true, maximumAge: 0 },
      );

      report = onRefusal;
      return () => {
        disarm();
        // Unless a newer watch has already taken the channel.
        if (report === onRefusal) report = null;
        navigator.geolocation.clearWatch(id);
      };
    },

    revive() {
      report?.(null);
    },
  };
}
