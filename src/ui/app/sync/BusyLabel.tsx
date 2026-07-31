import { IonSpinner } from "@ionic/react";
import type { ReactNode } from "react";

import { cx } from "../../shared/cx";

import styles from "./sync.module.css";

/**
 * A busy button's label, Ionic-best-practice shape: the label keeps the
 * button's intrinsic size and turns invisible; the spinner overlays it.
 * Swapping the label for a spinner resized the button on every press —
 * different line boxes can never be pixel-stable.
 */
export function BusyLabel({
  busy,
  children,
}: {
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <span className={cx(styles.busyLabel, busy && styles.busyLabelBusy)}>
      <span className={styles.busyText}>{children}</span>
      {busy && <IonSpinner name="crescent" className={styles.busySpinner} />}
    </span>
  );
}
