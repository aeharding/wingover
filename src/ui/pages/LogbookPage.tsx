import {
  IonActionSheet,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonLoading,
  IonNote,
  IonPage,
  IonTitle,
  IonToast,
  IonToolbar,
  useIonRouter,
} from "@ionic/react";
import { ellipsisHorizontal } from "ionicons/icons";
import { type RefObject, useEffect, useRef, useState } from "react";

import { isTauri } from "../../engine/platform";
import { formatAirtime, formatDistance } from "../../flight/format";
import { importGpxFiles } from "../../storage/importGpx";
import ErrorBoundary from "../components/ErrorBoundary";
import ConnectFunnel from "../logbook/ConnectFunnel";
import FlightList from "../logbook/FlightList";
import LogbookEmpty from "../logbook/LogbookEmpty";
import { useFlights } from "../logbook/useFlights";
import { useSettings } from "../settings/SettingsContext";

import styles from "./LogbookPage.module.css";

/**
 * The shell owns only the chrome — IonPage, the IonHeader with its Options
 * button, and the IonContent — plus the menu-open flag the button flips (a
 * bare boolean that can't throw). Those stay mounted through a crash so the
 * outlet's stack transitions keep working; the boundary swaps only the body
 * inside IonContent. The risky mass (the flight list, imports, totals) lives
 * in LogbookBody, protected. See PR #133.
 */
export default function LogbookPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  const contentRef = useRef<HTMLIonContentElement>(null);

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Logbook</IonTitle>
          <IonButtons slot="end">
            <IonButton
              aria-label="Options"
              data-testid="logbook-options"
              onClick={() => setMenuOpen(true)}
            >
              <IonIcon slot="icon-only" icon={ellipsisHorizontal} />
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent ref={contentRef}>
        <ErrorBoundary name="logbook">
          <LogbookBody
            contentRef={contentRef}
            menuOpen={menuOpen}
            setMenuOpen={setMenuOpen}
          />
        </ErrorBoundary>
      </IonContent>
    </IonPage>
  );
}

function LogbookBody({
  contentRef,
  menuOpen,
  setMenuOpen,
}: {
  contentRef: RefObject<HTMLIonContentElement | null>;
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
}) {
  const { units } = useSettings();
  const router = useIonRouter();
  const { flights, refresh } = useFlights();
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollParentRef = useRef<HTMLElement | null>(null);
  const [scrollReady, setScrollReady] = useState(false);

  useEffect(() => {
    contentRef.current?.getScrollElement().then((element) => {
      scrollParentRef.current = element;
      setScrollReady(true);
    });
  }, [contentRef]);

  const totalDistance = flights.reduce(
    (sum, flight) => sum + flight.stats.distanceMeters,
    0,
  );
  const totalDuration = flights.reduce(
    (sum, flight) => sum + flight.stats.durationSeconds,
    0,
  );

  const empty = flights.length === 0;

  return (
    <>
      <IonActionSheet
        isOpen={menuOpen}
        onDidDismiss={() => setMenuOpen(false)}
        buttons={[
          {
            text: "All Flights",
            handler: () => {
              router.push("/logbook/map");
            },
          },
          {
            text: "Import GPX files",
            handler: () => {
              fileInputRef.current?.click();
            },
          },
          { text: "Cancel", role: "cancel" },
        ]}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept=".gpx,application/gpx+xml"
        multiple
        hidden
        data-testid="gpx-input"
        onChange={async (event) => {
          const files = event.target.files;
          if (!files || files.length === 0) return;
          const showProgress = files.length > 5;
          const importStarted = Date.now();
          if (showProgress) {
            setImportProgress({ done: 0, total: files.length });
          }
          const result = await importGpxFiles(
            Array.from(files),
            (done, total) => {
              if (showProgress) setImportProgress({ done, total });
              if (done % 25 === 0) refresh();
            },
          );
          if (showProgress) {
            const elapsed = Date.now() - importStarted;
            if (elapsed < 600) {
              await new Promise((resolve) =>
                setTimeout(resolve, 600 - elapsed),
              );
            }
            setImportProgress(null);
          }
          event.target.value = "";
          setToastMessage(
            `Imported ${result.imported} flight${
              result.imported === 1 ? "" : "s"
            }${result.failed.length ? `, ${result.failed.length} failed` : ""}`,
          );
          refresh();
        }}
      />
      <IonToast
        isOpen={toastMessage !== null}
        message={toastMessage ?? ""}
        duration={2500}
        position="top"
        onDidDismiss={() => setToastMessage(null)}
      />
      <IonLoading
        isOpen={importProgress !== null}
        message={
          importProgress
            ? `Importing ${importProgress.done}/${importProgress.total}…`
            : undefined
        }
      />
      {empty ? (
        <LogbookEmpty>
          {isTauri() ? (
            "No flights yet."
          ) : (
            // A fresh browser is a front door: the pilot's flights are on
            // their phone, and this is where they connect (SYNC-UX).
            <ConnectFunnel onImport={() => fileInputRef.current?.click()} />
          )}
        </LogbookEmpty>
      ) : (
        scrollReady && (
          <FlightList
            flights={flights}
            units={units}
            scrollRef={scrollParentRef}
            onDeleted={refresh}
          />
        )
      )}
      {flights.length > 0 && (
        <div className={styles.totals}>
          <IonNote>
            {flights.length} flights · {formatAirtime(totalDuration)} ·{" "}
            {formatDistance(totalDistance, units)}
          </IonNote>
        </div>
      )}
    </>
  );
}
