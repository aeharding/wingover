import {
  IonButton,
  IonIcon,
  useIonActionSheet,
  useIonAlert,
} from "@ionic/react";
import { checkmarkOutline, close, cloudUploadOutline } from "ionicons/icons";
import { useEffect, useState, useSyncExternalStore } from "react";

import { isTauri } from "../../../platform/index";
import * as sync from "../../../sync/index";
import { cx } from "../../shared/cx";
import { describe } from "./describe";
import { SelfHostPage } from "./SelfHostPage";
import {
  AppleSignInButton,
  Connected,
  LinkAccountPage,
} from "./SyncConnection";
import {
  ChoosePlanPage,
  manageSubscription,
  SubscribeArea,
} from "./SyncSubscription";
import { useLogOut } from "./useLogOut";

import styles from "./sync.module.css";

/**
 * THE sync surface — one auto-height dialog, one question ("are my flights
 * backed up?"), every view derived from state (SYNC-UX.md). The
 * payments/connection split stays real in the architecture — and in the file
 * layout (SyncSubscription / SyncConnection) — but it stopped being
 * user-facing geography the day it took two Settings rows and a login
 * vocabulary to explain.
 *
 * Sub-views swap in place (no ion-nav: its absolutely positioned pages have
 * no natural height for a fit-content dialog to measure), and the keyed
 * remount in SyncSheets returns a reopened dialog to home.
 */
type SheetView = "home" | "plan" | "selfhost" | "computer" | "thanks";

