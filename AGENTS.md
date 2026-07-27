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
pnpm check:css                        # CSS Modules conventions (docs/CSS-MODULES.md)
pnpm test                             # vitest
pnpm exec playwright test             # needs port 5173 free (kills nothing itself)
```

The ios-sim ring (XCUITest) runs only in CI on macOS. `cargo check` the
plugin from `src-tauri/plugins/wingover/` when touching Rust.

## Hard rules

- Never push to main: every main merge burns a limited TestFlight build.
  Branch + PR, worktrees under `.claude/worktrees/`.
- No `location.reload()` in app code (instance-swap + notify instead).
  Two sanctioned exceptions, both in `src/ui/shared`, both on a page that
  is already broken: the error screens' Reload button (pilot-initiated,
  WAL-rehydrated), and `AppBoundary`'s single automatic heal per 60 s
  when a crash happens in flight.
- `src/ui/` has three buckets and the two ends never meet: `app/` (the
  ground app), `flight/` (the in-flight surface, which replaces the whole
  shell in flight), `shared/` (what both genuinely need). `app` and
  `flight` never import each other — anything both want moves to
  `shared`, deliberately (`wingover/ui-bucket-isolation`).
  `src/ui/App.tsx` is the one exception: it is the switch between them.
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

## Code style

- **Self-explaining over explained.** If code needs a lot of explanation,
  refactor the code, not the comment. Comments state constraints the code
  cannot show — doctrine, a platform quirk, why the obvious thing is
  wrong. A comment apologizing for structure means the structure is
  wrong. (PR #158: a fifty-line readiness closure became
  `onReadinessAnswer` + `reclassifyTakeover`, the comments shrank 5x, and
  behavior did not change.)
- **Comments record, they do not argue.** A comment stating a checkable
  fact — a measured behavior, a platform quirk, an API contract — rots
  loudly, because the next reader can test it. A comment justifying a
  choice launders an assumption into authority and rots silently: it
  makes wrong code read as settled, so nobody re-checks it. Three in
  this repo did exactly that (a shader claiming "the map is never
  pitched" while `touchPitch` was on; a generator selecting
  `.map-container` after the class stopped existing; a claim that e2e
  used a backend nothing selected). If you cannot say where a claim was
  verified, do not write it in the voice of fact.
- **`switch` and small early-return functions over ternary chains** —
  `switch (true)` included, when the arms are ranges rather than a
  discriminant. Nested ternaries are lint-banned repo-wide.
- **`{cond && <X />}` only as a simple guard**: one condition (an
  identifier, member read or call), one element. Anything composite gets a
  named boolean or an extracted early-return render function
  (`wingover/simple-jsx-guard`).
- **Size and complexity ceilings are ratchets** (`eslint.config.js`),
  tightest on the flight surface. The fix for a violation is
  decomposition; never an exception, and inline disables are banned
  anyway.

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
