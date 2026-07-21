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
    try {
      if (await sync.flushForLogOut()) {
        await finish(onDone);
        return;
      }
    } catch (error) {
      // Not handling — the React Compiler cannot lower a try/finally WITHOUT
      // a catch (it bails and leaves this whole hook unmemoized).
      throw error;
    } finally {
      setBusy(false);
    }
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
