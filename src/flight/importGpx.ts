import { saveFlight } from "../storage/db";
import { parseGpx } from "./gpxImport";
import { computeStats } from "./stats";

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

  for (const file of files) {
    try {
      const { name, fixes } = parseGpx(await file.text());
      await saveFlight(
        {
          id: crypto.randomUUID(),
          name: name || file.name.replace(/\.gpx$/i, ""),
          notes: "",
          startedAt: fixes[0].timestamp,
          stats: computeStats(fixes),
          updatedAt: importedAt,
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
