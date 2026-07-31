import { describe, expect, it } from "vitest";

import {
  getBooleanSetting,
  getDetectLanding,
  setBooleanSetting,
  setDetectLanding,
} from "./local";

describe("getDetectLanding (the renamed setting's compat read)", () => {
  it("defaults true, honors the pre-rename key, and prefers the new one", async () => {
    // Fresh device: nothing stored under either name.
    expect(await getDetectLanding()).toBe(true);

    // A device that chose before the rename keeps its choice.
    await setBooleanSetting("autoEndFlight", false);
    expect(await getDetectLanding()).toBe(false);

    // The first post-rename write takes over; the old key stops mattering
    // for reads, but stays mirrored so a rolled-back build reads the same
    // choice.
    await setDetectLanding(true);
    expect(await getDetectLanding()).toBe(true);
    expect(await getBooleanSetting("autoEndFlight", false)).toBe(true);
  });
});
