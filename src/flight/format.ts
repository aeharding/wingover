export type Units = "imperial" | "metric";

const METERS_TO_FEET = 3.28084;
const MPS_TO_MPH = 2.23694;
const MPS_TO_KMH = 3.6;
const METERS_TO_MILES = 1 / 1609.344;

export function formatAltitude(meters: number, units: Units): string {
  if (units === "imperial")
    return `${Math.round(meters * METERS_TO_FEET).toLocaleString()} ft`;
  return `${Math.round(meters).toLocaleString()} m`;
}

export function formatSpeed(metersPerSecond: number, units: Units): string {
  if (units === "imperial")
    return `${(metersPerSecond * MPS_TO_MPH).toFixed(1)} mph`;
  return `${(metersPerSecond * MPS_TO_KMH).toFixed(1)} km/h`;
}

export function formatClimb(metersPerSecond: number, units: Units): string {
  const value =
    units === "imperial"
      ? `${(metersPerSecond * METERS_TO_FEET).toFixed(1)} ft/s`
      : `${metersPerSecond.toFixed(1)} m/s`;
  return metersPerSecond > 0 ? `+${value}` : value;
}

export function formatDistance(meters: number, units: Units): string {
  const value = units === "imperial" ? meters * METERS_TO_MILES : meters / 1000;
  const suffix = units === "imperial" ? "mi" : "km";
  return `${value.toFixed(2)} ${suffix}`;
}

export function formatCourse(degrees: number): string {
  return `${Math.round(degrees)}°`;
}

export function formatRelativeDegrees(degrees: number): string {
  const rounded = Math.round(degrees);
  return `${rounded > 0 ? "+" : ""}${rounded}°`;
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0)
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}
