import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SourceError, SourcePosition } from "./real";
import { tauriPositionSource } from "./tauriSource";

const plugin = vi.hoisted(() => ({
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  watchPosition: vi.fn(),
  clearWatch: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-geolocation", () => plugin);

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("tauriPositionSource", () => {
  it("requests permission, watches, and maps positions", async () => {
    plugin.checkPermissions.mockResolvedValue({ location: "prompt" });
    plugin.requestPermissions.mockResolvedValue({ location: "granted" });
    let pluginCallback:
      ((position: unknown, error?: string) => void) | undefined;
    plugin.watchPosition.mockImplementation(
      async (_options: unknown, cb: typeof pluginCallback) => {
        pluginCallback = cb;
        return 7;
      },
    );

    const positions: SourcePosition[] = [];
    const errors: SourceError[] = [];
    const stop = tauriPositionSource.watch(
      (position) => positions.push(position),
      (error) => errors.push(error),
    );
    await flush();

    expect(plugin.requestPermissions).toHaveBeenCalledWith(["location"]);
    pluginCallback!({
      timestamp: 123,
      coords: {
        latitude: 43,
        longitude: -89.4,
        accuracy: 5,
        altitude: 300,
        altitudeAccuracy: 8,
        speed: 10,
        heading: 90,
      },
    });
    expect(positions).toHaveLength(1);
    expect(positions[0].coords.altitudeAccuracy).toBe(8);
    expect(errors).toEqual([]);

    stop();
    expect(plugin.clearWatch).toHaveBeenCalledWith(7);
  });

  it("classifies a permission refusal", async () => {
    plugin.checkPermissions.mockResolvedValue({ location: "denied" });
    const errors: SourceError[] = [];
    tauriPositionSource.watch(
      () => {},
      (error) => errors.push(error),
    );
    await flush();
    expect(errors).toHaveLength(1);
    expect(errors[0].permissionDenied).toBe(true);
    expect(plugin.watchPosition).not.toHaveBeenCalled();
  });

  it("never starts the watch when stopped during the permission flow", async () => {
    plugin.checkPermissions.mockResolvedValue({ location: "granted" });
    const stop = tauriPositionSource.watch(
      () => {},
      () => {},
    );
    stop();
    await flush();
    expect(plugin.watchPosition).not.toHaveBeenCalled();
  });

  it("clears a watch that resolves after stop", async () => {
    plugin.checkPermissions.mockResolvedValue({ location: "granted" });
    let resolveWatch: ((id: number) => void) | undefined;
    plugin.watchPosition.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWatch = resolve;
        }),
    );
    const stop = tauriPositionSource.watch(
      () => {},
      () => {},
    );
    await flush();
    expect(plugin.watchPosition).toHaveBeenCalled();
    stop();
    resolveWatch!(9);
    await flush();
    expect(plugin.clearWatch).toHaveBeenCalledWith(9);
  });
});
