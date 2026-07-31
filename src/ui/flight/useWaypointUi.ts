import { useState } from "react";

import { engine } from "../../engine";
import type { LngLat, Waypoint } from "../../engine/types";

interface WaypointUi {
  /** The tapped waypoint, if it is still an active nav target. */
  selected: Waypoint | null;
  /** A long-pressed position waiting on the pilot's confirmation. */
  pending: LngLat | null;
  select: (id: string | null) => void;
  propose: (at: LngLat) => void;
  dismissPending: () => void;
  addPending: (at: LngLat) => void;
  clearSelected: (id: string) => void;
}

/**
 * The waypoint the pilot tapped on the map — gates the "clear checkpoint"
 * control — and the one a long press has proposed.
 *
 * selectedId: held as an id; the live active set decides existence.
 * pending: a long-press PROPOSES a checkpoint; the pilot confirms in the
 * flight dialog before it becomes the nav target (gloves-first: a mistap
 * in turbulence must not silently retarget navigation). One state: both
 * are transient waypoint-interaction UI, cleared on the same journeys.
 */
export function useWaypointUi(
  activeWaypoints: Waypoint[],
  nextWaypointId: string | undefined,
): WaypointUi {
  const [ui, setUi] = useState<{
    selectedId: string | null;
    pending: LngLat | null;
  }>({ selectedId: null, pending: null });

  // Only a still-active selection surfaces the control; a reached/removed pin
  // drops out of activeWaypoints and the button hides on its own.
  const selected = activeWaypoints.find((w) => w.id === ui.selectedId) ?? null;

  function select(id: string | null) {
    // Only the next waypoint — the current target — can be selected to
    // clear. A tap on any other pin (or a deselect) clears.
    const target = id === nextWaypointId ? id : null;
    setUi((current) => ({ ...current, selectedId: target }));
  }

  function propose(at: LngLat) {
    setUi((current) => ({ ...current, pending: at }));
  }

  function dismissPending() {
    setUi((current) => ({ ...current, pending: null }));
  }

  function addPending(at: LngLat) {
    void engine.addAdhocWaypoint(at);
    dismissPending();
  }

  function clearSelected(id: string) {
    void engine.removeWaypoint(id);
    setUi((current) => ({ ...current, selectedId: null }));
  }

  return {
    selected,
    pending: ui.pending,
    select,
    propose,
    dismissPending,
    addPending,
    clearSelected,
  };
}
