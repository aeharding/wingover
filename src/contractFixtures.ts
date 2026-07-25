// Loader for the shared Swift <-> Rust <-> JS wire fixtures
// (src-tauri/plugins/wingover/contract-fixtures/, round-tripped by the
// cargo suite in wire.rs).
//
// Test support, not app code: it lives at the src root rather than in a
// layer because each layer tests the surfaces it owns and none of them may
// import another's internals — engine (nativeSource.contract.test.ts),
// sync (nativeContract.test.ts), UI (download.test.ts).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PLUGIN_DIR = join(__dirname, "../src-tauri/plugins/wingover");

const FIXTURE_DIR = join(PLUGIN_DIR, "contract-fixtures");

export interface Fixture {
  file: string;
  surface: string;
  /** swift->rust, rust->js, swift->rust->js, js->rust, js->rust->swift, rust->swift */
  hop: string;
  description: string;
  /** Literals WingoverPlugin.swift must carry: response keys plus stable codes. */
  codes?: string[];
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  /** Present when Rust unwraps the payload before JS sees it. */
  jsResponse?: unknown;
  expect?: { js?: Record<string, unknown> };
}

export const fixtures: Fixture[] = readdirSync(FIXTURE_DIR)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => ({
    file,
    ...(JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as Omit<
      Fixture,
      "file"
    >),
  }));

export function fixture(file: string): Fixture {
  const found = fixtures.find((candidate) => candidate.file === file);
  if (found === undefined) throw new Error(`no such fixture: ${file}`);
  return found;
}

/** What invoke() resolves with: Rust unwraps some payloads, passes others whole. */
export function jsPayload(fixture: Fixture): unknown {
  return "jsResponse" in fixture ? fixture.jsResponse : fixture.response;
}

/** A fixture that declares no reading for what it is being asked is a gap, not a pass. */
export function expectJs(fixture: Fixture, key: string): unknown {
  const expected = fixture.expect?.js;
  if (expected === undefined || !(key in expected))
    throw new Error(`${fixture.file}: fixture declares no expect.js.${key}`);
  return expected[key];
}
