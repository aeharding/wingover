import { useSyncExternalStore } from "react";

import { engine } from "../../engine";
import ErrorScreen from "../shared/ErrorScreen";
import { useSettings } from "../shared/settings/SettingsContext";
import { useLiveViewPrefs } from "../shared/useLiveViewPrefs";
import ArmedSurface from "./ArmedSurface";
import { useBigConfirm } from "./BigConfirm";
import RecordingSurface from "./RecordingSurface";
import { useFlightCollection } from "./useFlightCollection";

import styles from "./FlightSurface.module.css";

export default function FlightSurface() {
  const { units } = useSettings();
  // The engine is the single owner of flight state; this surface is a view.
  // Snapshots are cached (stable identity between changes) and the change
  // signal is coalesced per task, so a replay burst lands as one render of
  // a complete track — there is no per-fix mirror to fall behind.
  const snapshot = useSyncExternalStore(engine.subscribe, engine.snapshotSync);
  const { confirm: bigConfirm, element: confirmElement } = useBigConfirm();
  const liveView = useLiveViewPrefs();

  const status = snapshot.status;

  useFlightCollection(status);

  async function cancelArmed() {
    await engine.discard();
  }

  // Journal the stop; the flight derives to "ended" and the collection
  // effect persists it — the same crash-safe path as a detected landing.
  function endFlight() {
    engine.end();
  }

  // An explicit confirm beats the old long-press: nothing about a hold
  // gesture is discoverable mid-flight, and a stray tap must not end a
  // recording. The same reasoning covers the pre-launch Cancel button — a
  // mistap while acquiring GPS or waiting for takeoff would silently miss
  // the launch — so it reuses this exact dialog. Before takeoff there's
  // nothing recorded to finalize (end() no-ops until launch), so the
  // confirmed action discards the un-launched session instead of ending.
  // The landing prompt's own button stays direct — it IS the confirmation
  // there.
  function confirmEndFlight() {
    // No takeoff on record = nothing to finalize: discard instead of end.
    const stop = beforeTakeoff() ? cancelArmed : endFlight;
    bigConfirm({ title: "End flight?", action: "Stop", onAction: stop });
  }

  function beforeTakeoff() {
    return status === "acquiring" || status === "armed";
  }

  function dismissLandingPrompt() {
    engine.dismissLanding();
  }

  // One surface per engine state. "ended" (collection is already running)
  // deliberately paints nothing but the surface's own background, and "idle"
  // never reaches here: App.tsx sheds this surface for the shell, whose Fly
  // tab is the home screen (app/pages/FlyPage).
  function surface() {
    switch (status) {
      case "acquiring":
      case "armed":
        return (
          <ArmedSurface
            status={status}
            latest={snapshot.latest}
            units={units}
            errorCode={snapshot.error?.code}
            onCancel={confirmEndFlight}
          />
        );
      case "recording":
      case "landed":
        return (
          <RecordingSurface
            snapshot={snapshot}
            units={units}
            liveView={liveView}
            onStop={confirmEndFlight}
            onEndNow={endFlight}
            onDismissLanding={dismissLandingPrompt}
          />
        );
      default:
        return null;
    }
  }

  // "blocked" is engine state like any other status: an error the pilot
  // must act on owns the surface (ErrorScreen) — never inline prose.
  // Narrowing on snapshot.status types the error as BlockingError; the
  // engine's discriminant guarantees it. Non-blocking errors (storage,
  // transient GPS shadows) surface nothing here: storage retries on its
  // own with the native track durably held in Rust, and the acquiring
  // screen's guidance covers a slow first fix.
  if (snapshot.status === "blocked") {
    return (
      <div className={styles.content} data-testid="fly-content">
        <ErrorScreen
          error={snapshot.error}
          onRetry={
            snapshot.error.code === "busy" ? undefined : () => engine.retry()
          }
          onCancel={() => void engine.discard()}
        />
        {confirmElement}
      </div>
    );
  }

  return (
    <div className={styles.content} data-testid="fly-content">
      {surface()}
      {confirmElement}
    </div>
  );
}
