import type { Map as MapLibreMap } from "maplibre-gl";

// Anchor for inserting flight geometry: above all fills/lines (roads,
// buildings) but below the trailing label block. The first symbol layer in
// the style is not a safe anchor — OpenFreeMap dark places the `water_name`
// symbol before the `building` fill, which would put tracks under buildings.
export function labelInsertionPoint(map: MapLibreMap): string | undefined {
  const layers = map.getStyle().layers;
  let first: string | undefined;
  for (let i = layers.length - 1; i >= 0; i--) {
    if (layers[i].type !== "symbol") break;
    first = layers[i].id;
  }
  return first;
}
