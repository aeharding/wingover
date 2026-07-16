import {
  IonActionSheet,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonItemOption,
  IonItemOptions,
  IonItemSliding,
  IonLabel,
  IonList,
  IonLoading,
  IonNote,
  IonPage,
  IonTitle,
  IonToast,
  IonToolbar,
  useIonRouter,
  useIonViewWillEnter,
} from "@ionic/react";
import { ellipsisHorizontal, shareOutline, trashOutline } from "ionicons/icons";
import { useEffect, useRef, useState } from "react";
import { Virtualizer } from "virtua";

import { formatDistance, formatDuration } from "../../flight/format";
import { type Flight, listFlights, onDocsChanged } from "../../storage/db";
import { importGpxFiles } from "../../storage/importGpx";
import { useSettings } from "../settings/SettingsContext";
import { useFlightActions } from "../useFlightActions";

import "./LogbookPage.css";

export default function LogbookPage() {
  const { units } = useSettings();
  const router = useIonRouter();
  const [flights, setFlights] = useState<Flight[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLIonContentElement>(null);
  const scrollParentRef = useRef<HTMLElement | null>(null);
  const [scrollReady, setScrollReady] = useState(false);

  useEffect(() => {
    contentRef.current?.getScrollElement().then((element) => {
      scrollParentRef.current = element;
      setScrollReady(true);
    });
  }, []);

  async function refresh() {
    setFlights(await listFlights());
  }

  useIonViewWillEnter(() => {
    refresh();
  });

  // A flight replicated in from another device appears without a refresh —
  // the feed fires for pulls and local writes alike.
  useEffect(() => onDocsChanged("flight", () => void refresh()), []);

  const { exportFlight, confirmDeleteFlight } = useFlightActions();

  const totalDistance = flights.reduce(
    (sum, flight) => sum + flight.stats.distanceMeters,
    0,
  );
  const totalDuration = flights.reduce(
    (sum, flight) => sum + flight.stats.durationSeconds,
    0,
  );

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
        {flights.length === 0 ? (
          <div className="logbook-empty">No flights yet.</div>
        ) : (
          scrollReady && (
            <IonList>
              <Virtualizer
                scrollRef={scrollParentRef as React.RefObject<HTMLElement>}
              >
                {flights.map((flight) => (
                  <IonItemSliding key={flight.id}>
                    <IonItem routerLink={`/logbook/${flight.id}`} detail>
                      <IonLabel>
                        <h2>{flight.name}</h2>
                        <p>
                          {new Date(flight.startedAt).toLocaleString()} ·{" "}
                          {formatDuration(flight.stats.durationSeconds)} ·{" "}
                          {formatDistance(flight.stats.distanceMeters, units)}
                        </p>
                      </IonLabel>
                    </IonItem>
                    <IonItemOptions side="end">
                      <IonItemOption
                        aria-label="Export"
                        onClick={() => exportFlight(flight)}
                      >
                        <IonIcon slot="icon-only" icon={shareOutline} />
                      </IonItemOption>
                      <IonItemOption
                        color="danger"
                        aria-label="Delete"
                        onClick={() => confirmDeleteFlight(flight, refresh)}
                      >
                        <IonIcon slot="icon-only" icon={trashOutline} />
                      </IonItemOption>
                    </IonItemOptions>
                  </IonItemSliding>
                ))}
              </Virtualizer>
            </IonList>
          )
        )}
        {flights.length > 0 && (
          <div className="logbook-totals">
            <IonNote>
              {flights.length} flights · {formatDuration(totalDuration)} ·{" "}
              {formatDistance(totalDistance, units)}
            </IonNote>
          </div>
        )}
      </IonContent>
    </IonPage>
  );
}
