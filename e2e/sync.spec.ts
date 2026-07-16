import { expect, test } from "@playwright/test";

/**
 * Sync, end to end, against a real CouchDB — no Apple, no StoreKit, no Mac.
 *
 * Requires the dev database:
 *   docker compose -f dev/couchdb/docker-compose.yml up -d
 *
 * Only the credential is faked (dev/fake-auth-plugin.ts provisions a real
 * per-user database with the real validate_doc_update). Everything these tests
 * exercise — replication, the paywall, isolation — is the production path.
 */

const COUCH = "http://localhost:5984";

/** Skip rather than fail when the dev database isn't running. */
test.beforeAll(async ({ request }) => {
  const up = await request.get(`${COUCH}/_up`).catch(() => null);
  test.skip(
    !up?.ok(),
    "dev CouchDB not running — `docker compose -f dev/couchdb/docker-compose.yml up -d`",
  );
});

/**
 * Drives the real sync module inside the page, the way the UI will.
 *
 * The specifiers are variables, not literals: this code is serialized and run
 * in the browser, where Vite's dev server resolves them — but tsc would try to
 * resolve them against the filesystem and fail. A variable keeps it honest
 * without an inline suppression.
 */
async function enableSync(
  page: import("@playwright/test").Page,
  account: string,
  entitled = true,
) {
  return page.evaluate(
    async ([account, entitled]) => {
      const specifier = "/src/sync/index.ts";
      const sync = (await import(/* @vite-ignore */ specifier)) as {
        enable(provider: unknown): Promise<void>;
        fakeProvider(options: { account: string; entitled: boolean }): unknown;
      };
      await sync.enable(
        sync.fakeProvider({
          account: account as string,
          entitled: entitled as boolean,
        }),
      );
    },
    [account, entitled] as const,
  );
}

/** Settings → Sync → Self-hosted config: the door every self-host test walks. */
async function openOwnServerForm(page: import("@playwright/test").Page) {
  await page.getByTestId("settings-sync").click();
  await page.getByTestId("sync-goto-login").click();
}

/**
 * page.reload(), resilient to this machine's network-interface flaps:
 * Chromium aborts in-flight module loads with ERR_NETWORK_CHANGED when an
 * interface churns mid-reload (captured in traces; ~1 run in 3), leaving a
 * half-booted page and a test that hangs on the next click. A real pilot
 * hits refresh; so does this.
 */
async function reloadUntilReady(page: import("@playwright/test").Page) {
  for (let attempt = 0; ; attempt++) {
    await page.reload();
    try {
      await expect(page.getByTestId("settings-sync")).toBeVisible({
        timeout: 5_000,
      });
      return;
    } catch (error) {
      if (attempt >= 2) throw error;
    }
  }
}

test("a flight recorded on one device appears on another", async ({
  browser,
}) => {
  const account = `conv${Date.now()}`;

  // Device A: record a real flight, then sync it up.
  // Separate CONTEXTS, not pages: pages share the default context's
  // IndexedDB, so "device B" would already hold device A's flight and the
  // test would pass without replicating a single byte.
  const contextA = await browser.newContext();
  const a = await contextA.newPage();
  await a.goto("/?mock-speed=40&map-style=blank");
  await a.getByRole("button", { name: "Start Flight" }).click();
  await expect(a.getByTestId("recording")).toBeVisible({ timeout: 15_000 });
  await a.getByRole("button", { name: /stop/i }).click();
  await a
    .getByRole("button", { name: /stop|confirm|end/i })
    .last()
    .click();

  await a.goto("/logbook?map-style=blank");
  const recorded = a.locator("ion-item, .flight-row").first();
  await expect(recorded).toBeVisible({ timeout: 15_000 });

  await enableSync(a, account);

  // Device B: a different browser profile — different IndexedDB, nothing
  // shared but the account.
  const contextB = await browser.newContext();
  const b = await contextB.newPage();
  await b.goto("/logbook?map-style=blank");
  await enableSync(b, account);

  // Asserted in the UI, not the database: device B is already LOOKING at its
  // logbook, and the flight must appear with no reload and no tab revisit —
  // the page subscribes to the local database's changes feed, which fires for
  // replicated pulls the same as for local writes.
  await expect(b.locator("ion-item, .flight-row").first()).toBeVisible({
    timeout: 30_000,
  });

  await contextA.close();
  await contextB.close();
});

