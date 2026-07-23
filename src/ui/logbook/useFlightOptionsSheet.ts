import { useIonActionSheet } from "@ionic/react";
import { useEffect } from "react";

import type { Fix } from "../../engine/types";
import { splitAvailable, trimAvailable } from "../../flight/clip";
import type { Flight } from "../../storage/db";
import type { ClipMode } from "../replay/ClipDock";
import { useFlightActions } from "../useFlightActions";

/**
 * The flight options sheet (Export GPX / Trim / Split / Delete), shared by
 * the phone detail page and the desktop seat card. The two hosts differ only
 * at the seams: how a clip editor opens (`onBeginClip` — the seat drops
 * straight into the pane, the phone jumps to fullscreen first) and where a
 * delete goes next (`onDeleted`). Everything else — the trim/split gating,
 * the dismiss-before-present dance, the fold-with-a-hidden-host effect — is
 * identical, so it lives here.
 */
export function useFlightOptionsSheet({
  flight,
  track,
  active,
  onBeginClip,
  onDeleted,
}: {
  flight: Flight | null;
  track: Fix[];
  // Present only on a hidable host (the desktop seat): the sheet portals
  // outside the section's subtree, so it must fold when the section goes
  // URL-hidden. Undefined on the always-mounted phone page (no fold).
  active?: boolean;
  // Open (or repurpose) the replay pane as a clip editor in the given mode.
  onBeginClip: (mode: ClipMode) => void;
  onDeleted: () => void;
}): () => Promise<void> {
  // The CONTROLLER hook, not a controlled <IonActionSheet isOpen>: each
  // present makes a fresh overlay. The controlled form desynced when the
  // sheet was reopened while the previous dismissal was still animating
  // (clip flows do exactly that): the late onDidDismiss stamped the open
  // flag false over the new request and the sheet went permanently mute.
  const [presentOptions, dismissOptions] = useIonActionSheet();
  const { exportFlight, confirmDeleteFlight } = useFlightActions();

  // The sheet portals outside the section's subtree; if the section goes
  // URL-hidden while it is up, it must fold with it. Only a host that hides
  // passes `active` — the always-mounted phone page leaves it undefined.
  useEffect(() => {
    if (active === undefined) return;
    if (!active) void dismissOptions();
  }, [active, dismissOptions]);

  async function openOptions() {
    // The previous sheet may still be tearing down (the clip flows reopen
    // fast, and a busy frame stretches the dismiss animation); presenting
    // into its cleanup gets the new sheet silently destroyed with it.
    await dismissOptions();
    await presentOptions({
      buttons: [
        {
          text: "Export GPX",
          handler: () => {
            if (flight) exportFlight(flight);
          },
        },
        // Each trim end is its own errand (usually it is one or the other).
        ...(trimAvailable(track)
          ? [
              {
                text: "Trim start",
                handler: () => onBeginClip("trim-start"),
              },
              {
                text: "Trim end",
                handler: () => onBeginClip("trim-end"),
              },
            ]
          : []),
        ...(splitAvailable(track)
          ? [
              {
                text: "Split flight",
                handler: () => onBeginClip("split"),
              },
            ]
          : []),
        {
          text: "Delete flight",
          role: "destructive",
          handler: () => {
            if (flight) confirmDeleteFlight(flight, onDeleted);
          },
        },
        { text: "Cancel", role: "cancel" },
      ],
    });
  }

  return openOptions;
}
