import { airplaneOutline, globeOutline, mapOutline } from "ionicons/icons";

import NativeIcon from "../components/NativeIcon";
import type { MapViewKind } from "./config";
import useVfrChart from "./useVfrChart";

import mapCss from "./map.module.css";

interface ViewToggleProps {
  view: MapViewKind;
  // Ground maps that draw the sectional (useChartOverlay) opt in; the
  // flight surface does not, and neither does any map that would offer a
  // mode it cannot render.
  charts?: boolean;
  onChange: (view: MapViewKind) => void;
}

const LABEL: Record<MapViewKind, string> = {
  street: "Street view",
  satellite: "Satellite view",
  chart: "Sectional chart view",
};

const ICON: Record<MapViewKind, string> = {
  street: mapOutline,
  satellite: globeOutline,
  chart: airplaneOutline,
};

export default function ViewToggle({
  view,
  charts,
  onChange,
}: ViewToggleProps) {
  const chart = useVfrChart();
  // Sectionals join the cycle only once one has actually resolved for this
  // device: no manifest, or no JXL decoder, means no mode to offer. An
  // unoffered view falls out of the cycle, so a stored "chart" on a device
  // that lost charts steps back to street.
  const cycle: MapViewKind[] =
    charts && chart
      ? ["street", "satellite", "chart"]
      : ["street", "satellite"];
  const next = cycle[(cycle.indexOf(view) + 1) % cycle.length];
  return (
    <button
      className={mapCss.button}
      aria-label={LABEL[next]}
      onClick={() => onChange(next)}
    >
      <NativeIcon icon={ICON[next]} />
    </button>
  );
}
