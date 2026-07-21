import { expect, test } from "@playwright/test";

// The DOM half of keyboard handling (src/tauri-ionic/keyboard.ts +
// theme.css). On device, tauri-plugin-ionic's IonicPlugin dispatches
// Capacitor-named keyboardWillShow/Hide window events; here we dispatch them
// synthetically and assert the web layer's full reaction. The native half
// (scroll pinning, accessory bar, event dispatch itself) is out of browser
// reach; it's covered on-simulator.

function showKeyboard(
  page: import("@playwright/test").Page,
  keyboardHeight: number,
) {
  return page.evaluate((height) => {
    window.dispatchEvent(
      new CustomEvent("keyboardWillShow", {
        detail: { keyboardHeight: height },
      }),
    );
  }, keyboardHeight);
}

function hideKeyboard(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("keyboardWillHide"));
  });
}

test("keyboard events resize ion-app, collapse the safe area, and hide the tab bar", async ({
  page,
}) => {
  await page.goto("/?map-style=blank");
  await expect(page.locator("ion-tab-bar")).toBeVisible();

  await showKeyboard(page, 300);

  // <ion-app> shrinks by exactly the keyboard height (rAF-deferred, so retry).
  await expect(page.locator("ion-app")).toHaveAttribute(
    "style",
    /calc\(100% - 300px\)/,
  );
  await expect(page.locator("html")).toHaveClass(/keyboard-open/);
  // The bottom inset is dead space behind the keyboard — forced to zero.
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--safe-area-inset-bottom")
          .trim(),
      ),
    )
    .toBe("0px");
  // Ionic's own keyboard controller reacts to the same events (that's why the
  // native side uses Capacitor's event names) and hides the tab bar.
  await expect(page.locator("ion-tab-bar")).toBeHidden();

  await hideKeyboard(page);

  await expect(page.locator("ion-app")).not.toHaveAttribute(
    "style",
    /calc\(100% - 300px\)/,
  );
  await expect(page.locator("html")).not.toHaveClass(/keyboard-open/);
  await expect(page.locator("ion-tab-bar")).toBeVisible();
});

test("keyboard height updates in place when the keyboard changes size", async ({
  page,
}) => {
  await page.goto("/?map-style=blank");

  // e.g. emoji search or an autocorrect bar changing the keyboard's height:
  // iOS fires another willShow with the new height, no willHide between.
  await showKeyboard(page, 300);
  await expect(page.locator("ion-app")).toHaveAttribute(
    "style",
    /calc\(100% - 300px\)/,
  );

  await showKeyboard(page, 260);
  await expect(page.locator("ion-app")).toHaveAttribute(
    "style",
    /calc\(100% - 260px\)/,
  );

  await hideKeyboard(page);
  await expect(page.locator("html")).not.toHaveClass(/keyboard-open/);
});
