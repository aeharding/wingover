import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import * as sync from "../../../sync/index";
import { AppleSignInButton } from "./SyncConnection";
import {
  ChoosePlanPage,
  DormantSubscribe,
  PlanGate,
  ResubscribeArea,
  SubscribeArea,
} from "./SyncSubscription";

// The presentational pieces of the sheet, rendered to static markup. This is
// the ONLY coverage of the products (iOS) path: the sync e2e runs on the web,
// where StoreKit serves nothing, so it never sees a real plan button.
const product = (term: sync.SubscriptionTerm, displayPrice: string) =>
  ({
    id: sync.SUBSCRIPTION_PRODUCT_IDS[term],
    displayPrice,
  }) as sync.StoreProduct;

const monthly = product("monthly", "$2.99");
const yearly = product("yearly", "$29.99");
const both = [monthly, yearly];
const noop = () => {};

describe("PlanGate", () => {
  test("one verb, one door, no prices: the choice lives on its own page", () => {
    const html = renderToStaticMarkup(
      <PlanGate
        verb="Resubscribe"
        testId="sync-resubscribe"
        onOpenPlans={noop}
      />,
    );
    expect(html).toContain("Resubscribe");
    expect(html).toContain('data-testid="sync-resubscribe"');
    expect(html).not.toContain("$2.99");
    expect(html).not.toContain("$29.99");
  });
});

describe("ChoosePlanPage", () => {
  test("each plan self-described, and the paywall disclosure beneath", () => {
    const html = renderToStaticMarkup(
      <ChoosePlanPage products={both} onBack={noop} onPurchased={noop} />,
    );
    expect(html).toContain("Monthly · $2.99/month");
    expect(html).toContain("Yearly · $29.99/year");
    expect(html).toContain('data-testid="plan-monthly"');
    expect(html).toContain('data-testid="plan-yearly"');
    expect(html).toContain("Auto-renews until cancelled");
    expect(html).toContain("Terms of Use");
  });

  test("no year button when there is no yearly product", () => {
    const html = renderToStaticMarkup(
      <ChoosePlanPage products={[monthly]} onBack={noop} onPurchased={noop} />,
    );
    expect(html).toContain("Monthly · $2.99/month");
    expect(html).not.toContain("/year");
    expect(html).not.toContain("plan-yearly");
  });
});

describe("AppleSignInButton", () => {
  test("block variant: white button with the Apple glyph", () => {
    const html = renderToStaticMarkup(
      <AppleSignInButton
        label="Sign in with Apple"
        onClick={noop}
        busy={false}
        testId="sync-signin"
      />,
    );
    expect(html).toContain('expand="block"'); // the full-width white button
    expect(html).toContain("Sign in with Apple");
    // The glyph must be a DIRECT slotted child of the button: nested in a
    // span it lands unslotted, mis-sized and un-spaced (measured).
    expect(html).toMatch(/<ion-button[^>]*>\s*<ion-icon[^>]*slot="start"/);
  });

  test("quiet variant: a plain text link, no glyph", () => {
    const html = renderToStaticMarkup(
      <AppleSignInButton
        quiet
        label="Have an account? Sign in"
        onClick={noop}
        busy={false}
        testId="sync-signin"
      />,
    );
    expect(html).toContain('fill="clear"'); // a quiet text link, not a block
    expect(html).toContain("Have an account? Sign in");
    expect(html).not.toContain("ion-icon"); // no glyph
  });
});

// isTauri() is false in the node test env (no Tauri global), so the no-product
// cases exercise the WEB branch; the product branch is platform-independent.
describe("buy areas route by products", () => {
  test("SubscribeArea: the plans inline when products exist (two taps)", () => {
    const html = renderToStaticMarkup(
      <SubscribeArea products={both} onPurchased={noop} />,
    );
    expect(html).toContain("Monthly · $2.99/month");
    expect(html).toContain("Yearly · $29.99/year");
    expect(html).toContain('data-testid="plan-monthly"');
  });

  test("SubscribeArea: the web note when there are no products", () => {
    const html = renderToStaticMarkup(
      <SubscribeArea products={[]} onPurchased={noop} />,
    );
    expect(html).toContain('data-testid="sync-web-note"');
    expect(html).toContain("from the Wingover app on your iPhone");
    expect(html).not.toContain("plan-monthly");
  });

  test("ResubscribeArea: the Resubscribe door when products exist", () => {
    const html = renderToStaticMarkup(
      <ResubscribeArea products={both} onOpenPlans={noop} />,
    );
    expect(html).toContain("Resubscribe");
    expect(html).toContain('data-testid="sync-resubscribe"');
    expect(html).not.toContain("$2.99");
  });

  test("ResubscribeArea: points to the iPhone on the web", () => {
    const html = renderToStaticMarkup(
      <ResubscribeArea products={[]} onOpenPlans={noop} />,
    );
    expect(html).toContain("Resubscribe on your iPhone");
  });

  test("DormantSubscribe: the Subscribe door when products exist", () => {
    const html = renderToStaticMarkup(
      <DormantSubscribe products={both} onOpenPlans={noop} />,
    );
    expect(html).toContain("Subscribe");
    expect(html).toContain('data-testid="sync-subscribe"');
    expect(html).not.toContain("$2.99");
  });

  test("DormantSubscribe: the signed-in web line with no products", () => {
    const html = renderToStaticMarkup(
      <DormantSubscribe products={[]} onOpenPlans={noop} />,
    );
    expect(html).toContain('data-testid="sync-signedin-web"');
  });
});
