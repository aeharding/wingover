import type { ReactNode } from "react";

import styles from "./MapCluster.module.css";

/**
 * The 2×2 corner control cluster every full-screen map wears (fly page,
 * flight-detail fullscreen, the desktop seat). Cells are slots:
 *
 * - `undefined` (or omitted) — the cell doesn't render, and its auto track
 *   collapses; no state leaves controls floating off the host's anchor.
 * - `null` — the cell renders EMPTY. A host uses this to keep a row's
 *   geometry: the detail page's TL "compass slot" must hold its place so
 *   the compass lands on the same row as play, not a row above it.
 *
 * The hosts decide which corner the cluster hugs by where they place it;
 * the seat's "mirrored" layout is just its content in the left column.
 */
export default function MapCluster({
  tl,
  tr,
  bl,
  br,
}: {
  tl?: ReactNode;
  tr?: ReactNode;
  bl?: ReactNode;
  br?: ReactNode;
}) {
  return (
    <div className={styles.cluster}>
      {tl !== undefined && <div className={styles.tl}>{tl}</div>}
      {tr !== undefined && <div className={styles.tr}>{tr}</div>}
      {bl !== undefined && <div className={styles.bl}>{bl}</div>}
      {br !== undefined && <div className={styles.br}>{br}</div>}
    </div>
  );
}
