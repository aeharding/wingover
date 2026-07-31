import { IonModal } from "@ionic/react";
import { createContext, type ReactNode, useContext, useState } from "react";

import { SyncSheet } from "./SyncSheet";

import styles from "./sync.module.css";

/**
 * One sheet for everything sync (SYNC-UX.md): a modal, not a page, so it can
 * be raised from anywhere — the Settings row today, a post-flight nudge or an
 * empty logbook later — without every caller owning a modal or the router
 * growing a screen for it. Mounted once at the app root; open it with
 * useSyncSheet().
 */
const SyncSheetContext = createContext<() => void>(() => {});

export function useSyncSheet(): () => void {
  return useContext(SyncSheetContext);
}

export function SyncSheetsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  // Plain functions: the React Compiler stabilizes them, context value
  // included.
  const present = () => setOpen(true);
  const close = () => setOpen(false);

  return (
    <SyncSheetContext.Provider value={present}>
      {children}
      {/* Voyager's floating-card grammar: the modal is invisible and
          auto-height; the card inside is the visible dialog. */}
      <IonModal isOpen={open} onDidDismiss={close} className={styles.floating}>
        {/* Keyed on open so a dismissed sheet reopens at its root instead
            of whichever sub-view it was left on. */}
        <SyncSheet key={String(open)} onClose={close} />
      </IonModal>
    </SyncSheetContext.Provider>
  );
}
