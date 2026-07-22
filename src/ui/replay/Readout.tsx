import { cx } from "../cx";

import styles from "./Readout.module.css";

/**
 * One in-flight stat in the pane's readout row. Shared by the playback
 * dock and the clip dock.
 */
export default function Readout({
  label,
  value,
  accent,
  testId,
}: {
  label: string;
  value: string;
  accent?: "cyan" | "green" | "yellow";
  testId: string;
}) {
  return (
    <div className={cx(styles.readout, accent && styles[accent])}>
      <div className={styles.label}>{label}</div>
      <div className={styles.value} data-testid={testId}>
        {value}
      </div>
    </div>
  );
}
