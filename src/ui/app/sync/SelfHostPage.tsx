import { IonButton, IonInput, IonItem, IonList, IonNote } from "@ionic/react";
import { useEffect, useRef, useState } from "react";

import * as sync from "../../../sync/index";
import { cx } from "../../shared/cx";
import { SheetHeader } from "./SheetHeader";

import styles from "./sync.module.css";

/**
 * The own-server form — the Log In rail's page (SYNC-UX.md: self-host is a
 * login), but pushable from either sheet: the Log In doors own it, and the
 * Subscription pitch's "Prefer to self-host?" link pushes it in place rather
 * than bouncing the pilot through a second modal.
 */
export function SelfHostPage({
  onBack,
  onConnected,
}: {
  onBack: () => void;
  onConnected: () => void;
}) {
  const serverInput = useRef<HTMLIonInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [server, setServer] = useState({
    url: "",
    dbName: "",
    username: "",
    password: "",
  });

  const ready = Boolean(server.url && server.dbName) && !busy;

  // Enter connects, from any field. A <form> can't do this for us: IonInput's
  // real <input> lives in its shadow root, so it isn't a form control of any
  // light-DOM form and implicit submission never fires. Key events do cross the
  // boundary (composed), so this is the seam that actually works.
  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Enter" && ready) void connect();
  }

  // Ionic's own docs: the autofocus attribute "may not be sufficient", and
  // inside a modal you should setFocus after the presentation settles. This is
  // a nav push inside a modal, so wait out the transition rather than race it.
  useEffect(() => {
    const timer = setTimeout(() => void serverInput.current?.setFocus(), 400);
    return () => clearTimeout(timer);
  }, []);

  async function connect() {
    setBusy(true);
    setProblem(null);
    try {
      await sync.enable(sync.manualProvider(server));
      onConnected();
    } catch (error) {
      // .message, not String(error): the provider writes these for the pilot,
      // and "Error: " in front of a sentence is a stack trace leaking into copy.
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SheetHeader
        title="Self Hosted"
        onBack={onBack}
        action={
          /* The action belongs in the header, next to the way out — the iOS
             form idiom. A block button below the fields reads like a landing
             page and pushes the fine print off-screen. */
          <IonButton
            fill="clear"
            strong
            disabled={!ready}
            onClick={connect}
            data-testid="sync-connect"
          >
            Connect
          </IonButton>
        }
      />
      {/* The grouped-card (inset list) treatment the Settings pages use —
          in light mode the cells vanish without the grouped gray behind
          them (white on white). */}
      <div className={styles.formBody}>
        {problem && (
          <p className={cx(styles.errorMessage, styles.formProblem)}>
            {problem}
          </p>
        )}
        {/* inset: margin + rounded corners in iOS mode — the grouped-card form
            iOS Settings uses. Hand-rolled padding around a plain list fights it
            and lands edge-to-edge and cramped. */}
        <IonList inset lines="inset">
          <IonItem>
            <IonInput
              ref={serverInput}
              label="Server"
              labelPlacement="stacked"
              placeholder="https://couch.example.com"
              autocapitalize="off"
              autocorrect="off"
              inputmode="url"
              enterkeyhint="go"
              onKeyDown={onKeyDown}
              value={server.url}
              onIonInput={(e) =>
                setServer((s) => ({ ...s, url: e.detail.value ?? "" }))
              }
            />
          </IonItem>
          <IonItem>
            <IonInput
              label="Database"
              labelPlacement="stacked"
              placeholder="wingover"
              autocapitalize="off"
              autocorrect="off"
              enterkeyhint="go"
              onKeyDown={onKeyDown}
              value={server.dbName}
              onIonInput={(e) =>
                setServer((s) => ({ ...s, dbName: e.detail.value ?? "" }))
              }
            />
          </IonItem>
          <IonItem>
            <IonInput
              label="Username"
              labelPlacement="stacked"
              autocapitalize="off"
              autocorrect="off"
              enterkeyhint="go"
              onKeyDown={onKeyDown}
              value={server.username}
              onIonInput={(e) =>
                setServer((s) => ({ ...s, username: e.detail.value ?? "" }))
              }
            />
          </IonItem>
          <IonItem>
            <IonInput
              label="Password"
              labelPlacement="stacked"
              type="password"
              enterkeyhint="go"
              onKeyDown={onKeyDown}
              value={server.password}
              onIonInput={(e) =>
                setServer((s) => ({ ...s, password: e.detail.value ?? "" }))
              }
            />
          </IonItem>
        </IonList>
        <IonNote className={cx(styles.finePrint, styles.formNote)}>
          Any CouchDB. Wingover will only communicate with this backend.
        </IonNote>
      </div>
    </>
  );
}
