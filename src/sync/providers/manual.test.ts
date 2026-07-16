import { afterEach, describe, expect, it, vi } from "vitest";

import { manualProvider } from "./manual";

/**
 * The self-host preflight. These assert the *messages*, not just the throw:
 * this provider is the only thing standing between a typo and a five-minute
 * account lockout (e2e proves that end to end), and a pilot who is told the
 * wrong thing retypes the wrong field.
 */

const input = {
  url: "https://couch.example.com",
  dbName: "wingover",
  username: "pilot",
  password: "hunter2",
};

function respondWith(init: { status: number; body?: unknown }) {
  const fetchMock = vi.fn<
    (url: string, options?: RequestInit) => Promise<Response>
  >(async () =>
    init.status === 200
      ? new Response(JSON.stringify(init.body ?? { db_name: "wingover" }))
      : new Response(JSON.stringify(init.body ?? {}), { status: init.status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("manualProvider", () => {
  it("returns credentials when the server confirms the database", async () => {
    const fetchMock = respondWith({ status: 200 });

    const credentials = await manualProvider(input).obtain();

    expect(credentials).toEqual({
      kind: "manual",
      url: "https://couch.example.com",
      dbName: "wingover",
      username: "pilot",
      password: "hunter2",
      entitled: true,
    });
    // Basic auth, against the database itself — anything less doesn't prove
    // these credentials can read the thing we're about to replicate.
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://couch.example.com/wingover");
    expect((options?.headers as Record<string, string>).Authorization).toBe(
      `Basic ${btoa("pilot:hunter2")}`,
    );
  });

  /**
   * The one that isn't about error copy at all.
   *
   * PouchDB given "couch.example.com" creates a LOCAL IndexedDB of that name
   * and syncs the device to itself, reporting a healthy "On" forever while
   * nothing leaves the phone. It must never get the chance.
   */
  it("rejects a schemeless server before touching the network", async () => {
    const fetchMock = respondWith({ status: 200 });

    await expect(
      manualProvider({ ...input, url: "couch.example.com" }).obtain(),
    ).rejects.toThrow(/must start with https:\/\/ or http:\/\//);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("trims trailing slashes so the database URL doesn't double up", async () => {
    const fetchMock = respondWith({ status: 200 });

    const credentials = await manualProvider({
      ...input,
      url: "https://couch.example.com//",
    }).obtain();

    expect(credentials.url).toBe("https://couch.example.com");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://couch.example.com/wingover",
    );
  });

  it("names the password on a 401", async () => {
    respondWith({ status: 401 });
    await expect(manualProvider(input).obtain()).rejects.toThrow(
      "Wrong username or password.",
    );
  });

  /**
   * CouchDB 3.5 locks an account after 5 failures and then refuses the CORRECT
   * password for five minutes. "Wrong username or password" here would send the
   * pilot to retype a password that was already right.
   */
  it("distinguishes a lockout from a bad password", async () => {
    respondWith({
      status: 403,
      body: {
        error: "forbidden",
        reason:
          "Account is temporarily locked due to multiple authentication failures",
      },
    });
    await expect(manualProvider(input).obtain()).rejects.toThrow(
      /locked this account; wait five minutes/,
    );
  });

  it("names the database on a 404", async () => {
    respondWith({ status: 404 });
    await expect(manualProvider(input).obtain()).rejects.toThrow(
      'No database named "wingover" on https://couch.example.com.',
    );
  });

  it("names CORS when the request never lands", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(manualProvider(input).obtain()).rejects.toThrow(/CORS/);
  });
});
