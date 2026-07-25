// The Swift <-> Rust <-> JS wire, read from the same fixtures the cargo
// suite reads (src-tauri/plugins/wingover/contract-fixtures/, round-tripped
// in wire.rs). Three rings, one set of payloads:
//
//  - every fixture flows through the REAL JS reader, not a restatement of
//    it: the drain bug survived a unit test that stubbed a shape production
//    never produced;
//  - the Swift source must declare every key and code a fixture names
//    (presence only — necessary, not sufficient — since executing Swift
//    needs a Mac);
//  - the four command registries must agree, or an invoke that passes every
//    type check is refused at runtime by the capability list.
//
// A fixture no ring claims fails here, by design. Surfaces the headless
// world may not import (sync, UI) are claimed by a test in their own layer
// and listed in CLAIMED_ELSEWHERE.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectJs,
  type Fixture,
  fixtures,
  jsPayload,
  PLUGIN_DIR,
} from "../contractFixtures";
import { getCurrentPosition } from "../platform/currentPosition";
import {
  classifyDrainError,
  nativeCore,
  nativeLocationReady,
  nativePositionSource,
  permissionRefusal,
  type PermissionStatus,
} from "./nativeSource";
import type { SourceError, SourcePosition } from "./real";

const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => core);
// Every native reader gates on this; the fixtures describe the native ring.
vi.mock("../platform", () => ({ isTauri: () => true }));

const ROOT = join(__dirname, "../..");
const SWIFT = readFileSync(
  join(PLUGIN_DIR, "ios/Sources/WingoverPlugin.swift"),
  "utf8",
);

// The engine imports neither sync nor the UI (STEERING's directory
// boundaries), so their surfaces are read where the import is legal.
const CLAIMED_ELSEWHERE: Record<string, string> = {
  keychain_available: "src/sync/nativeContract.test.ts",
  keychain_delete: "src/sync/nativeContract.test.ts",
  keychain_get: "src/sync/nativeContract.test.ts",
  keychain_set: "src/sync/nativeContract.test.ts",
  share_file: "src/ui/download.test.ts",
  sign_in_with_apple: "src/sync/nativeContract.test.ts",
  storekit_current_entitlement: "src/sync/nativeContract.test.ts",
  storekit_environment: "src/sync/nativeContract.test.ts",
  storekit_products: "src/sync/nativeContract.test.ts",
  storekit_purchase: "src/sync/nativeContract.test.ts",
};

const here = (fixture: Fixture) => !(fixture.surface in CLAIMED_ELSEWHERE);

function stub(responses: Record<string, unknown>) {
  core.invoke.mockImplementation((command: string) =>
    Promise.resolve(command in responses ? responses[command] : null),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the fixtures themselves", () => {
  it("carry the fields every ring reads", () => {
    // A floor at the current count, not a token one: fixtures only ever
    // get added, so this catches a directory that quietly stopped being
    // read (a bad glob, a moved folder) instead of passing on two files.
    expect(fixtures.length).toBeGreaterThanOrEqual(32);
    for (const fixture of fixtures) {
      expect(fixture.surface, `${fixture.file}: surface`).toBeTruthy();
      expect(fixture.description, `${fixture.file}: description`).toBeTruthy();
      expect(fixture.hop, `${fixture.file}: hop`).toMatch(
        /^(swift|rust|js)(->(swift|rust|js))+$/,
      );
      // A JS-consumed payload without a declared reading is a fixture no
      // ring actually checks.
      if (fixture.hop.endsWith("js"))
        expect(fixture.expect?.js, `${fixture.file}: expect.js`).toBeTruthy();
    }
  });

  it("name only surfaces the plugin actually has", () => {
    // drain and speak are native-only primitives: Rust calls them, JS
    // never sees them, so they are absent from the command registries.
    const internal = new Set(["drain", "speak"]);
    for (const fixture of fixtures)
      if (!internal.has(fixture.surface))
        expect(registeredCommands(), fixture.file).toContain(fixture.surface);
  });

  it("hand the surfaces this layer cannot import to a test that can", () => {
    for (const [surface, file] of Object.entries(CLAIMED_ELSEWHERE))
      expect(readFileSync(join(ROOT, file), "utf8"), file).toContain(surface);
  });
});

