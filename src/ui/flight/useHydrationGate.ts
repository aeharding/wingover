import { useEffect, useState } from "react";

import { engine } from "../../engine";

// WAL hydration happens once per app launch. The App swaps the whole nav shell
// for a bare <FlyPage> when a flight is active, so FlyPage remounts mid-session
// (the moment a flight starts, and again when it ends). Seeding `ready` from
// this module flag keeps that remount from flashing the pre-hydration blank —
// the engine is already hydrated by then.
let hydratedOnce = false;

/**
 * Hydration gate: before the WAL read the engine reports "idle", which
 * must not flash the Start button during a live-flight reload. This is
 * only the in-surface half. Whether that surface is mounted AT ALL on a
 * mid-flight launch is decided a layer up, off snapshot.sessionInPlay —
 * "loading" is what the pilot sees for the frames in between.
 */
export function useHydrationGate(): boolean {
  const [ready, setReady] = useState(hydratedOnce);

  useEffect(() => {
    // Kick the one-time WAL hydration; the subscription picks up the
    // resulting state change like any other.
    void engine.getSnapshot().then(() => {
      hydratedOnce = true;
      setReady(true);
    });
  }, []);

  return ready;
}
