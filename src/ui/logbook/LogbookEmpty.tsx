import type { ReactNode } from "react";

import styles from "./LogbookEmpty.module.css";

/** The logbook's empty state, centered in whatever hosts it (the phone
 * page, the desktop list pane). The hosts choose the content: a plain
 * sentence on native, the connect funnel on a fresh browser. */
export default function LogbookEmpty({ children }: { children: ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}
