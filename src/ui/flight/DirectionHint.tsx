import type { DirectionHint as Direction } from "../../flight/navigationGuidance";
import { cx } from "../shared/cx";

import styles from "./DirectionHint.module.css";

export default function DirectionHint({ direction }: { direction: Direction }) {
  if (!direction) return null;
  return (
    <div
      className={cx(styles.hint, styles[direction])}
      data-testid={`direction-hint-${direction}`}
      aria-hidden="true"
    />
  );
}