describe("the engine reads every fixture it owns through the real path", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const fixture of fixtures.filter(
    (candidate) => candidate.hop.endsWith("js") && here(candidate),
  )) {
    it(`${fixture.file}`, async () => {
      const payload = jsPayload(fixture);
      switch (fixture.surface) {
        case "fixes_since": {
          const { error, fixes } = payload as {
            error: string | null;
            fixes: unknown[];
          };
          // The classifier's own answer. Suppressing a code while fixes
          // still flow is the watch's rule, pinned by the live-watch test
          // below, so a fixture carrying both declares no error here.
          if (error !== null && fixes.length === 0)
            expect(classifyDrainError(error)).toStrictEqual(
              expectJs(fixture, "sourceError"),
            );
          else expect(expectJs(fixture, "sourceError")).toBeNull();
          break;
        }
        case "check_permissions":
        case "request_permissions": {
          const status = payload as PermissionStatus;
          expect(permissionRefusal(status)).toStrictEqual(
            expectJs(fixture, "refusal"),
          );
          // Readiness always asks check_permissions; a request_permissions
          // fixture is here to prove the two shapes are interchangeable.
          stub({ "plugin:wingover|check_permissions": status });
          expect(await nativeLocationReady()).toBe(expectJs(fixture, "ready"));
          break;
        }
        case "current_position": {
          stub({
            "plugin:wingover|check_permissions": { location: "granted" },
            "plugin:wingover|current_position": payload,
          });
          expect(await getCurrentPosition()).toStrictEqual(
            expectJs(fixture, "currentPosition"),
          );
          break;
        }
        default:
          throw new Error(
            `${fixture.file}: no JS reader claims surface "${fixture.surface}" — add a case, or list it in CLAIMED_ELSEWHERE`,
          );
      }
    });
  }

  // The poll response, through the watch that actually consumes it: the
  // classifier agreeing in isolation is exactly what the drain bug had.
  for (const fixture of fixtures.filter(
    (candidate) => candidate.surface === "fixes_since",
  )) {
    it(`${fixture.file}: through the live watch`, async () => {
      vi.useFakeTimers();
      stub({
        "plugin:wingover|check_permissions": {
          location: "granted",
          precise: true,
        },
        "plugin:wingover|fixes_since": jsPayload(fixture),
      });

      const batches: SourcePosition[][] = [];
      const errors: SourceError[] = [];
      const stop = nativePositionSource.watch(
        (batch) => batches.push(batch),
        (error) => errors.push(error),
      );
      await vi.advanceTimersByTimeAsync(0);
      stop();

      const sourceError = expectJs(
        fixture,
        "sourceError",
      ) as SourceError | null;
      expect(errors).toStrictEqual(sourceError === null ? [] : [sourceError]);
      expect(batches.flat().map((position) => position.timestamp)).toEqual(
        expectJs(fixture, "positions"),
      );
      // The cursor argument is contract too: Rust's command takes `ts`.
      expect(core.invoke).toHaveBeenCalledWith("plugin:wingover|fixes_since", {
        ts: expect.any(Number),
      });
    });
  }

  for (const fixture of fixtures.filter(
    (candidate) => candidate.hop.startsWith("js") && here(candidate),
  )) {
    it(`${fixture.file}: emitted by the real caller`, () => {
      stub({});
      switch (fixture.surface) {
        case "set_waypoints":
          nativeCore.setWaypoints(
            fixture.request!.waypoints as Parameters<
              typeof nativeCore.setWaypoints
            >[0],
          );
          break;
        default:
          throw new Error(
            `${fixture.file}: no JS producer claims surface "${fixture.surface}" — add a case, or list it in CLAIMED_ELSEWHERE`,
          );
      }
      expect(core.invoke).toHaveBeenCalledWith(
        `plugin:wingover|${fixture.surface}`,
        fixture.request,
      );
    });
  }
});

