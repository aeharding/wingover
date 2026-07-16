import { isTauri } from "../engine/platform";

// Under Tauri (WKWebView) an external link — the map's attribution credits,
// say — is swallowed on tap or would navigate away inside the app. Catch
// clicks on external http(s) links and hand them to the opener plugin so
// they open in the system browser. On the web the browser already does the
// right thing, so this installs nothing.
/**
 * Open an external URL from code (not an anchor — the click handler below
 * only sees anchors): system browser under Tauri, new tab on the web. For
 * places like alert buttons, where there is no <a> to intercept.
 */
export function openExternal(url: string): void {
  if (isTauri()) {
    // Loaded lazily so the opener plugin never enters the web bundle path.
    void import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
      openUrl(url),
    );
  } else {
    window.open(url, "_blank", "noopener");
  }
}

export function installExternalLinkHandler(): void {
  if (!isTauri()) return;
  document.addEventListener("click", (event) => {
    // Left-click only, and don't fight a handler that already acted.
    if (event.defaultPrevented || event.button !== 0) return;
    const anchor = (event.target as Element | null)?.closest?.("a[href]");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (!/^https?:\/\//i.test(href)) return;
    event.preventDefault();
    // Loaded lazily so the opener plugin never enters the web bundle path.
    void import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
      openUrl(href),
    );
  });
}
