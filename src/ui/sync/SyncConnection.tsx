import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonNavLink,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from "@ionic/react";
import { chevronBackOutline, logoApple } from "ionicons/icons";
import { type RefObject, useState, useSyncExternalStore } from "react";

import { isTauri } from "../../engine/platform";
import * as sync from "../../sync";
import { describe, type SyncTone } from "./describe";
import { resolveSyncView } from "./resolveSyncView";
import { SelfHostPage } from "./SelfHostPage";
import styles from "./sync.module.css";
import {
  DormantSubscribe,
  manageSubscription,
  ResubscribeArea,
} from "./SyncSubscription";

/**
 * The Log In rail (SYNC-UX.md): connection only. Which CouchDB this device
 * syncs to, whether it's connected, and how to connect or disconnect —
 * Sign in with Apple (the login door), the self-host login, the derived
 * status view, and the post-purchase link page. Self-host is a login. The
 * remedy for a lapse is a purchase, so this rail borrows the payments rail's
 * Resubscribe/Manage pieces (one-way; the payments rail never reaches back).
 */

// A semantic tone → the sheet's status-label modifier class. On/off/neutral
// ride the default label color; only a lapse (amber) and an error (red) paint.
export const SHEET_TONE_CLASS: Record<SyncTone, string> = {
  on: "",
  off: "",
  warn: styles.stateReadonly,
  error: styles.stateError,
  neutral: "",
};

// Sign in with Apple: a quiet text link (the iOS pitch) or the white HIG button.
export function AppleSignInButton({
  label,
  onClick,
  busy,
  testId,
  quiet = false,
}: {
  label: string;
  onClick: () => void;
  busy: boolean;
  testId: string;
  quiet?: boolean;
}) {
  if (quiet) {
    return (
      <IonButton
        fill="clear"
        size="small"
        className={styles.quietAction}
        disabled={busy}
        onClick={onClick}
        data-testid={testId}
      >
        {busy ? <IonSpinner name="crescent" /> : label}
      </IonButton>
    );
  }
  return (
    <IonButton
      expand="block"
      className={styles.siwaButton}
      disabled={busy}
      onClick={onClick}
      data-testid={testId}
    >
      {busy ? (
        <IonSpinner name="crescent" />
      ) : (
        <>
          <IonIcon slot="start" icon={logoApple} aria-hidden="true" />
          {label}
        </>
      )}
    </IonButton>
  );
}

export function SelfHostLink({ onConnected }: { onConnected: () => void }) {
  return (
    <IonNavLink
      routerDirection="forward"
      component={() => (
        <SelfHostPage backText="Sync" onConnected={onConnected} />
      )}
    >
      <IonButton
        fill="clear"
        size="small"
        className={styles.quietAction}
        data-testid="sync-goto-login"
      >
        Self-hosted config
      </IonButton>
    </IonNavLink>
  );
}

/**
 * Anything but nothing: connected, dormant (signed in, no sub), lapsed,
 * subscribed-but-off, supporter. One status block, then only the actions the
 * state earns.
 */
