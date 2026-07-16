import {
  IonButton,
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
  cloudUploadOutline,
  desktopOutline,
  logoApple,
} from "ionicons/icons";
import { useEffect, useState, useSyncExternalStore } from "react";

import { isTauri } from "../../engine/platform";
import * as sync from "../../sync";
import { openExternal } from "../externalLinks";
import { describe } from "./describe";
import { SelfHostPage } from "./SelfHostPage";

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
  return <IonNav root={() => <SyncHome onClose={onClose} />} />;
}

function SyncHome({ onClose }: { onClose: () => void }) {
  const status = useSyncExternalStore(sync.subscribe, sync.currentStatus);
  const account = useSyncExternalStore(sync.subscribe, sync.currentAccount);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // null = StoreKit didn't hand us the product — a browser, the desktop dev
  // ring, or App Store Connect not serving it yet.
  const [product, setProduct] = useState<sync.StoreProduct | null>(null);
  // The subscription rail's own state, straight from StoreKit: what makes a
  // supporter or a signed-out subscriber see the truth here.
  const [appleSub, setAppleSub] = useState<"active" | "expired" | null>(null);
  // Post-purchase "use it on your computer" offer (SYNC-UX.md junction 2).
  const [linkOffer, setLinkOffer] = useState<"hidden" | "offered" | "linked">(
    "hidden",
  );
  const [presentAlert] = useIonAlert();

  useEffect(() => {
    void sync.subscriptionProduct().then(setProduct);
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

  async function buy() {
    setBusy(true);
    setProblem(null);
    try {
      await sync.purchase();
      if (isTauri() && sync.currentAccount()?.kind === "apple") {
        setLinkOffer("offered");
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
              product={product}
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
              product={product}
              busy={busy}
              problem={problem}
              linkOffer={linkOffer}
              onBuy={buy}
              onConnect={() => run(() => sync.connectWithSubscription())}
              onLink={() =>
                run(async () => {
                  await sync.linkAppleAccount();
                  setLinkOffer("linked");
                })
              }
              onSkipLink={() => setLinkOffer("hidden")}
              onSignIn={() => run(() => sync.signIn())}
              onTurnOff={() => run(() => sync.disable())}
              onConnected={onClose}
              onDelete={() =>
                presentAlert({
                  header: "Delete account?",
                  // Deleting also turns sync off, and off persists — so the
                  // account can't resurrect by itself at launch. Only an
                  // explicit reconnect re-creates it, and the copy says so.
                  message:
                    account?.kind === "apple" && account.entitled
                      ? "Your subscription is still active, and deleting does not stop billing; cancel it with Apple. While it keeps renewing, turning sync back on would re-create an empty account. Deleting removes your hosted database and every flight on it, permanently. Flights on this device stay here."
                      : "Deletes your hosted database and every flight on it, permanently. Flights on this device stay here. Any subscription is managed by Apple; cancel it in the App Store.",
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

          <FinePrint product={product} showTerms={nothing} />
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
function Pitch({
  product,
  busy,
  problem,
  onBuy,
  onSignIn,
  onRestore,
  onConnected,
}: {
  product: sync.StoreProduct | null;
  busy: boolean;
  problem: string | null;
  onBuy: () => void;
  onSignIn: () => void;
  onRestore: () => void;
  onConnected: () => void;
}) {
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

      {product ? (
        <IonButton
          expand="block"
          disabled={busy}
          onClick={onBuy}
          data-testid="sync-subscribe"
        >
          {busy ? (
            <IonSpinner name="crescent" />
          ) : (
            `Subscribe for ${product.displayPrice}/month`
          )}
        </IonButton>
      ) : isTauri() ? (
        <IonButton expand="block" disabled data-testid="sync-subscribe">
          Subscribe (coming soon)
        </IonButton>
      ) : null}

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

      {isTauri() && (
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
  product,
  busy,
  problem,
  linkOffer,
  onBuy,
  onConnect,
  onLink,
  onSkipLink,
  onSignIn,
  onTurnOff,
  onDelete,
  onConnected,
}: {
  status: sync.SyncStatus;
  account: sync.SyncAccount | null;
  appleSub: "active" | "expired" | null;
  supporter: boolean;
  product: sync.StoreProduct | null;
  busy: boolean;
  problem: string | null;
  linkOffer: "hidden" | "offered" | "linked";
  onBuy: () => void;
  onConnect: () => void;
  onLink: () => void;
  onSkipLink: () => void;
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
            Flights stay on this device.
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

      {/* Resubscribe: the lapse is discovered here, the remedy is a purchase. */}
      {lapsed &&
        (product ? (
          <IonButton
            expand="block"
            disabled={busy}
            onClick={onBuy}
            data-testid="sync-resubscribe"
          >
            {busy ? (
              <IonSpinner name="crescent" />
            ) : (
              `Resubscribe for ${product.displayPrice}/month`
            )}
          </IonButton>
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
        (product ? (
          <IonButton
            expand="block"
            disabled={busy}
            onClick={onBuy}
            data-testid="sync-subscribe"
          >
            {busy ? (
              <IonSpinner name="crescent" />
            ) : (
              `Subscribe for ${product.displayPrice}/month`
            )}
          </IonButton>
        ) : (
          <p className="sync-fine-print" data-testid="sync-signedin-web">
            Signed in. Subscribe in the iOS app to start syncing.
          </p>
        ))}

      {linkOffer === "offered" && (
        <>
          <p className="sync-fine-print">
            Want your flights on your computer? Link your Apple Account: one
            tap, and you can sign in anywhere.
          </p>
          <IonButton
            expand="block"
            className="sync-siwa-button"
            disabled={busy}
            onClick={onLink}
            data-testid="sync-link-offer"
          >
            <IonIcon slot="start" icon={logoApple} aria-hidden="true" />
            Link Apple Account
          </IonButton>
          <IonButton
            fill="clear"
            size="small"
            className="sync-quiet-action"
            onClick={onSkipLink}
            data-testid="sync-link-skip"
          >
            Skip for now
          </IonButton>
        </>
      )}
      {linkOffer === "linked" && (
        <p className="sync-fine-print" data-testid="sync-link-done">
          Linked. Sign in with Apple on your computer to sync there.
        </p>
      )}

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
          {dormant ? "Sign out" : "Turn off sync"}
        </IonButton>
      )}

      {(hosted || supporter || appleSub !== null) && (
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

      {hosted && isTauri() && linkOffer === "hidden" && !dormant && (
        // Junction 2 catch-up for pilots who skipped the post-purchase link.
        // Idempotent server-side; harmless for the already-linked.
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
          Turning sync off forgets this device&apos;s connection, and it stays
          off until you turn it back on. Nothing is deleted: every flight
          stays on this device and on the server. If you subscribe, billing
          is unchanged.
        </p>
      )}
    </>
  );
}

/** Paywall metadata App Review checks for: price, period, terms, privacy. */
function FinePrint({
  product,
  showTerms,
}: {
  product: sync.StoreProduct | null;
  showTerms: boolean;
}) {
  if (!showTerms) return null;
  return (
    <p className="sync-fine-print">
      {product ? `${product.displayPrice}/month, auto-renews` : "Auto-renews"}{" "}
      until cancelled in your App Store settings.{" "}
      <a href="https://www.apple.com/legal/internet-services/itunes/dev/stdeula/">
        Terms of Use
      </a>{" "}
      ·{" "}
      <a href="https://wingover.app/privacy">Privacy Policy</a>
    </p>
  );
}
