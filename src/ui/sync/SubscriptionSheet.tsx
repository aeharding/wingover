import {
  IonButton,
  IonContent,
  IonHeader,
  IonIcon,
  IonNav,
  IonNavLink,
  IonTitle,
  IonToolbar,
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
import { SelfHostPage } from "./SelfHostPage";

/**
 * Payments only (SYNC-UX.md): subscribe, restore, resubscribe, manage, fine
 * print. Never a sync status or a logout. The one exception is deliberate:
 * "Prefer to self-host?" pushes the Log In rail's own-server form IN PLACE —
 * a nav push with a back chevron to the pitch, because closing this modal to
 * open another one for a link the pilot just tapped reads as a glitch.
 */
export function SubscriptionSheet({ onClose }: { onClose: () => void }) {
  return (
    <IonNav root={() => <SubscriptionHome onClose={onClose} />} />
  );
}

function SubscriptionHome({ onClose }: { onClose: () => void }) {
  const account = useSyncExternalStore(sync.subscribe, sync.currentAccount);
  const status = useSyncExternalStore(sync.subscribe, sync.currentStatus);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A supporter's purchase leaves their own-server login untouched (the
  // junction 2 guard), so `account` won't flip to apple — this is the receipt.
  const [supporting, setSupporting] = useState(false);
  // The post-purchase link interstitial (SYNC-UX.md junction 2): offered once,
  // right after buying, when the motivation is highest. Always skippable —
  // account creation stays optional (guideline 5.1.1).
  const [linkOffer, setLinkOffer] = useState<"hidden" | "offered" | "linked">(
    "hidden",
  );
  // null = StoreKit didn't hand us the product — a browser, the desktop dev
  // ring, or App Store Connect not serving it yet. Subscribe stays honestly
  // disabled in all of those; it only goes live once a tap can succeed.
  const [product, setProduct] = useState<sync.StoreProduct | null>(null);
  // The rail's own state, from StoreKit: what makes the supporter and the
  // signed-out lapsed pilot see their subscription here at all.
  const [appleSub, setAppleSub] = useState<"active" | "expired" | null>(null);

  useEffect(() => {
    void sync.subscriptionProduct().then(setProduct);
    void sync.appleSubscriptionState().then(setAppleSub);
  }, []);

  // "unsubscribed" is the sign-in-born account: logged in, never entitled.
  // That pilot belongs on the pitch (with a subscribe prompt), not on the
  // Active/Expired status view — "Expired" would be a lie about an account
  // that never had a subscription to expire. StoreKit's word counts even
  // with no hosted login held (supporter; lapsed-and-logged-out).
  const subscribed =
    appleSub !== null ||
    (account?.kind === "apple" && status.state !== "unsubscribed");
  const entitled =
    appleSub === "active" ||
    (account?.kind === "apple" &&
      account.entitled &&
      status.state !== "unsubscribed");

  async function buy() {
    setBusy(true);
    setProblem(null);
    try {
      await sync.purchase();
      if (sync.currentAccount()?.kind === "manual") setSupporting(true);
      else if (isTauri()) setLinkOffer("offered");
      // No close: the sheet re-renders as Active (or the supporter thank-you),
      // and seeing it is the receipt.
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      // The pilot closed Apple's sheet. Nothing is wrong; say nothing.
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

  // Restore lives here (App Review expects it near the price) and connects the
  // device it runs on — the same junction as a purchase. The Log In page's
  // "Use my subscription" door is the same code path approached from the
  // connection side.
  async function restore() {
    setBusy(true);
    setProblem(null);
    try {
      const jws = await sync.probeEntitlementJWS();
      if (!jws) {
        setProblem("No subscription found for this Apple Account.");
        return;
      }
      await sync.connectWithSubscription(jws);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

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

  return (
    <>
      {/* The iOS large-title pair: collapse="fade" leaves the bar with no
          background until you scroll, collapse="condense" is the big title
          that shrinks into it, and fullscreen lets the photo run under both.
          color=" " is what keeps the condensed toolbar transparent over the
          photo — a blank color emits an ion-color- class with no palette
          behind it, so no background is painted. Same trick Voyager uses on
          its Welcome screen. */}
      <IonHeader translucent collapse="fade" className="sync-home-header">
        <IonToolbar>
          <IonTitle>Subscription</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen className="sync-home-content">
        <IonHeader collapse="condense">
          <IonToolbar color=" ">
            <IonTitle size="large">Subscription</IonTitle>
          </IonToolbar>
        </IonHeader>
        <div className="sync-home-body">
          {subscribed ? (
            <Subscribed
              entitled={entitled}
              product={product}
              busy={busy}
              problem={problem}
              onResubscribe={buy}
              linkOffer={linkOffer}
              onLink={() =>
                run(async () => {
                  await sync.linkAppleAccount();
                  setLinkOffer("linked");
                })
              }
              onSkipLink={() => setLinkOffer("hidden")}
            />
          ) : (
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

              {supporting ? (
                <p className="sync-fine-print" data-testid="sync-supporting">
                  Subscribed — thank you for supporting Wingover. Your own
                  server stays connected.
                </p>
              ) : product ? (
                // displayPrice is Apple's localized string; "/month" is safe to
                // append because the only product we sell is the monthly.
                <IonButton
                  expand="block"
                  disabled={busy}
                  onClick={buy}
                  data-testid="sync-subscribe"
                >
                  Subscribe — {product.displayPrice}/month
                </IonButton>
              ) : isTauri() ? (
                // StoreKit exists but has no product behind it, so a tap could
                // only fail — the button says so rather than lying.
                <IonButton expand="block" disabled data-testid="sync-subscribe">
                  Subscribe — coming soon
                </IonButton>
              ) : account ? (
                // Already signed in, never subscribed — the prompt-to-
                // subscribe resting state (SYNC-UX.md). Web checkout replaces
                // this sentence when it exists.
                <p className="sync-fine-print" data-testid="sync-signedin-web">
                  Signed in — subscribe in the iOS app to start syncing.
                </p>
              ) : (
                // The PWA pitch leads with identity, right here (SYNC-UX.md):
                // sign in, and a valid subscription connects on the spot —
                // the common case, done in one tap. Signed in WITHOUT one, the
                // pilot lands in the resting state above.
                <IonButton
                  expand="block"
                  className="sync-siwa-button"
                  disabled={busy}
                  onClick={() => run(() => sync.signIn())}
                  data-testid="sync-signin-web"
                >
                  <IonIcon slot="start" icon={logoApple} aria-hidden="true" />
                  Sign in with Apple
                </IonButton>
              )}

              {isTauri() && !supporting && (
                <IonButton
                  fill="clear"
                  size="small"
                  className="sync-quiet-action"
                  disabled={busy}
                  onClick={restore}
                  data-testid="sync-restore"
                >
                  Restore Purchases
                </IonButton>
              )}

              {/* Self-host is a LOGIN (the form is the Log In rail's page),
                  and must always be discoverable from the pitch — hiding the
                  free path is where honest FOSS monetization stops being
                  honest. Pushed in place: the tap already said what the pilot
                  wants, and back returns them right here. */}
              <IonNavLink
                routerDirection="forward"
                component={() => (
                  <SelfHostPage backText="Subscription" onConnected={onClose} />
                )}
              >
                <IonButton
                  expand="block"
                  fill="clear"
                  className="sync-selfhost-toggle"
                  data-testid="sync-goto-login"
                >
                  Self-host config
                </IonButton>
              </IonNavLink>
            </>
          )}

          <FinePrint product={product} />
        </div>
      </IonContent>
    </>
  );
}

/**
 * The subscribed view. Expired is amber territory, not red: the pilot's
 * flights are all still there, readable and pullable — resubscribing buys
 * writes back (STEERING: paying buys writes, not reads).
 */
function Subscribed({
  entitled,
  product,
  busy,
  problem,
  onResubscribe,
  linkOffer,
  onLink,
  onSkipLink,
}: {
  entitled: boolean;
  product: sync.StoreProduct | null;
  busy: boolean;
  problem: string | null;
  onResubscribe: () => void;
  linkOffer: "hidden" | "offered" | "linked";
  onLink: () => void;
  onSkipLink: () => void;
}) {
  return (
    <>
      <div className={`sync-state ${entitled ? "" : "sync-state-readonly"}`}>
        <span className="sync-state-label" data-testid="subscription-state">
          {entitled ? "Active" : "Expired"}
        </span>
        <span className="sync-state-detail">
          {entitled
            ? "Renews automatically. Manage or cancel with Apple."
            : "Your flights are safe. Resubscribe to sync new ones."}
        </span>
      </div>

      {problem && <p className="sync-error-message">{problem}</p>}

      {linkOffer === "offered" && (
        <>
          <p className="sync-fine-print">
            Want your flights on your computer? Link your Apple Account — one
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
          Linked — sign in with Apple on your computer to sync there.
        </p>
      )}

      {!entitled &&
        (product ? (
          <IonButton
            expand="block"
            disabled={busy}
            onClick={onResubscribe}
            data-testid="sync-resubscribe"
          >
            Resubscribe — {product.displayPrice}/month
          </IonButton>
        ) : (
          // No product means no App Store right now (offline at a remote
          // field, most likely). A silently-disabled button reads as broken;
          // a sentence reads as read-only-and-safe, which is the truth.
          <p
            className="sync-fine-print"
            data-testid="sync-resubscribe-unavailable"
          >
            Resubscribing needs the App Store — check your connection and
            reopen this screen.
          </p>
        ))}

      {/* A plain anchor: under Tauri the external-link handler hands it to the
          system browser; billing lives with Apple, never in here. */}
      <IonButton
        expand="block"
        fill="outline"
        color="medium"
        href="https://apps.apple.com/account/subscriptions"
        data-testid="sync-manage"
      >
        Manage Subscription
      </IonButton>
    </>
  );
}

/**
 * The paywall metadata App Review checks for: price, period, terms, privacy.
 * Terms is Apple's standard EULA; the privacy page is ours.
 */
function FinePrint({ product }: { product: sync.StoreProduct | null }) {
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
