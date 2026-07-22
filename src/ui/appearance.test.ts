import { describe, expect, it } from "vitest";

import { deriveDark, normalizeAppearance } from "./appearance";

describe("normalizeAppearance", () => {
  it("reads unset (null) as the default: dark", () => {
    expect(normalizeAppearance(null)).toBe("dark");
  });

  it("keeps an explicit auto", () => {
    expect(normalizeAppearance("auto")).toBe("auto");
  });

  it("keeps an explicit dark", () => {
    expect(normalizeAppearance("dark")).toBe("dark");
  });

  it("falls back to dark for anything unrecognized", () => {
    expect(normalizeAppearance("light")).toBe("dark");
    expect(normalizeAppearance("")).toBe("dark");
  });
});

describe("deriveDark", () => {
  it("default (dark) pins dark regardless of system or satellite", () => {
    expect(
      deriveDark({ appearance: "dark", systemDark: false, satellite: false }),
    ).toBe(true);
    expect(
      deriveDark({ appearance: "dark", systemDark: false, satellite: true }),
    ).toBe(true);
  });

  it("auto follows the system scheme when not on satellite", () => {
    expect(
      deriveDark({ appearance: "auto", systemDark: false, satellite: false }),
    ).toBe(false);
    expect(
      deriveDark({ appearance: "auto", systemDark: true, satellite: false }),
    ).toBe(true);
  });

  it("auto still forces dark on satellite even with a light system", () => {
    expect(
      deriveDark({ appearance: "auto", systemDark: false, satellite: true }),
    ).toBe(true);
  });
});
