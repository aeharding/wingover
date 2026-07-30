import { IonButton, IonIcon } from "@ionic/react";
import { chevronBackOutline } from "ionicons/icons";
import type { ReactNode } from "react";

import styles from "./sync.module.css";

/**
 * The auto-height sheet's slim header row: a back chevron when the view has
 * somewhere to go back to, a centred title, an action slot for the form
 * views. The old full-screen chrome (IonHeader + large titles) assumed a
 * full-height modal; a content-hugging sheet earns neither.
 */
export function SheetHeader({
  title,
  onBack,
  action,
}: {
  title: string;
  onBack?: () => void;
  action?: ReactNode;
}) {
  function renderBack() {
    if (!onBack) return null;
    return (
      <IonButton fill="clear" onClick={onBack} data-testid="sheet-back">
        <IonIcon slot="icon-only" icon={chevronBackOutline} />
      </IonButton>
    );
  }

  return (
    <div className={styles.sheetHeader}>
      <div className={styles.sheetHeaderSide}>{renderBack()}</div>
      <h2>{title}</h2>
      <div className={styles.sheetHeaderSideEnd}>{action}</div>
    </div>
  );
}
