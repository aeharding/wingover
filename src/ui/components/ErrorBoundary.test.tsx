// @vitest-environment happy-dom
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import ErrorBoundary from "./ErrorBoundary";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// A child that throws on demand: the flag lets a test flip it off and prove
// the retry re-renders healthy children.
let shouldThrow = true;
function Child() {
  if (shouldThrow) throw new Error("boom");
  return <div data-testid="child-ok">ok</div>;
}

function mount(ui: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  // React logs caught errors to console.error on top of our own log; silence
  // both so a passing run's output stays clean.
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const root = createRoot(container);
  act(() => root.render(ui));
  return { container, errorSpy };
}

afterEach(() => {
  shouldThrow = true;
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("renders children when they do not throw", () => {
    shouldThrow = false;
    const { container } = mount(
      <ErrorBoundary name="test">
        <Child />
      </ErrorBoundary>,
    );
    expect(container.querySelector('[data-testid="child-ok"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Something went wrong.");
  });

  it("shows the fallback and logs the boundary name when a child throws", () => {
    const { container, errorSpy } = mount(
      <ErrorBoundary name="logbook">
        <Child />
      </ErrorBoundary>,
    );
    expect(container.textContent).toContain("Something went wrong.");
    expect(container.textContent).toContain("Try again");
    // Ground fallback carries no recording copy.
    expect(container.textContent).not.toContain("Recording continues");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("logbook"),
      expect.anything(),
      expect.anything(),
    );
  });

  it("adds the recording-continues line in the flight variant", () => {
    const { container } = mount(
      <ErrorBoundary name="fly" variant="flight">
        <Child />
      </ErrorBoundary>,
    );
    expect(container.textContent).toContain("Something went wrong.");
    expect(container.textContent).toContain(
      "Recording continues in the background.",
    );
  });

  it("re-renders the children when Try again is tapped", () => {
    const { container } = mount(
      <ErrorBoundary name="test">
        <Child />
      </ErrorBoundary>,
    );
    expect(container.textContent).toContain("Something went wrong.");

    // The child is healthy now; the retry must show it again.
    shouldThrow = false;
    const button = container.querySelector("button");
    act(() => button?.click());

    expect(container.querySelector('[data-testid="child-ok"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Something went wrong.");
  });

  it("auto-resets the fallback when resetKey changes", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const root = createRoot(container);

    act(() =>
      root.render(
        <ErrorBoundary name="plan" resetKey="a">
          <Child />
        </ErrorBoundary>,
      ),
    );
    expect(container.textContent).toContain("Something went wrong.");

    // A navigation (new resetKey) with a now-healthy child clears the panel.
    shouldThrow = false;
    act(() =>
      root.render(
        <ErrorBoundary name="plan" resetKey="b">
          <Child />
        </ErrorBoundary>,
      ),
    );
    expect(container.querySelector('[data-testid="child-ok"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Something went wrong.");
  });
});
