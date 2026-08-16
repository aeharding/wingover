import type { Fix } from "../engine/types";
import { bearingBetween } from "./nav";
import { haversineMeters } from "./stats";

const EARTH_RADIUS = 6371000;

const HOME = {
  latitude: 43.075,
  longitude: -89.55,
  groundAltitude: 300,
};

const CRUISE_ALTITUDE = HOME.groundAltitude + 300;
const GPS_ACQUIRE_SECONDS = 18;
const LAUNCH_RUN_END_S = 52;
// The simulated pilot lands after two hours: fly home, descend, and stop
// AT the launch point with zero speed — the engine's landing detection
// insists on all three (landing.ts), and the simulator only supplies
// data; the engine detects and finalizes.
export const SIM_FLIGHT_END_S = LAUNCH_RUN_END_S + 2 * 60 * 60;

const RETURN_SPEED_MPS = 10.5;
const DESCENT_RATE_MPS = 1.5;
// A literal, not the detector's threshold: the data producer must not
// import the decider it is used to exercise (a fixture defined in terms
// of the code under test can never disconfirm it).
const CIRCLING_SPEED_MPS = 4;

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
  private home = { latitude: HOME.latitude, longitude: HOME.longitude };

  constructor(
    seed: number,
    private startTime: number,
    home?: { latitude: number; longitude: number },
  ) {
    this.rand = mulberry32(seed);
    this.heading = this.rand() * 360;
    if (home) {
      this.latitude = home.latitude;
      this.longitude = home.longitude;
      this.home = { latitude: home.latitude, longitude: home.longitude };
    }
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

    const here = { latitude: this.latitude, longitude: this.longitude };
    const remaining = SIM_FLIGHT_END_S - t;
    const distanceHome = haversineMeters(here, this.home);
    const airborne = t >= LAUNCH_RUN_END_S && t < SIM_FLIGHT_END_S;
    // Turn for home when the flight time left just covers the trip (~30 s
    // spare), and bleed the altitude off over the last ~200 s, so the
    // clock stops on a wing already down at the launch point.
    const returning =
      airborne && remaining <= distanceHome / RETURN_SPEED_MPS + 30;
    const descending =
      airborne &&
      remaining * DESCENT_RATE_MPS <= this.altitude - HOME.groundAltitude + 30;

    let speed: number;
    let climb: number;

    if (t < 45) {
      speed = this.rand() * 0.6;
      climb = 0;
    } else if (t < LAUNCH_RUN_END_S) {
      speed = 2 + (t - 45) * 0.8;
      climb = 0;
    } else if (t >= SIM_FLIGHT_END_S) {
      speed = 0;
      climb = 0;
    } else if (returning) {
      this.heading = bearingBetween(here, this.home);
      // Overhead early: circle tight, still unmistakably flying.
      speed = distanceHome > 100 ? RETURN_SPEED_MPS : CIRCLING_SPEED_MPS;
      climb = descending ? -DESCENT_RATE_MPS : 0;
    } else if (this.altitude < CRUISE_ALTITUDE && !descending) {
      speed = 10;
      climb = 1.5;
    } else {
      speed = 10.5 + (this.rand() - 0.5) * 2;
      climb = descending ? -DESCENT_RATE_MPS : (this.rand() - 0.5) * 1.2;
    }

    if (speed > 0 && !returning) {
      this.heading = (this.heading + (this.rand() - 0.5) * 6 + 360) % 360;
    }
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
