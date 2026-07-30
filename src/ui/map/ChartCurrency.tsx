import type { MapViewKind } from "./config";
import useVfrChart from "./useVfrChart";
import { chartLabel } from "./vfrCharts";

import mapCss from "./map.module.css";

/**
 * Which sectional this is, shown beside the map's controls while the chart
 * view is up. The FAA republishes every 56 days and the pyramid follows,
 * so the pilot's question is not whether charts exist but which edition is
 * under them. Absent in every other view, and absent when there is no
 * chart to name.
 */
export default function ChartCurrency({ view }: { view: MapViewKind }) {
  const chart = useVfrChart();
  if (view !== "chart" || !chart) return null;
  const label = chartLabel(chart);
  if (!label) return null;
  return (
    <div className={mapCss.currency} data-testid="chart-currency">
      Sectional {label}
    </div>
  );
}
