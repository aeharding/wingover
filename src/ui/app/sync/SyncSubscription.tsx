import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonNavLink,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from "@ionic/react";
import { useState } from "react";

import { isTauri } from "../../../platform/index";
import * as sync from "../../../sync/index";
import { openExternal } from "../../shared/externalLinks";

import styles from "./sync.module.css";

/**
 * The Subscription rail (SYNC-UX.md): payments only. The single buy doors
 * (pitch, lapse, dormant), the plan-choice page they all push, Manage
 * Subscription, and the paywall fine print. Nothing here touches connection.
 */

function byTerm(
  products: sync.StoreProduct[],
  term: sync.SubscriptionTerm,
): sync.StoreProduct | undefined {
  return products.find(
    (product) => product.id === sync.SUBSCRIPTION_PRODUCT_IDS[term],
  );
}

/**
 * The one buy door every surface shares: a single verb, no prices. Two
 * priced buttons stacked on the sheet made the pilot price-compare before
 * they had decided to buy at all; the choice now lives on its own page,
 * where each plan carries its full context (Alex, 2026-07-30).
 */
export function PlanGate({
  verb,
  products,
  testId,
  onPurchased,
}: {
  verb: string;
  products: sync.StoreProduct[];
  testId: string;
  onPurchased: () => void;
}) {
  return (
    <IonNavLink
      routerDirection="forward"
      component={() => (
        <ChoosePlanPage products={products} onPurchased={onPurchased} />
      )}
    >
      <IonButton expand="block" data-testid={testId}>
        {verb}
      </IonButton>
    </IonNavLink>
  );
}

/**
 * The paywall: both plans, each self-described, and the required disclosure.
 * Owns its own purchase state so a StoreKit problem surfaces HERE, on the
 * screen the pilot is looking at, never on the view beneath.
 */
export function ChoosePlanPage({
  products,
  onPurchased,
}: {
  products: sync.StoreProduct[];
  onPurchased: () => void;
}) {
  const [buying, setBuying] = useState<sync.SubscriptionTerm | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const monthly = byTerm(products, "monthly");
  const yearly = byTerm(products, "yearly");

  async function buy(term: sync.SubscriptionTerm) {
    setBuying(term);
    setProblem(null);
    try {
      await sync.purchase(term);
      onPurchased();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      // A closed Apple sheet is a non-event, not a problem to display.
      if (/cancelled/i.test(text)) return;
      setProblem(
        /pending/i.test(text)
          ? "This purchase is waiting for approval (Ask to Buy). Once it's approved, tap your plan again."
          : text,
      );
    } finally {
      setBuying(null);
    }
  }

  return (
    <>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton text="Sync" />
          </IonButtons>
          <IonTitle>Choose a plan</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <div className={styles.loginBody}>
          {problem && <p className={styles.errorMessage}>{problem}</p>}

          {monthly && (
            <IonButton
              expand="block"
              disabled={buying !== null}
              onClick={() => void buy("monthly")}
              data-testid="plan-monthly"
            >
              {buying === "monthly" ? (
                <IonSpinner name="crescent" />
              ) : (
                `Monthly · ${monthly.displayPrice}/month`
              )}
            </IonButton>
          )}
          {yearly && (
            <IonButton
              expand="block"
              fill="outline"
              disabled={buying !== null}
              onClick={() => void buy("yearly")}
              data-testid="plan-yearly"
            >
              {buying === "yearly" ? (
                <IonSpinner name="crescent" />
              ) : (
                `Yearly · ${yearly.displayPrice}/year`
              )}
            </IonButton>
          )}

          <p className={styles.finePrint}>
            {/* The auto-renew disclosure is App Review's required paywall
                copy, and this page is the paywall: the one place a purchase
                happens. */}
            Auto-renews until cancelled in your App Store settings.{" "}
            <TermsLinks />
          </p>
        </div>
      </IonContent>
    </>
  );
}

// Pitch buy CTA: the plan door on iOS, a placeholder before products load,
// or a plain line on the web (no StoreKit, so nothing to sell).
export function SubscribeArea({
  products,
  onPurchased,
}: {
  products: sync.StoreProduct[];
  onPurchased: () => void;
}) {
  if (byTerm(products, "monthly"))
    return (
      <PlanGate
        verb="Subscribe"
        products={products}
        testId="sync-subscribe"
        onPurchased={onPurchased}
      />
    );
  if (isTauri())
    return (
      <IonButton expand="block" disabled data-testid="sync-subscribe">
        Subscribe (coming soon)
      </IonButton>
    );
  return (
    <p className={styles.pitchNote} data-testid="sync-web-note">
      Sync is a subscription, from the Wingover app on your iPhone.
    </p>
  );
}

// A lapse's remedy: the plan door, or where to buy when StoreKit can't serve.
export function ResubscribeArea({
  products,
  onPurchased,
}: {
  products: sync.StoreProduct[];
  onPurchased: () => void;
}) {
  if (byTerm(products, "monthly"))
    return (
      <PlanGate
        verb="Resubscribe"
        products={products}
        testId="sync-resubscribe"
        onPurchased={onPurchased}
      />
    );
  if (isTauri())
    return (
      <p
        className={styles.finePrint}
        data-testid="sync-resubscribe-unavailable"
      >
        Resubscribing needs the App Store. Check your connection and reopen this
        screen.
      </p>
    );
  return <p className={styles.finePrint}>Resubscribe on your iPhone.</p>;
}

// Signed in, never subscribed: the plan door on iOS, sign-in-on-iPhone on web.
export function DormantSubscribe({
  products,
  onPurchased,
}: {
  products: sync.StoreProduct[];
  onPurchased: () => void;
}) {
  if (byTerm(products, "monthly"))
    return (
      <PlanGate
        verb="Subscribe"
        products={products}
        testId="sync-subscribe"
        onPurchased={onPurchased}
      />
    );
  return (
    <p className={styles.finePrint} data-testid="sync-signedin-web">
      Signed in. Subscribe in the iOS app to start syncing.
    </p>
  );
}

/** Native: StoreKit's own sheet — the only surface that shows sandbox and
 * TestFlight subscriptions. Web: the public page. */
export function manageSubscription() {
  if (isTauri()) {
    void sync.manageSubscriptions().catch(() => {
      openExternal("https://apps.apple.com/account/subscriptions");
    });
  } else {
    openExternal("https://apps.apple.com/account/subscriptions");
  }
}

/** The two legal links. Shared by the pitch and the plan page. */
export function TermsLinks() {
  return (
    <>
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
    </>
  );
}

/**
 * The pitch's legal footer: links only. The purchase disclosure (prices,
 * period, auto-renew) moved to ChoosePlanPage, the one place a purchase
 * happens — App Review's paywall metadata rides with the paywall.
 */
export function FinePrint({ showTerms }: { showTerms: boolean }) {
  if (!showTerms) return null;
  return (
    <p className={styles.finePrint}>
      <TermsLinks />
    </p>
  );
}
