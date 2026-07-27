import styles from "./AppCrash.module.css";

/**
 * What the pilot sees instead of a black screen when React's tree is gone
 * (#185). Deliberately says nothing about what broke: a stack trace is not
 * something a pilot can act on, and the fact that matters is that the flight
 * is not lost. Recording survives a React crash — the engine is module-scoped
 * and the WAL is native-side.
 *
 * `position: fixed` rather than absolute: the tree that would have provided a
 * positioned ancestor is exactly what just died.
 *
 * Takes no props, though react-error-boundary offers the error and a reset:
 * showing a pilot a stack is noise, and resetting in place cannot fix the
 * class of crash this exists for (a poisoned MapKit map survives a remount;
 * only a reload cleared it in #185). Surfacing the error properly is the
 * diagnostics work, and that means the whole rust/native/js record, not the
 * one string React happened to catch.
 */
export default function AppCrash() {
  return (
    <div className={styles.screen} data-testid="app-crashed">
      <h2>App Crashed</h2>
      <p>
        Wingover hit an unexpected error. Any flight in progress is still being
        recorded and nothing has been erased. Reload to continue.
      </p>
      <button
        className={styles.action}
        onClick={() => window.location.reload()}
      >
        Reload
      </button>
    </div>
  );
}
