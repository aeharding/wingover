import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn().mockResolvedValue(undefined),
  onSettingChanged: vi.fn(),
}));
vi.mock("../../../storage/local", () => settings);

import { captureLaunchUrl } from "../../shared/map/config";
import { degradeUnreachableSatellite } from "./satelliteAvailability";

function stored(values: Record<string, string | null>) {
  settings.getSetting.mockImplementation((key: string) =>
    Promise.resolve(values[key] ?? null),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // resolveBackend reads location.search through captureLaunchUrl; vitest runs
  // in node, where there is no location.
  (globalThis as { location?: unknown }).location ??= { search: "" };
  captureLaunchUrl();
});

describe("degradeUnreachableSatellite", () => {
  it("degrades to street when MapLibre has no key to render satellite with", async () => {
    stored({ mapView: "satellite", mapBackend: "maplibre" });
    await degradeUnreachableSatellite();
    expect(settings.setSetting).toHaveBeenCalledWith("mapView", "street");
  });

  it("leaves satellite alone once the pilot's key is back", async () => {
    stored({ mapView: "satellite", mapBackend: "maplibre", maptilerKey: "k" });
    await degradeUnreachableSatellite();
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it("leaves satellite alone on MapKit, where it costs nothing", async () => {
    stored({ mapView: "satellite", mapBackend: "mapkit" });
    await degradeUnreachableSatellite();
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it("does not touch a street view", async () => {
    stored({ mapView: "street", mapBackend: "maplibre" });
    await degradeUnreachableSatellite();
    expect(settings.setSetting).not.toHaveBeenCalled();
  });
});
