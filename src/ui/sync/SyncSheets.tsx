import { IonModal } from "@ionic/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import { LoginSheet } from "./LoginSheet";
import { SubscriptionSheet } from "./SubscriptionSheet";

import "./SyncSheets.css";

/**
 * Sync's two surfaces, per SYNC-UX.md: Subscription (payments only) and
 * Log In (connection only). They live in modals, not pages, so either can be
 * raised from anywhere — the Settings rows today, a post-flight nudge later —
 * without every caller owning a modal or the router growing screens for them.
 * Mounted once at the app root; open them with useSyncSheets().
 */
type Sheet = "subscription" | "login" | null;

interface SyncSheetOpeners {
  openSubscription: () => void;
  openLogin: () => void;
}

const SyncSheetsContext = createContext<SyncSheetOpeners>({
  openSubscription: () => {},
  openLogin: () => {},
});

export function useSyncSheets(): SyncSheetOpeners {
  return useContext(SyncSheetsContext);
}

export function SyncSheetsProvider({ children }: { children: ReactNode }) {
  // One sheet at a time: the rails are separate, and the cross-links between
  // them (self-host from the pitch, Resubscribe from read-only) are sheet
  // SWITCHES — setting this straight to the other value dismisses one modal
  // and presents the other.
  const [sheet, setSheet] = useState<Sheet>(null);
  const [presenting, setPresenting] = useState<HTMLElement | null>(null);

  // Full-screen card modal: `presentingElement` is what makes the page behind
  // scale back, the platform-native "this is a detour, not a new place" cue.
  // Resolved at present time, not at mount: a live flight sheds the whole nav
  // shell — router outlet included — and a stale ref would present against a
  // detached element. Null just means a plain full-screen modal.
  const open = useCallback((which: Exclude<Sheet, null>) => {
    setPresenting(document.querySelector<HTMLElement>("ion-router-outlet"));
    setSheet(which);
  }, []);

  const openers = useMemo<SyncSheetOpeners>(
    () => ({
      openSubscription: () => open("subscription"),
      openLogin: () => open("login"),
    }),
    [open],
  );

  const close = useCallback(() => setSheet(null), []);

  // NOT `() => setSheet(null)`: during a sheet switch the outgoing modal's
  // dismiss lands AFTER the state already points at the incoming sheet, and an
  // unconditional null would close it in the same breath it opened.
  const dismissed = useCallback(
    (which: Sheet) => setSheet((current) => (current === which ? null : current)),
    [],
  );

  return (
    <SyncSheetsContext.Provider value={openers}>
      {children}
      <IonModal
        isOpen={sheet === "subscription"}
        onDidDismiss={() => dismissed("subscription")}
        presentingElement={presenting ?? undefined}
      >
        {/* Keyed on open so a dismissed sheet reopens at its root instead of
            wherever its inner nav was left — same for Log In below. */}
        <SubscriptionSheet
          key={String(sheet === "subscription")}
          onClose={close}
        />
      </IonModal>
      <IonModal
        isOpen={sheet === "login"}
        onDidDismiss={() => dismissed("login")}
        presentingElement={presenting ?? undefined}
      >
        <LoginSheet
          key={String(sheet === "login")}
          onClose={close}
          onSubscription={openers.openSubscription}
        />
      </IonModal>
    </SyncSheetsContext.Provider>
  );
}
