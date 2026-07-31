import { afterEach, describe, expect, it, vi } from "vitest";

import { fixture } from "../../contractFixtures";
import { exportTextFile } from "./download";

const core = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => core);

afterEach(() => {
  vi.clearAllMocks();
  delete (globalThis as { window?: unknown }).window;
});

describe("exportTextFile", () => {
  it("routes through the native share sheet under Tauri, name sanitized", async () => {
    // isTauri() keys off __TAURI_INTERNALS__ on window.
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    core.invoke.mockResolvedValue(null);

    await exportTextFile("Flight 7/10/2026, 5:03:12 PM.gpx", "<gpx/>");

    expect(core.invoke).toHaveBeenCalledWith("plugin:wingover|share_file", {
      name: "Flight 7-10-2026, 5.03.12 PM.gpx",
      content: "<gpx/>",
    });
  });

  // The UI's half of the native wire contract: share_file's arguments, from
  // the shared fixtures (src-tauri/plugins/wingover/contract-fixtures/,
  // read by the cargo suite and the engine's contract test). Here because
  // the headless world may not import the UI to check it.
  it("emits the share_file request the contract fixture declares", async () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    core.invoke.mockResolvedValue(null);
    const { request } = fixture("share_file.request.json");

    await exportTextFile(request!.name as string, request!.content as string);

    expect(core.invoke).toHaveBeenCalledWith(
      "plugin:wingover|share_file",
      request,
    );
  });

  it("falls back to an anchor download on the web", async () => {
    const anchor = {
      href: "",
      download: "",
      click: vi.fn(),
    };
    const created: string[] = [];
    vi.stubGlobal("document", {
      createElement: (tag: string) => {
        created.push(tag);
        return anchor;
      },
    });
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:test",
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal("Blob", class {});

    await exportTextFile("flight.gpx", "<gpx/>");

    expect(core.invoke).not.toHaveBeenCalled();
    expect(created).toEqual(["a"]);
    expect(anchor.download).toBe("flight.gpx");
    expect(anchor.click).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
