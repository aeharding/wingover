import { describe, expect, it, vi } from "vitest";

import { BOOT_HYDRATION_TIMEOUT_MS, createBootGate } from "./bootGate";

// A promise this test resolves by hand: it stands in for the WAL read the
// real gate waits on (engine.getSnapshot).
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// One macrotask: enough for a settled promise's continuations and for a
// short timer to have fired.
function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createBootGate", () => {
  it("opens when hydration lands, having asked exactly once", async () => {
    const hydration = deferred();
    const hydrate = vi.fn(() => hydration.promise);
    const gate = createBootGate(hydrate, 10_000);
    const woken = vi.fn();
    gate.subscribe(woken);

    // Read the way React reads it — every render, plus a second subscriber
    // (App and anything else that ever waits on boot). The gate is a latch,
    // not a trigger: none of that may re-ask the engine.
    expect(gate.settled()).toBe(false);
    expect(gate.settled()).toBe(false);
    gate.subscribe(() => {});
    expect(gate.settled()).toBe(false);
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(woken).not.toHaveBeenCalled();

    hydration.resolve();
    await tick();
    expect(gate.settled()).toBe(true);
    expect(woken).toHaveBeenCalledTimes(1);
    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  it("opens when hydration rejects: an unreadable WAL is an answer too", async () => {
    const hydration = deferred();
    const gate = createBootGate(() => hydration.promise, 10_000);
    const woken = vi.fn();
    gate.subscribe(woken);

    hydration.reject(new Error("storage unavailable"));
    await tick();
    expect(gate.settled()).toBe(true);
    expect(woken).toHaveBeenCalledTimes(1);
  });

  it("opens on the deadline when hydration never lands, and only once", async () => {
    // The degraded path, and the reason the wait is bounded: the app renders
    // from the current snapshot (pre-hydration, honestly "idle") — the exact
    // behaviour it had before the gate existed — instead of holding the dark
    // boot frame forever.
    const hydration = deferred();
    const gate = createBootGate(() => hydration.promise, 20);
    const woken = vi.fn();
    gate.subscribe(woken);

    expect(gate.settled()).toBe(false);
    await tick(40);
    expect(gate.settled()).toBe(true);
    expect(woken).toHaveBeenCalledTimes(1);

    // The WAL finally answers, long after the app committed. The gate is
    // already open and says so once: the snapshot's own subscribers carry
    // the state change from here (App re-renders off engine.subscribe).
    hydration.resolve();
    await tick();
    expect(gate.settled()).toBe(true);
    expect(woken).toHaveBeenCalledTimes(1);
  });

  it("stops waking a listener that unsubscribed", async () => {
    const hydration = deferred();
    const gate = createBootGate(() => hydration.promise, 10_000);
    const woken = vi.fn();
    gate.subscribe(woken)();

    hydration.resolve();
    await tick();
    expect(gate.settled()).toBe(true);
    expect(woken).not.toHaveBeenCalled();
  });

  it("arms the shipped deadline when the caller names none", () => {
    // src/engine/index.ts constructs the real gate without a timeout, so the
    // default parameter IS the shipped deadline: without this, changing it to
    // 0 (every boot flashes) or to a minute (a dead store is a dark screen)
    // leaves the whole unit ring green.
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      createBootGate(() => deferred().promise);
      expect(setTimeoutSpy).toHaveBeenCalledWith(
        expect.any(Function),
        BOOT_HYDRATION_TIMEOUT_MS,
      );
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("ships a deadline that is a failsafe, not a budget", () => {
    // Long enough that a cold, contended launch never trips it (which would
    // put the flash back on real devices), short enough that a pilot on a
    // genuinely dead store is not left staring at a dark screen.
    expect(BOOT_HYDRATION_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
    expect(BOOT_HYDRATION_TIMEOUT_MS).toBeLessThanOrEqual(3000);
  });
});
