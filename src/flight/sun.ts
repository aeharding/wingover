const DEG = Math.PI / 180;
const J2000 = 2451545.0;
const UNIX_EPOCH_JD = 2440587.5;
const MS_PER_DAY = 86400000;
const MS_PER_MINUTE = 60000;
const MS_PER_HOUR = 3600000;

interface SolarDay {
  // Julian date of solar noon.
  jTransit: number;
  // Half the day arc, in degrees of hour angle.
  omega: number;
}

// The standard sunrise-equation approximation (NOAA coefficients) for
// the mean solar day nearest the given moment. Accurate to a couple of
// minutes, plenty for a glanceable fact; no network, no tables. Null in
// polar day/night, when the sun neither rises nor sets.
function solarDayNear(
  at: Date,
  latitude: number,
  longitude: number,
): SolarDay | null {
  const jd = at.getTime() / MS_PER_DAY + UNIX_EPOCH_JD;
  // Local solar time runs AHEAD of UTC east of Greenwich, hence +lng.
  const n = Math.round(jd - J2000 + 0.0008 + longitude / 360);
  const jStar = n + longitude / -360;

  const meanAnomaly = (357.5291 + 0.98560028 * jStar) % 360;
  const m = meanAnomaly * DEG;
  const center =
    1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m);
  const eclipticLng = ((meanAnomaly + center + 180 + 102.9372) % 360) * DEG;

  const jTransit =
    J2000 + jStar + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * eclipticLng);

  const sinDecl = Math.sin(eclipticLng) * Math.sin(23.4397 * DEG);
  const cosDecl = Math.cos(Math.asin(sinDecl));
  const cosHourAngle =
    (Math.sin(-0.833 * DEG) - Math.sin(latitude * DEG) * sinDecl) /
    (Math.cos(latitude * DEG) * cosDecl);
  if (cosHourAngle < -1 || cosHourAngle > 1) return null;

  return { jTransit, omega: Math.acos(cosHourAngle) / DEG };
}

const fromJulian = (j: number) => new Date((j - UNIX_EPOCH_JD) * MS_PER_DAY);

/** Sunset (upper limb, -0.833 degree horizon) nearest the given moment. */
export function sunsetNear(
  at: Date,
  latitude: number,
  longitude: number,
): Date | null {
  const day = solarDayNear(at, latitude, longitude);
  return day ? fromJulian(day.jTransit + day.omega / 360) : null;
}

/** Sunrise, same contract as sunsetNear. */
export function sunriseNear(
  at: Date,
  latitude: number,
  longitude: number,
): Date | null {
  const day = solarDayNear(at, latitude, longitude);
  return day ? fromJulian(day.jTransit - day.omega / 360) : null;
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
  d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

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
