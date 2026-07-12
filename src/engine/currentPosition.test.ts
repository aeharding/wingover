import { describe, expect, it, vi } from "vitest";

import { getCurrentPosition } from "./currentPosition";

// invoke is only reached under Tauri; mock it so the import resolves.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function setNavigator(value: unknown) {
  Object.defineProperty(globalThis, "navigator", {
    value,
    configurable: true,
    writable: true,
  });
}

// No __TAURI_INTERNALS__ in the test env, so isTauri() is false and the
// web (navigator.geolocation) path runs.
describe("getCurrentPosition (web fallback)", () => {
  it("resolves with lat/lng from navigator.geolocation", async () => {
    setNavigator({
      geolocation: {
        getCurrentPosition: (success: PositionCallback) =>
          success({
            coords: { latitude: 43.07, longitude: -89.4 },
          } as GeolocationPosition),
      },
    });
    await expect(getCurrentPosition()).resolves.toEqual({
      latitude: 43.07,
      longitude: -89.4,
    });
  });

  it("rejects with the geolocation error message", async () => {
    setNavigator({
      geolocation: {
        getCurrentPosition: (
          _success: PositionCallback,
          error?: PositionErrorCallback,
        ) => error?.({ message: "denied" } as GeolocationPositionError),
      },
    });
    await expect(getCurrentPosition()).rejects.toThrow("denied");
  });

  it("rejects when geolocation is unavailable", async () => {
    setNavigator({});
    await expect(getCurrentPosition()).rejects.toThrow("no geolocation support");
  });
});
