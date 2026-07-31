// Where the pilot IS on a flight's timeline — the position and the
// zoomed window — surviving the pane's dock swaps. The docks remount on
// every mode change (replay <-> clip editors) and on every track
// rewrite, but the pilot's place belongs to the FLIGHT, not to the dock
// instance: pausing at the takeoff and choosing "Trim start" should
// arrive with the cut already there, and Cancel/apply should land back
// at that moment with the same zoom.
//
// Deliberately module state, not React state (the paneWanted precedent,
// minus persistence): mounting docks read it in useState initializers,
// handlers and effects write it, and nothing re-renders on account of
// it. Keyed by flight id so a selection switch never inherits another
// flight's position; a reload starts fresh on purpose — this is gesture
// continuity, not a preference.

export interface TimelineView {
  start: number;
  end: number;
}

let memory: {
  key: string | null;
  at: number | null;
  view: TimelineView | null;
} = { key: null, at: null, view: null };

function forKey(key: string) {
  if (memory.key !== key) memory = { key, at: null, view: null };
  return memory;
}

export function rememberPosition(key: string, at: number): void {
  forKey(key).at = at;
}

export function rememberView(key: string, view: TimelineView | null): void {
  forKey(key).view = view;
}

export function recallTimeline(key: string): {
  at: number | null;
  view: TimelineView | null;
} {
  return memory.key === key ? memory : { at: null, view: null };
}
