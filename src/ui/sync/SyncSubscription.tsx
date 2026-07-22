import { IonButton, IonSpinner } from "@ionic/react";

import { isTauri } from "../../engine/platform";
import * as sync from "../../sync";
import { openExternal } from "../externalLinks";

import styles from "./sync.module.css";

/**
 * The Subscription rail (SYNC-UX.md): payments only. The presentational buy
 * CTAs (pitch, lapse, dormant), the plan-button pair they share, Manage
 * Subscription, and the paywall fine print. Pure and stateless — the sheet
 * owns the buy action and passes it down; nothing here touches connection.
 */

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

// The month-primary + year-companion pair, shared by the pitch and a lapse.
export function PlanButtons({
  monthly,
  yearly,
  verb,
  testId,
  busy,
  onBuy,
}: {
  monthly: sync.StoreProduct;
  yearly: sync.StoreProduct | undefined;
  verb: string;
  testId: string;
  busy: boolean;
  onBuy: (term: sync.SubscriptionTerm) => void;
}) {
  return (
    <>
      <IonButton
        expand="block"
        disabled={busy}
        onClick={() => onBuy("monthly")}
        data-testid={testId}
      >
        {busy ? (
          <IonSpinner name="crescent" />
        ) : (
          `${verb} · ${monthly.displayPrice}/month`
        )}
      </IonButton>
      {yearly && (
        <IonButton
          expand="block"
          fill="outline"
          disabled={busy}
          onClick={() => onBuy("yearly")}
          data-testid={`${testId}-yearly`}
        >
          {`${yearly.displayPrice}/year`}
        </IonButton>
      )}
    </>
  );
}

// Pitch buy CTA: the plans on iOS, a placeholder before products load, or a
// plain line on the web (no StoreKit, so no button and no price to quote).
export function SubscribeArea({
  products,
  busy,
  onBuy,
}: {
  products: sync.StoreProduct[];
  busy: boolean;
  onBuy: (term: sync.SubscriptionTerm) => void;
}) {
  const monthly = byTerm(products, "monthly");
  if (monthly)
    return (
      <PlanButtons
        monthly={monthly}
        yearly={byTerm(products, "yearly")}
        verb="Subscribe"
        testId="sync-subscribe"
        busy={busy}
        onBuy={onBuy}
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

// A lapse's remedy: the plans, or where to buy when StoreKit can't serve them.
export function ResubscribeArea({
  products,
  busy,
  onBuy,
}: {
  products: sync.StoreProduct[];
  busy: boolean;
  onBuy: (term: sync.SubscriptionTerm) => void;
}) {
  const monthly = byTerm(products, "monthly");
  if (monthly)
    return (
      <PlanButtons
        monthly={monthly}
        yearly={byTerm(products, "yearly")}
        verb="Resubscribe"
        testId="sync-resubscribe"
        busy={busy}
        onBuy={onBuy}
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

// Signed in, never subscribed: the plans on iOS, sign-in-on-iPhone on the web.
export function DormantSubscribe({
  products,
  busy,
  onBuy,
}: {
  products: sync.StoreProduct[];
  busy: boolean;
  onBuy: (term: sync.SubscriptionTerm) => void;
}) {
  const monthly = byTerm(products, "monthly");
  if (monthly)
    return (
      <PlanButtons
        monthly={monthly}
        yearly={byTerm(products, "yearly")}
        verb="Subscribe"
        testId="sync-subscribe"
        busy={busy}
        onBuy={onBuy}
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

/** Paywall metadata App Review checks for: price, period, terms, privacy. */
export function FinePrint({
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
    <p className={styles.finePrint}>
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