export function Connected({
  status,
  account,
  appleSub,
  products,
  busy,
  problem,
  onBuy,
  onConnect,
  onLink,
  onSignIn,
  onTurnOff,
  onDelete,
  onConnected,
}: {
  status: sync.SyncStatus;
  account: sync.SyncAccount | null;
  appleSub: "active" | "expired" | null;
  products: sync.StoreProduct[];
  busy: boolean;
  problem: string | null;
  onBuy: (term: sync.SubscriptionTerm) => void;
  onConnect: () => void;
  onLink: () => void;
  onSignIn: () => void;
  onTurnOff: () => void;
  onDelete: () => void;
  onConnected: () => void;
}) {
  // One pure resolve; everything below is a dumb render of its fields, so no
  // action can contradict the account/status (the class of bug this replaced).
  const v = resolveSyncView(status, account, appleSub, isTauri());

  return (
    <>
      <div className={`${styles.state} ${SHEET_TONE_CLASS[v.statusTone]}`}>
        <span className={styles.stateLabel} data-testid="sync-state">
          {v.statusLabel}
        </span>
        <span className={styles.stateDetail}>{v.statusDetail}</span>
      </div>

      {v.supporterNote && (
        <p className={styles.finePrint} data-testid="sync-supporting">
          Subscribed. Thank you for supporting Wingover; your own server stays
          connected.
        </p>
      )}

      {status.state === "error" && (
        <p className={styles.errorMessage}>{status.message}</p>
      )}
      {problem && <p className={styles.errorMessage}>{problem}</p>}

      {/* Turn sync (back) on: subscribed on this device but not connected. */}
      {v.showTurnOn && (
        <IonButton
          expand="block"
          disabled={busy}
          onClick={onConnect}
          data-testid="sync-connect-device"
        >
          {busy ? <IonSpinner name="crescent" /> : "Turn on sync"}
        </IonButton>
      )}

      {/* Resubscribe: the lapse is discovered here, the remedy is a purchase.
          Both plans, matching the pitch, so a lapse never buries the year. */}
      {v.showResubscribe && (
        <ResubscribeArea products={products} busy={busy} onBuy={onBuy} />
      )}

      {/* Dormant: signed in, never subscribed — prompted to subscribe
          (SYNC-UX.md). Web checkout replaces the sentence when it exists. */}
      {v.showDormantSubscribe && (
        <DormantSubscribe products={products} busy={busy} onBuy={onBuy} />
      )}

      {/* Off + a lapsed or absent sub still deserves a way in. */}
      {v.showSignIn && (
        <AppleSignInButton
          label="Sign in with Apple"
          onClick={onSignIn}
          busy={busy}
          testId="sync-signin"
        />
      )}

      {v.showTurnOff && (
        <IonButton
          expand="block"
          fill="outline"
          color="medium"
          disabled={busy}
          onClick={onTurnOff}
          data-testid="sync-off"
        >
          {v.turnOffLabel}
        </IonButton>
      )}

      {/* A subscription to manage means one exists: never for a dormant
          (signed-in, never-subscribed) account, whose Manage link opened an
          empty App Store page. */}
      {v.showManage && (
        <IonButton
          fill="clear"
          size="small"
          className={styles.quietAction}
          onClick={manageSubscription}
          data-testid="sync-manage"
        >
          Manage Subscription
        </IonButton>
      )}

      {v.showUseOnComputer && (
        // Junction 2 catch-up for pilots who skipped the post-purchase page —
        // opens the same page. Idempotent server-side. Once the server says
        // the Apple Account is linked, the door becomes the note below.
        <IonButton
          fill="clear"
          size="small"
          className={styles.quietAction}
          disabled={busy}
          onClick={onLink}
          data-testid="sync-link-apple"
        >
          Use on your computer
        </IonButton>
      )}

      {v.showLinkedNote && (
        <p className={styles.finePrint} data-testid="sync-linked-note">
          Linked. Sign in with Apple at wingover.app any time.
        </p>
      )}

      {v.showDelete && (
        <IonButton
          fill="clear"
          size="small"
          color="danger"
          className={styles.quietAction}
          disabled={busy}
          onClick={onDelete}
          data-testid="sync-delete-account"
        >
          Delete account…
        </IonButton>
      )}

      {v.showSelfHost && <SelfHostLink onConnected={onConnected} />}

      {v.showTurnOffNote && (
        <p className={styles.finePrint}>
          {isTauri()
            ? "Turning sync off forgets this device's connection, and it stays off until you turn it back on. Nothing is deleted: every flight stays on this device and on the server. If you subscribe, billing is unchanged."
            : "Logging out removes your flights from this computer. They stay on the server and your other devices. If you subscribe, billing is unchanged."}
        </p>
      )}
    </>
  );
}

/**
 * Pushed right after a purchase connects this device (and reachable later via
 * "Use on your computer"): the thank-you, and the one optional step,
 * explained simply. Its own page because the inline version was cramped and
 * hard to read. Done or the back chevron pops to the sheet.
 */
export function LinkAccountPage({
  nav,
}: {
  nav: RefObject<HTMLIonNavElement | null>;
}) {
  // Live, not asserted: this page once claimed "On" while the connect had
  // actually landed read-only (a stale purchase transaction) — the pilot
  // popped back to a contradiction.
  const status = useSyncExternalStore(sync.subscribe, sync.currentStatus);
  const account = useSyncExternalStore(sync.subscribe, sync.currentAccount);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Derived from the account, NOT a local flag: linkAppleAccount patches
  // account.login and the store notifies, so this flips on its own. It also
  // means an already-linked pilot who lands here (a resubscribe) reads "Linked",
  // never an offer to link what is already linked — the bug this replaced.
  const linked = account?.login === "apple";

  function pop() {
    void nav.current?.pop();
  }

  async function link() {
    setBusy(true);
    setProblem(null);
    try {
      await sync.linkAppleAccount();
      // No local flag: account.login flips to "apple" through the store and
      // `linked` above recomputes true.
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!/cancelled/i.test(text)) setProblem(text);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonButton onClick={pop} data-testid="link-page-back">
              <IonIcon slot="icon-only" icon={chevronBackOutline} />
            </IonButton>
          </IonButtons>
          <IonTitle>You&apos;re synced</IonTitle>
          <IonButtons slot="end">
            <IonButton strong onClick={pop} data-testid="link-page-done">
              Done
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <div className={styles.loginBody}>
          <div
            className={`${styles.state} ${SHEET_TONE_CLASS[describe(status).tone]}`}
          >
            <span className={styles.stateLabel}>{describe(status).label}</span>
            <span className={styles.stateDetail}>
              {status.state === "syncing" && !status.readOnly
                ? "Your flights now back up automatically."
                : describe(status).detail}
            </span>
          </div>

          {linked ? (
            <p className={styles.loginLede} data-testid="link-page-linked">
              Linked. Sign in with Apple at wingover.app any time.
            </p>
          ) : (
            <>
              <p className={styles.loginLede}>
                One optional step: link your Apple Account, and you can sign in
                at wingover.app to see your flights on any computer.
              </p>

              {problem && <p className={styles.errorMessage}>{problem}</p>}

              <AppleSignInButton
                label="Link Apple Account"
                onClick={link}
                busy={busy}
                testId="link-page-link"
              />
              <IonButton
                fill="clear"
                size="small"
                className={styles.quietAction}
                onClick={pop}
                data-testid="link-page-skip"
              >
                Skip for now
              </IonButton>
              <p className={styles.finePrint}>
                You can always do this later from the Sync screen.
              </p>
            </>
          )}
        </div>
      </IonContent>
    </>
  );
}
