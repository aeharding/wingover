import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "../engine/platform";

// Flight names contain "/" and ":" (locale timestamps) — invalid or
// path-splitting in filenames on every target.
function sanitizeFilename(name: string): string {
  return name.replaceAll("/", "-").replaceAll(":", ".");
}

export async function exportTextFile(filename: string, contents: string) {
  const name = sanitizeFilename(filename);
  if (isTauri()) {
    // WKWebView has no download manager — an anchor download is a silent
    // no-op. The file leaves the app through the system share sheet
    // (the plugin's fifth actuator primitive).
    await invoke("plugin:wingover|share_file", { name, content: contents });
    return;
  }
  const blob = new Blob([contents], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}
