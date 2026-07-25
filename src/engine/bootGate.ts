// The boot gate: the app does not commit its first render to a guess about
// whether a flight is in progress. It waits for the engine to say.
//
// The WAL lives in IndexedDB and cannot be read synchronously, so before
// hydration the engine honestly reports "idle" — and src/ui/App.tsx picks
// nav shell vs bare flight surface off exactly that. A pilot who relaunches
// mid-flight therefore watches the homescreen paint, tab bar and all, and
// only then the flight, against STEERING's Reliability invariant 3: "After
// any interruption, foregrounding the app shows the recording in progress,
// exactly where it left off, with zero pilot action."
//
// The fix is to wait, not to keep a second copy of the answer somewhere
// synchronous. A mirror in localStorage would be a cache of the WAL with its
// own coherence problem — every write site, every crash window between the
// two stores, and a stale flag that lands a pilot on the wrong surface — to
// buy back a wait that is a single IndexedDB transaction long. So: hold the
// first commit, keep the dark canvas index.html has already stamped, and
// render from the truth a few milliseconds later.
//
// Bounded, because a wait with no deadline is a brick. If the read has not
// landed by BOOT_HYDRATION_TIMEOUT_MS the gate opens anyway and the app
// renders from the current snapshot — precisely the behaviour it had before
// this gate existed, flash and all. The degraded path is the old status quo,
// never a black screen forever.
//
// Kicked at construction, which the composition root does at module init
// (engine/index.ts), NOT from a component effect: the read then races the
// webview's own boot work (module graph, CSS, first React render) instead of
// starting after it.

// A deadline for a WAL that has stopped answering (an evicted store, a
// WKWebView whose IndexedDB was severed by a Settings trip), not a budget
// for a healthy one: the read is one transaction against a store the browser
// already holds, and it lands in single-digit milliseconds. Long enough that
// a cold, contended launch never trips it; short enough that a pilot facing
// a genuinely dead store is not staring at a dark screen wondering.
export const BOOT_HYDRATION_TIMEOUT_MS = 2000;

export interface BootGate {
  // Stable identities (properties, not methods on a class the caller
  // destructures): useSyncExternalStore resubscribes when the subscribe
  // function changes and compares snapshots by identity.
  settled: () => boolean;
  subscribe: (listener: () => void) => () => void;
}

/**
 * @param hydrate the wait itself — `() => engine.getSnapshot()`, which
 *   resolves when the WAL has spoken. Called EXACTLY once, here; the gate is
 *   a one-shot latch, so no render, no remount and no second subscriber can
 *   re-ask.
 * @param timeoutMs the deadline past which the gate opens regardless.
 */
export function createBootGate(
  hydrate: () => Promise<unknown>,
  timeoutMs: number = BOOT_HYDRATION_TIMEOUT_MS,
): BootGate {
  let settled = false;
  const listeners = new Set<() => void>();

  // Idempotent: whichever of the two arms below arrives first opens the gate,
  // and the other is a no-op. (It closes over `timer` from below, which is
  // sound because nothing can call it synchronously: a settled promise's
  // continuation is a microtask and a timer is a task, so both run after this
  // function has finished building the gate.)
  const open = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    for (const listener of [...listeners]) listener();
  };

  // The deadline is armed BEFORE the read is asked for, so it covers the
  // whole wait no matter how hydrate() behaves.
  const timer = setTimeout(open, timeoutMs);
  // A rejection is an answer too: an unreadable WAL is not evidence of a
  // flight, and the app must boot the ordinary way rather than sit out the
  // deadline waiting on a promise that has already failed.
  void hydrate().then(open, open);

  return {
    settled: () => settled,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
