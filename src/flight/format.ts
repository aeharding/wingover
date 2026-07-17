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
  // The browser's own grouping (10,690.32), matching formatAltitude: a
  // season's totals cross four digits and ungrouped reads as a typo.
  return `${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${suffix}`;
}

/**
 * The logbook row's timestamp, de-noised: weekday plus date at minutes
 * precision ("Sun, Jul 12 · 6:42 AM"), the weekday because that is how
 * recent flights are remembered. The year only once it stops being this
 * one, replacing the weekday, which no one recalls at that distance.
 */
export function formatFlightDate(startedAt: number, now = new Date()): string {
  const date = new Date(startedAt);
  const sameYear = date.getFullYear() === now.getFullYear();
  const day = date.toLocaleDateString(
    undefined,
    sameYear
      ? { weekday: "short", month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
  );
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${day} · ${time}`;
}

/**
 * LOGGED durations: "1 hr 34 min", "56 min", "45 sec". Floored, not
 * rounded (it is logged time, not an estimate), seconds only under a
 * minute (logbook scale has no use for them), and unambiguous where the
 * clock form was not ("55:37" read as either minutes or hours). The LIVE
 * flight timer keeps formatDuration's ticking clock on purpose: a
 * stopwatch that visibly advances reads as recording; a frozen "1 hr
 * 34 min" reads as stalled. FlyPage is almost a separate app.
 */
export function formatAirtime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds} sec`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) return `${minutes} min`;
  if (minutes === 0) return `${hours.toLocaleString()} hr`;
  return `${hours.toLocaleString()} hr ${minutes} min`;
}

/**
 * What a flight is CALLED. A name is optional (recording mints none);
 * the launch site stands in, and the date is the floor. Everything that
 * titles a flight (list row, seat card, GPX export) goes through here so
 * blank never leaks.
 */
export function flightTitle(flight: {
  name: string;
  launchName?: string;
  startedAt: number;
}): string {
  return flight.name || flight.launchName || formatFlightDate(flight.startedAt);
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
