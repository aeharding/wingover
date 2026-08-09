import { useEffect, useState } from "react";

import { resolveVfrChart, type VfrChart } from "./vfrCharts";

/**
 * The session's VFR chart release, or null while it resolves and forever
 * after if it cannot be resolved. Charts are an enhancement: a page that
 * gets null shows its map without them and says nothing about it.
 */
export default function useVfrChart(): VfrChart | null {
  const [chart, setChart] = useState<VfrChart | null>(null);

  useEffect(() => {
    let alive = true;
    void resolveVfrChart().then((resolved) => {
      if (alive) setChart(resolved);
    });
    return () => {
      alive = false;
    };
  }, []);

  return chart;
}
