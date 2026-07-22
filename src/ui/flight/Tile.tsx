import { cx } from "../cx";

import styles from "./Tile.module.css";

interface TileProps {
  label: string;
  value: React.ReactNode;
  icon?: React.ReactNode;
  accent?: "cyan" | "green" | "yellow";
  wide?: boolean;
  testId: string;
}

export default function Tile({
  label,
  value,
  icon,
  accent,
  wide,
  testId,
}: TileProps) {
  const classes = cx(
    styles.tile,
    accent && styles[accent],
    wide && styles.wide,
    !!icon && styles.hasIcon,
  );
  return (
    <div className={classes}>
      <div className={styles.label}>{label}</div>
      <div className={styles.value} data-testid={testId}>
        {value}
      </div>
      {icon && <div className={styles.icon}>{icon}</div>}
    </div>
  );
}
