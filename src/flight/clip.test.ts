import { describe, expect, it } from "vitest";

import { FlightSimulator } from "../engine/simulator";
import {
  cumulativeDistances,
  MIN_CLIP_SPAN_MS,
  sliceTrack,
  splitAvailable,
  splitTrack,
  trimAvailable,
  windowIndices,
} from "./clip";
import { computeStats } from "./stats";

const track = new FlightSimulator(42, 0).fixesUpTo(180);

describe("windowIndices / sliceTrack", () => {
  it("is inclusive at both bounds", () => {
    const { from, to } = windowIndices(
      track,
      track[10].timestamp,
      track[20].timestamp,
    );
    expect(from).toBe(10);
    expect(to).toBe(20);
    const slice = sliceTrack(track, track[10].timestamp, track[20].timestamp);
    expect(slice).toHaveLength(11);
    expect(slice[0]).toEqual(track[10]);
    expect(slice[10]).toEqual(track[20]);
  });

  it("handles fractional bounds from barogram pixels", () => {
    // Half a fix-interval in from each side: the boundary fixes fall out.
    const start = track[10].timestamp + 0.5;
    const end = track[20].timestamp - 0.5;
    const slice = sliceTrack(track, start, end);
    expect(slice[0]).toEqual(track[11]);
    expect(slice[slice.length - 1]).toEqual(track[19]);
  });

  it("returns an empty slice when the window holds no fixes", () => {
    const between = track[10].timestamp + 1;
    expect(sliceTrack(track, between, track[11].timestamp - 1)).toHaveLength(0);
  });

  it("slice stats cover exactly the windowed fixes", () => {
    const slice = sliceTrack(track, track[30].timestamp, track[90].timestamp);
    const stats = computeStats(slice);
    expect(stats.durationSeconds).toBe(
      (track[90].timestamp - track[30].timestamp) / 1000,
    );
    expect(stats.launchAltitude).toBe(track[30].altitude);
  });
});

describe("splitTrack", () => {
  it("shares the boundary fix: the second half takes off where the first lands", () => {
    const { first, second } = splitTrack(track, track[90].timestamp);
    expect(first[first.length - 1]).toEqual(track[90]);
    expect(second[0]).toEqual(track[90]);
  });

  it("drops nothing: minus the shared point, the halves reassemble the whole", () => {
    const { first, second } = splitTrack(track, track[90].timestamp + 0.5);
    expect(first.length + second.length).toBe(track.length + 1);
    expect([...first, ...second.slice(1)]).toEqual(track);
    // The shared point makes the durations add up to the recording.
    expect(
      first[first.length - 1].timestamp -
        first[0].timestamp +
        (second[second.length - 1].timestamp - second[0].timestamp),
    ).toBe(track[track.length - 1].timestamp - track[0].timestamp);
  });
});

describe("cumulativeDistances", () => {
  it("agrees with computeStats over the whole track and any window", () => {
    const cum = cumulativeDistances(track);
    expect(cum[0]).toBe(0);
    expect(cum[track.length - 1]).toBeCloseTo(
      computeStats(track).distanceMeters,
      6,
    );
    const windowed = computeStats(track.slice(30, 91)).distanceMeters;
    expect(cum[90] - cum[30]).toBeCloseTo(windowed, 6);
  });

  it("is empty for an empty track", () => {
    expect(cumulativeDistances([])).toEqual([]);
  });
});

describe("availability", () => {
  const upTo = (seconds: number) =>
    new FlightSimulator(7, 0).fixesUpTo(seconds);

  it("offers trim only beyond the clip floor", () => {
    expect(trimAvailable(upTo(30))).toBe(false);
    expect(trimAvailable(upTo(MIN_CLIP_SPAN_MS / 1000 + 1))).toBe(false);
    expect(trimAvailable(upTo(90))).toBe(true);
  });

  it("offers split only when both halves can clear the floor", () => {
    expect(splitAvailable(upTo(90))).toBe(false);
    expect(splitAvailable(upTo(180))).toBe(true);
  });

  it("never offers either for a degenerate track", () => {
    expect(trimAvailable([])).toBe(false);
    expect(splitAvailable(upTo(1))).toBe(false);
  });
});
