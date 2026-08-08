import { useEffect, useRef } from "react";

import type { MapView, RasterOverlay } from "../../shared/map/types";
import useVfrChart from "./useVfrChart";
import { VFR_COVERAGE } from "./vfrCharts";

interface Held {
  view: MapView;
  overlay: RasterOverlay;
}

/**
 * Draws the FAA sectionals over a ground map while `enabled`.
 *
 * Attached from an effect rather than from the page's onReady because the
 * manifest answer arrives over the network, long after the map is ready.
 * Silent when there is no chart for this device (manifest unreachable, or
 * a browser that cannot decode JXL): charts are an enhancement, and an
 * enhancement never explains itself to a pilot.
 */
export default function useChartOverlay(map: MapView | null, enabled: boolean) {
  const chart = useVfrChart();
  const held = useRef<Held | null>(null);

  useEffect(() => {
    // An overlay belongs to the view that minted it. When the page hands us
    // a different view (provider swap) or none (teardown), the old handle
    // is already dead with its map: drop it, never remove() through it.
    if (held.current && held.current.view !== map) held.current = null;
    if (!map) return;
    if (!enabled) {
      held.current?.overlay.remove();
      held.current = null;
      return;
    }
    if (!chart || held.current) return;
    const overlay = map.rasterOverlay(chart.tiles, {
      minZoom: chart.minZoom,
      maxZoom: chart.maxZoom,
      bounds: VFR_COVERAGE,
    });
    held.current = { view: map, overlay };
  }, [map, enabled, chart]);
}
