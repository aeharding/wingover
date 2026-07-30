import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonTitle,
  IonToolbar,
  useIonActionSheet,
  useIonAlert,
} from "@ionic/react";
import {
  checkmarkOutline,
  chevronBackOutline,
  desktopOutline,
  logoApple,
} from "ionicons/icons";
import { type RefObject, useState, useSyncExternalStore } from "react";

import { isTauri } from "../../../platform/index";
import * as sync from "../../../sync/index";
import { cx } from "../../shared/cx";
import { BusyLabel } from "./BusyLabel";
import { describe, type SyncTone } from "./describe";
import { resolveSyncView } from "./resolveSyncView";
import {
  DormantSubscribe,
  manageSubscription,
  ResubscribeArea,
} from "./SyncSubscription";

import styles from "./sync.module.css";

/**
 * The Log In rail (SYNC-UX.md): connection only. Which CouchDB this device
 * syncs to, whether it's connected, and how to connect or disconnect —
 * Sign in with Apple (the login door), the self-host login, the derived
 * status view, and the post-purchase link page. Self-host is a login. The
 * remedy for a lapse is a purchase, so this rail borrows the payments rail's
 * Resubscribe/Manage pieces (one-way; the payments rail never reaches back).
 */

// A semantic tone → the sheet's status-label modifier class. The sheet is
// the Settings row expanded (one tap), so "on" paints the SAME green the
// row uses; a lapse amber, an error red; off/neutral ride the default.
export const SHEET_TONE_CLASS: Record<SyncTone, string> = {
  on: styles.stateOn,
  off: "",
  warn: styles.stateReadonly,
  error: styles.stateError,
  neutral: "",
};

// The sheet's status block, shared by the home view and the post-purchase
// page. The checkmark rides "on" exactly like the Settings row's note.
export function StatusBlock({
  label,
  detail,
  tone,
  testId,
}: {
  label: string;
  detail: string;
  tone: SyncTone;
  testId?: string;
}) {
  const on = tone === "on";
  return (
    <div className={cx(styles.state, SHEET_TONE_CLASS[tone])}>
      <span className={styles.stateLabel} data-testid={testId}>
        {on && <IonIcon icon={checkmarkOutline} aria-hidden="true" />}
        {label}
      </span>
      <span className={styles.stateDetail}>{detail}</span>
    </div>
  );
}

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
        <BusyLabel busy={busy}>{label}</BusyLabel>
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
      <BusyLabel busy={busy}>
        <IonIcon slot="start" icon={logoApple} aria-hidden="true" />
        {label}
      </BusyLabel>
    </IonButton>
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
  onPurchased,
  onConnect,
  onLink,
  onSignIn,
  onTurnOff,
  onDelete,
  onSelfHost,
}: {
  status: sync.SyncStatus;
  account: sync.SyncAccount | null;
  appleSub: "active" | "expired" | null;
  products: sync.StoreProduct[];
  busy: boolean;
  problem: string | null;
  onPurchased: () => void;
  onConnect: () => void;
  onLink: () => void;
  onSignIn: () => void;
  onTurnOff: () => void;
  onDelete: () => void;
  onSelfHost: () => void;
}) {
  // One pure resolve; everything below is a dumb render of its fields, so no
  // action can contradict the account/status (the class of bug this replaced).
  const v = resolveSyncView(status, account, appleSub, isTauri());
  const [presentAlert] = useIonAlert();
  const [presentSheet] = useIonActionSheet();

  // The what-it-does fine print rides the confirm, at the moment it matters,
  // instead of resting on screen as a paragraph among buttons. Native only:
  // the web's Log out has its own flush-then-decide machinery (useLogOut)
  // and an extra always-on confirm would train click-through (SYNC-UX.md).
  function confirmTurnOff() {
    if (!isTauri()) {
      onTurnOff();
      return;
    }
    void presentAlert({
      header: `${v.turnOffLabel}?`,
      message:
        "Sync stays off until you turn it back on. Nothing is deleted: every flight stays on this device and on the server. If you subscribe, billing is unchanged.",
      buttons: [
        { text: "Cancel", role: "cancel" },
        { text: v.turnOffLabel, role: "destructive", handler: onTurnOff },
      ],
    });
  }

  // Real doors that almost nobody needs on a given visit: one quiet More
  // button, an action sheet behind it.
  function moreOptions() {
    void presentSheet({
      buttons: [
        ...(v.showUseOnComputer
          ? [{ text: "Use on your computer", handler: onLink }]
          : []),
        ...(v.showSelfHost
          ? [
              {
                text: "Self Hosted",
                handler: onSelfHost,
                htmlAttributes: { "data-testid": "sync-goto-login" },
              },
            ]
          : []),
        ...(v.showManage
          ? [{ text: "Manage Subscription", handler: manageSubscription }]
          : []),
        ...(v.showDelete
          ? [
              {
                text: "Delete account…",
                role: "destructive",
                handler: onDelete,
              },
            ]
          : []),
        { text: "Cancel", role: "cancel" },
      ],
    });
  }

  const showMore =
    v.showManage || v.showDelete || v.showUseOnComputer || v.showSelfHost;

  return (
    <>
      <StatusBlock
        label={v.statusLabel}
        detail={v.statusDetail}
        tone={v.statusTone}
        testId="sync-state"
      />

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
          <BusyLabel busy={busy}>Turn on sync</BusyLabel>
        </IonButton>
      )}

      {/* Resubscribe: the lapse is discovered here, the remedy is a purchase.
          The door pushes the plan page, same as the pitch. */}
      {v.showResubscribe && (
        <ResubscribeArea products={products} onPurchased={onPurchased} />
      )}

      {/* Dormant: signed in, never subscribed — prompted to subscribe
          (SYNC-UX.md). Web checkout replaces the sentence when it exists. */}
      {v.showDormantSubscribe && (
        <DormantSubscribe products={products} onPurchased={onPurchased} />
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
          onClick={confirmTurnOff}
          data-testid="sync-off"
        >
          {v.turnOffLabel}
        </IonButton>
      )}

      {showMore && (
        <IonButton
          fill="clear"
          size="small"
          className={styles.quietAction}
          onClick={moreOptions}
          data-testid="sync-more"
        >
          More options
        </IonButton>
      )}
    </>
  );
}

