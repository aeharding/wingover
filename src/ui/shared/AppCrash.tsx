import styles from "./AppCrash.module.css";

/**
 * The two ways the app can be broken at the root, and the only two screens
 * App.tsx renders instead of a surface. Both say the same three things: it
 * broke, your flights are safe, reload — so they are one component with two
 * pieces of copy rather than two near-identical files.
 *
 * Not in flight/ErrorScreen.tsx, which is a different thing despite looking
 * alike: that one is the engine's BLOCKED status (permission denied,
 * imprecise, busy), a state the pilot can ACT on, and it belongs to the flight
 * surface that is its only consumer.
 *
 * `position: fixed` rather than absolute: for the crash case, the tree that
 * would have provided a positioned ancestor is exactly what just died.
 */

// Two testids, not one: a drill asserting the app crashed must not pass
// because the WAL failed to read, and real-engine.spec already watches
// boot-failed specifically.
function RootFailure({
  testId,
  title,
  body,
}: {
  testId: string;
  title: string;
  body: string;
}) {
  return (
    <div className={styles.screen} data-testid={testId}>
      <h2>{title}</h2>
      <p>{body}</p>
      <button
        className={styles.action}
        onClick={() => window.location.reload()}
      >
        Reload
      </button>
    </div>
  );
}

/**
 * React's tree is gone (#185). Deliberately says nothing about what broke: a
 * stack is not something a pilot can act on, and the fact that matters is that
 * the flight is not lost. Recording survives a React crash — the engine is
 * module-scoped and the WAL is native-side.
 *
 * Takes no props, though react-error-boundary offers the error and a reset.
 * Resetting in place cannot fix the class of crash this exists for: a poisoned
 * MapKit map survives a remount, and only the reload cleared it in #185.
 * Surfacing the error properly is the diagnostics work, and that means the
 * whole rust/native/js record, not the one string React happened to catch.
 */
export default function AppCrash() {
  return (
    <RootFailure
      testId="app-crashed"
      title="App Crashed"
      body="Wingover hit an unexpected error. Any flight in progress is still being recorded and nothing has been erased. Reload to continue."
    />
  );
}

/**
 * The WAL could not be read, so the engine cannot know whether a flight is
 * live and no normal surface is safe to show: the idle screen's Start Flight
 * would clear the unread WAL. Reload is the only honest action, and a working
 * WAL rehydrates the session.
 */
export function BootFailedScreen() {
  return (
    <RootFailure
      testId="boot-failed"
      title="Something Went Wrong"
      body="Wingover could not read its saved flight data. Nothing has been erased. Reload to try again."
    />
  );
}
