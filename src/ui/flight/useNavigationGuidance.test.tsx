// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import type { Fix } from "../../engine/types";
import type { NavigationGuidance } from "../../flight/navigationGuidance";
import useNavigationGuidance from "./useNavigationGuidance";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const launch: Fix = {
  timestamp: 0,
  latitude: 43,
  longitude: -89,
  altitude: 300,
  speed: 12,
  course: 180,
  climbRate: 0,
  horizontalAccuracy: 3,
  verticalAccuracy: 5,
};

const latest: Fix = {
  ...launch,
  timestamp: 1000,
  latitude: 43.03,
};

describe("useNavigationGuidance", () => {
  it("derives from the track independently of unrelated props", () => {
    const track = [launch, latest];
    const results: (NavigationGuidance | null)[] = [];
    const root = createRoot(document.createElement("div"));

    function Harness({ fixes, tick }: { fixes: Fix[]; tick: number }) {
      results.push(useNavigationGuidance(fixes, null));
      return <span>{tick}</span>;
    }

    act(() => root.render(<Harness fixes={track} tick={0} />));
    act(() => root.render(<Harness fixes={track} tick={1} />));
    expect(results[1]).toStrictEqual(results[0]);

    const closer = { ...latest, timestamp: 2000, latitude: 43.02 };
    act(() => root.render(<Harness fixes={[...track, closer]} tick={2} />));
    expect(results[2]!.distanceMeters).toBeLessThan(results[1]!.distanceMeters);
    act(() => root.unmount());
  });
});
