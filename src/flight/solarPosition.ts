const DEG = Math.PI / 180;
const J2000 = 2451545;
const DAYS_PER_CENTURY = 36525;

// Meeus solar coordinates and equation of time, as published by NOAA:
// https://gml.noaa.gov/grad/solcalc/main.js
function obliquity(centuries: number): number {
  const seconds =
    21.448 -
    centuries * (46.815 + centuries * (0.00059 - centuries * 0.001813));
  const mean = 23 + (26 + seconds / 60) / 60;
  const omega = (125.04 - 1934.136 * centuries) * DEG;
  return (mean + 0.00256 * Math.cos(omega)) * DEG;
}

function declination(
  centuries: number,
  meanLongitude: number,
  anomaly: number,
  tilt: number,
): number {
  const center =
    Math.sin(anomaly) *
      (1.914602 - centuries * (0.004817 + 0.000014 * centuries)) +
    Math.sin(2 * anomaly) * (0.019993 - 0.000101 * centuries) +
    Math.sin(3 * anomaly) * 0.000289;
  const omega = (125.04 - 1934.136 * centuries) * DEG;
  const apparentLongitude =
    meanLongitude + (center - 0.00569 - 0.00478 * Math.sin(omega)) * DEG;
  return Math.asin(Math.sin(tilt) * Math.sin(apparentLongitude));
}

function equationOfTime(
  centuries: number,
  meanLongitude: number,
  anomaly: number,
  tilt: number,
): number {
  const eccentricity =
    0.016708634 - centuries * (0.000042037 + 0.0000001267 * centuries);
  const y = Math.tan(tilt / 2) ** 2;
  const equation =
    y * Math.sin(2 * meanLongitude) -
    2 * eccentricity * Math.sin(anomaly) +
    4 * eccentricity * y * Math.sin(anomaly) * Math.cos(2 * meanLongitude) -
    0.5 * y * y * Math.sin(4 * meanLongitude) -
    1.25 * eccentricity * eccentricity * Math.sin(2 * anomaly);
  return (equation / DEG) * 4;
}

export function solarPosition(julianDate: number): {
  declinationRadians: number;
  equationOfTimeMinutes: number;
} {
  const centuries = (julianDate - J2000) / DAYS_PER_CENTURY;
  const meanLongitude =
    ((280.46646 + centuries * (36000.76983 + 0.0003032 * centuries)) % 360) *
    DEG;
  const anomaly =
    (357.52911 + centuries * (35999.05029 - 0.0001537 * centuries)) * DEG;
  const tilt = obliquity(centuries);
  return {
    declinationRadians: declination(centuries, meanLongitude, anomaly, tilt),
    equationOfTimeMinutes: equationOfTime(
      centuries,
      meanLongitude,
      anomaly,
      tilt,
    ),
  };
}
