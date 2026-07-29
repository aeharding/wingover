import styles from "./SavingSurface.module.css";

/**
 * The "ended" surface: the beat between a flight finishing and the logbook
 * having it.
 *
 * It exists because "ended" is not "idle", so App.tsx still sheds the whole
 * Ionic shell here — tab bar, router, every page. Painting nothing meant a
 * pilot whose save failed sat in front of an empty screen with no text, no
 * button and no way out, and the only thing that used to speak was a toast
 * this surface replaced. STEERING is explicit that a finalization failure
 * surfaces loudly on every ring, this being the ring where the WAL is the
 * only copy.
 *
 * The flight is NOT at risk in either state, and the copy says so: it is
 * finalized in the WAL, collection is idempotent, and a foreground or a
 * relaunch retries on its own. Retry is here because neither of those
 * arrives for a pilot who just keeps looking at the screen.
 */
export default function SavingSurface({
  failed,
  onRetry,
}: {
  failed: boolean;
  onRetry: () => void;
}) {
  if (!failed) {
    return (
      <div className={styles.root} data-testid="saving">
        <p className={styles.saving}>Saving flight</p>
      </div>
    );
  }

  return (
    <div className={styles.root} data-testid="saving-failed">
      <h1 className={styles.title}>Flight Not Saved Yet</h1>
      <p className={styles.body}>
        The flight is recorded and safe on this device. It has not reached the
        logbook yet.
      </p>
      <button className={styles.retry} onClick={onRetry}>
        Try Again
      </button>
    </div>
  );
}
