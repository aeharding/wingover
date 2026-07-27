import { describe, expect, it } from "vitest";

import { mayHeal } from "./AppBoundary";

// The heal window is the one piece of this that can loop forever if it is
// wrong, and it is the piece a reload erases: the marker lives in storage
// precisely because every variable in the page dies before the next crash
// can read it. Pure, so it is testable without a DOM or a reload.
describe("AppBoundary: one heal per 60 s", () => {
  it("heals when nothing has healed before", () => {
    expect(mayHeal(1_000_000, null)).toBe(true);
  });

  it("refuses a second heal inside the window", () => {
    const healedAt = 1_000_000;
    expect(mayHeal(healedAt + 1, healedAt)).toBe(false);
    expect(mayHeal(healedAt + 59_999, healedAt)).toBe(false);
  });

  it("heals again once the window has passed", () => {
    const healedAt = 1_000_000;
    expect(mayHeal(healedAt + 60_000, healedAt)).toBe(true);
    expect(mayHeal(healedAt + 600_000, healedAt)).toBe(true);
  });

  // A clock that went backwards (NTP, timezone, a device asleep across a
  // sync) must not read as "60 s have passed". Refusing is the safe answer:
  // the pilot gets the crash screen instead of a possible reload loop.
  it("refuses when the clock has moved backwards", () => {
    const healedAt = 1_000_000;
    expect(mayHeal(healedAt - 5_000, healedAt)).toBe(false);
  });
});
