import type { Fix } from "./types";

const EARTH_RADIUS = 6371000;

const HOME = {
  latitude: 43.075,
  longitude: -89.55,
  groundAltitude: 300,
};

const CRUISE_ALTITUDE = HOME.groundAltitude + 300;
const GPS_ACQUIRE_SECONDS = 18;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class FlightSimulator {
  private rand: () => number;
  private fixes: Fix[] = [];
  private heading: number;
  private latitude = HOME.latitude;
  private longitude = HOME.longitude;
  private altitude = HOME.groundAltitude;

  constructor(
    seed: number,
    private startTime: number,
  ) {
    this.rand = mulberry32(seed);
    this.heading = this.rand() * 360;
  }

  fixesUpTo(count: number): Fix[] {
    while (this.fixes.length < count) this.step();
    return this.fixes.slice(0, count);
  }

  private step() {
    const t = this.fixes.length;
    const acquireProgress = Math.min(1, t / GPS_ACQUIRE_SECONDS);
    const horizontalAccuracy = 35 - 30 * acquireProgress + this.rand() * 2;
    const verticalAccuracy = 55 - 45 * acquireProgress + this.rand() * 3;

    let speed: number;
    let climb: number;

    if (t < 45) {
      speed = this.rand() * 0.6;
      climb = 0;
    } else if (t < 52) {
      speed = 2 + (t - 45) * 0.8;
      climb = 0;
    } else if (this.altitude < CRUISE_ALTITUDE) {
      speed = 10;
      climb = 1.5;
    } else {
      speed = 10.5 + (this.rand() - 0.5) * 2;
      climb = (this.rand() - 0.5) * 1.2;
    }

    this.heading = (this.heading + (this.rand() - 0.5) * 6 + 360) % 360;
    const headingRadians = (this.heading * Math.PI) / 180;
    const north = speed * Math.cos(headingRadians);
    const east = speed * Math.sin(headingRadians);

    this.latitude += (north / EARTH_RADIUS) * (180 / Math.PI);
    this.longitude +=
      (east / (EARTH_RADIUS * Math.cos((this.latitude * Math.PI) / 180))) *
      (180 / Math.PI);

    const previousAltitude = this.altitude;
    this.altitude = Math.max(HOME.groundAltitude, this.altitude + climb);

    this.fixes.push({
      timestamp: this.startTime + t * 1000,
      latitude: this.latitude,
      longitude: this.longitude,
      altitude: this.altitude,
      speed,
      course: this.heading,
      climbRate: this.altitude - previousAltitude,
      horizontalAccuracy,
      verticalAccuracy,
    });
  }
}