test("settings do not replicate between devices", async ({ browser }) => {
  const account = `settings${Date.now()}`;

  const contextA = await browser.newContext();
  const a = await contextA.newPage();
  await a.goto("/?map-style=blank");
  await enableSync(a, account);
  await a.evaluate(async () => {
    const specifier = "/src/storage/local.ts";
    const { setSetting } = (await import(/* @vite-ignore */ specifier)) as {
      setSetting(key: string, value: string): Promise<void>;
    };
    await setSetting("mapView", "satellite");
  });

  const contextB = await browser.newContext();
  const b = await contextB.newPage();
  await b.goto("/?map-style=blank");
  await enableSync(b, account);

  // Device preferences are device-local. A phone strapped to a leg has no
  // business dictating the map view on a laptop — this is the whole reason
  // settings were split out of the synced database.
  await a.waitForTimeout(3000);
  expect(
    await b.evaluate(async () => {
      const specifier = "/src/storage/local.ts";
      const { getSetting } = (await import(/* @vite-ignore */ specifier)) as {
        getSetting(key: string): Promise<string | null>;
      };
      return getSetting("mapView");
    }),
  ).toBeNull();

  await contextA.close();
  await contextB.close();
});

test("a lapsed client replicates pull-only and never pushes into a 403", async ({
  browser,
}) => {
  const account = `pullonly${Date.now()}`;
  const page = await browser.newPage();
  await page.goto("/?map-style=blank");

  // Record the client's own status stream. Asserting the server 403s proves
  // CouchDB works, not that the client mirrors it — this is the difference.
  await page.evaluate(async () => {
    const specifier = "/src/sync/index.ts";
    const sync = (await import(/* @vite-ignore */ specifier)) as {
      subscribe(fn: () => void): () => void;
      currentStatus(): unknown;
    };
    const log: string[] = [];
    (globalThis as unknown as { __syncLog: string[] }).__syncLog = log;
    sync.subscribe(() => log.push(JSON.stringify(sync.currentStatus())));
  });

  await enableSync(page, account, false);

  // Give the lapsed client something it would push, if it were going to.
  await page.evaluate(async () => {
    const specifier = "/src/storage/db.ts";
    const { db } = (await import(/* @vite-ignore */ specifier)) as {
      db: { put(doc: Record<string, unknown>): Promise<unknown> };
    };
    await db.put({
      _id: `flight:lapsed-${Date.now()}`,
      name: "recorded while lapsed",
      startedAt: Date.now(),
    });
  });
  await page.waitForTimeout(4000);

  const log = await page.evaluate(() =>
    (globalThis as unknown as { __syncLog: string[] }).__syncLog.join("|"),
  );
  // A push would be denied, and PouchDB advances the checkpoint past a denied
  // doc — so this flight would never be pushed again, not even after renewal.
  // The client must not try.
  expect(log).not.toContain("denied");
  expect(log).toContain('"readOnly":true');

  await page.close();
});

