import { useState } from "react";

import type { Fix } from "../../engine/types";
import { type Flight, updateFlight } from "../../storage/db";

interface Drafts {
  name: string;
  launch: string;
  notes: string;
}

function seedFrom(flight: Flight | null): Drafts {
  return {
    name: flight?.name ?? "",
    launch: flight?.launchName ?? "",
    notes: flight?.notes ?? "",
  };
}

/**
 * The editable fields (name, launch, notes) as ONE draft object, plus the
 * commit-on-blur that persists them. Shared by the phone detail page and
 * the desktop seat. Drafts are DERIVED from the loaded flight until the
 * pilot types (edits are kept only while they belong to the same flight
 * object), so a selection swap re-seeds with no effect and no clobbering.
 */
export function useFlightDrafts(
  flight: Flight | null,
  setFlight: (flight: Flight) => void,
  track: Fix[],
): {
  drafts: Drafts;
  setDraft: (key: keyof Drafts, value: string) => void;
  commit: () => void;
} {
  const [edits, setEdits] = useState<{ base: Flight; drafts: Drafts } | null>(
    null,
  );

  const drafts =
    edits && edits.base === flight ? edits.drafts : seedFrom(flight);

  function setDraft(key: keyof Drafts, value: string) {
    if (!flight) return;
    setEdits({ base: flight, drafts: { ...drafts, [key]: value } });
  }

  function commit() {
    if (!flight) return;
    const name = drafts.name.trim() || flight.name;
    const launchName = drafts.launch.trim() || undefined;
    const notes = drafts.notes;
    // Dropping the edits re-derives from the (possibly updated) flight.
    setEdits(null);
    if (
      name === flight.name &&
      notes === flight.notes &&
      launchName === flight.launchName
    ) {
      return;
    }
    const changes: Partial<
      Pick<Flight, "name" | "notes" | "launchName" | "launchAt">
    > = { name, notes, launchName };
    // Flights recorded before launchAt existed have no coordinates to
    // match against — capture them from the loaded track the moment the
    // pilot names the launch, so future flights from this field inherit.
    if (launchName && !flight.launchAt && track.length > 0) {
      changes.launchAt = [track[0].longitude, track[0].latitude];
    }
    void updateFlight(flight.id, changes);
    setFlight({ ...flight, ...changes });
  }

  return { drafts, setDraft, commit };
}
