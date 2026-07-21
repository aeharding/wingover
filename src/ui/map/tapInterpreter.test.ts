import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTapInterpreter, type TapInterpreter } from "./tapInterpreter";

/** Drives the interpreter on vitest's fake clock. */
function make(deliverDelayMs: number) {
  const onTap = vi.fn();
  const interpreter = createTapInterpreter({
    deliverDelayMs,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id) => clearTimeout(id),
    onTap,
  });
  return { interpreter, onTap };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A full clean tap: down, then the backend's tap event shortly after. */
function cleanTap(i: TapInterpreter, holdMs = 60) {
  i.down();
  vi.advanceTimersByTime(holdMs);
  i.tap();
}

describe("immediate delivery (MapKit style, deliverDelayMs 0)", () => {
  it("delivers a lone tap", () => {
    const { interpreter, onTap } = make(0);
    cleanTap(interpreter);
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("swallows the tap that stopped an active scroll", () => {
    const { interpreter, onTap } = make(0);
    interpreter.scrollStart();
    interpreter.down(); // stop-tap: arms the suppression window
    // MapKit dispatches the stop-tap's single-tap ~350ms later.
    vi.advanceTimersByTime(350);
    interpreter.tap();
    expect(onTap).not.toHaveBeenCalled();
  });

  it("swallows a stop-tap even when the scroll ended just before the down (native-first ordering)", () => {
    const { interpreter, onTap } = make(0);
    interpreter.scrollStart();
    interpreter.scrollEnd(); // backend processed the touch first
    interpreter.down(); // 0ms later: correlated as the stopping touch
    vi.advanceTimersByTime(350);
    interpreter.tap();
    expect(onTap).not.toHaveBeenCalled();
  });

  it("delivers the NEXT tap after a stop-tap, even inside the swallow window", () => {
    const { interpreter, onTap } = make(0);
    interpreter.scrollStart();
    interpreter.scrollEnd();
    interpreter.down(); // stop-tap at t=0
    vi.advanceTimersByTime(300);
    cleanTap(interpreter); // deliberate second tap at t=300
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("does not treat a down long after scroll-end as a stop-tap", () => {
    const { interpreter, onTap } = make(0);
    interpreter.scrollStart();
    interpreter.scrollEnd();
    vi.advanceTimersByTime(500);
    interpreter.down(); // long after scroll-end: a clean down
    interpreter.tap();
    expect(onTap).toHaveBeenCalledTimes(1);
  });
});

describe("debounced delivery (MapLibre style, deliverDelayMs 300)", () => {
  it("delivers a lone tap after the double-tap window", () => {
    const { interpreter, onTap } = make(300);
    cleanTap(interpreter);
    expect(onTap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("a second DOWN cancels the pending tap (touch double-tap: WebKit emits no dblclick and the zoom handler eats the second click)", () => {
    const { interpreter, onTap } = make(300);
    cleanTap(interpreter); // tap 1 → pending
    vi.advanceTimersByTime(150);
    interpreter.down(); // tap 2's touchstart — the only tell
    vi.advanceTimersByTime(1000);
    expect(onTap).not.toHaveBeenCalled();
  });

  it("a dblclick cancels the pending tap (desktop mouse path)", () => {
    const { interpreter, onTap } = make(300);
    cleanTap(interpreter);
    vi.advanceTimersByTime(100);
    cleanTap(interpreter); // second click re-arms...
    interpreter.doubleTap(); // ...and dblclick cancels
    vi.advanceTimersByTime(1000);
    expect(onTap).not.toHaveBeenCalled();
  });

  it("a scroll starting while a tap is pending cancels it (tap became a pan)", () => {
    const { interpreter, onTap } = make(300);
    cleanTap(interpreter);
    interpreter.scrollStart();
    vi.advanceTimersByTime(1000);
    expect(onTap).not.toHaveBeenCalled();
  });

  it("swallows the stop-tap's click, delivered through the debounce", () => {
    const { interpreter, onTap } = make(300);
    interpreter.scrollStart();
    interpreter.scrollEnd();
    interpreter.down(); // stop-tap
    interpreter.tap(); // its click arrives immediately on MapLibre
    vi.advanceTimersByTime(1000);
    expect(onTap).not.toHaveBeenCalled();
  });

  it("delivers a deliberate tap shortly after a stop-tap", () => {
    const { interpreter, onTap } = make(300);
    interpreter.scrollStart();
    interpreter.scrollEnd();
    interpreter.down(); // stop-tap at t=0
    vi.advanceTimersByTime(400);
    cleanTap(interpreter); // clean down clears suppression
    vi.advanceTimersByTime(300);
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("dispose cancels a pending delivery", () => {
    const { interpreter, onTap } = make(300);
    cleanTap(interpreter);
    interpreter.dispose();
    vi.advanceTimersByTime(1000);
    expect(onTap).not.toHaveBeenCalled();
  });
});
