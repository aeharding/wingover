# Wire contract fixtures (Swift <-> Rust <-> JS)

One canonical payload per surface and per interesting case, read by all three
languages. The rule this enforces is AGENTS.md's: **serde drops unknown fields
silently, so an untested field is an unsent field.**

The bug these exist for: Swift's `drain()` emitted an `error` field, Rust's
`DrainResponse` silently dropped it (serde ignores unknown fields), JS had a
handler for it, and a unit test stubbed a shape production never produced. Four
layers, individually plausible, jointly broken, invisible to every test.

## Who reads a fixture

| Ring                 | File                                       | What it asserts                                                                                                                                              |
| -------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| cargo (macOS, `ios`) | `src/wire.rs` (`mod contract`)             | every fixture key survives a round trip through the REAL serde types (deserializing alone proves nothing), and `expect.rust` matches what those types parsed |
| vitest (Linux)       | `src/engine/nativeSource.contract.test.ts` | every fixture flows through the real JS reader (helpers plus the real `watch`), and every declared literal exists in the Swift source                        |

Both switch on `surface` and **fail on a surface they don't know**. Adding a
fixture therefore fails until all sides claim it; that is the whole mechanism.

`cargo test` runs in CI's **iOS build job on macOS**, not the Linux job — the
plugin's build script drives the Swift compile, so the whole ring is one
`macos-26` runner. It runs fine on Linux locally and that is the fast loop:
`cargo test --manifest-path src-tauri/plugins/wingover/Cargo.toml`.

The Swift ring is a literal-presence check only (necessary, not sufficient): it
proves the key and code strings exist in `WingoverPlugin.swift`, not that the
right function emits them. Executing Swift against these fixtures needs a test
target that only a Mac can run; deferred.

## Fields

| Field                   | Meaning                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `surface`               | switch key for every reader. Command name, native or JS spelling of the same call                                      |
| `hop`                   | `swift->rust`, `rust->js`, `swift->rust->js`, `js->rust`, `js->rust->swift`, `rust->swift`                             |
| `description`           | why this case exists, and what breaks if it regresses                                                                  |
| `produces` / `consumes` | the two ends, by file                                                                                                  |
| `codes`                 | string literals `WingoverPlugin.swift` must contain: response keys plus stable codes. Only strings Swift itself writes |
| `request`               | the call's arguments, when it takes any                                                                                |
| `response`              | what the FIRST hop's producer emits                                                                                    |
| `jsResponse`            | what `invoke()` resolves with, when Rust unwraps the payload (`{ value }` -> string, `{ jws }` -> string, ...)         |
| `expect.rust`           | fix count and error the real serde types must parse. REQUIRED on `drain` and `fixes_since`; asserted by `wire.rs`      |
| `expect.js`             | what the real JS reader produces. Required whenever `hop` ends in `js`                                                 |

## Adding one

1. Write the JSON. `pnpm format` keeps it prettier-clean; CI checks it.
2. `cargo test --manifest-path src-tauri/plugins/wingover/Cargo.toml` — add a
   match arm in `wire.rs` if the surface is new.
3. `pnpm test` — add a case in `nativeSource.contract.test.ts` if the surface is
   new, or the "every fixture is claimed" test fails.

Never `#[serde(deny_unknown_fields)]` on `DrainResponse` to get the same signal:
Swift clears its buffer before resolving, so a failed parse loses that second of
flight permanently. The round-trip test catches renames in CI at no flight risk.
