import { IonInput, IonItem, IonList, IonTextarea } from "@ionic/react";
import type { KeyboardEvent as ReactKeyboardEvent, Ref } from "react";

import { isTauri } from "../../../platform/index";

interface Drafts {
  name: string;
  launch: string;
  notes: string;
}

/**
 * What a pilot writes about a flight: name, launch, notes. Shared by the
 * logbook detail page and the sheet a landing raises, so the two can never
 * offer different fields or commit them differently.
 *
 * State lives in useFlightDrafts, one level up, because the flight doc does
 * too. This is only the form.
 */
export default function FlightFields({
  drafts,
  setDraft,
  commit,
  nameRef,
}: {
  drafts: Drafts;
  setDraft: (key: keyof Drafts, value: string) => void;
  commit: () => void;
  /** The first field, for callers that want to put the cursor in it. */
  nameRef?: Ref<HTMLIonInputElement>;
}) {
  return (
    <IonList>
      <IonItem>
        <IonInput
          ref={nameRef}
          label="Name"
          clearInput
          autocapitalize="words"
          placeholder="Add name"
          value={drafts.name}
          aria-label="Flight name"
          onIonInput={(event) => setDraft("name", event.detail.value ?? "")}
          onIonBlur={commit}
          enterkeyhint="done"
          onKeyDown={blurOnEnter}
        />
      </IonItem>
      <IonItem>
        <IonInput
          label="Launch"
          clearInput
          autocapitalize="words"
          placeholder="Add location"
          value={drafts.launch}
          aria-label="Launch location"
          onIonInput={(event) => setDraft("launch", event.detail.value ?? "")}
          onIonBlur={commit}
          enterkeyhint="done"
          onKeyDown={blurOnEnter}
        />
      </IonItem>
      <IonItem>
        {/* rows 1: one line empty (a textarea's native default is two),
            growing with content. */}
        <IonTextarea
          label="Notes"
          autocapitalize="sentences"
          placeholder="Wing, motor, conditions…"
          rows={1}
          autoGrow
          value={drafts.notes}
          aria-label="Flight notes"
          onIonInput={(event) => setDraft("notes", event.detail.value ?? "")}
          onIonBlur={commit}
        />
      </IonItem>
    </IonList>
  );
}

// Native only: the keyboard's return key reads "Done" (enterkeyhint above) and
// pressing it closes the keyboard. Single-line fields have nothing else for
// Enter to do, and the accessory bar with its own Done is hidden globally. On
// the PWA, Enter keeps the browser's default behavior.
function blurOnEnter(event: ReactKeyboardEvent<HTMLIonInputElement>) {
  if (!isTauri() || event.key !== "Enter") return;
  // A CJK keyboard's Return first commits the composition — that keystroke
  // must not steal the keyboard mid-word.
  if (event.nativeEvent.isComposing) return;
  (document.activeElement as HTMLElement | null)?.blur();
}