test("one sheet: pitch when nothing, self-host connects, status when on", async ({
  browser,
  request,
}) => {
  const errors: string[] = [];
  const account = `ui${Date.now()}`;
  // Self-host is a real path today: no Apple, no StoreKit, no subscription.
  const credentials = (await request
    .post("http://localhost:5173/v1/session", {
      data: { fake: true, account, entitled: true },
    })
    .then((r) => r.json())) as {
    url: string;
    dbName: string;
    username: string;
    password: string;
  };

  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/settings?map-style=blank");

  // One row, one question (SYNC-UX.md): are the flights backed up? Off is
  // never a neutral dash — it reads red "⊗ Off" without the pilot opening
  // anything.
  await expect(page.getByTestId("settings-sync")).toContainText("Off");

  // Nothing yet → the pitch. On the web the hosted door is Sign in with
  // Apple (step one of subscribing, once web checkout exists); no status
  // block renders.
  await page.getByTestId("settings-sync").click();
  await expect(page.getByTestId("sync-headline")).toBeVisible();
  await expect(page.getByTestId("sync-state")).toHaveCount(0);
  await expect(page.getByTestId("sync-signin")).toBeVisible();

  // Self-hosted config pushes the form IN PLACE — a nav push inside the one
  // sheet, never a second modal.
  await page.getByTestId("sync-goto-login").click();
  await page.getByLabel("Server").fill(credentials.url);
  await page.getByLabel("Database").fill(credentials.dbName);
  await page.getByLabel("Username").fill(credentials.username);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByTestId("sync-connect").click();

  await expect(page.getByTestId("settings-sync")).toContainText("On", {
    timeout: 15_000,
  });

  // ...and off again, without deleting anything: back to the pitch.
  await page.getByTestId("settings-sync").click();
  await expect(page.getByTestId("sync-state")).toHaveText("On");
  await page.getByTestId("sync-off").click();
  await expect(page.getByTestId("sync-headline")).toBeVisible();

  expect(errors).toEqual([]);
  await context.close();
});

test("a lapsed subscription is read-only on the server, never locked out", async ({
  browser,
  request,
}) => {
  const account = `lapsed${Date.now()}`;
  const page = await browser.newPage();
  await page.goto("/?map-style=blank");
  await enableSync(page, account, false);

  const credentials = (await request
    .post("http://localhost:5173/v1/session", {
      data: { fake: true, account, entitled: false },
    })
    .then((r) => r.json())) as {
    dbName: string;
    username: string;
    password: string;
  };
  const auth = {
    Authorization: `Basic ${Buffer.from(
      `${credentials.username}:${credentials.password}`,
    ).toString("base64")}`,
  };

  // Reading your own flights must always work — that is the promise.
  expect(
    (
      await request.get(`${COUCH}/${credentials.dbName}/_all_docs`, {
        headers: auth,
      })
    ).status(),
  ).toBe(200);

  // Writing must not. The server, not the client, enforces this.
  expect(
    (
      await request.put(`${COUCH}/${credentials.dbName}/nope:1`, {
        headers: auth,
        data: {},
      })
    ).status(),
  ).toBe(403);

  await page.close();
});

/**
 * Provision a real self-host target: a per-user CouchDB with the real
 * validate_doc_update. Only the credential is faked.
 */
async function provision(
  request: import("@playwright/test").APIRequestContext,
  account: string,
) {
  return (await request
    .post("http://localhost:5173/v1/session", {
      data: { fake: true, account, entitled: true },
    })
    .then((r) => r.json())) as {
    url: string;
    dbName: string;
    username: string;
    password: string;
  };
}

test("sync survives a relaunch", async ({ browser, request }) => {
  const credentials = await provision(request, `resume${Date.now()}`);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/settings?map-style=blank");

  await openOwnServerForm(page);
  await page.getByLabel("Server").fill(credentials.url);
  await page.getByLabel("Database").fill(credentials.dbName);
  await page.getByLabel("Username").fill(credentials.username);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByTestId("sync-connect").click();
  await expect(page.getByTestId("settings-sync")).toContainText("On", {
    timeout: 15_000,
  });

  // The whole point. Every other test in this file enables and asserts inside
  // one page session, which is how sync shipped for a while working exactly
  // once per install: the credential was written to the store and never read
  // back, so a relaunch showed "Off" and quietly stopped backing anything up.
  await reloadUntilReady(page);

  await expect(page.getByTestId("settings-sync")).toContainText("On", {
    timeout: 15_000,
  });

  await context.close();
});

