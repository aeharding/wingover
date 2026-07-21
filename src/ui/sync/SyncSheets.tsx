import { IonModal } from "@ionic/react";
import {
  createContext,
  type ReactNode,
  useContext,
  useState,
} from "react";

import { SyncSheet } from "./SyncSheet";

import "./SyncSheets.css";

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
  const [presenting, setPresenting] = useState<HTMLElement | null>(null);

  // Full-screen card modal: `presentingElement` is what makes the page behind
  // scale back, the platform-native "this is a detour, not a new place" cue.
  // Resolved at present time, not at mount: a live flight sheds the whole nav
  // shell — router outlet included — and a stale ref would present against a
  // detached element. Null just means a plain full-screen modal.
  // Plain functions: the React Compiler stabilizes them, context value
  // included.
  const present = () => {
    setPresenting(document.querySelector<HTMLElement>("ion-router-outlet"));
    setOpen(true);
  };

  const close = () => setOpen(false);

  return (
    <SyncSheetContext.Provider value={present}>
      {children}
      <IonModal
        className="sync-modal"
        isOpen={open}
        onDidDismiss={close}
        presentingElement={presenting ?? undefined}
      >
        {/* Keyed on open so a dismissed sheet reopens at its root instead of
            wherever its inner nav was left. */}
        <SyncSheet key={String(open)} onClose={close} />
      </IonModal>
    </SyncSheetContext.Provider>
  );
}
