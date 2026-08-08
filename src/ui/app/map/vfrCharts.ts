import { launchParam } from "../../shared/map/config";
import type { Bounds } from "../../shared/map/types";

/**
 * Where the FAA VFR sectional tiles are, right now.
 *
 * The tile pyramid is immutable and versioned: every bake ships to a NEW
 * prefix and the bucket deletes vfr objects after 180 days, so any URL
 * compiled into the app is a dated bomb. This manifest is the one pointer
 * that moves, and it is short-TTL cached while the tiles themselves are
 * immutable-cached. Read it, or show no chart; never guess a prefix.
 */
const MANIFEST_URL = "https://charts.wingover.app/vfr/latest.json";

// A hung request must not pin the session's one resolution attempt (see
// resolveVfrChart: only a settled failure is retried).
const FETCH_TIMEOUT_MS = 8000;

/**
 * The product's coverage as one box. Deliberately near-global: the VFR
 * product runs from the Marianas (145E) east to the Virgin Islands (60W)
 * and from Samoa (14S) to Point Barrow (72N), so it straddles the
 * antimeridian and no single tight box exists. It buys only the obvious
 * skips (deep ocean rows, the poles); precise coverage is the pipeline's
 * to publish, and this constant retires when the manifest carries it.
 */
export const VFR_COVERAGE: Bounds = [
  [-180, -15.5],
  [180, 72.5],
];

export interface VfrChart {
  // Absolute {z}/{x}/{y} tile template.
  tiles: string;
  minZoom: number;
  maxZoom: number;
  // When this cycle takes force (ms epoch), or null if unstated. Charts go
  // effective at 0901Z on their effective date.
  effective: number | null;
}

interface RawRelease {
  tiles?: unknown;
  minZoom?: unknown;
  maxZoom?: unknown;
  effective?: unknown;
}

interface RawManifest {
  current?: unknown;
  next?: unknown;
}

// WHATWG URL percent-encodes { and } in a path, which would turn the
// placeholders into %7Bz%7D and make every tile a 404. Put them back.
const withBraces = (href: string) =>
  href.replaceAll("%7B", "{").replaceAll("%7D", "}");

// The manifest may state its template relative to itself.
function absolute(template: string): string {
  return withBraces(new URL(template, MANIFEST_URL).href);
}

function toMillis(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// A release is usable only if it can actually be fetched AND drawn: a
// template with all three placeholders, and a real zoom range. maxZoom in
// particular is not cosmetic — past it the adapters crop and upscale the
// deepest ancestor rather than requesting tiles the pyramid never had, so
// a missing one means every deep zoom asks for nothing that exists.
function toChart(raw: unknown): VfrChart | null {
  if (!raw || typeof raw !== "object") return null;
  const release = raw as RawRelease;
  const { tiles, minZoom, maxZoom } = release;
  if (typeof tiles !== "string") return null;
  if (!["{z}", "{x}", "{y}"].every((token) => tiles.includes(token))) {
    return null;
  }
  if (typeof minZoom !== "number" || typeof maxZoom !== "number") return null;
  if (!Number.isFinite(minZoom) || !Number.isFinite(maxZoom)) return null;
  return {
    tiles: absolute(tiles),
    minZoom,
    maxZoom,
    effective: toMillis(release.effective),
  };
}

/**
 * Which release to fly with, given the moment.
 *
 * The FAA publishes a cycle ~20 days before it takes force and the
 * pipeline bakes it on sight, so `next` can be a perfectly good pyramid of
 * a chart that is not the law yet. A not-yet-effective chart is NEVER the
 * chart: the client waits out the clock even though the tiles are sitting
 * right there. The pipeline also promotes next to current server-side at
 * the effective moment, so the two rules agree and a client that misses
 * the promotion is merely stale, never premature.
 *
 * A `next` with no effective time cannot be shown to have arrived, so it
 * never wins. An unusable one falls through to `current`: a stale chart
 * beats no chart.
 */
export function selectChart(manifest: unknown, nowMs: number): VfrChart | null {
  if (!manifest || typeof manifest !== "object") return null;
  const { current, next } = manifest as RawManifest;
  const upcoming = toChart(next);
  if (upcoming?.effective != null && nowMs >= upcoming.effective) {
    return upcoming;
  }
  return toChart(current);
}

/**
 * A pinned tile template, for pointing a build at one specific bake:
 * ?vfr=<template> at launch, or a "wingover.vfr" localStorage key. Off
 * unless set, and it is the only way to reach a prefix the manifest does
 * not name — which is how a bake gets tested before it is published, and
 * how the e2e ring reaches chart view at all.
 *
 * It may name the chart host or the app's own origin, and NOWHERE else. A
 * template is a URL whose bitmaps the map then draws as the sectional, so
 * an ungated one turns any link into "render a stranger's chart for this
 * pilot, and report where he is looking, tile by tile."
 */
export function pinnedTemplate(
  raw: string | null,
  appOrigin: string,
): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw, appOrigin);
    const homes = [new URL(MANIFEST_URL).origin, appOrigin];
    return homes.includes(url.origin) ? withBraces(url.href) : null;
  } catch {
    return null;
  }
}

