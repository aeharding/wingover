import { afterEach, describe, expect, it, vi } from "vitest";

import { isUnlinked, siwaProvider } from "./apple";

/**
 * The StoreKit paths need a device; this covers the identity path, which is
 * plain fetch and must behave the same in every ring.
 */
describe("siwaProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function answer(status: number, body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      })),
    );
  }

  it("trades the identity token for credentials and stamps the kind", async () => {
    answer(200, {
      url: "https://db.wingover.app",
      dbName: "userdb-u1",
      username: "u1",
      password: "pw",
      entitled: true,
    });

    const credentials = await siwaProvider(
      "https://api.example",
      "token",
    ).obtain();

    // kind is stamped client-side — the server doesn't know which proof the
    // client led with, and resume() dispatches its refresh strategy on this.
    expect(credentials.kind).toBe("apple");
    expect(credentials.username).toBe("u1");

    const call = vi.mocked(fetch).mock.calls[0]!;
    expect(call[0]).toBe("https://api.example/v1/session");
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      identityToken: "token",
    });
  });

  it("turns the server's 404 into a sentence and marks it unlinked", async () => {
    answer(404, { message: "no linked account" });

    const failure = siwaProvider("https://api.example", "token").obtain();

    // The marker is what lets iOS self-heal via StoreKit (SYNC-UX junction 4);
    // the message is what a browser pilot is left with, so it must say what
    // to actually do.
    await expect(failure).rejects.toThrow(/subscribe in the ios app/i);
    await expect(failure).rejects.toSatisfy(isUnlinked);
  });

  it("does not mark other failures as unlinked", async () => {
    answer(500, { message: "boom" });

    const failure = siwaProvider("https://api.example", "token").obtain();

    await expect(failure).rejects.toThrow(/500/);
    await expect(failure).rejects.not.toSatisfy(isUnlinked);
  });
});
