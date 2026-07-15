import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonList,
  IonModal,
  IonNav,
  IonNavLink,
  IonNote,
  IonTitle,
  IonToolbar,
} from "@ionic/react";
import {
  bookOutline,
  cloudUploadOutline,
  desktopOutline,
} from "ionicons/icons";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import * as sync from "../../sync";

import "./SyncSheet.css";

/**
 * Sync lives in a modal, not a page, so it can be raised from anywhere — the
 * Settings row today, a post-flight nudge or an empty logbook later — without
 * every caller owning a modal or the router growing a screen for it.
 * Mounted once at the app root; open it with useSyncSheet().
 */
const SyncSheetContext = createContext<() => void>(() => {});

export function useSyncSheet(): () => void {
  return useContext(SyncSheetContext);
}

export function SyncSheetProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [presenting, setPresenting] = useState<HTMLElement | null>(null);

  // Full-screen card modal: `presentingElement` is what makes the page behind
  // scale back, the platform-native "this is a detour, not a new place" cue.
  // Resolved at present time, not at mount: a live flight sheds the whole nav
  // shell — router outlet included — and a stale ref would present against a
  // detached element. Null just means a plain full-screen modal.
  const present = useCallback(() => {
    setPresenting(document.querySelector<HTMLElement>("ion-router-outlet"));
    setOpen(true);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  return (
    <SyncSheetContext.Provider value={present}>
      {children}
      <IonModal
        isOpen={open}
        onDidDismiss={close}
        presentingElement={presenting ?? undefined}
      >
        {/* IonNav, not the app router: self-host gets a real push animation
            without a route existing for a screen you reach from a modal. Keyed
            on `open` so a dismissed modal reopens at the root instead of
            wherever it was left. */}
        <IonNav key={String(open)} root={() => <SyncHome onClose={close} />} />
      </IonModal>
    </SyncSheetContext.Provider>
  );
}

function describe(status: sync.SyncStatus): {
  label: string;
  detail: string;
  tone: string;
} {
  switch (status.state) {
    case "off":
      return { label: "Off", detail: "Flights stay on this device.", tone: "" };
    case "connecting":
      return { label: "Connecting", detail: "", tone: "" };
    case "paused":
      // Recording outranks sync, always — and saying so is better than looking
      // broken mid-flight.
      return {
        label: "Paused",
        detail: "Syncs when the flight ends.",
        tone: "",
      };
    case "syncing":
      return status.readOnly
        ? {
            label: "Read-only",
            detail: "Your flights are still here, and still yours.",
            tone: "sync-state-readonly",
          }
        : {
            label: "On",
            detail: status.lastSyncedAt
              ? `Last synced ${new Date(status.lastSyncedAt).toLocaleTimeString()}`
              : "Waiting for changes",
            tone: "",
          };
    case "error":
      return { label: "Problem", detail: "", tone: "sync-state-error" };
  }
}

function SyncHome({ onClose }: { onClose: () => void }) {
  const status = useSyncExternalStore(sync.subscribe, sync.currentStatus);
  const [busy, setBusy] = useState(false);

  const on = status.state !== "off";
  const { label, detail, tone } = describe(status);

  async function turnOff() {
    setBusy(true);
    try {
      await sync.disable();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* The iOS large-title pair: collapse="fade" leaves the bar with no
          background until you scroll, collapse="condense" is the big title
          that shrinks into it, and fullscreen lets the photo run under both.
          color=" " is what keeps the condensed toolbar transparent over the
          photo — a blank color emits an ion-color- class with no palette
          behind it, so no background is painted. Same trick Voyager uses on
          its Welcome screen. */}
      <IonHeader translucent collapse="fade" className="sync-home-header">
        <IonToolbar>
          <IonTitle>Subscription</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen className="sync-home-content">
        <IonHeader collapse="condense">
          <IonToolbar color=" ">
            <IonTitle size="large">Subscription</IonTitle>
          </IonToolbar>
        </IonHeader>
        <div className="sync-home-body">
          {/* One headline per state, doing the job that state needs. Off is a
              pitch — the biggest words should be why you'd want this, not a
              status label restating what the Subscribe button already says.
              On is a status screen, where the state IS the headline. */}
          {on ? (
            <>
              <div className={`sync-state ${tone}`}>
                <span className="sync-state-label" data-testid="sync-state">
                  {label}
                </span>
                <span className="sync-state-detail">{detail}</span>
              </div>

              {status.state === "error" && (
                <p className="sync-error-message">{status.message}</p>
              )}

              <IonButton
                expand="block"
                fill="outline"
                color="medium"
                disabled={busy}
                onClick={turnOff}
                data-testid="sync-off"
              >
                Turn off sync
              </IonButton>
              <p className="sync-fine-print">
                Turning sync off forgets this device&apos;s connection. Nothing
                is deleted — every flight stays on this device and on the
                server.
              </p>
            </>
          ) : (
            <>
              <h2 className="sync-headline" data-testid="sync-headline">
                Your flights, on all your devices.
              </h2>

              <ul className="sync-reasons">
                <li>
                  <IonIcon icon={cloudUploadOutline} aria-hidden="true" />
                  Backed up off your phone
                </li>
                <li>
                  <IonIcon icon={desktopOutline} aria-hidden="true" />
                  Plan flights on desktop
                </li>
                <li>
                  <IonIcon icon={bookOutline} aria-hidden="true" />
                  Your logbook on any device
                </li>
              </ul>

              {/* StoreKit lands with the native plugin; until then this button
                  would be a lie, so it says so rather than failing on tap. */}
              <IonButton expand="block" disabled data-testid="sync-subscribe">
                Subscribe — coming soon
              </IonButton>

              <IonNavLink
                routerDirection="forward"
                component={() => <SelfHostPage onConnected={onClose} />}
              >
                <IonButton
                  expand="block"
                  fill="clear"
                  className="sync-selfhost-toggle"
                  data-testid="sync-selfhost-toggle"
                >
                  Use my own server
                </IonButton>
              </IonNavLink>
            </>
          )}
        </div>
      </IonContent>
    </>
  );
}

function SelfHostPage({ onConnected }: { onConnected: () => void }) {
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
      setProblem(String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton text="Subscription" />
          </IonButtons>
          <IonTitle>Self-hosted</IonTitle>
          {/* The action belongs in the navbar, next to the way out — the iOS
              form idiom. A block button below the fields reads like a landing
              page and pushes the fine print off-screen. */}
          <IonButtons slot="end">
            <IonButton
              strong
              disabled={!ready}
              onClick={connect}
              data-testid="sync-connect"
            >
              Connect
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        {problem && <p className="sync-error-message ion-padding">{problem}</p>}
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
              value={server.password}
              onIonInput={(e) =>
                setServer((s) => ({ ...s, password: e.detail.value ?? "" }))
              }
            />
          </IonItem>
        </IonList>
        <IonNote className="sync-fine-print sync-form-note">
          Any CouchDB. Wingover will only communicate with this backend.
        </IonNote>
      </IonContent>
    </>
  );
}
