import { beforeEach, describe, expect, it } from "vitest";

import { readLiveViewState, writeLiveViewState } from "./liveViewState";

describe("liveViewState", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns empty state when nothing is stored", () => {
    expect(readLiveViewState()).toEqual({});
  });

  it("merges patches across writes", () => {
    writeLiveViewState({ trackUp: true, zoom: 14 });
    writeLiveViewState({ follow: false });
    expect(readLiveViewState()).toEqual({
      trackUp: true,
      zoom: 14,
      follow: false,
    });
  });

  it("survives corrupted storage", () => {
    localStorage.setItem("wingover.live-view", "not json");
    expect(readLiveViewState()).toEqual({});
    writeLiveViewState({ zoom: 12 });
    expect(readLiveViewState()).toEqual({ zoom: 12 });
  });
});
