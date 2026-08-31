import { cx } from "../shared/cx";

import styles from "./Tile.module.css";

export interface TileSecondary {
  label?: string;
  value: React.ReactNode;
  accent: "green" | "magenta";
  testId: string;
}

interface TileProps {
  label: string;
  value: React.ReactNode;
  icon?: React.ReactNode;
  accent?: "cyan" | "green" | "yellow";
  secondary?: TileSecondary;
  wide?: boolean;
  testId: string;
}

export default function Tile({
  label,
  value,
  icon,
  accent,
  secondary,
  wide,
  testId,
}: TileProps) {
  const classes = cx(
    styles.tile,
    accent && styles[accent],
    wide && styles.wide,
    !!icon && styles.hasIcon,
    secondary && styles.split,
  );
  const labelClasses = cx(styles.labelRow, secondary && styles.splitRow);
  const valueClasses = cx(styles.valueRow, secondary && styles.splitRow);
  const secondaryClasses = secondary
    ? cx(
        styles.value,
        styles.secondaryValue,
        styles[`${secondary.accent}Value`],
      )
    : "";
  return (
    <div className={classes}>
      <div className={labelClasses}>
        <div className={styles.label}>{label}</div>
        {secondary?.label && (
          <div className={styles.secondaryLabel}>{secondary.label}</div>
        )}
      </div>
      <div className={valueClasses}>
        <div className={styles.value} data-testid={testId} data-tile-value="">
          {value}
        </div>
        {secondary && (
          <div className={secondaryClasses} data-testid={secondary.testId}>
            {secondary.value}
          </div>
        )}
      </div>
      {icon && <div className={styles.icon}>{icon}</div>}
    </div>
  );
}
