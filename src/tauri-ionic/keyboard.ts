/**
 * On-screen keyboard layout — the DOM half of the native keyboard handling.
 *
 * IonicPlugin.keyboardWillChange (tauri-plugin-ionic, Swift) does the
 * WKWebView-only work (pinning the scroll view, hiding the accessory bar)
 * and then dispatches `keyboardWillShow` / `keyboardWillHide` on window —
 * the same events Capacitor's Keyboard plugin fires, so Ionic's tab bar and
 * footer also hide themselves off them (createKeyboardController). Here we
 * do the rest, in the web layer where the app's layout lives:
 *
 *   - resize <ion-app> to (window height − keyboard height) so content sits
 *     above the keyboard. <ion-app>'s `100%` is the full webview height, so
 *     `calc(100% − <kb>px)` is that height — and it self-corrects on rotation,
 *     unlike a px value computed once natively.
 *   - flag <html>.keyboard-open, off which theme.css collapses the bottom safe
 *     area (dead space behind the keyboard).
 *
 * Dormant everywhere but on-device: only the native plugin fires these events.
 */

interface KeyboardEventDetail {
  keyboardHeight?: number;
}

function onKeyboardWillShow(event: Event) {
  const keyboardHeight =
    (event as CustomEvent<KeyboardEventDetail>).detail?.keyboardHeight ?? 0;

  requestAnimationFrame(() => {
    const app = document.querySelector<HTMLElement>("ion-app");
    if (app) app.style.height = `calc(100% - ${keyboardHeight}px)`;
    document.documentElement.classList.add("keyboard-open");
  });
}

function onKeyboardWillHide() {
  requestAnimationFrame(() => {
    const app = document.querySelector<HTMLElement>("ion-app");
    if (app) app.style.removeProperty("height");
    document.documentElement.classList.remove("keyboard-open");
  });
}

export function installKeyboardLayout() {
  window.addEventListener("keyboardWillShow", onKeyboardWillShow);
  window.addEventListener("keyboardWillHide", onKeyboardWillHide);
}
