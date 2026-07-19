/// <reference lib="webworker" />
import { clientsClaim } from "workbox-core";
import { createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { NetworkOnly } from "workbox-strategies";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>;
};

self.skipWaiting();
clientsClaim();

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
