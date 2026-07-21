// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { Flight } from "../../storage/db";
import { useFlightDrafts } from "./useFlightDrafts";

vi.mock("../../storage/db", () => ({
  updateFlight: vi.fn(() => Promise.resolve()),
}));

const { updateFlight } = await import("../../storage/db");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const baseFlight: Flight = {
  id: "f1",
  name: "Sunset ridge",
  notes: "",
  startedAt: 0,
  updatedAt: 0,
  launchName: "Madcity",
  stats: {
    durationSeconds: 0,
    distanceMeters: 0,
    launchAltitude: 0,
    maxAltitude: 0,
    minAltitude: 0,
    maxSpeed: 0,
    averageSpeed: 0,
    maxClimbRate: 0,
    minClimbRate: 0,
  },
};

// The hook needs a component to live in; the harness owns the flight the
// way the pages do (setFlight feeds back into the next render) and hands
// the latest hook api out for the test to drive.
function setup(initial: Flight) {
  const latest = {} as ReturnType<typeof useFlightDrafts> & { flight: Flight };

  function Harness() {
    const [flight, setFlight] = useState(initial);
    Object.assign(latest, useFlightDrafts(flight, setFlight, []), { flight });
    return null;
  }

  act(() => {
    createRoot(document.createElement("div")).render(<Harness />);
  });
  return latest;
}

describe("useFlightDrafts", () => {
  it("clearing the name commits empty instead of reverting on blur", () => {
    const api = setup(baseFlight);

    // What the ion-input clear button does: ionInput with "", then blur.
    act(() => api.setDraft("name", ""));
    act(() => api.commit());

    expect(updateFlight).toHaveBeenCalledWith(
      "f1",
      expect.objectContaining({ name: "" }),
    );
    // Re-derived drafts stay cleared — no bounce back to "Sunset ridge".
    expect(api.drafts.name).toBe("");
    expect(api.flight.name).toBe("");
  });

  it("does not persist anything when nothing changed", () => {
    const api = setup(baseFlight);
    vi.mocked(updateFlight).mockClear();

    act(() => api.setDraft("name", "Sunset ridge"));
    act(() => api.commit());

    expect(updateFlight).not.toHaveBeenCalled();
  });
});