test("one wrong password must not lock the pilot out of their own server", async ({
  browser,
  request,
}) => {
  const account = `badpw${Date.now()}`;
  const credentials = await provision(request, account);
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("/settings?map-style=blank");
  await openOwnServerForm(page);
  await page.getByLabel("Server").fill(credentials.url);
  await page.getByLabel("Database").fill(credentials.dbName);
  await page.getByLabel("Username").fill(credentials.username);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByTestId("sync-connect").click();

  // Told in the form, about the field they got wrong, while they are still
  // looking at it.
  await expect(page.getByText("Wrong username or password.")).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(4000);

  // The real damage, and the reason the preflight exists.
  //
  // Connecting used to hand the typo straight to db.sync(), which opens its
  // handshake in parallel: measured, ~7 authenticated requests inside 700ms.
  // CouchDB 3.5 ships chttpd_auth_lockout with mode=enforce and threshold=5, so
  // a single attempt blows through it — and a locked account then refuses the
  // CORRECT password for five minutes. The pilot fixes their typo and is still
  // locked out, with nothing on screen able to explain why.
  //
  // One request cannot trip a threshold of five.
  const probe = await request.get(`${COUCH}/${credentials.dbName}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(
        `${credentials.username}:${credentials.password}`,
      ).toString("base64")}`,
    },
  });
  expect(
    probe.status(),
    "the right password must still work after a typo",
  ).toBe(200);

  await context.close();
});

test("Enter connects, from any field", async ({ browser, request }) => {
  const credentials = await provision(request, `enter${Date.now()}`);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/settings?map-style=blank");

  await openOwnServerForm(page);
  await page.getByLabel("Server").fill(credentials.url);
  await page.getByLabel("Database").fill(credentials.dbName);
  await page.getByLabel("Username").fill(credentials.username);
  await page.getByLabel("Password").fill(credentials.password);
  // Never reaching for the navbar. IonInput's real <input> is in a shadow root,
  // so a <form> around these would never see an implicit submit.
  await page.getByLabel("Password").press("Enter");

  await expect(page.getByTestId("settings-sync")).toContainText("On", {
    timeout: 15_000,
  });

  await context.close();
});

test("a credential that goes stale is explained, not dumped raw", async ({
  browser,
  request,
}) => {
  const account = `rekey${Date.now()}`;
  const credentials = await provision(request, account);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/settings?map-style=blank");

  await openOwnServerForm(page);
  await page.getByLabel("Server").fill(credentials.url);
  await page.getByLabel("Database").fill(credentials.dbName);
  await page.getByLabel("Username").fill(credentials.username);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByTestId("sync-connect").click();
  await expect(page.getByTestId("settings-sync")).toContainText("On", {
    timeout: 15_000,
  });

  // The preflight cannot help here — these credentials were valid when saved.
  // This is a server-side credentialVersion bump: the password changes under a
  // device that is already replicating, which the server is designed to do.
  const admin = {
    Authorization: `Basic ${Buffer.from("admin:password").toString("base64")}`,
  };
  const userDoc = (await request
    .get(`${COUCH}/_users/org.couchdb.user:${credentials.username}`, {
      headers: admin,
    })
    .then((r) => r.json())) as Record<string, unknown>;
  await request.put(
    `${COUCH}/_users/org.couchdb.user:${credentials.username}`,
    {
      headers: admin,
      data: { ...userDoc, password: "rotated-out-from-under" },
    },
  );

  await reloadUntilReady(page);

  // PouchDB stops on its own here, so this is not about a retry storm. The
  // thing that must not happen is the pilot being shown a raw PouchDB error
  // object and left to guess. The sentence IS the fix, so a sentence is what
  // is asserted — EITHER of them: the stale-credential handshake fires ~7
  // parallel auth failures, and whether the first 401 reaches the screen
  // before CouchDB's lockout trips at failure five is a genuine server-side
  // race. Both messages are the designed copy for this situation.
  await page.getByTestId("settings-sync").click();
  await expect(page.getByTestId("sync-state")).toHaveText("Problem", {
    timeout: 20_000,
  });
  await expect(
    page.getByText(
      /rejected this device's password|locked this account/,
    ),
  ).toBeVisible();

  await context.close();
});
