# The engine audit ritual

The recording engine is the app's reason to exist (STEERING: "recording
never loses a flight"), and history shows its bugs don't look like bugs:
they look like plausible code that passed 270 green tests. The blocked-state
redesign shipped with a one-tap data-loss path, a severed Swift→Rust→JS
error channel, and a foreground handler that could delete a backgrounded
takeoff — all found not by tests but by an adversarial audit run before
merge. This document makes that audit a standing step instead of a heroic
one-off.

## When

Any PR that touches `src/engine/`, `src/flight/` detection logic,
`src-tauri/plugins/wingover/` (Rust or Swift), or the WAL/storage layer.
Skip it for copy, styling, and UI-only changes.

## What

Two independent reviewers with different lenses, run as background agents
(or by a human with the same briefs):

1. **Adversarial bug hunt.** Brief: the full branch diff plus surrounding
   context; hunt dead code, redundant guards, races/lifecycle bugs (timers
   vs teardown, concurrent retries, watch bounces mid-flush), real bugs in
   new paths, and test gaps. Require the reviewer to try to REFUTE each of
   its own findings before reporting, and to label survivors CONFIRMED
   (full path traced) or PLAUSIBLE. Findings come back as file:line + a
   concrete failure scenario, most severe first.

2. **Architecture review against doctrine.** Brief: read STEERING.md and
   ARCHITECTURE.md first, then judge the diff purely architecturally —
   seam placement, layer ownership, fix-time doctrine, background parity,
   reliability invariants. Verdict per area: CORRECT /
   ACCEPTABLE-BUT-NOTE / VIOLATION, each grounded in a quoted doctrine
   line, with the minimal doctrinally-correct fix sketched for violations.
   State explicitly which product decisions are final so the reviewer
   judges the implementation, not the decision.

The two briefs deliberately do not overlap; tell each agent the other
exists so it doesn't duplicate.

## Consuming the findings

- Verify CONFIRMED findings yourself before fixing — audits have been
  right about the defect and wrong about the reachable path.
- Fold all accepted findings into one consolidated pass, not a trickle of
  fix-of-the-fix commits (that churn is what the audit exists to prevent).
- PLAUSIBLE findings that don't get fixed get a sentence in the PR saying
  why not.
- Every fixed finding gets a test pinning the contract, in the ring that
  can actually observe it (unit / Playwright / ios-sim).

## What the audit is not

Not a substitute for the gates (see CLAUDE.md for the CI-parity list),
not a rubber stamp (an audit that finds nothing on a large engine diff is
a reason for suspicion, not celebration), and not a place to relitigate
decisions STEERING already made.
