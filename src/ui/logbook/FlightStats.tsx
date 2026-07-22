import { IonItem, IonLabel, IonList, IonNote } from "@ionic/react";

import {
  formatAirtime,
  formatAltitude,
  formatDistance,
  formatSpeed,
  type Units,
} from "../../flight/format";
import type { FlightStats as Stats } from "../../flight/stats";

import styles from "./FlightStats.module.css";

/**
 * The six-row flight summary (Duration, Distance, speeds, altitudes), shared
 * by the phone detail page and the desktop seat card.
 */
export default function FlightStats({
  stats,
  units,
}: {
  stats: Stats;
  units: Units;
}) {
  return (
    <IonList>
      <Stat label="Duration" value={formatAirtime(stats.durationSeconds)} />
      <Stat
        label="Distance"
        value={formatDistance(stats.distanceMeters, units)}
      />
      <Stat label="Max speed" value={formatSpeed(stats.maxSpeed, units)} />
      <Stat label="Avg speed" value={formatSpeed(stats.averageSpeed, units)} />
      <Stat
        label="Max altitude"
        value={formatAltitude(stats.maxAltitude, units)}
      />
      <Stat
        label="Max above launch"
        lines="none"
        value={formatAltitude(
          stats.maxAltitude - (stats.launchAltitude ?? stats.minAltitude),
          units,
        )}
      />
    </IonList>
  );
}

function Stat({
  label,
  value,
  lines,
}: {
  label: string;
  value: string;
  lines?: "none";
}) {
  return (
    <IonItem lines={lines}>
      <IonLabel>{label}</IonLabel>
      <IonNote slot="end" className={styles.statValue}>
        {value}
      </IonNote>
    </IonItem>
  );
}
