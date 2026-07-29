import { IonContent, IonIcon, IonModal } from "@ionic/react";
import { closeOutline } from "ionicons/icons";
import { type CSSProperties, useState } from "react";

import { consumeEndedFlight } from "../../../engine/session";
import {
  formatAirtime,
  formatAltitude,
  formatDistance,
  type Units,
} from "../../../flight/format";
import type { FlightStats as Stats } from "../../../flight/stats";
import { useSettings } from "../../shared/settings/SettingsContext";
import FlightFields from "./FlightFields";
import FlightStats from "./FlightStats";
import TrackSketch from "./TrackSketch";
import { useFlightDoc } from "./useFlightDoc";
import { useFlightDrafts } from "./useFlightDrafts";

import styles from "./EndedFlightSheet.module.css";

/**
 * What a pilot sees the moment a flight lands in the logbook.
 *
 * A real iOS sheet, and the gestures are the requirement rather than the
 * decoration: drag between the two detents, tap the handle to cycle them,
 * swipe down to dismiss. That is why this keeps Ionic's breakpoints — an
 * auto-height modal sizes to its content perfectly and cannot be dragged at
 * all, which is the wrong trade.
 *
 * Keeping them costs the problem breakpoints have: they are fractions of the
 * VIEWPORT, so a summary with an intrinsic height gets clipped on a short
 * phone and trails a strip of the form on a tall one. The fix is to stop
 * having an intrinsic height. The summary is exactly one detent tall (see
 * --detent in the CSS, set from the constant below), the type inside it is
 * fixed, and the track absorbs whatever is left over. Nothing below the fold
 * can peek, because the fold IS where the details start; nothing can be
 * clipped, because the elastic part is the only part that changes size.
 *
 * Read once on mount, not subscribed to: a flight can only end while the
 * flight surface is up, and handing it over is what mounts this shell, so the
 * value is always already there — same page load, no persistence, no store.
 *
 * useState's initializer, not an effect: consuming during the first render
 * commits to showing it, which is exactly the promise being made by clearing
 * it. An effect would leave a window where a remount consumes it twice.
 */

/** The landing stop, as a fraction of the screen. CSS reads it as --detent. */
const DETENT = 0.42;

export default function EndedFlightSheet() {
  const [flightId, setFlightId] = useState(consumeEndedFlight);
  // Presented-ness is its own state so the close button can play the dismiss
  // animation. Clearing the flight instead would empty the sheet mid-slide.
  const [open, setOpen] = useState(flightId !== null);

  return (
    <IonModal
      className={styles.sheet}
      isOpen={open}
      onDidDismiss={() => setFlightId(null)}
      // Two stops, not three: the landing summary, and the whole flight.
      // Anything between is a size with nothing to say. The leading 0 is what
      // makes a downward swipe dismiss rather than bottom out.
      breakpoints={[0, DETENT, 1]}
      initialBreakpoint={DETENT}
      handle
      handleBehavior="cycle"
      style={{ "--detent": DETENT } as CSSProperties}
    >
      {flightId && <EndedFlight id={flightId} onClose={() => setOpen(false)} />}
    </IonModal>
  );
}

function EndedFlight({ id, onClose }: { id: string; onClose: () => void }) {
  const { units } = useSettings();
  const { flight, setFlight, track } = useFlightDoc(id);
  const drafts = useFlightDrafts(flight, setFlight, track);

  if (!flight) return null;

  return (
    <IonContent>
      {/* slot="fixed": at the top detent the content scrolls, and the only
          explicit way out must not scroll away with it. */}
      <button
        slot="fixed"
        className={styles.close}
        aria-label="Close"
        data-testid="sheet-close"
        onClick={onClose}
      >
        <IonIcon icon={closeOutline} />
      </button>
      {/* The shape flown, then what it was. */}
      <div className={styles.summary}>
        <div className={styles.sketch}>
          <TrackSketch track={track} />
        </div>
        <Type stats={flight.stats} units={units} />
      </div>
      <div className={styles.details}>
        <FlightFields
          drafts={drafts.drafts}
          setDraft={drafts.setDraft}
          commit={drafts.commit}
        />
        {/* Duration is the headline above; printing it again here read as a
            bug on the first build of this screen. */}
        <FlightStats stats={flight.stats} units={units} skipDuration />
      </div>
    </IonContent>
  );
}

function Type({ stats, units }: { stats: Stats; units: Units }) {
  return (
    <div className={styles.type}>
      <p className={styles.saved}>Saved to logbook</p>
      <p className={styles.airtime}>{formatAirtime(stats.durationSeconds)}</p>
      <p className={styles.line}>
        {formatDistance(stats.distanceMeters, units)} ·{" "}
        {formatAltitude(stats.maxAltitude, units)}
      </p>
    </div>
  );
}
