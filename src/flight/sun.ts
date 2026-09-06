import { solarPosition } from "./solarPosition";

const DEG = Math.PI / 180;
const J2000 = 2451545.0;
const UNIX_EPOCH_JD = 2440587.5;
const MS_PER_DAY = 86400000;
const MS_PER_MINUTE = 60000;
const MS_PER_HOUR = 3600000;

// A level horizon with standard refraction and the Sun's upper limb.
// Solar coordinates are refined at the event, independently for rise/set.
function solarEventNear(
  at: Date,
  latitude: number,
  longitude: number,
  direction: -1 | 1,
): Date | null {
  const jd = at.getTime() / MS_PER_DAY + UNIX_EPOCH_JD;
  const solarDay = Math.round(jd - J2000 + longitude / 360);
  const meanNoon = J2000 + solarDay - longitude / 360;
  let event = meanNoon + direction / 4;
  for (let iteration = 0; iteration < 4; iteration++) {
    const { declinationRadians, equationOfTimeMinutes } = solarPosition(event);
    const cosHourAngle =
      (Math.sin(-0.833 * DEG) -
        Math.sin(latitude * DEG) * Math.sin(declinationRadians)) /
      (Math.cos(latitude * DEG) * Math.cos(declinationRadians));
    if (cosHourAngle < -1 || cosHourAngle > 1) return null;
    const hourAngle = Math.acos(cosHourAngle) / DEG;
    event =
      meanNoon + (direction * hourAngle * 4 - equationOfTimeMinutes) / 1440;
  }
  return fromJulian(event);
}

const fromJulian = (j: number) => new Date((j - UNIX_EPOCH_JD) * MS_PER_DAY);

/** Sunset (upper limb, -0.833 degree horizon) nearest the given moment. */
export function sunsetNear(
  at: Date,
  latitude: number,
  longitude: number,
): Date | null {
  return solarEventNear(at, latitude, longitude, 1);
}

/** Sunrise, same contract as sunsetNear. */
export function sunriseNear(
  at: Date,
  latitude: number,
  longitude: number,
): Date | null {
  return solarEventNear(at, latitude, longitude, -1);
}

type EventNear = typeof sunsetNear;

// "Near" rounds to the nearest solar day, so walk a day either way for
// the strictly-next / strictly-previous event.
function eventAfter(
  event: EventNear,
  at: Date,
  latitude: number,
  longitude: number,
): Date | null {
  for (const days of [0, 1]) {
    const found = event(
      new Date(at.getTime() + days * MS_PER_DAY),
      latitude,
      longitude,
    );
    if (found && found.getTime() > at.getTime()) return found;
  }
  return null;
}

function eventBefore(
  event: EventNear,
  at: Date,
  latitude: number,
  longitude: number,
): Date | null {
  for (const days of [0, -1]) {
    const found = event(
      new Date(at.getTime() + days * MS_PER_DAY),
      latitude,
      longitude,
    );
    if (found && found.getTime() <= at.getTime()) return found;
  }
  return null;
}

// "2h 14m", "45m" — never "0m", never seconds.
function span(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MS_PER_MINUTE));
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m`;
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

const clock = (d: Date) =>
  new Date(
    Math.round(d.getTime() / MS_PER_MINUTE) * MS_PER_MINUTE,
  ).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * The idle screen's sun fact, walking the day's cycle (boundaries per
 * Alex): absolute sunset far out, relative inside 4h, "ago" up to 30m
 * past sunset; then the next sunrise, absolute until 120m out, relative
 * to the minute after that; "ago" until 6h past sunrise, then back to
 * sunset. Null only where the approximation gives up (polar day/night).
 */
export function sunFactLabel(
  at: Date,
  latitude: number,
  longitude: number,
): string | null {
  const t = at.getTime();

  const lastSet = eventBefore(sunsetNear, at, latitude, longitude);
  if (lastSet && t - lastSet.getTime() <= 30 * MS_PER_MINUTE) {
    return `Sunset ${span(t - lastSet.getTime())} ago`;
  }

  const lastRise = eventBefore(sunriseNear, at, latitude, longitude);
  const nextSet = eventAfter(sunsetNear, at, latitude, longitude);
  const nextRise = eventAfter(sunriseNear, at, latitude, longitude);

  const isDay =
    lastRise !== null &&
    nextSet !== null &&
    (nextRise === null || nextSet.getTime() < nextRise.getTime());

  if (isDay) {
    if (t - lastRise.getTime() <= 6 * MS_PER_HOUR) {
      return `Sunrise ${span(t - lastRise.getTime())} ago`;
    }
    if (nextSet.getTime() - t <= 4 * MS_PER_HOUR) {
      return `Sunset in ${span(nextSet.getTime() - t)}`;
    }
    return `Sunset ${clock(nextSet)}`;
  }

  if (nextRise) {
    if (nextRise.getTime() - t <= 120 * MS_PER_MINUTE) {
      return `Sunrise in ${span(nextRise.getTime() - t)}`;
    }
    return `Sunrise ${clock(nextRise)}`;
  }

  return nextSet ? `Sunset ${clock(nextSet)}` : null;
}
