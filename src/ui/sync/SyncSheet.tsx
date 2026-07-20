import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonNav,
  IonNavLink,
  IonSpinner,
  IonTitle,
  IonToolbar,
  useIonAlert,
} from "@ionic/react";
import {
  bookOutline,
  chevronBackOutline,
  cloudUploadOutline,
  desktopOutline,
  logoApple,
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
import { openExternal } from "../externalLinks";
import { describe } from "./describe";
import { SelfHostPage } from "./SelfHostPage";
import { useLogOut } from "./useLogOut";

/**
 * THE sync surface — one sheet, one question ("are my flights backed up?"),
 * every view derived from state (SYNC-UX.md). The payments/connection split
 * stays real in the architecture; it stopped being user-facing geography the
 * day it took two Settings rows and a login vocabulary to explain.
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
      // The thank-you/link page gets its own screen (SYNC-UX.md junction 2):
      // the inline offer was cramped and hard to read. Only when the purchase
      // actually connected this device (the supporter guard means a self-
      // hoster's purchase doesn't).
      if (isTauri() && sync.currentAccount()?.kind === "apple") {
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

  const supporter = account?.kind === "manual" && appleSub !== null;
  const connected = status.state !== "off";
  // The pitch shows only when there is truly nothing: no connection, no
  // account, no subscription on this device.
  const nothing = !connected && !account && appleSub === null;

  return (
    <>
      <IonHeader translucent collapse="fade" className="sync-home-header">
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
              supporter={supporter}
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

/** Native: StoreKit's own sheet — the only surface that shows sandbox and
 * TestFlight subscriptions. Web: the public page. */
function manageSubscription() {
  if (isTauri()) {
    void sync.manageSubscriptions().catch(() => {
      openExternal("https://apps.apple.com/account/subscriptions");
    });
  } else {
    openExternal("https://apps.apple.com/account/subscriptions");
  }
}

/**
 * Nothing yet. On iOS the primary is Subscribe (no login exists or is
 * needed); Sign in with Apple sits beneath for the pilot whose account was
 * born elsewhere — the web/Stripe future. On the web those roles flip:
 * sign-in IS the door, and (until web checkout) subscribing lives on the
 * iPhone.
 */
function byTerm(
  products: sync.StoreProduct[],
  term: sync.SubscriptionTerm,
): sync.StoreProduct | undefined {
  return products.find(
    (product) => product.id === sync.SUBSCRIPTION_PRODUCT_IDS[term],
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
  const monthly = byTerm(products, "monthly");
  const yearly = byTerm(products, "yearly");
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

      {monthly ? (
        // iOS: subscribing is the one clear action; the year is a lighter
        // companion beneath it, not a rival for the tap.
        <>
          <IonButton
            expand="block"
            disabled={busy}
            onClick={() => onBuy("monthly")}
            data-testid="sync-subscribe"
          >
            {busy ? (
              <IonSpinner name="crescent" />
            ) : (
              `Subscribe · ${monthly.displayPrice}/month`
            )}
          </IonButton>
          {yearly && (
            <IonButton
              expand="block"
              fill="outline"
              disabled={busy}
              onClick={() => onBuy("yearly")}
              data-testid="sync-subscribe-yearly"
            >
              {`${yearly.displayPrice}/year`}
            </IonButton>
          )}
        </>
      ) : native ? (
        <IonButton expand="block" disabled data-testid="sync-subscribe">
          Subscribe (coming soon)
        </IonButton>
      ) : (
        // Web: no StoreKit, so no buy button and no price to quote. Say what it
        // is and where to get it, rather than a blank screen whose fine print
        // used to promise an App Store renewal that wasn't on it.
        <p className="sync-pitch-note" data-testid="sync-web-note">
          Sync is a subscription, from the Wingover app on your iPhone.
        </p>
      )}

      {/* Sign in is a door, not a place: quiet on iOS (a web-born account
          arriving on a phone), the prominent way back for a subscriber on the
          web. Either way it keeps the same testid. */}
      {native ? (
        <IonButton
          fill="clear"
          size="small"
          className="sync-quiet-action"
          disabled={busy}
          onClick={onSignIn}
          data-testid="sync-signin"
        >
          {busy ? <IonSpinner name="crescent" /> : "Have an account? Sign in"}
        </IonButton>
      ) : (
        <IonButton
          expand="block"
          className="sync-siwa-button"
          disabled={busy}
          onClick={onSignIn}
          data-testid="sync-signin"
        >
          {busy ? (
            <IonSpinner name="crescent" />
          ) : (
            <>
              <IonIcon slot="start" icon={logoApple} aria-hidden="true" />
              Already subscribed? Sign in
            </>
          )}
        </IonButton>
      )}

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

function SelfHostLink({ onConnected }: { onConnected: () => void }) {
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
        className="sync-quiet-action"
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
function Connected({
  status,
  account,
  appleSub,
  supporter,
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
  supporter: boolean;
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
  const { label, detail, tone } = describe(status);
  const off = status.state === "off";
  const dormant = status.state === "unsubscribed";
  const lapsed =
    (status.state === "syncing" && status.readOnly && account?.kind !== "manual") ||
    (off && appleSub === "expired");
  const hosted = account?.kind === "apple";

  return (
    <>
      {off ? (
        // Subscribed (or lapsed) but not connected on this device — the
        // healer state. Rare now that the subscription is a standing opt-in,
        // but a deliberate "Turn off sync" lands here.
        <div className={`sync-state ${appleSub === "expired" ? "sync-state-readonly" : ""}`}>
          <span className="sync-state-label" data-testid="sync-state">
            {appleSub === "expired" ? "Expired" : "Off"}
          </span>
          <span className="sync-state-detail">
            Flights are not being backed up.
          </span>
        </div>
      ) : (
        <div className={`sync-state ${tone}`}>
          <span className="sync-state-label" data-testid="sync-state">
            {supporter && status.state === "syncing" && !status.readOnly
              ? "On"
              : label}
          </span>
          <span className="sync-state-detail">{detail}</span>
        </div>
      )}

      {supporter && (
        <p className="sync-fine-print" data-testid="sync-supporting">
          Subscribed. Thank you for supporting Wingover; your own server stays
          connected.
        </p>
      )}

      {status.state === "error" && (
        <p className="sync-error-message">{status.message}</p>
      )}
      {problem && <p className="sync-error-message">{problem}</p>}

      {/* Turn sync (back) on: subscribed on this device but not connected. */}
      {off && appleSub === "active" && isTauri() && (
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
      {lapsed &&
        (byTerm(products, "monthly") ? (
          <>
            <IonButton
              expand="block"
              disabled={busy}
              onClick={() => onBuy("monthly")}
              data-testid="sync-resubscribe"
            >
              {busy ? (
                <IonSpinner name="crescent" />
              ) : (
                `Resubscribe · ${byTerm(products, "monthly")?.displayPrice}/month`
              )}
            </IonButton>
            {byTerm(products, "yearly") && (
              <IonButton
                expand="block"
                fill="outline"
                disabled={busy}
                onClick={() => onBuy("yearly")}
                data-testid="sync-resubscribe-yearly"
              >
                {`${byTerm(products, "yearly")?.displayPrice}/year`}
              </IonButton>
            )}
          </>
        ) : isTauri() ? (
          <p
            className="sync-fine-print"
            data-testid="sync-resubscribe-unavailable"
          >
            Resubscribing needs the App Store. Check your connection and
            reopen this screen.
          </p>
        ) : (
          <p className="sync-fine-print">Resubscribe on your iPhone.</p>
        ))}

      {/* Dormant: signed in, never subscribed — prompted to subscribe
          (SYNC-UX.md). Web checkout replaces the sentence when it exists. */}
      {dormant &&
        (byTerm(products, "monthly") ? (
          <IonButton
            expand="block"
            disabled={busy}
            onClick={() => onBuy("monthly")}
            data-testid="sync-subscribe"
          >
            {busy ? (
              <IonSpinner name="crescent" />
            ) : (
              `Subscribe for ${byTerm(products, "monthly")?.displayPrice}/month`
            )}
          </IonButton>
        ) : (
          <p className="sync-fine-print" data-testid="sync-signedin-web">
            Signed in. Subscribe in the iOS app to start syncing.
          </p>
        ))}

      {/* Off + a lapsed or absent sub still deserves a way in. */}
      {off && appleSub !== "active" && (
        <IonButton
          expand="block"
          className="sync-siwa-button"
          disabled={busy}
          onClick={onSignIn}
          data-testid="sync-signin"
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
      )}

      {!off && (
        <IonButton
          expand="block"
          fill="outline"
          color="medium"
          disabled={busy}
          onClick={onTurnOff}
          data-testid="sync-off"
        >
          {!isTauri() ? "Log out" : dormant ? "Sign out" : "Turn off sync"}
        </IonButton>
      )}

      {/* A subscription to manage means one exists: never for a dormant
          (signed-in, never-subscribed) account, whose Manage link opened an
          empty App Store page. */}
      {!dormant && (hosted || supporter || appleSub !== null) && (
        <IonButton
          fill="clear"
          size="small"
          className="sync-quiet-action"
          onClick={manageSubscription}
          data-testid="sync-manage"
        >
          Manage Subscription
        </IonButton>
      )}

      {hosted && isTauri() && !dormant && account?.login !== "apple" && (
        // Junction 2 catch-up for pilots who skipped the post-purchase page —
        // opens the same page. Idempotent server-side. Once the server says
        // the Apple Account is linked, the door becomes the note below.
        <IonButton
          fill="clear"
          size="small"
          className="sync-quiet-action"
          disabled={busy}
          onClick={onLink}
          data-testid="sync-link-apple"
        >
          Use on your computer
        </IonButton>
      )}

      {hosted && isTauri() && !dormant && account?.login === "apple" && (
        <p className="sync-fine-print" data-testid="sync-linked-note">
          Linked. Sign in with Apple at wingover.app any time.
        </p>
      )}

      {hosted && !dormant && (
        <IonButton
          fill="clear"
          size="small"
          color="danger"
          className="sync-quiet-action"
          disabled={busy}
          onClick={onDelete}
          data-testid="sync-delete-account"
        >
          Delete account…
        </IonButton>
      )}

      {off && <SelfHostLink onConnected={onConnected} />}

      {!off && !dormant && (
        <p className="sync-fine-print">
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
function LinkAccountPage({
  nav,
}: {
  nav: RefObject<HTMLIonNavElement | null>;
}) {
  // Live, not asserted: this page once claimed "On" while the connect had
  // actually landed read-only (a stale purchase transaction) — the pilot
  // popped back to a contradiction.
  const status = useSyncExternalStore(sync.subscribe, sync.currentStatus);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [linked, setLinked] = useState(false);

  function pop() {
    void nav.current?.pop();
  }

  async function link() {
    setBusy(true);
    setProblem(null);
    try {
      await sync.linkAppleAccount();
      setLinked(true);
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
        <div className="sync-login-body">
          <div className={`sync-state ${describe(status).tone}`}>
            <span className="sync-state-label">{describe(status).label}</span>
            <span className="sync-state-detail">
              {status.state === "syncing" && !status.readOnly
                ? "Your flights now back up automatically."
                : describe(status).detail}
            </span>
          </div>

          {linked ? (
            <p className="sync-login-lede" data-testid="link-page-linked">
              Linked. Sign in with Apple at wingover.app any time.
            </p>
          ) : (
            <>
              <p className="sync-login-lede">
                One optional step: link your Apple Account, and you can sign
                in at wingover.app to see your flights on any computer.
              </p>

              {problem && <p className="sync-error-message">{problem}</p>}

              <IonButton
                expand="block"
                className="sync-siwa-button"
                disabled={busy}
                onClick={link}
                data-testid="link-page-link"
              >
                {busy ? (
                  <IonSpinner name="crescent" />
                ) : (
                  <>
                    <IonIcon slot="start" icon={logoApple} aria-hidden="true" />
                    Link Apple Account
                  </>
                )}
              </IonButton>
              <IonButton
                fill="clear"
                size="small"
                className="sync-quiet-action"
                onClick={pop}
                data-testid="link-page-skip"
              >
                Skip for now
              </IonButton>
              <p className="sync-fine-print">
                You can always do this later from the Sync screen.
              </p>
            </>
          )}
        </div>
      </IonContent>
    </>
  );
}

/** Paywall metadata App Review checks for: price, period, terms, privacy. */
function FinePrint({
  products,
  showTerms,
}: {
  products: sync.StoreProduct[];
  showTerms: boolean;
}) {
  if (!showTerms) return null;
  const monthly = byTerm(products, "monthly");
  const yearly = byTerm(products, "yearly");
  return (
    <p className="sync-fine-print">
      {/* The auto-renew disclosure is App Review's required paywall copy, and it
          belongs only where a purchase happens: with StoreKit products on iOS,
          never on the web, which has no buy button and nothing to renew. */}
      {monthly && (
        <>
          {[
            `${monthly.displayPrice}/month`,
            ...(yearly ? [`or ${yearly.displayPrice}/year`] : []),
            "auto-renews",
          ].join(", ")}{" "}
          until cancelled in your App Store settings.{" "}
        </>
      )}
      <a href="https://www.apple.com/legal/internet-services/itunes/dev/stdeula/">
        Terms of Use
      </a>{" "}
      ·{" "}
      {/* target=_blank: in an installed standalone PWA a same-origin
          navigation would replace the app with a page that has no way
          back (no browser chrome). */}
      <a href="https://wingover.app/privacy" target="_blank" rel="noopener">
        Privacy Policy
      </a>
    </p>
  );
}
