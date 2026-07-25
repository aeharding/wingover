// The synchronous mirror of "a session is in play", written for one reader:
// the first render after a launch.
//
// The WAL is the source of truth and it lives in IndexedDB, which cannot be
// read synchronously. So before hydration the engine honestly reports
// "idle" — and the App picks nav shell vs bare flight surface off exactly
// that (src/ui/App.tsx). A pilot who relaunches mid-flight therefore watches
// the homescreen paint, tab bar and all, for as long as the WAL read takes,
// and only then the flight. That is the app appearing to forget the flight,
// against Reliability invariant 3: "After any interruption, foregrounding
// the app shows the recording in progress, exactly where it left off, with
// zero pilot action" (STEERING.md).
//
// Same doctrine as the recordInBrowser mirror (SettingsPage.saveRecordHere):
// "the / redirect and the /fly route gate commit on first render, long
// before an IndexedDB read resolves. PouchDB stays the source of truth; this
// is a cache of it." Here the WAL stays the source of truth and the engine
// owns every write: session presence changes in exactly three places
// (start, discard, hydration) and each one updates this cache — hydration
// last and authoritatively, so the cache can never outlive the WAL it
// describes.
//
// The two directions are not symmetric, and the hydration reconcile is what
// keeps the asymmetry honest:
//
//   flag missing on a real flight — the reported defect. Unacceptable.
//   flag left over on an idle app — one black loading frame before
//     hydration clears it. That is the same frame the flight surface shows
//     on any launch, over the same boot-dark canvas (index.html), so it
//     costs a pilot nothing.
//
// Read straight through on every call rather than cached in a module: the
// cost is a getItem on a store the browser holds in process, the callers
// are a boot render and a coalesced change notification, and a cache would
// be one more thing that can disagree with the WAL.

const KEY = "wingover.session";

/** Whether the engine holds a session (armed, flying, or awaiting collection). */
export function sessionInPlay(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Engine-only. Session presence changed; update the boot cache. */
export function setSessionInPlay(inPlay: boolean): void {
  try {
    if (inPlay) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    // No storage, no mirror: boot falls back to waiting on the WAL, i.e. to
    // the flash this exists to remove. Never a reason to fail a flight.
  }
}
