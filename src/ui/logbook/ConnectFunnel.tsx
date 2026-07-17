import { IonButton, IonIcon, IonSpinner } from "@ionic/react";
import { logoApple } from "ionicons/icons";
import { useState, useSyncExternalStore } from "react";

import * as sync from "../../sync";
import { describe } from "../sync/describe";
import { useSyncSheet } from "../sync/SyncSheets";

/**
 * The empty logbook in a browser is a front door, not a dead end: a pilot
 * who tapped "Open your logbook in the browser" on the landing page arrives
 * here with their flights on the phone. Sign in with Apple is the browser's
 * login (SYNC-UX: no StoreKit here); self-host and GPX import are the other
 * two ways flights exist off-phone. Once connected, replication streams the
 * logbook in live via the changes feed — no reload.
 */
export default function ConnectFunnel({ onImport }: { onImport: () => void }) {
  const openSync = useSyncSheet();
  const status = useSyncExternalStore(sync.subscribe, sync.currentStatus);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setProblem(null);
    try {
      await sync.signIn();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!/cancelled/i.test(text)) setProblem(text);
    } finally {
      setBusy(false);
    }
  }

  // "error" keeps the doors open: a stale self-host credential must not
  // turn the front door into a dead end of one problem line.
  const connected = status.state !== "off" && status.state !== "error";

  return (
    <div className="connect-funnel">
      <h2>No flights yet.</h2>
      <p className="funnel-sub">
        Flights sync from your phone when sync is on.
      </p>
      {!connected && (
        <>
          <IonButton
            expand="block"
            className="sync-siwa-button"
            disabled={busy}
            onClick={() => void signIn()}
            data-testid="funnel-signin"
          >
            {busy ? (
              <IonSpinner name="crescent" />
            ) : (
              <>
                <IonIcon slot="start" icon={logoApple} aria-hidden="true" />
                Sign in with Apple
              </>
            )}
          </IonButton>
          <IonButton fill="clear" onClick={openSync}>
            Self-hosted config
          </IonButton>
        </>
      )}
      <IonButton fill="clear" onClick={onImport} data-testid="funnel-import">
        Import GPX files
      </IonButton>
      {status.state !== "off" && (
        <p className="funnel-status" data-testid="funnel-status">
          {describe(status).label}
          {describe(status).detail ? `. ${describe(status).detail}` : ""}
        </p>
      )}
      {problem && <p className="funnel-problem">{problem}</p>}
    </div>
  );
}
