import {
  IonButton,
  IonContent,
  IonHeader,
  IonIcon,
  IonNav,
  IonTitle,
  IonToolbar,
  useIonAlert,
} from "@ionic/react";
import {
  bookOutline,
  cloudUploadOutline,
  desktopOutline,
} from "ionicons/icons";
import {
  type RefObject,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { isTauri } from "../../engine/platform";
import * as sync from "../../sync";
import {
  AppleSignInButton,
  Connected,
  LinkAccountPage,
  SelfHostLink,
} from "./SyncConnection";
import {
  FinePrint,
  manageSubscription,
  SubscribeArea,
} from "./SyncSubscription";
import { useLogOut } from "./useLogOut";

/**
 * THE sync surface — one sheet, one question ("are my flights backed up?"),
 * every view derived from state (SYNC-UX.md). The payments/connection split
 * stays real in the architecture — and in the file layout (SyncSubscription /
 * SyncConnection) — but it stopped being user-facing geography the day it took
 * two Settings rows and a login vocabulary to explain.
 *
 * Sign-in is a door, not a place: quiet on iOS (a web-born account arriving
 * on a phone — the Stripe future), primary on the web (where it is step one
 * of subscribing once web checkout exists).
 */
export function SyncSheet({ onClose }: { onClose: () => void }) {
  const nav = useRef<HTMLIonNavElement>(null);
  return (
    <IonNav ref={nav} root={() => <SyncHome onClose={onClose} nav={nav} />} />
  );
}

function SyncHome({
  onClose,
  nav,
}: {
  onClose: () => void;
  nav: RefObject<HTMLIonNavElement | null>;
}) {
  const status = useSyncExternalStore(sync.subscribe, sync.currentStatus);
  const account = useSyncExternalStore(sync.subscribe, sync.currentAccount);
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

  async function buy(term: sync.SubscriptionTerm) {
    setBusy(true);
    setProblem(null);
    try {
      await sync.purchase(term);
      // StoreKit's entitlement just changed; re-derive the local copy so a
      // resubscribe's fresh "active" replaces the stale mount-time "expired"
      // (this appleSub cache is otherwise stamped once — see its declaration).
      void sync.appleSubscriptionState().then(setAppleSub);
      // The thank-you/link page gets its own screen (SYNC-UX.md junction 2):
      // the inline offer was cramped and hard to read. Only when the purchase
      // actually connected this device (the supporter guard means a self-
      // hoster's purchase doesn't), and only when NOT already linked: pushing
      // the link offer to a pilot who linked long ago (a resubscribe)
      // contradicts the "Linked" view right behind it.
      const acct = sync.currentAccount();
      if (isTauri() && acct?.kind === "apple" && acct.login !== "apple") {
        void nav.current?.push(() => <LinkAccountPage nav={nav} />);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (/cancelled/i.test(text)) return;
      setProblem(
        /pending/i.test(text)
          ? "This purchase is waiting for approval (Ask to Buy). Once it's approved, tap Subscribe again."
          : text,
      );
    } finally {
      setBusy(false);
    }
  }

  const connected = status.state !== "off";
  // The pitch shows only when there is truly nothing: no connection, no
  // account, no subscription on this device.
  const nothing = !connected && !account && appleSub === null;

  return (
    <>
      <IonHeader collapse="fade" className="sync-home-header">
        <IonToolbar>
          <IonTitle>Sync</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen className="sync-home-content">
        <IonHeader collapse="condense">
          <IonToolbar color=" ">
            <IonTitle size="large">Sync</IonTitle>
          </IonToolbar>
        </IonHeader>
        <div className="sync-home-body">
          {nothing ? (
            <Pitch
              products={products}
              busy={busy}
              problem={problem}
              onBuy={buy}
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
              onConnected={onClose}
            />
          ) : (
            <Connected
              status={status}
              account={account}
              appleSub={appleSub}
              products={products}
              busy={busy || loggingOut}
              problem={problem}
              onBuy={buy}
              onConnect={() => run(() => sync.connectWithSubscription())}
              onLink={() =>
                void nav.current?.push(() => <LinkAccountPage nav={nav} />)
              }
              onSignIn={() => run(() => sync.signIn())}
              onTurnOff={() =>
                isTauri()
                  ? void run(() => sync.disable())
                  : void logOut(onClose)
              }
              onConnected={onClose}
              onDelete={() =>
                presentAlert({
                  header: "Delete account?",
                  // Three facts, shortest true sentences: what dies, what
                  // survives, what keeps billing. (Deleting also turns sync
                  // off, and off persists, so the account cannot resurrect at
                  // launch; a deliberate reconnect minting a fresh empty
                  // account is self-evident when it happens and doesn't earn
                  // alert space.)
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
                        // Keep the alert open: cancelling out there and
                        // deleting here are both still on the table.
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
                })
              }
            />
          )}

          <FinePrint products={products} showTerms={nothing} />
        </div>
      </IonContent>
    </>
  );
}

function Pitch({
  products,
  busy,
  problem,
  onBuy,
  onSignIn,
  onRestore,
  onConnected,
}: {
  products: sync.StoreProduct[];
  busy: boolean;
  problem: string | null;
  onBuy: (term: sync.SubscriptionTerm) => void;
  onSignIn: () => void;
  onRestore: () => void;
  onConnected: () => void;
}) {
  const native = isTauri();
  return (
    <>
      <h2 className="sync-headline" data-testid="sync-headline">
        Your flights, on all your devices.
      </h2>

      <ul className="sync-reasons">
        <li>
          <IonIcon icon={cloudUploadOutline} aria-hidden="true" />
          Backed up off your phone
        </li>
        <li>
          <IonIcon icon={desktopOutline} aria-hidden="true" />
          Plan flights on desktop
        </li>
        <li>
          <IonIcon icon={bookOutline} aria-hidden="true" />
          Your logbook on any device
        </li>
      </ul>

      {problem && <p className="sync-error-message">{problem}</p>}

      <SubscribeArea products={products} busy={busy} onBuy={onBuy} />

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
          className="sync-quiet-action"
          disabled={busy}
          onClick={onRestore}
          data-testid="sync-restore"
        >
          Restore Purchases
        </IonButton>
      )}

      {/* Self-host is a LOGIN and must always be discoverable from the pitch:
          hiding the free path is where honest FOSS monetization stops being
          honest. Pushed in place; back returns right here. */}
      <SelfHostLink onConnected={onConnected} />
    </>
  );
}
