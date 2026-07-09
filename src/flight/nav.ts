import type { Fix } from "../engine/types";

type LatLon = Pick<Fix, "latitude" | "longitude">;

export function bearingBetween(from: LatLon, to: LatLon): number {
  const toRadians = Math.PI / 180;
  const lat1 = from.latitude * toRadians;
  const lat2 = to.latitude * toRadians;
  const dLon = (to.longitude - from.longitude) * toRadians;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) / toRadians + 360) % 360;
}

export function relativeBearing(course: number, bearing: number): number {
  return ((bearing - course + 540) % 360) - 180;
}
