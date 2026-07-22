import type { Fix } from "../engine/types";

export interface FlightStats {
  durationSeconds: number;
  distanceMeters: number;
  launchAltitude: number;
  maxAltitude: number;
  minAltitude: number;
  maxSpeed: number;
  averageSpeed: number;
  maxClimbRate: number;
  minClimbRate: number;
}

const EARTH_RADIUS = 6371000;

export function haversineMeters(
  a: Pick<Fix, "latitude" | "longitude">,
  b: Pick<Fix, "latitude" | "longitude">,
): number {
  const toRadians = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * toRadians;
  const dLon = (b.longitude - a.longitude) * toRadians;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h =
    sinLat * sinLat +
    Math.cos(a.latitude * toRadians) *
      Math.cos(b.latitude * toRadians) *
      sinLon *
      sinLon;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(h));
}

/** A flight with no fixes, or a doc that predates/omits the stats field. */
export const EMPTY_STATS: FlightStats = {
  durationSeconds: 0,
  distanceMeters: 0,
  launchAltitude: 0,
  maxAltitude: 0,
  minAltitude: 0,
  maxSpeed: 0,
  averageSpeed: 0,
  maxClimbRate: 0,
  minClimbRate: 0,
};

export function computeStats(track: Fix[]): FlightStats {
  if (track.length === 0) {
    return { ...EMPTY_STATS };
  }

  const first = track[0];
  const last = track[track.length - 1];

  let distanceMeters = 0;
  let maxAltitude = first.altitude;
  let minAltitude = first.altitude;
  let maxSpeed = first.speed;
  let speedSum = 0;
  let maxClimbRate = first.climbRate;
  let minClimbRate = first.climbRate;

  for (let i = 0; i < track.length; i++) {
    const fix = track[i];
    if (i > 0) distanceMeters += haversineMeters(track[i - 1], fix);
    maxAltitude = Math.max(maxAltitude, fix.altitude);
    minAltitude = Math.min(minAltitude, fix.altitude);
    maxSpeed = Math.max(maxSpeed, fix.speed);
    speedSum += fix.speed;
    maxClimbRate = Math.max(maxClimbRate, fix.climbRate);
    minClimbRate = Math.min(minClimbRate, fix.climbRate);
  }

  return {
    durationSeconds: (last.timestamp - first.timestamp) / 1000,
    distanceMeters,
    launchAltitude: first.altitude,
    maxAltitude,
    minAltitude,
    maxSpeed,
    averageSpeed: speedSum / track.length,
    maxClimbRate,
    minClimbRate,
  };
}