/**
 * Two doors, one link machinery, two very different moments:
 *
 * - "purchase": pushed right after a purchase connects this device — the
 *   thank-you ("You're synced", the live status) and the one optional step.
 * - "computer": opened from More options. It is ABOUT computer access, so it
 *   says only that; the sheet behind it already shows the sync status, and
 *   repeating it here once produced a page titled "You're synced" over an
 *   amber "Not subscribed" (found on-device, 2026-07-30).
 */
export function LinkAccountPage({
  nav,
  context = "purchase",
}: {
  nav: RefObject<HTMLIonNavElement | null>;
  context?: "purchase" | "computer";
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

  const purchase = context === "purchase";
  const computer = !purchase;

  function renderStatus() {
    if (!purchase) return null;
    return (
      <StatusBlock
        label={describe(status).label}
        detail={
          status.state === "syncing" && !status.readOnly
            ? "Your flights now back up automatically."
            : describe(status).detail
        }
        tone={describe(status).tone}
      />
    );
  }

  function renderLinkOffer() {
    return (
      <>
        <p className={styles.loginLede}>
          {purchase
            ? "One optional step: link your Apple Account, and you can sign in at wingover.app to see your flights on any computer."
            : "Link your Apple Account, and you can sign in at wingover.app to see your flights on any computer."}
        </p>

        {problem && <p className={styles.errorMessage}>{problem}</p>}

        <AppleSignInButton
          label="Link Apple Account"
          onClick={link}
          busy={busy}
          testId="link-page-link"
        />
        {purchase && (
          <IonButton
            fill="clear"
            size="small"
            className={styles.quietAction}
            onClick={pop}
            data-testid="link-page-skip"
          >
            Skip for now
          </IonButton>
        )}
        {purchase && (
          <p className={styles.finePrint}>
            You can always do this later from the Sync screen.
          </p>
        )}
      </>
    );
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
          <IonTitle>{purchase ? "You're synced" : "On your computer"}</IonTitle>
          <IonButtons slot="end">
            <IonButton strong onClick={pop} data-testid="link-page-done">
              Done
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <div className={styles.loginBody}>
          {renderStatus()}

          {computer && (
            <IonIcon
              icon={desktopOutline}
              className={styles.computerGlyph}
              aria-hidden="true"
            />
          )}

          {linked ? (
            <p className={styles.loginLede} data-testid="link-page-linked">
              Linked. Sign in with Apple at wingover.app on any computer.
            </p>
          ) : (
            renderLinkOffer()
          )}
        </div>
      </IonContent>
    </>
  );
}
