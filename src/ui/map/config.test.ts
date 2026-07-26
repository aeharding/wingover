import { beforeEach, describe, expect, it, vi } from "vitest";

// The pilot's stored settings are the only thing resolveMapStyle reads besides
// the network; stub them so these tests are about the STYLE decision alone.
const settings = vi.hoisted(() => ({ getSetting: vi.fn() }));
vi.mock("../../storage/local", () => settings);

import { captureLaunchUrl, resolveMapStyle } from "./config";

const STYLE = { version: 8, sources: {}, layers: [] };

function respond(ok: boolean) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    json: () => Promise.resolve(STYLE),
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  settings.getSetting.mockResolvedValue(null); // no MapTiler key
  // config.ts reads location.search at module scope via captureLaunchUrl;
  // vitest runs in node, where there is no location.
  (globalThis as { location?: unknown }).location ??= { search: "" };
  captureLaunchUrl();
});

describe("resolveMapStyle", () => {
  it("returns the parsed style when the basemap is reachable", async () => {
    respond(true);
    await expect(resolveMapStyle("street", "dark")).resolves.toEqual(STYLE);
  });

  // null is the contract the whole offline story rests on: the caller decides
  // what unreachable means, rather than maplibre being handed a URL it cannot
  // fetch and ending up with NO style — which takes the track down with it.
  it("returns null when the style responds not-ok", async () => {
    respond(false);
    await expect(resolveMapStyle("street", "dark")).resolves.toBeNull();
  });

  it("returns null when the fetch rejects outright (offline)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
    await expect(resolveMapStyle("street", "dark")).resolves.toBeNull();
  });

  // Answering a satellite request with street is the map showing a view
  // nobody asked for, and it hides the reason: there is no key.
  it("returns null for satellite with no MapTiler key, rather than street", async () => {
    respond(true);
    await expect(resolveMapStyle("satellite", "dark")).resolves.toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  // Street is reachable here, so a null answer can only come from refusing to
  // substitute it for the satellite view that was asked for.
  it("returns null when the key cannot fetch the hybrid style", async () => {
    settings.getSetting.mockResolvedValue("a-key");
    globalThis.fetch = vi.fn((url: string) =>
      Promise.resolve({
        ok: !url.includes("hybrid"),
        json: () => Promise.resolve(STYLE),
      }),
    ) as unknown as typeof fetch;
    await expect(resolveMapStyle("satellite", "dark")).resolves.toBeNull();
  });

  // Asked for, not failed. The distinction matters: a requested blank style
  // must never be retried, while an unreachable one must be.
  it("returns NO_BASEMAP_STYLE verbatim when ?map-style=blank asked for it", async () => {
    // The launch URL is pinned on first read, so the flag has to be in place
    // before a fresh copy of the module loads.
    (globalThis as { location: { search: string } }).location = {
      search: "?map-style=blank",
    };
    vi.resetModules();
    const fresh = await import("./config");
    // Identity, not shape: the adapter distinguishes "asked for blank" from
    // "could not reach a basemap" by reference. Take it from the same fresh
    // module graph, since resetModules mints a new NO_BASEMAP_STYLE object.
    const { NO_BASEMAP_STYLE: fresh_ } = await import("./noBasemapStyle");
    expect(await fresh.resolveMapStyle("street", "dark")).toBe(fresh_);
  });
});
