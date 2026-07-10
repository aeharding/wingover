import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { nativePositionSource } from "./nativeSource";
import type { SourceError, SourcePosition } from "./real";

const core = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => core);

interface NativeFix {
  timestamp: number;
  latitude: number;
  longitude: number;
  horizontalAccuracy: number;
  altitude?: number;
  verticalAccuracy?: number;
  speed?: number;
  course?: number;
}

function fix(timestamp: number, extra: Partial<NativeFix> = {}): NativeFix {
  return {
    timestamp,
    latitude: 43,
    longitude: -89.5,
    horizontalAccuracy: 5,
    altitude: 300,
    verticalAccuracy: 8,
    speed: 10,
    course: 90,
    ...extra,
  };
}

// Simulates the plugin: granted permissions, a native buffer served by
// fixes_since(ts), and records every command invoked.
function stubPlugin(buffer: NativeFix[], error?: string) {
  core.invoke.mockImplementation((cmd: string, args?: { ts: number }) => {
    switch (cmd) {
      case "plugin:wingover-location|check_permissions":
        return Promise.resolve({ location: "granted" });
      case "plugin:wingover-location|fixes_since":
        return Promise.resolve({
          fixes: buffer.filter((f) => f.timestamp > args!.ts),
          ...(error !== undefined && { error }),
        });
      default:
        return Promise.resolve(null);
    }
  });
}

function commands(): string[] {
  return core.invoke.mock.calls.map(([cmd]) => cmd as string);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("nativePositionSource", () => {
  it("starts the native watch and delivers fixes, advancing the cursor", async () => {
    const buffer = [fix(1000), fix(2000)];
    stubPlugin(buffer);

    const positions: SourcePosition[] = [];
    nativePositionSource.watch(
      (position) => positions.push(position),
      () => {},
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(commands()).toContain("plugin:wingover-location|start_watch");
    expect(positions.map((p) => p.timestamp)).toEqual([1000, 2000]);

    // Next poll only sees newer fixes — cursor advanced past 2000.
    buffer.push(fix(3000));
    await vi.advanceTimersByTimeAsync(1000);
    expect(positions.map((p) => p.timestamp)).toEqual([1000, 2000, 3000]);
  });

  it("replays only the backlog after `since` (post-reload catch-up)", async () => {
    stubPlugin([fix(1000), fix(2000), fix(3000)]);

    const positions: SourcePosition[] = [];
    nativePositionSource.watch(
      (position) => positions.push(position),
      () => {},
      { since: 2000 },
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(positions.map((p) => p.timestamp)).toEqual([3000]);
  });

  it("maps absent invalid values to nulls", async () => {
    stubPlugin([
      fix(1000, {
        altitude: undefined,
        verticalAccuracy: undefined,
        speed: undefined,
        course: undefined,
      }),
    ]);

    const positions: SourcePosition[] = [];
    nativePositionSource.watch(
      (position) => positions.push(position),
      () => {},
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(positions[0].coords).toEqual({
      latitude: 43,
      longitude: -89.5,
      accuracy: 5,
      altitude: null,
      altitudeAccuracy: null,
      speed: null,
      heading: null,
    });
  });

  it("requests permission when status is prompt", async () => {
    core.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "plugin:wingover-location|check_permissions":
          return Promise.resolve({ location: "prompt" });
        case "plugin:wingover-location|request_permissions":
          return Promise.resolve({ location: "granted" });
        case "plugin:wingover-location|fixes_since":
          return Promise.resolve({ fixes: [] });
        default:
          return Promise.resolve(null);
      }
    });

    nativePositionSource.watch(
      () => {},
      () => {},
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(commands()).toContain("plugin:wingover-location|request_permissions");
    expect(commands()).toContain("plugin:wingover-location|start_watch");
  });

  it("surfaces permission denial without starting the watch", async () => {
    core.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "plugin:wingover-location|check_permissions":
          return Promise.resolve({ location: "denied" });
        default:
          return Promise.resolve(null);
      }
    });

    const errors: SourceError[] = [];
    nativePositionSource.watch(
      () => {},
      (error) => errors.push(error),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(errors).toEqual([
      { permissionDenied: true, message: "location permission denied" },
    ]);
    expect(commands()).not.toContain("plugin:wingover-location|start_watch");
  });

  it("surfaces a native error when no fixes flow, and classifies denial", async () => {
    stubPlugin([], "location permission denied");

    const errors: SourceError[] = [];
    nativePositionSource.watch(
      () => {},
      (error) => errors.push(error),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(errors).toEqual([
      { permissionDenied: true, message: "location permission denied" },
    ]);
  });

  it("suppresses stale errors while fixes are still flowing", async () => {
    stubPlugin([fix(1000)], "GPS glitch");

    const positions: SourcePosition[] = [];
    const errors: SourceError[] = [];
    nativePositionSource.watch(
      (position) => positions.push(position),
      (error) => errors.push(error),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(positions).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("unsubscribe stops polling and finalizes the native session", async () => {
    stubPlugin([fix(1000)]);

    const positions: SourcePosition[] = [];
    const stop = nativePositionSource.watch(
      (position) => positions.push(position),
      () => {},
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(positions).toHaveLength(1);

    stop();
    expect(commands()).toContain("plugin:wingover-location|stop_watch");

    stubPlugin([fix(1000), fix(2000)]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(positions).toHaveLength(1);
  });

  it("does not start the native watch if stopped during the permission flow", async () => {
    let resolvePermissions: ((status: unknown) => void) | undefined;
    core.invoke.mockImplementation((cmd: string) => {
      if (cmd === "plugin:wingover-location|check_permissions") {
        return new Promise((resolve) => {
          resolvePermissions = resolve;
        });
      }
      return Promise.resolve(null);
    });

    const stop = nativePositionSource.watch(
      () => {},
      () => {},
    );
    await vi.advanceTimersByTimeAsync(0);
    stop();
    resolvePermissions!({ location: "granted" });
    await vi.advanceTimersByTimeAsync(0);

    expect(commands()).not.toContain("plugin:wingover-location|start_watch");
  });
});
