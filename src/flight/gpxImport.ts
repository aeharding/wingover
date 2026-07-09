import type { Fix } from "../engine/types";
import { bearingBetween } from "./nav";
import { haversineMeters } from "./stats";

export interface ParsedGpx {
  name: string | null;
  fixes: Fix[];
}

const MIN_INTERVAL_MS = 500;

interface RawPoint {
  latitude: number;
  longitude: number;
  altitude: number;
  timestamp: number;
}

function firstTagText(parent: Element | Document, tag: string): string | null {
  const element = parent.getElementsByTagName(tag)[0];
  return element?.textContent?.trim() || null;
}

export function parseGpx(xml: string): ParsedGpx {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("Invalid GPX");
  }

  const track = doc.getElementsByTagName("trk")[0];
  const metadata = doc.getElementsByTagName("metadata")[0];
  const name =
    (track && firstTagText(track, "name")) ||
    (metadata && firstTagText(metadata, "name")) ||
    null;

  const raw: RawPoint[] = [];
  const points = doc.getElementsByTagName("trkpt");
  for (const point of Array.from(points)) {
    const latitude = Number(point.getAttribute("lat"));
    const longitude = Number(point.getAttribute("lon"));
    const time = firstTagText(point, "time");
    const timestamp = time ? Date.parse(time) : NaN;
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(timestamp)
    ) {
      continue;
    }
    const altitude = Number(firstTagText(point, "ele") ?? NaN);
    raw.push({
      latitude,
      longitude,
      altitude: Number.isFinite(altitude) ? altitude : 0,
      timestamp,
    });
  }

  raw.sort((a, b) => a.timestamp - b.timestamp);

  const kept: RawPoint[] = [];
  for (const point of raw) {
    const previous = kept[kept.length - 1];
    if (previous && point.timestamp - previous.timestamp < MIN_INTERVAL_MS) {
      continue;
    }
    kept.push(point);
  }

  if (kept.length < 2) throw new Error("No usable track points");

  const fixes: Fix[] = kept.map((point, index) => {
    const previous = kept[index - 1];
    const next = kept[index + 1];
    const dtSeconds = previous
      ? (point.timestamp - previous.timestamp) / 1000
      : 0;
    const speed =
      previous && dtSeconds > 0
        ? haversineMeters(previous, point) / dtSeconds
        : 0;
    const climbRate =
      previous && dtSeconds > 0
        ? (point.altitude - previous.altitude) / dtSeconds
        : 0;
    const course = next
      ? bearingBetween(point, next)
      : previous
        ? bearingBetween(previous, point)
        : 0;
    return {
      timestamp: point.timestamp,
      latitude: point.latitude,
      longitude: point.longitude,
      altitude: point.altitude,
      speed,
      course,
      climbRate,
      horizontalAccuracy: 0,
      verticalAccuracy: 0,
    };
  });

  return { name, fixes };
}
