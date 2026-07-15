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
  await a.getByRole("button", { name: /stop|confirm|end/i }).last().click();

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

  await expect
    .poll(
      () =>
        b.evaluate(async () => {
          const specifier = "/src/storage/db.ts";
          const { listFlights } = (await import(/* @vite-ignore */ specifier)) as {
            listFlights(): Promise<unknown[]>;
          };
          return (await listFlights()).length;
        }),
      { timeout: 30_000, message: "flight should replicate to the second device" },
    )
    .toBeGreaterThan(0);

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

  const log = await page.evaluate(
    () => (globalThis as unknown as { __syncLog: string[] }).__syncLog.join("|"),
  );
  // A push would be denied, and PouchDB advances the checkpoint past a denied
  // doc — so this flight would never be pushed again, not even after renewal.
  // The client must not try.
  expect(log).not.toContain("denied");
  expect(log).toContain('"readOnly":true');

  await page.close();
});

test("the sync sheet opens from settings and connects a self-hosted server", async ({
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

  // The row reports state without opening anything — a pilot shouldn't have to
  // go looking to find out whether their flights are backed up.
  await expect(page.getByTestId("settings-sync")).toContainText("Off");

  await page.getByTestId("settings-sync").click();
  // Off is a pitch, not a status screen: the headline sells, and the presence
  // of Subscribe is what says it's off.
  await expect(page.getByTestId("sync-headline")).toBeVisible();
  await expect(page.getByTestId("sync-state")).toHaveCount(0);
  // Subscribe is inert until the StoreKit plugin exists; it must say so rather
  // than fail on tap. (Ionic exposes this as aria-disabled, not the native
  // attribute — that's also what assistive tech reads.)
  await expect(page.getByTestId("sync-subscribe")).toHaveAttribute(
    "aria-disabled",
    "true",
  );

  await page.getByTestId("sync-selfhost-toggle").click();
  await page.getByLabel("Server").fill(credentials.url);
  await page.getByLabel("Database").fill(credentials.dbName);
  await page.getByLabel("Username").fill(credentials.username);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByTestId("sync-connect").click();

  await expect(page.getByTestId("settings-sync")).not.toContainText("Off", {
    timeout: 15_000,
  });

  // ...and off again, without deleting anything.
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
    (await request.get(`${COUCH}/${credentials.dbName}/_all_docs`, { headers: auth }))
      .status(),
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
