import {
  IonActionSheet,
  IonButton,
  IonIcon,
  IonLoading,
  IonToast,
} from "@ionic/react";
import { ellipsisHorizontal } from "ionicons/icons";
import { useRef, useState } from "react";
import { useHistory, useLocation } from "react-router-dom";

import { importGpxFiles } from "../../storage/importGpx";
import ConnectFunnel from "../logbook/ConnectFunnel";
import FlightList from "../logbook/FlightList";
import FlightSeat from "../logbook/FlightSeat";
import { useFlights } from "../logbook/useFlights";
import AllFlightsMapPage from "../pages/AllFlightsMapPage";
import { useSettings } from "../settings/SettingsContext";

/**
 * The desktop logbook: a persistent split. The list never remounts (scroll
 * survives selection), the seat is one persistent FlightSeat whose id swaps
 * as a prop (the map lives across selections), and the URL stays the source
 * of truth — plain react-router, no Ionic outlet, so /logbook/:id updates
 * in place with real history entries.
 */
export default function LogbookSection() {
  const { units } = useSettings();
  const history = useHistory();
  const { pathname } = useLocation();
  const { flights, loaded, refresh } = useFlights();
  const [menuOpen, setMenuOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);

  if (pathname === "/logbook/map") return <AllFlightsMapPage />;

  const selectedId = /^\/logbook\/(.+)$/.exec(pathname)?.[1];
  const selected = flights.find((flight) => flight.id === selectedId);
  const empty = loaded && flights.length === 0;

  return (
    <div className="logbook-split">
      <aside className="logbook-pane" ref={paneRef}>
        <div className="pane-header">
          <h1>Logbook</h1>
          <IonButton
            fill="clear"
            aria-label="Options"
            data-testid="logbook-options"
            onClick={() => setMenuOpen(true)}
          >
            <IonIcon slot="icon-only" icon={ellipsisHorizontal} />
          </IonButton>
        </div>
        {empty ? (
          <div className="logbook-empty">
            <ConnectFunnel onImport={() => fileInputRef.current?.click()} />
          </div>
        ) : (
          <FlightList
            flights={flights}
            units={units}
            scrollRef={paneRef}
            totalsStrip
            selectedId={selectedId}
            onSelect={(flight) => history.push(`/logbook/${flight.id}`)}
            onDeleted={(deleted) => {
              refresh();
              if (deleted.id === selectedId) history.replace("/logbook");
            }}
          />
        )}
      </aside>
      <div className="logbook-seat" data-testid="logbook-seat">
        {selected ? (
          <FlightSeat
            id={selected.id}
            active={pathname.startsWith("/logbook")}
            onDeleted={() => {
              refresh();
              history.replace("/logbook");
            }}
          />
        ) : (
          !empty && <div className="seat-placeholder">Select a flight</div>
        )}
      </div>
      <IonActionSheet
        // Derived, not just state: overlays portal OUTSIDE the hidden
        // section, so browser Back would strand an open sheet floating
        // over the next section.
        isOpen={menuOpen && pathname.startsWith("/logbook")}
        onDidDismiss={() => setMenuOpen(false)}
        buttons={[
          {
            text: "All Flights",
            handler: () => history.push("/logbook/map"),
          },
          {
            text: "Import GPX files",
            handler: () => fileInputRef.current?.click(),
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
          if (showProgress) setImportProgress({ done: 0, total: files.length });
          const result = await importGpxFiles(
            Array.from(files),
            (done, total) => {
              if (showProgress) setImportProgress({ done, total });
              if (done % 25 === 0) refresh();
            },
          );
          if (showProgress) setImportProgress(null);
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
    </div>
  );
}
