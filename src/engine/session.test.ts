import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Pin } from "../storage/db";

// session.ts is the ONE projection of plan pins -> session waypoints
// (ARCHITECTURE.md's flight-scoped-config seam). Mock the three edges it
// touches — the pin store, the settings store, and the engine — and assert the
// projection and the copy-at-start behavior it documents.
const dbMock = vi.hoisted(() => ({ listPins: vi.fn() }));
const localMock = vi.hoisted(() => ({ getBooleanSetting: vi.fn() }));
const engineMock = vi.hoisted(() => ({ engine: { start: vi.fn() } }));

vi.mock("../storage/db", () => dbMock);
vi.mock("../storage/local", () => localMock);
vi.mock("./index", () => engineMock);

// WAYPOINT_RADIUS_M stays the REAL constant (not mocked) so the test pins the
// actual geofence radius the projection stamps.
import { WAYPOINT_RADIUS_M } from "../flight/waypoints";
import { startFlight } from "./session";

function pin(over: Partial<Pin> = {}): Pin {
  return {
    id: "p1",
    name: "Launch",
    notes: "grassy knoll",
    latitude: 46,
    longitude: 7,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const startArg = () =>
  engineMock.engine.start.mock.calls[0]?.[0] as {
    waypoints: unknown[];
    autoEnd: boolean;
  };

describe("startFlight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localMock.getBooleanSetting.mockResolvedValue(true);
    engineMock.engine.start.mockResolvedValue(undefined);
  });

  it("copies the plan pins into the session as ordered geofence waypoints", async () => {
    dbMock.listPins.mockResolvedValue([
      pin({ id: "a", latitude: 46.1, longitude: 7.1 }),
      pin({ id: "b", latitude: 46.2, longitude: 7.2 }),
    ]);

    await startFlight();

    expect(engineMock.engine.start).toHaveBeenCalledOnce();
    expect(startArg().waypoints).toEqual([
      { id: "a", latitude: 46.1, longitude: 7.1, radiusM: WAYPOINT_RADIUS_M },
      { id: "b", latitude: 46.2, longitude: 7.2, radiusM: WAYPOINT_RADIUS_M },
    ]);
  });

  it("never leaks pin planning fields (name, notes) into the waypoint", async () => {
    dbMock.listPins.mockResolvedValue([
      pin({ name: "Secret LZ", notes: "power lines to the east" }),
    ]);

    await startFlight();

    const wp = startArg().waypoints[0] as Record<string, unknown>;
    expect(Object.keys(wp).sort()).toEqual([
      "id",
      "latitude",
      "longitude",
      "radiusM",
    ]);
    expect(wp).not.toHaveProperty("name");
    expect(wp).not.toHaveProperty("notes");
  });

  it("starts with an empty waypoint set when there is no plan", async () => {
    dbMock.listPins.mockResolvedValue([]);

    await startFlight();

    expect(startArg().waypoints).toEqual([]);
  });

  it("copies the autoEnd setting the flight takes off with (default on)", async () => {
    dbMock.listPins.mockResolvedValue([]);
    localMock.getBooleanSetting.mockResolvedValue(false);

    await startFlight();

    expect(localMock.getBooleanSetting).toHaveBeenCalledWith(
      "autoEndFlight",
      true,
    );
    expect(startArg().autoEnd).toBe(false);
  });
});
