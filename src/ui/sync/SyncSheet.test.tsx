import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import * as sync from "../../sync";
import {
  AppleSignInButton,
  DormantSubscribe,
  PlanButtons,
  ResubscribeArea,
  SubscribeArea,
} from "./SyncSheet";

// The presentational pieces of the sheet, rendered to static markup. This is
// the ONLY coverage of the products (iOS) path: the sync e2e runs on the web,
// where StoreKit serves nothing, so it never sees a real plan button.
const product = (term: sync.SubscriptionTerm, displayPrice: string) =>
  ({ id: sync.SUBSCRIPTION_PRODUCT_IDS[term], displayPrice }) as sync.StoreProduct;

const monthly = product("monthly", "$2.99");
const yearly = product("yearly", "$29.99");
const both = [monthly, yearly];
const noop = () => {};

describe("PlanButtons", () => {
  test("a filled month with the verb, and a price-only year beneath it", () => {
    const html = renderToStaticMarkup(
      <PlanButtons
        monthly={monthly}
        yearly={yearly}
        verb="Subscribe"
        testId="sync-subscribe"
        busy={false}
        onBuy={noop}
      />,
    );
    expect(html).toContain("Subscribe · $2.99/month");
    expect(html).toContain("$29.99/year");
    expect(html).toContain('data-testid="sync-subscribe"');
    expect(html).toContain('data-testid="sync-subscribe-yearly"');
  });

  test("no year button, and no -yearly testid, when there is no yearly product", () => {
    const html = renderToStaticMarkup(
      <PlanButtons
        monthly={monthly}
        yearly={undefined}
        verb="Resubscribe"
        testId="sync-resubscribe"
        busy={false}
        onBuy={noop}
      />,
    );
    expect(html).toContain("Resubscribe · $2.99/month");
    expect(html).not.toContain("/year");
    expect(html).not.toContain("sync-resubscribe-yearly");
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
    expect(html).toContain("ion-icon"); // the Apple glyph
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
  test("SubscribeArea: the plans when products exist", () => {
    const html = renderToStaticMarkup(
      <SubscribeArea products={both} busy={false} onBuy={noop} />,
    );
    expect(html).toContain("Subscribe · $2.99/month");
    expect(html).toContain('data-testid="sync-subscribe"');
  });

  test("SubscribeArea: the web note when there are no products", () => {
    const html = renderToStaticMarkup(
      <SubscribeArea products={[]} busy={false} onBuy={noop} />,
    );
    expect(html).toContain('data-testid="sync-web-note"');
    expect(html).toContain("from the Wingover app on your iPhone");
    expect(html).not.toContain("sync-subscribe");
  });

  test("ResubscribeArea: Resubscribe plans when products exist", () => {
    const html = renderToStaticMarkup(
      <ResubscribeArea products={both} busy={false} onBuy={noop} />,
    );
    expect(html).toContain("Resubscribe · $2.99/month");
    expect(html).toContain('data-testid="sync-resubscribe"');
  });

  test("ResubscribeArea: points to the iPhone on the web", () => {
    const html = renderToStaticMarkup(
      <ResubscribeArea products={[]} busy={false} onBuy={noop} />,
    );
    expect(html).toContain("Resubscribe on your iPhone");
  });

  test("DormantSubscribe: Subscribe plans when products exist", () => {
    const html = renderToStaticMarkup(
      <DormantSubscribe products={both} busy={false} onBuy={noop} />,
    );
    expect(html).toContain("Subscribe · $2.99/month");
  });

  test("DormantSubscribe: the signed-in web line with no products", () => {
    const html = renderToStaticMarkup(
      <DormantSubscribe products={[]} busy={false} onBuy={noop} />,
    );
    expect(html).toContain('data-testid="sync-signedin-web"');
  });
});