describe("the Swift source declares every key and code the fixtures name", () => {
  // Presence, not provenance: this cannot see WHICH function emits a
  // literal, only that WingoverPlugin.swift still contains it. A rename
  // (the drain bug's move) fails here on Linux; a misplaced key does not.
  // Keys arrive two ways — a resolve dictionary writes "key", a Decodable
  // argument declares `let key: Type`. The type annotation is required in
  // the second form so a local binding of the same name (`if let error =`)
  // cannot stand in for the wire key it is named after.
  function declares(token: string): boolean {
    return (
      SWIFT.includes(`"${token}"`) || new RegExp(`\\blet ${token}:`).test(SWIFT)
    );
  }

  function keysOf(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap(keysOf);
    if (value === null || typeof value !== "object") return [];
    return Object.entries(value).flatMap(([key, field]) => [
      key,
      ...keysOf(field),
    ]);
  }

  for (const fixture of fixtures) {
    const expected = new Set([
      ...(fixture.codes ?? []),
      // Response keys where Swift is the producer; argument names where
      // Swift is the consumer.
      ...(fixture.hop.startsWith("swift") ? keysOf(fixture.response) : []),
      ...(fixture.hop.endsWith("swift") ? keysOf(fixture.request) : []),
    ]);
    if (expected.size === 0) continue;
    it(`${fixture.file}`, () => {
      for (const token of expected)
        expect(
          declares(token),
          `WingoverPlugin.swift is missing ${token}`,
        ).toBe(true);
    });
  }

  it("answers checkPermissions and requestPermissions with the same shape", () => {
    // The asymmetry that bypasses the precise gate on a first-run grant:
    // JS reassigns one PermissionStatus from both, so a key present in one
    // and absent from the other reads as "fine" and starts capture with
    // Precise Location off. Every resolve that reports authorization must
    // report accuracy with it — requestPermissions and the delegate that
    // answers the prompt included.
    const shape = (surface: string) =>
      fixtures
        .filter((fixture) => fixture.surface === surface)
        .map((fixture) =>
          Object.keys(fixture.response ?? {})
            .sort()
            .join(","),
        );
    expect(new Set(shape("request_permissions"))).toEqual(
      new Set(shape("check_permissions")),
    );

    // Exactly one dictionary in the Swift source answers with location,
    // and it carries precise: three call sites resolve permissions
    // (checkPermissions, requestPermissions, didChangeAuthorization) and a
    // second literal is how one of them drifts.
    const literals = SWIFT.match(/\[[^[\]]*"location":[^[\]]*\]/g) ?? [];
    expect(literals).toHaveLength(1);
    expect(literals[0]).toContain('"precise"');
    // Every input the refusal rule reads travels in that one dictionary,
    // so readiness and the watch's pre-capture gate can never be looking
    // at different state: a device-wide Location Services switch visible
    // to one and not the other is exactly a poll that says ready against
    // a watch that keeps refusing.
    expect(literals[0]).toContain('"servicesEnabled"');
  });
});

// build.rs feeds the permission generator, generate_handler! feeds the IPC
// router, and the capability list decides at runtime whether the call is
// allowed at all. A command missing from any one of them type-checks
// everywhere and fails on the phone.
function registeredCommands(): string[] {
  const buildRs = readFileSync(join(PLUGIN_DIR, "build.rs"), "utf8");
  const block = /const COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/.exec(buildRs);
  if (block === null) throw new Error("build.rs: no COMMANDS array");
  return [...block[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
}

describe("the command registries agree", () => {
  const sorted = (names: Iterable<string>) => [...new Set(names)].sort();

  it("build.rs, generate_handler! and the capability list list the same commands", () => {
    const libRs = readFileSync(join(PLUGIN_DIR, "src/lib.rs"), "utf8");
    const handler = /generate_handler!\[([\s\S]*?)\]/.exec(libRs);
    if (handler === null) throw new Error("lib.rs: no generate_handler!");
    const handled = [...handler[1].matchAll(/commands::(\w+)/g)].map(
      (match) => match[1],
    );

    const capabilities = JSON.parse(
      readFileSync(join(ROOT, "src-tauri/capabilities/default.json"), "utf8"),
    ) as { permissions: (string | { identifier: string })[] };
    const allowed = capabilities.permissions
      .filter(
        (permission): permission is string =>
          typeof permission === "string" &&
          permission.startsWith("wingover:allow-"),
      )
      .map((permission) =>
        permission.slice("wingover:allow-".length).replaceAll("-", "_"),
      );

    expect(sorted(handled)).toEqual(sorted(registeredCommands()));
    expect(sorted(allowed)).toEqual(sorted(registeredCommands()));
  });

  it("every command JS invokes is registered", () => {
    const invoked = new Set<string>();
    for (const file of readdirSync(join(ROOT, "src"), { recursive: true })) {
      const path = String(file);
      if (!path.endsWith(".ts") && !path.endsWith(".tsx")) continue;
      const source = readFileSync(join(ROOT, "src", path), "utf8");
      for (const match of source.matchAll(/plugin:wingover\|(\w+)/g))
        invoked.add(match[1]);
    }
    expect(invoked.size).toBeGreaterThan(0);
    expect(sorted(invoked)).toEqual(
      sorted(
        [...invoked].filter((name) => registeredCommands().includes(name)),
      ),
    );
  });
});
