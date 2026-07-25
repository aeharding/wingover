# Wingover — agent session guide

Paramotor flight recorder (Tauri v2 iOS + PWA). The one non-negotiable:
**recording never loses a flight** (STEERING.md).

## Read before deciding

- Design/UI/architecture calls: STEERING.md first, ARCHITECTURE.md for
  layer ownership. Doctrine disputes are settled by quoting them.
- Sync UI: SYNC-UX.md. Safe-area/insets: docs/INSETS.md. CSS:
  docs/CSS-MODULES.md.
- Engine/native-touching PRs run the audit ritual: docs/ENGINE-AUDIT.md.

## Gates (CI parity — run ALL of these locally before pushing)

```sh
pnpm exec tsc --noEmit
pnpm exec eslint . --max-warnings 0   # stricter than CI on purpose: CI runs `pnpm lint`, which lets warnings through
pnpm format:check                     # prettier, its own CI step after lint — and the one that fails most often
pnpm test                             # vitest
pnpm exec playwright test             # needs port 5173 free (kills nothing itself)
```

The ios-sim ring (XCUITest) runs only in CI on macOS. `cargo check` the
plugin from `src-tauri/plugins/wingover/` when touching Rust.

## Hard rules

- Never push to main: every main merge burns a limited TestFlight build.
  Branch + PR, worktrees under `.claude/worktrees/`.
- No `location.reload()` in app code (instance-swap + notify instead).
  The one sanctioned exception is the web denied-error screen's Reload
  button — pilot-initiated, pre-flight, WAL-rehydrated.
- Pilot-facing strings: no em dashes; plain words (UI Principles in
  STEERING). Colors are display-p3 with no sRGB fallbacks.
- The engine (`src/engine/`, `src/flight/`, `src/storage/`) imports no
  React and never switches on the platform — sources declare
  capabilities and the engine adapts. Swift/Kotlin sense and actuate;
  they do not decide (ARCHITECTURE.md).
- Wire contracts across Swift↔Rust↔JS are stable code strings, not
  prose, and every shape is covered by the contract fixtures
  (`src-tauri/plugins/wingover/contract-fixtures/`, read by `wire.rs` and
  `src/engine/nativeSource.contract.test.ts`) — serde drops unknown fields
  silently, so an untested field is an unsent field.

## Environment traps (all have drawn blood)

- Two dev servers: 5173 must serve the worktree under test; check the
  listener's cwd via /proc before trusting phone-test feedback.
- Backgrounding a vite server through `| head` kills it by SIGPIPE once
  it logs enough; don't pipe long-lived servers.
- `pkill -f vite` matches your own shell's command line; use `[v]ite`.
- Stale Safari bundles survive server swaps; retest in a private tab.
- A crash-looping docker container flaps the bridge network and aborts
  Chromium page loads mid-e2e (`ERR_NETWORK_CHANGED`).
- Deploy to the iPhone: `scripts/deploy-iphone.sh [ref]` (Mac over SSH; see script header). Simulator ring: docs/ios-sim-runbook.md.
