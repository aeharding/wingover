import type { IncomingMessage, ServerResponse } from "node:http";

import type { Plugin } from "vite";

/**
 * Serves the landing page at exactly `/`, mirroring production's Caddy
 * route (server repo, deploy/Caddyfile: `@root path /` → `rewrite
 * /landing.html`). Without this, dev's `/` boots the SPA and the shell
 * bounces straight to /logbook — so the rail logo (a plain href="/")
 * could never reach the landing on localhost, and the used-flag forward
 * in landing.html's head was untestable outside production.
 *
 * One deliberate seam from Caddy: a query string keeps `/` on the app.
 * The e2e suite launches at `/?mock-speed=…&map-style=blank` (flags are
 * captured from the launch URL), and those sessions are the app under
 * test, not the pitch. Production never sees the difference — nothing
 * links to `/?anything`.
 */
export function landingAtRoot(): Plugin {
  const rewrite = (
    req: IncomingMessage,
    _res: ServerResponse,
    next: () => void,
  ) => {
    if (req.url === "/") req.url = "/landing.html";
    next();
  };
  return {
    name: "wingover-landing-at-root",
    configureServer(server) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite);
    },
  };
}