export function SyncSheet({ onClose }: { onClose: () => void }) {
  const status = useSyncExternalStore(sync.subscribe, sync.currentStatus);
  const account = useSyncExternalStore(sync.subscribe, sync.currentAccount);
  const [view, setView] = useState<SheetView>("home");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Empty = StoreKit didn't hand us products — a browser, the desktop dev
  // ring, or App Store Connect not serving them yet.
  const [products, setProducts] = useState<sync.StoreProduct[]>([]);
  // The subscription rail's own state, straight from StoreKit: what makes a
  // supporter or a signed-out subscriber see the truth here.
  const [appleSub, setAppleSub] = useState<"active" | "expired" | null>(null);
  const [presentAlert] = useIonAlert();
  const { logOut, busy: loggingOut } = useLogOut();

  useEffect(() => {
    void sync.subscriptionProducts().then(setProducts);
    void sync.appleSubscriptionState().then(setAppleSub);
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setProblem(null);
    try {
      await action();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      // A closed Apple sheet/popup is a non-event, not a problem to display.
      if (!/cancelled/i.test(text)) setProblem(text);
    } finally {
      setBusy(false);
    }
  }

  // The purchase itself lives on ChoosePlanPage (its problems surface
  // there); this is the after: refresh the StoreKit-derived cache, then the
  // thank-you/link view (SYNC-UX.md junction 2) — only when the purchase
  // actually connected this device (the supporter guard means a
  // self-hoster's purchase doesn't), and only when NOT already linked:
  // offering to link what is linked contradicts the view right behind it.
  function afterPurchase() {
    void sync.appleSubscriptionState().then(setAppleSub);
    const acct = sync.currentAccount();
    if (isTauri() && acct?.kind === "apple" && acct.login !== "apple") {
      setView("thanks");
      return;
    }
    setView("home");
  }

  const home = () => setView("home");

  const connected = status.state !== "off";
  // The pitch shows only when there is truly nothing: no connection, no
  // account, no subscription on this device.
  const nothing = !connected && !account && appleSub === null;

  function confirmDelete() {
    void presentAlert({
      header: "Delete account?",
      // Three facts, shortest true sentences: what dies, what survives,
      // what keeps billing. (Deleting also turns sync off, and off
      // persists, so the account cannot resurrect at launch; a deliberate
      // reconnect minting a fresh empty account is self-evident when it
      // happens and doesn't earn alert space.)
      message:
        account?.kind === "apple" && account.entitled
          ? "This deletes your flights from the server, permanently. The copies on this phone stay. Your subscription keeps billing until you cancel it with Apple."
          : "This deletes your flights from the server, permanently. The copies on this device stay.",
      buttons: [
        { text: "Cancel", role: "cancel" },
        {
          text: "Manage Subscription",
          handler: () => {
            manageSubscription();
            // Keep the alert open: cancelling out there and deleting here
            // are both still on the table.
            return false;
          },
        },
        {
          text: "Delete",
          role: "destructive",
          handler: () => {
            void run(() => sync.deleteAccount());
          },
        },
      ],
    });
  }

  function renderHome() {
    return (
      <div className={styles.homeBody}>
        {nothing ? (
          <Pitch
            products={products}
            busy={busy}
            problem={problem}
            onPurchased={afterPurchase}
            onSignIn={() => run(() => sync.signIn())}
            onRestore={() =>
              run(async () => {
                const jws = await sync.probeEntitlementJWS();
                if (!jws) {
                  throw new Error(
                    "No subscription found for this Apple Account.",
                  );
                }
                await sync.connectWithSubscription(jws);
              })
            }
            onSelfHost={() => setView("selfhost")}
          />
        ) : (
          <Connected
            status={status}
            account={account}
            appleSub={appleSub}
            products={products}
            busy={busy || loggingOut}
            problem={problem}
            onOpenPlans={() => setView("plan")}
            onConnect={() => run(() => sync.connectWithSubscription())}
            onLink={() => setView("computer")}
            onSignIn={() => run(() => sync.signIn())}
            onTurnOff={() =>
              isTauri() ? void run(() => sync.disable()) : void logOut(onClose)
            }
            onSelfHost={() => setView("selfhost")}
            onDelete={confirmDelete}
          />
        )}
      </div>
    );
  }

  // The badge is the sync status speaking from the card's crown: the same
  // tones the Settings row paints, a checkmark when all is well.
  function renderBadge() {
    const tone = nothing ? "neutral" : describe(status).tone;
    const badgeClass = {
      on: styles.badge,
      neutral: styles.badge,
      off: cx(styles.badge, styles.badgeOff),
      warn: cx(styles.badge, styles.badgeWarn),
      error: cx(styles.badge, styles.badgeError),
    }[tone];
    return (
      <div className={badgeClass}>
        <IonIcon
          icon={tone === "on" ? checkmarkOutline : cloudUploadOutline}
          aria-hidden="true"
        />
      </div>
    );
  }

  function renderView() {
    switch (view) {
      case "home":
        return renderHome();
      case "plan":
        return (
          <ChoosePlanPage
            products={products}
            onBack={home}
            onPurchased={afterPurchase}
          />
        );
      case "selfhost":
        return <SelfHostPage onBack={home} onConnected={onClose} />;
      case "computer":
        return <LinkAccountPage context="computer" onDone={home} />;
      case "thanks":
        return <LinkAccountPage context="purchase" onDone={home} />;
    }
  }

  return (
    <div className={styles.sheetScroll}>
      <div className={styles.card}>
        {renderBadge()}
        <button
          className={styles.cardClose}
          onClick={onClose}
          aria-label="Close"
          data-testid="sync-close"
        >
          <IonIcon icon={close} aria-hidden="true" />
        </button>
        {renderView()}
      </div>
    </div>
  );
}

function Pitch({
  products,
  busy,
  problem,
  onPurchased,
  onSignIn,
  onRestore,
  onSelfHost,
}: {
  products: sync.StoreProduct[];
  busy: boolean;
  problem: string | null;
  onPurchased: () => void;
  onSignIn: () => void;
  onRestore: () => void;
  onSelfHost: () => void;
}) {
  const native = isTauri();
  const [presentSheet] = useIonActionSheet();
  return (
    <>
      <div className={styles.cardTitle} data-testid="sync-headline">
        Sync
      </div>
      <p className={styles.cardDescription}>
        Your flights on all your devices,
        <br />
        backed up automatically.
      </p>

      {problem && <p className={styles.errorMessage}>{problem}</p>}

      {/* The plans live right here: a fresh pilot taps Sync, taps a
          price, done. */}
      <SubscribeArea products={products} onPurchased={onPurchased} />

      {/* Sign in is a door, not a place: quiet on iOS (a web-born account
          arriving on a phone), the prominent way back for a subscriber on the
          web. Same testid either way. */}
      <AppleSignInButton
        quiet={native}
        label={
          native ? "Have an account? Sign in" : "Already subscribed? Sign in"
        }
        onClick={onSignIn}
        busy={busy}
        testId="sync-signin"
      />

      {native && (
        <IonButton
          fill="clear"
          size="small"
          className={styles.quietAction}
          disabled={busy}
          onClick={onRestore}
          data-testid="sync-restore"
        >
          Restore Purchases
        </IonButton>
      )}

      {/* Self-host is a LOGIN, reachable from the pitch one tap in. */}
      <IonButton
        fill="clear"
        size="small"
        className={styles.quietAction}
        data-testid="sync-more"
        onClick={() =>
          void presentSheet({
            buttons: [
              {
                text: "Self Hosted",
                handler: onSelfHost,
                htmlAttributes: { "data-testid": "sync-goto-login" },
              },
              { text: "Cancel", role: "cancel" },
            ],
          })
        }
      >
        More options
      </IonButton>
    </>
  );
}
