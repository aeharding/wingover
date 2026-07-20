/// <reference lib="webworker" />
import { createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { NetworkOnly } from "workbox-strategies";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>;
};

// Deliberately NO skipWaiting / clientsClaim. A new worker WAITS until every
// tab of the old one is gone, then activates on the next cold start — a PWA
// updates on relaunch, like a native app.
//
// The alternative bit us: if a fresh worker claims an open tab, that tab is
// still running the PREVIOUS index.html, whose lazy imports point at old chunk
// hashes (the map adapter, etc.). This deploy no longer serves those hashes, so
// the import 404s and the map dies until a manual refresh. Waiting keeps every
// session on one consistent build, so nothing 404s mid-session.

precacheAndRoute(self.__WB_MANIFEST, { directoryIndex: null });

const appShell = createHandlerBoundToURL("/index.html");

registerRoute(
  new NavigationRoute(appShell, {
    allowlist: [/^\/(fly|logbook|plan|settings|home)(\/|$)/],
  }),
);

registerRoute(
  ({ request, url }) => request.mode === "navigate" && url.pathname === "/",
  async (options) => {
    const mobile = /android|iphone|ipad|ipod/i.test(self.navigator.userAgent);
    if (mobile || options.request.referrer) {
      try {
        return await new NetworkOnly().handle(options);
      } catch {
        return appShell(options);
      }
    }
    return appShell(options);
  },
);
