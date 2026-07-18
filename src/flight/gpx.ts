import type { Fix } from "../engine/types";
import type { Flight } from "../storage/db";
import { flightTitle } from "./format";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function flightToGpx(
  flight: Pick<Flight, "name" | "launchName" | "startedAt">,
  fixes: Fix[],
): string {
  const points = fixes
    .map(
      (fix) =>
        `      <trkpt lat="${fix.latitude.toFixed(6)}" lon="${fix.longitude.toFixed(6)}">
        <ele>${fix.altitude.toFixed(1)}</ele>
        <time>${new Date(fix.timestamp).toISOString()}</time>
      </trkpt>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Wingover" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${escapeXml(flightTitle(flight))}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`;
}
