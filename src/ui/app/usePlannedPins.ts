import { useEffect, useState } from "react";

import {
  isExpectedSwapRejection,
  listPins,
  onDocsChanged,
  type Pin,
} from "../../storage/db";

/**
 * The planned route, for the idle-screen distance. Reloaded on every entry
 * to the Fly tab so edits made on the Plan tab are reflected.
 *
 * Loaded on mount and then LIVE: edits on the Plan tab, or a synced pull
 * from another device, land here through the store's own feed. No shell
 * lifecycle involved; the flight surface subscribes directly.
 */
export function usePlannedPins(): Pin[] {
  const [pins, setPins] = useState<Pin[]>([]);

  useEffect(() => {
    // Caught and LOGGED, never unhandled: a logout destroys the instance
    // mid-read (expected; the swap notifier re-renders with the fresh
    // one), and an unhandled rejection here would read to idbHeal as a
    // severed session during the one flow that must never reload.
    void listPins()
      .then(setPins)
      .catch((error) => {
        if (isExpectedSwapRejection(error)) return;
        console.error("pin list read failed:", error);
        throw error;
      });
    return onDocsChanged(
      "pin",
      () =>
        void listPins()
          .then(setPins)
          .catch((error) => {
            if (isExpectedSwapRejection(error)) return;
            console.error("pin list read failed:", error);
            throw error;
          }),
    );
  }, []);

  return pins;
}
