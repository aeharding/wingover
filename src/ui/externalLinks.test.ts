// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { installExternalLinkHandler } from "./externalLinks";

const { openUrlMock } = vi.hoisted(() => ({ openUrlMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: openUrlMock }));

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

function clickAnchor(href: string): MouseEvent {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.textContent = "link";
  document.body.appendChild(anchor);
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    button: 0,
  });
  anchor.dispatchEvent(event);
  return event;
}

const pristineOpen = window.open;

describe("installExternalLinkHandler", () => {
  afterEach(() => {
    setTauri(false);
    document.body.innerHTML = "";
    openUrlMock.mockClear();
    // The handler shims window.open; restore it so tests don't leak wrappers.
    window.open = pristineOpen;
  });

  it("installs no click handler on the web", () => {
    setTauri(false);
    const spy = vi.spyOn(document, "addEventListener");
    installExternalLinkHandler();
    expect(spy).not.toHaveBeenCalledWith("click", expect.anything());
    spy.mockRestore();
  });

  it("opens external links via the opener plugin under Tauri", async () => {
    setTauri(true);
    installExternalLinkHandler();
    const event = clickAnchor("https://www.maptiler.com/");
    // The in-app navigation is cancelled...
    expect(event.defaultPrevented).toBe(true);
    // ...and handed to the system browser (after the lazy import resolves).
    await vi.waitFor(() =>
      expect(openUrlMock).toHaveBeenCalledWith("https://www.maptiler.com/"),
    );
  });

  it("ignores in-app (non-http) links under Tauri", () => {
    setTauri(true);
    installExternalLinkHandler();
    const event = clickAnchor("#section");
    expect(event.defaultPrevented).toBe(false);
    expect(openUrlMock).not.toHaveBeenCalled();
  });

  it("routes a window.open(http) — MapKit's Legal link — to the opener", async () => {
    setTauri(true);
    installExternalLinkHandler();
    const result = window.open("https://gspe21-ssl.ls.apple.com/legal");
    // No WKWebView popup: the shim returns null and hands off to the opener.
    expect(result).toBeNull();
    await vi.waitFor(() =>
      expect(openUrlMock).toHaveBeenCalledWith(
        "https://gspe21-ssl.ls.apple.com/legal",
      ),
    );
  });

  it("leaves non-http window.open alone under Tauri", () => {
    setTauri(true);
    installExternalLinkHandler();
    window.open("about:blank");
    expect(openUrlMock).not.toHaveBeenCalled();
  });
});
