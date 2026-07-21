import { useIonAlert } from "@ionic/react";
import { useState } from "react";

import * as sync from "../../sync";

/**
 * The web Log out flow, shared by the sync sheet and the desktop rail
 * menu: flush, then decide. One final push proves the server current;
 * when it succeeds the logout is non-destructive and runs with no dialog
 * at all (an always-on confirm trains click-through). Only when the flush
 * cannot prove a clean state (offline, lapsed, rejected credential) does
 * a confirm appear, and then it states the real stakes. Never reloads:
 * sync.logOut() resets the store in place and every consumer re-reads.
 */
export function useLogOut(): {
  logOut: (onDone?: () => void) => Promise<void>;
  busy: boolean;
} {
  const [presentAlert] = useIonAlert();
  const [busy, setBusy] = useState(false);

  async function finish(onDone?: () => void) {
    try {
      await sync.logOut();
      onDone?.();
    } catch (error) {
      presentAlert({
        header: "Log out failed",
        message: String(error),
        buttons: ["OK"],
      });
    }
  }

  async function logOut(onDone?: () => void) {
    setBusy(true);
    // No try/finally: the React Compiler cannot lower a catchless try (it
    // bails and leaves the whole hook unmemoized). A flush THROW is the
    // same condition as flushed=false — "cannot prove a clean state"
    // (offline, lapsed) — so it takes the confirm path below. finish()
    // never throws (it handles its own failure with an alert).
    const flushed = await sync.flushForLogOut().catch(() => false);
    if (flushed) {
      await finish(onDone);
      setBusy(false);
      return;
    }
    setBusy(false);
    presentAlert({
      header: "Log out?",
      message:
        "Some flights on this computer haven't synced yet. Logging out deletes them from this computer. Everything already synced stays on the server and your other devices.",
      buttons: [
        { text: "Cancel", role: "cancel" },
        {
          text: "Log out",
          role: "destructive",
          handler: () => {
            void finish(onDone);
          },
        },
      ],
    });
  }

  return { logOut, busy };
}
