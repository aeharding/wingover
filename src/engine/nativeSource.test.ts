import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { nativeLocationRefusal, nativePositionSource } from "./nativeSource";
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
      case "plugin:wingover|check_permissions":
        return Promise.resolve({ location: "granted" });
      case "plugin:wingover|fixes_since":
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

    const batches: SourcePosition[][] = [];
    nativePositionSource.watch(
      (batch) => batches.push(batch),
      () => {},
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(commands()).toContain("plugin:wingover|start_watch");
    // The whole backlog arrives as ONE batch: the burst boundary is
    // structural, not an artifact of delivery timing.
    expect(batches.map((b) => b.map((p) => p.timestamp))).toEqual([
      [1000, 2000],
    ]);

    // Next poll only sees newer fixes — cursor advanced past 2000.
    buffer.push(fix(3000));
    await vi.advanceTimersByTimeAsync(1000);
    expect(batches.map((b) => b.map((p) => p.timestamp))).toEqual([
      [1000, 2000],
      [3000],
    ]);
  });

  it("replays only the backlog after `since` (post-reload catch-up)", async () => {
    stubPlugin([fix(1000), fix(2000), fix(3000)]);

    const positions: SourcePosition[] = [];
    nativePositionSource.watch(
      (batch) => positions.push(...batch),
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
      (batch) => positions.push(...batch),
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
        case "plugin:wingover|check_permissions":
          return Promise.resolve({ location: "prompt" });
        case "plugin:wingover|request_permissions":
          return Promise.resolve({ location: "granted" });
        case "plugin:wingover|fixes_since":
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

    expect(commands()).toContain("plugin:wingover|request_permissions");
    expect(commands()).toContain("plugin:wingover|start_watch");
  });

  // The Never -> "Ask Next Time" recovery, from the source's side: an
  // unasked permission is not a refusal, so the probe answers null, the
  // engine bounces, and the fresh watch's start sequence is what finally
  // puts the system alert on screen. Answering with a refusal here left
  // the pilot on the red takeover until a second trip out of the app. A
  // real refusal names WHICH one, so a takeover whose reason changed while
  // it was up re-renders on the current one.
  it("an unasked prompt refuses nothing; a Settings-level refusal names itself", async () => {
    let location = "prompt";
    let precise = true;
    core.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "plugin:wingover|check_permissions":
          return Promise.resolve({ location, precise, servicesEnabled: true });
        default:
          return Promise.resolve(null);
      }
    });

    expect(await nativeLocationRefusal()).toBeNull();
    location = "denied";
    expect(await nativeLocationRefusal()).toStrictEqual({
      permissionDenied: true,
      message: "location permission denied",
    });
    // The same probe, a different refusal: precise off instead of denied.
    location = "granted";
    precise = false;
    expect(await nativeLocationRefusal()).toStrictEqual({
      permissionDenied: false,
      imprecise: true,
      message: "precise location disabled",
    });
  });

  it("refuses reduced accuracy in JS, before capture ever starts", async () => {
    core.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "plugin:wingover|check_permissions":
          return Promise.resolve({ location: "granted", precise: false });
        default:
          return Promise.resolve(null);
      }
    });

    const errors: unknown[] = [];
    nativePositionSource.watch(
      () => {},
      (error) => errors.push(error),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(commands()).not.toContain("plugin:wingover|start_watch");
    expect(errors).toEqual([
      {
        permissionDenied: false,
        imprecise: true,
        message: "precise location disabled",
      },
    ]);
  });

  it("a bounced watch's stale permission round-trip never reports", async () => {
    let resolvePermissions: (value: unknown) => void = () => {};
    core.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "plugin:wingover|check_permissions":
          return new Promise((resolve) => {
            resolvePermissions = resolve;
          });
        default:
          return Promise.resolve(null);
      }
    });

    const errors: unknown[] = [];
    const stop = nativePositionSource.watch(
      () => {},
      (error) => errors.push(error),
    );
    await vi.advanceTimersByTimeAsync(0);
    // The bounce: this watch is dead before its permission check lands.
    stop();
    resolvePermissions({ location: "denied" });
    await vi.advanceTimersByTimeAsync(0);

    expect(errors).toEqual([]);
    expect(commands()).not.toContain("plugin:wingover|start_watch");
  });

  it("surfaces permission denial without starting the watch", async () => {
    core.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "plugin:wingover|check_permissions":
          return Promise.resolve({ location: "denied" });
        default:
          return Promise.resolve(null);
      }
    });

    const errors: (SourceError | null)[] = [];
    nativePositionSource.watch(
      () => {},
      (error) => errors.push(error),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(errors).toEqual([
      { permissionDenied: true, message: "location permission denied" },
    ]);
    expect(commands()).not.toContain("plugin:wingover|start_watch");
  });

  it("surfaces a native error when no fixes flow, and classifies denial", async () => {
    stubPlugin([], "location permission denied");

    const errors: (SourceError | null)[] = [];
    nativePositionSource.watch(
      () => {},
      (error) => errors.push(error),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(errors).toEqual([
      {
        permissionDenied: true,
        imprecise: false,
        message: "location permission denied",
      },
    ]);
  });

  it("classifies a reduced-accuracy refusal as imprecise", async () => {
    stubPlugin([], "precise location disabled");

    const errors: (SourceError | null)[] = [];
    nativePositionSource.watch(
      () => {},
      (error) => errors.push(error),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(errors).toEqual([
      {
        permissionDenied: false,
        imprecise: true,
        message: "precise location disabled",
      },
    ]);
  });

  it("suppresses stale errors while fixes are still flowing", async () => {
    stubPlugin([fix(1000)], "GPS glitch");

    const positions: SourcePosition[] = [];
    const errors: (SourceError | null)[] = [];
    nativePositionSource.watch(
      (batch) => positions.push(...batch),
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
      (batch) => positions.push(...batch),
      () => {},
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(positions).toHaveLength(1);

    stop();
    expect(commands()).toContain("plugin:wingover|stop_watch");

    stubPlugin([fix(1000), fix(2000)]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(positions).toHaveLength(1);
  });

  it("does not start the native watch if stopped during the permission flow", async () => {
    let resolvePermissions: ((status: unknown) => void) | undefined;
    core.invoke.mockImplementation((cmd: string) => {
      if (cmd === "plugin:wingover|check_permissions") {
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

    expect(commands()).not.toContain("plugin:wingover|start_watch");
  });
});

// Every foreground calls revive, and a null report makes the engine bounce
// the watch — which here means stop_watch: CoreLocation stopped and the
// native session log deleted. So revive must speak ONLY from a state this
// watch actually refused from. This is the load-bearing rule of the
// pushdown (#160); the first test is the one that keeps a foreground from
// tearing down a running capture.
describe("nativePositionSource.revive", () => {
  it("says nothing while capture is healthy — no probe, no report", async () => {
    stubPlugin([fix(1000)]);
    const reports: (SourceError | null)[] = [];
    nativePositionSource.watch(
      () => {},
      (refusal) => reports.push(refusal),
    );
    await vi.advanceTimersByTimeAsync(0);

    core.invoke.mockClear();
    nativePositionSource.revive?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(reports).toEqual([]);
    expect(commands()).not.toContain("plugin:wingover|check_permissions");
  });

  // The Settings trip: the watch refused at start, so no capture is
  // running and the probe is the only way to learn what the pilot did.
  it("probes from a refused watch and reports nothing refusing", async () => {
    let precise = false;
    core.invoke.mockImplementation((cmd: string) =>
      cmd === "plugin:wingover|check_permissions"
        ? Promise.resolve({
            location: "granted",
            precise,
            servicesEnabled: true,
          })
        : Promise.resolve(null),
    );

    const reports: (SourceError | null)[] = [];
    nativePositionSource.watch(
      () => {},
      (refusal) => reports.push(refusal),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(reports).toEqual([
      {
        permissionDenied: false,
        imprecise: true,
        message: "precise location disabled",
      },
    ]);

    precise = true;
    nativePositionSource.revive?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(reports[1]).toBeNull();
  });

  // Recovery is not the only answer a probe can give: the pilot may have
  // traded one refusal for another while the takeover was up.
  it("reports the refusal that stands now, not the one that raised it", async () => {
    let status: Record<string, unknown> = {
      location: "granted",
      precise: false,
      servicesEnabled: true,
    };
    core.invoke.mockImplementation((cmd: string) =>
      cmd === "plugin:wingover|check_permissions"
        ? Promise.resolve(status)
        : Promise.resolve(null),
    );

    const reports: (SourceError | null)[] = [];
    nativePositionSource.watch(
      () => {},
      (refusal) => reports.push(refusal),
    );
    await vi.advanceTimersByTimeAsync(0);

    status = { location: "denied", precise: true, servicesEnabled: true };
    nativePositionSource.revive?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(reports[1]).toStrictEqual({
      permissionDenied: true,
      message: "location permission denied",
    });

    // Still refusing, so the next foreground still asks.
    nativePositionSource.revive?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(reports[2]).toStrictEqual({
      permissionDenied: true,
      message: "location permission denied",
    });
  });

  // A refusal the drain reported is the same state as a start-time one:
  // the pilot went to fix something and came back.
  it("probes from a refusal the drain reported", async () => {
    stubPlugin([], "permission-denied");
    const reports: (SourceError | null)[] = [];
    nativePositionSource.watch(
      () => {},
      (refusal) => reports.push(refusal),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(reports).toHaveLength(1);

    core.invoke.mockClear();
    nativePositionSource.revive?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(commands()).toContain("plugin:wingover|check_permissions");
  });

  // Fixes flowing again is the platform's own answer and it outranks
  // whatever this watch last refused with: a foreground after recovery
  // must not bounce the capture that recovered.
  it("goes quiet again once fixes flow", async () => {
    let error: string | undefined = "reduced-accuracy";
    core.invoke.mockImplementation((cmd: string, args?: { ts: number }) => {
      switch (cmd) {
        case "plugin:wingover|check_permissions":
          return Promise.resolve({
            location: "granted",
            precise: true,
            servicesEnabled: true,
          });
        case "plugin:wingover|fixes_since":
          return Promise.resolve({
            fixes: error === undefined ? [fix(args!.ts + 1000)] : [],
            ...(error !== undefined && { error }),
          });
        default:
          return Promise.resolve(null);
      }
    });

    const reports: (SourceError | null)[] = [];
    nativePositionSource.watch(
      () => {},
      (refusal) => reports.push(refusal),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(reports).toHaveLength(1);

    error = undefined;
    await vi.advanceTimersByTimeAsync(1000);

    core.invoke.mockClear();
    nativePositionSource.revive?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(reports).toHaveLength(1);
    expect(commands()).not.toContain("plugin:wingover|check_permissions");
  });

  // The probe is a round trip, and its watch can be gone before it lands.
  it("a probe answer that outlives its watch never reports", async () => {
    let resolveProbe: ((status: unknown) => void) | undefined;
    let probes = 0;
    core.invoke.mockImplementation((cmd: string) => {
      if (cmd !== "plugin:wingover|check_permissions") {
        return Promise.resolve(null);
      }
      probes++;
      if (probes === 1) {
        return Promise.resolve({
          location: "denied",
          precise: true,
          servicesEnabled: true,
        });
      }
      return new Promise((resolve) => {
        resolveProbe = resolve;
      });
    });

    const reports: (SourceError | null)[] = [];
    const stop = nativePositionSource.watch(
      () => {},
      (refusal) => reports.push(refusal),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(reports).toHaveLength(1);

    nativePositionSource.revive?.();
    stop();
    resolveProbe!({
      location: "granted",
      precise: true,
      servicesEnabled: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(reports).toHaveLength(1);
  });

  // A plugin that will not answer says nothing about what refuses, so
  // nothing is acted on — and an unhandled rejection on every foreground
  // would fail this suite outright.
  it("a probe that rejects reports nothing, and never an unhandled rejection", async () => {
    let probes = 0;
    core.invoke.mockImplementation((cmd: string) => {
      if (cmd !== "plugin:wingover|check_permissions") {
        return Promise.resolve(null);
      }
      probes++;
      if (probes === 1) {
        return Promise.resolve({
          location: "denied",
          precise: true,
          servicesEnabled: true,
        });
      }
      return Promise.reject(new Error("plugin not responding"));
    });

    const reports: (SourceError | null)[] = [];
    nativePositionSource.watch(
      () => {},
      (refusal) => reports.push(refusal),
    );
    await vi.advanceTimersByTimeAsync(0);

    nativePositionSource.revive?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(reports).toHaveLength(1);
  });
  // A probe answer is only as good as the moment it lands: fixes flowing
  // again while it was in flight is the platform answering the same
  // question first, and more directly.
  it("a probe answer landing after fixes resumed is dropped", async () => {
    let resolveProbe: ((status: unknown) => void) | undefined;
    let probes = 0;
    let error: string | undefined = "reduced-accuracy";
    core.invoke.mockImplementation((cmd: string, args?: { ts: number }) => {
      switch (cmd) {
        case "plugin:wingover|check_permissions":
          probes++;
          if (probes === 1) {
            return Promise.resolve({
              location: "granted",
              precise: true,
              servicesEnabled: true,
            });
          }
          return new Promise((resolve) => {
            resolveProbe = resolve;
          });
        case "plugin:wingover|fixes_since":
          return Promise.resolve({
            fixes: error === undefined ? [fix(args!.ts + 1000)] : [],
            ...(error !== undefined && { error }),
          });
        default:
          return Promise.resolve(null);
      }
    });

    const reports: (SourceError | null)[] = [];
    nativePositionSource.watch(
      () => {},
      (refusal) => reports.push(refusal),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(reports).toHaveLength(1);

    // The pilot flips Precise back on: the probe goes out, and CoreLocation
    // starts delivering before it answers.
    nativePositionSource.revive?.();
    error = undefined;
    await vi.advanceTimersByTimeAsync(1000);
    resolveProbe!({ location: "denied", precise: true, servicesEnabled: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(reports).toHaveLength(1);
  });
  // AUDIT (#160). A permission takeover absorbs its own fixes at the
  // engine (real.ts handlePositions returns early for every blocking code
  // but imprecise), so fixes flowing are NOT evidence that the takeover is
  // over. If they retired the held refusal, revive would go silent and the
  // red screen would have no exit but Cancel — and this is the ordinary
  // case, not a corner: background capture resumes the moment the pilot
  // re-grants, so fixes are already draining before they reach the app.
  it("keeps asking after a permission refusal even while fixes drain", async () => {
    let location = "granted";
    let error: string | undefined;
    core.invoke.mockImplementation((cmd: string, args?: { ts: number }) => {
      switch (cmd) {
        case "plugin:wingover|check_permissions":
          return Promise.resolve({
            location,
            precise: true,
            servicesEnabled: true,
          });
        case "plugin:wingover|fixes_since":
          return Promise.resolve({
            fixes: error === undefined ? [fix(args!.ts + 1000)] : [],
            ...(error !== undefined && { error }),
          });
        default:
          return Promise.resolve(null);
      }
    });

    const reports: (SourceError | null)[] = [];
    const stop = nativePositionSource.watch(
      () => {},
      (refusal) => reports.push(refusal),
    );
    await vi.advanceTimersByTimeAsync(0);

    // Authorization revoked mid-capture: the drain mirrors the code.
    location = "denied";
    error = "permission-denied";
    await vi.advanceTimersByTimeAsync(1000);
    expect(reports).toHaveLength(1);

    // The pilot re-grants in Settings. Background capture resumes and
    // fixes drain BEFORE they switch back to the app — the engine keeps
    // absorbing them under the takeover.
    location = "granted";
    error = undefined;
    await vi.advanceTimersByTimeAsync(1000);

    // Now they come back. This must still be able to ask.
    (nativePositionSource as unknown as { revive: () => void }).revive();
    await vi.advanceTimersByTimeAsync(0);
    expect(reports[reports.length - 1]).toBeNull();
    stop();
  });

  // A refusal a fresh watch cannot judge is not worth a bounce: a bounce
  // is stop_watch, and stop_watch deletes the native session log. Swift's
  // lastError is sticky across drains, so a GPS shadow would otherwise
  // hand every single foreground a capture teardown.
  it("never asks for a bounce over a refusal a fresh watch cannot clear", async () => {
    stubPlugin([], "kCLErrorDomain error 0");
    const reports: (SourceError | null)[] = [];
    const stop = nativePositionSource.watch(
      () => {},
      (refusal) => reports.push(refusal),
    );
    await vi.advanceTimersByTimeAsync(0);
    // The engine hears about it (it renders as a non-blocking
    // "unavailable")...
    expect(reports).toHaveLength(1);

    // ...but a foreground must not turn it into a capture teardown.
    core.invoke.mockClear();
    (nativePositionSource as unknown as { revive: () => void }).revive();
    await vi.advanceTimersByTimeAsync(0);
    expect(reports).toHaveLength(1);
    expect(commands()).not.toContain("plugin:wingover|check_permissions");
    stop();
  });

  // Reduced accuracy is the one refusal a delivery CAN retire, because the
  // engine retires the matching takeover on the same evidence.
  it("stops asking once a non-reduced fix disproves reduced accuracy", async () => {
    let error: string | undefined = "reduced-accuracy";
    core.invoke.mockImplementation((cmd: string, args?: { ts: number }) => {
      switch (cmd) {
        case "plugin:wingover|check_permissions":
          return Promise.resolve({
            location: "granted",
            precise: true,
            servicesEnabled: true,
          });
        case "plugin:wingover|fixes_since":
          return Promise.resolve({
            fixes: error === undefined ? [fix(args!.ts + 1000)] : [],
            ...(error !== undefined && { error }),
          });
        default:
          return Promise.resolve(null);
      }
    });

    const reports: (SourceError | null)[] = [];
    const stop = nativePositionSource.watch(
      () => {},
      (refusal) => reports.push(refusal),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(reports).toHaveLength(1);

    error = undefined;
    await vi.advanceTimersByTimeAsync(1000);

    core.invoke.mockClear();
    (nativePositionSource as unknown as { revive: () => void }).revive();
    await vi.advanceTimersByTimeAsync(0);
    expect(reports).toHaveLength(1);
    expect(commands()).not.toContain("plugin:wingover|check_permissions");
    stop();
  });

  // A reduced fix proves authorization exists but not that accuracy is
  // back, so a permission refusal that the pilot half-fixed must follow
  // the platform to its real reason instead of going quiet.
  it("a coarse fix under a permission refusal still leads to the current reason", async () => {
    let status: Record<string, unknown> = {
      location: "denied",
      precise: true,
      servicesEnabled: true,
    };
    core.invoke.mockImplementation((cmd: string, args?: { ts: number }) => {
      switch (cmd) {
        case "plugin:wingover|check_permissions":
          return Promise.resolve(status);
        case "plugin:wingover|fixes_since":
          return Promise.resolve({
            fixes: [
              fix(args!.ts + 1000, {
                horizontalAccuracy: 13_000,
                verticalAccuracy: undefined,
                altitude: undefined,
              }),
            ],
          });
        default:
          return Promise.resolve(null);
      }
    });

    const reports: (SourceError | null)[] = [];
    const stop = nativePositionSource.watch(
      () => {},
      (refusal) => reports.push(refusal),
    );
    await vi.advanceTimersByTimeAsync(0);

    status = { location: "granted", precise: false, servicesEnabled: true };
    (nativePositionSource as unknown as { revive: () => void }).revive();
    await vi.advanceTimersByTimeAsync(0);
    expect(reports[reports.length - 1]).toStrictEqual({
      permissionDenied: false,
      imprecise: true,
      message: "precise location disabled",
    });
    stop();
  });
});
