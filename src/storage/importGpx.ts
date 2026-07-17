import type { LngLat } from "../engine/types";
import { parseGpx } from "../flight/gpxImport";
import { computeStats } from "../flight/stats";
import { namedLaunches, nearestLaunchName, saveFlight } from "./db";

export interface ImportResult {
  imported: number;
  failed: string[];
  batchId: string;
}

export async function importGpxFiles(
  files: File[],
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  const batchId = crypto.randomUUID();
  const importedAt = Date.now();
  const failed: string[] = [];
  let imported = 0;
  let done = 0;

  // Loaded ONCE for the whole batch: a per-file inheritedLaunchName() call
  // reads every flight doc, turning a big historical import into
  // O(files x flights). GPX carries no launch names, so imported files can
  // only ever inherit from flights that predate the batch; a static
  // snapshot is exactly as correct as per-file reads, and a read failure
  // only costs labels, never the import.
  const launches = await namedLaunches().catch(() => []);

  for (const file of files) {
    try {
      const { name, fixes } = parseGpx(await file.text());
      const launchAt: LngLat = [fixes[0].longitude, fixes[0].latitude];
      await saveFlight(
        {
          id: crypto.randomUUID(),
          name: name || file.name.replace(/\.gpx$/i, ""),
          notes: "",
          startedAt: fixes[0].timestamp,
          stats: computeStats(fixes),
          updatedAt: importedAt,
          launchAt,
          launchName: nearestLaunchName(launches, launchAt),
          source: "gpx-import",
          sourceFilename: file.name,
          importBatchId: batchId,
          importedAt,
        },
        fixes,
      );
      imported++;
    } catch {
      failed.push(file.name);
    }
    done++;
    onProgress?.(done, files.length);
  }

  return { imported, failed, batchId };
}
