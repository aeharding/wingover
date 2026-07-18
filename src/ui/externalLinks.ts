import { isTauri } from "../engine/platform";

// Under Tauri (WKWebView) an external link — the Apple Maps attribution's
// "Legal" credit, say — is swallowed: WKWebView opens neither a
// target="_blank" anchor nor a window.open() without a native UI delegate,
// so a tap just does nothing. Route those to the system browser through the
// opener plugin instead. On the web the browser already does the right
// thing, so this installs nothing.

const isHttp = (url: string): boolean => /^https?:\/\//i.test(url);

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

  // CAPTURE phase, not bubbling: MapKit binds its own handler to the
  // attribution/"Legal" control and stops the event (or preventDefaults it)
  // before a bubbling document listener would ever see it — which is why the
  // link "does nothing." Capturing runs us first, so the click reaches the
  // opener instead of dying in WKWebView's _blank void.
  document.addEventListener(
    "click",
    (event) => {
      // Left-click only, and don't fight a handler that already acted.
      if (event.defaultPrevented || event.button !== 0) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!isHttp(href)) return;
      event.preventDefault();
      openExternal(href);
    },
    true,
  );

  // The other half: some MapKit controls reach the Legal page with
  // window.open() rather than an anchor — no click to intercept above, and
  // WKWebView opens no popup, so it too is a silent no-op. Route http(s)
  // opens to the system browser; everything else (about:blank probes and
  // the like) falls through to the real implementation untouched.
  const nativeOpen = window.open.bind(window);
  window.open = (
    url?: string | URL,
    target?: string,
    features?: string,
  ): Window | null => {
    const href = typeof url === "string" ? url : url?.href;
    if (href && isHttp(href)) {
      openExternal(href);
      return null;
    }
    return nativeOpen(url, target, features);
  };
}
