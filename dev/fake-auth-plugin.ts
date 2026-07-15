import type { IncomingMessage, ServerResponse } from "node:http";

import type { Plugin } from "vite";

/**
 * Fakes the entitlement service for the browser ring.
 *
 * Serves POST /v1/session from the Vite dev server, provisioning a real CouchDB
 * database the same way production does — per-user database, role-scoped
 * membership, and the validate_doc_update that IS the paywall. Only the way
 * credentials are *obtained* is faked; everything the app does afterwards is
 * the production replication path.
 *
 * Mirroring the VDU matters: it makes the lapsed, read-only path — the one a
 * paying pilot must never hit, and the one nobody tests by hand — reachable
 * from an e2e test with `entitled: false`.
 *
 * Dev only. `configureServer` never runs in a build, so this cannot ship.
 */

const COUCH = "http://localhost:5984";
const ADMIN = `Basic ${Buffer.from("admin:password").toString("base64")}`;
const WRITE_ROLE = "wingover:write";

const AUTH_DDOC = {
  _id: "_design/auth",
  validate_doc_update: `function (newDoc, oldDoc, userCtx) {
    if (userCtx.roles.indexOf("_admin") !== -1) return;
    if (userCtx.roles.indexOf("${WRITE_ROLE}") === -1) {
      throw({ forbidden: "Sync is paused: your subscription is inactive. Your flights are still here, and still yours — you can read and export them any time." });
    }
  }`,
};

async function couch(path: string, init: RequestInit = {}) {
  return fetch(`${COUCH}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: ADMIN,
      ...init.headers,
    },
  });
}

async function provision(account: string, entitled: boolean) {
  const userId = `u_dev_${account.replace(/[^a-z0-9_]/gi, "").toLowerCase()}`;
  const dbName = `userdb-${userId}`;
  const password = `dev-${userId}`;

  // The system databases aren't created by the official image's entrypoint,
  // and _users must exist before we can write a user into it.
  await couch("/_users", { method: "PUT" }); // 412 if it exists — fine.
  await couch(`/${dbName}`, { method: "PUT" });
  await couch(`/${dbName}/_security`, {
    method: "PUT",
    body: JSON.stringify({
      admins: { names: [], roles: [] },
      members: { names: [], roles: [userId] },
    }),
  });

  const existingDdoc = await couch(`/${dbName}/_design/auth`);
  const rev = existingDdoc.ok
    ? ((await existingDdoc.json()) as { _rev: string })._rev
    : undefined;
  await couch(`/${dbName}/_design/auth`, {
    method: "PUT",
    body: JSON.stringify(rev ? { ...AUTH_DDOC, _rev: rev } : AUTH_DDOC),
  });

  const userDocId = `org.couchdb.user:${userId}`;
  const existingUser = await couch(`/_users/${encodeURIComponent(userDocId)}`);
  const userRev = existingUser.ok
    ? ((await existingUser.json()) as { _rev: string })._rev
    : undefined;
  await couch(`/_users/${encodeURIComponent(userDocId)}`, {
    method: "PUT",
    body: JSON.stringify({
      ...(userRev && { _rev: userRev }),
      _id: userDocId,
      name: userId,
      type: "user",
      roles: entitled ? [userId, WRITE_ROLE] : [userId],
      password,
    }),
  });

  return { url: COUCH, dbName, username: userId, password, entitled };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) chunks.push(chunk as Uint8Array);
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    return {};
  }
}

export function fakeAuth(): Plugin {
  return {
    name: "wingover-fake-auth",
    configureServer(server) {
      server.middlewares.use(
        "/v1/session",
        (req: IncomingMessage, res: ServerResponse) => {
          void (async () => {
            res.setHeader("content-type", "application/json");
            try {
              const body = await readJson(req);
              const credentials = await provision(
                typeof body.account === "string" ? body.account : "devpilot",
                body.entitled !== false,
              );
              res.end(JSON.stringify(credentials));
            } catch (error) {
              res.statusCode = 500;
              res.end(
                JSON.stringify({
                  error: `fake-auth: is dev CouchDB up? \`docker compose -f dev/couchdb/docker-compose.yml up -d\` — ${String(error)}`,
                }),
              );
            }
          })();
        },
      );
    },
  };
}
