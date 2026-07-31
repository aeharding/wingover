import { useEffect, useState } from "react";

import { listPins, onDocsChanged, type Pin } from "../../storage/db";

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
    // A logout destroys the instance mid-read; the swap notifier
    // re-renders with the fresh one, so a rejection here is expected.
    void listPins()
      .then(setPins)
      .catch(() => {});
    return onDocsChanged(
      "pin",
      () =>
        void listPins()
          .then(setPins)
          .catch(() => {}),
    );
  }, []);

  return pins;
}