function storedTemplate(): string | null {
  try {
    return localStorage.getItem("wingover.vfr");
  } catch {
    return null;
  }
}

function templateOverride(): string | null {
  const raw = launchParam("vfr") ?? storedTemplate();
  return pinnedTemplate(raw, location.origin);
}

// A 1x1 JXL in the SAME ISOBMFF container the tiles ship in (signature
// box, ftyp, jxlc), 60 bytes. Decoding is NATIVE or not at all by
// decision: no WASM decoder, no AVIF twin, no fallback host. So a browser
// that cannot decode this cannot show a chart, and asking it to fetch
// half a megabyte of tiles per screen would be pure waste.
//
// Measured 2026-07-30 through Playwright: WebKit decodes it (1x1),
// Chromium and Firefox reject it, and a corrupted twin is rejected by all
// three — so a pass is a decode, not a decoder shrugging.
const JXL_PROBE =
  "data:image/jxl;base64,AAAADEpYTCANCocKAAAAFGZ0eXBqeGwgAAAAAGp4bCAAAAAcanhsY/8KABAQCQgCAQAgAEsSpUKFJBwA";

let decodable: Promise<boolean> | null = null;

function canDecodeJxl(): Promise<boolean> {
  decodable ??= (async () => {
    try {
      const probe = new Image();
      probe.src = JXL_PROBE;
      await probe.decode();
      return probe.naturalWidth > 0;
    } catch {
      return false;
    }
  })();
  return decodable;
}

async function load(): Promise<VfrChart | null> {
  // A pinned template answers BEFORE the codec gate, so that a run which
  // pins one is testing the chart path rather than the browser's codec
  // list: Chromium decodes no JXL, so gating first would end every
  // headless run before the feature started. Every bake to date is z0-12;
  // an override states only the template, so it takes that range on faith.
  const override = templateOverride();
  if (override) return toChart({ tiles: override, minZoom: 0, maxZoom: 12 });
  // Codec next: a browser that cannot decode JXL has no use for the
  // manifest, and this costs no network.
  if (!(await canDecodeJxl())) return null;
  try {
    const response = await fetch(MANIFEST_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`VFR charts: latest.json returned ${response.status}`);
      return null;
    }
    const chart = selectChart(await response.json(), Date.now());
    if (!chart) {
      console.warn("VFR charts: latest.json names no usable current release");
    }
    return chart;
  } catch (error) {
    console.warn("VFR charts: latest.json unreachable", error);
    return null;
  }
}

let resolution: Promise<VfrChart | null> | null = null;

/**
 * The session's chart, resolved once. The manifest changes at most every
 * few days, so one read per launch is plenty; a FAILED read is not cached,
 * so a launch with no signal does not cost the pilot charts for the rest
 * of the session.
 */
export function resolveVfrChart(): Promise<VfrChart | null> {
  resolution ??= load().then((chart) => {
    if (!chart) resolution = null;
    return chart;
  });
  return resolution;
}
