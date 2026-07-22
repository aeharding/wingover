import {
  IonActionSheet,
  IonButton,
  IonIcon,
  IonLoading,
  IonToast,
} from "@ionic/react";
import { ellipsisHorizontal } from "ionicons/icons";
import { useEffect, useRef, useState } from "react";
import { useHistory, useLocation } from "react-router-dom";

import { formatAirtime, formatDistance } from "../../flight/format";
import { importGpxFiles } from "../../storage/importGpx";
import ConnectFunnel from "../logbook/ConnectFunnel";
import FlightList from "../logbook/FlightList";
import FlightSeat from "../logbook/FlightSeat";
import { useFlights } from "../logbook/useFlights";
import LogbookEmpty from "../logbook/LogbookEmpty";
import AllFlightsMapPage from "../pages/AllFlightsMapPage";
import { useSettings } from "../settings/SettingsContext";
import styles from "./LogbookSection.module.css";

/**
 * The list pane's width, remembered per device. Plain localStorage, not a
 * setting: pure UI geometry, needed synchronously at first paint.
 */
const PANE_KEY = "wingover.logbookPane";
const PANE_DEFAULT = 340;
const PANE_MIN = 260;
const PANE_MAX = 520;

/** Also bounded by the window: the seat keeps room for the stats card and
 *  the map padding that clears it (440px reserve + margins). */
function clampPane(width: number): number {
  const max = Math.max(PANE_MIN, Math.min(PANE_MAX, window.innerWidth - 700));
  return Math.min(max, Math.max(PANE_MIN, width));
}

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
  const [paneWidth, setPaneWidth] = useState(() => {
    const stored = Number(localStorage.getItem(PANE_KEY));
    return stored >= PANE_MIN && stored <= PANE_MAX ? stored : PANE_DEFAULT;
  });
  const paneWidthRef = useRef(paneWidth);

  function rememberPane(width: number) {
    paneWidthRef.current = width;
    setPaneWidth(width);
    localStorage.setItem(PANE_KEY, String(width));
  }

  function startPaneDrag(down: React.PointerEvent<HTMLDivElement>) {
    down.preventDefault();
    const handle = down.currentTarget;
    handle.setPointerCapture(down.pointerId);
    const startX = down.clientX;
    const startWidth = paneWidthRef.current;
    const move = (event: PointerEvent) => {
      const next = clampPane(startWidth + event.clientX - startX);
      paneWidthRef.current = next;
      setPaneWidth(next);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      localStorage.setItem(PANE_KEY, String(paneWidthRef.current));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  }

  const selectedIdForKeys = /^\/logbook\/(.+)$/.exec(pathname)?.[1];

  // Arrow keys walk the logbook. replace, not push: holding a key must not
  // flood the history stack. Reads window.location live so the listener is
  // inert while the section is URL-hidden, and yields to anything typed.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const path = window.location.pathname;
      if (!path.startsWith("/logbook") || path === "/logbook/map") return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, ion-input, ion-textarea, ion-alert")
      ) {
        return;
      }
      const index = flights.findIndex(
        (flight) => flight.id === selectedIdForKeys,
      );
      const next =
        event.key === "ArrowDown"
          ? (flights[index + 1] ?? (index === -1 ? flights[0] : undefined))
          : flights[index - 1];
      if (!next) return;
      event.preventDefault();
      history.replace(`/logbook/${next.id}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flights, selectedIdForKeys, history]);

  // A selection that stops existing (web log-out emptied the store; the
  // flight was deleted on another device) folds back to the bare list
  // instead of seating a ghost id.
  useEffect(() => {
    if (
      loaded &&
      selectedIdForKeys &&
      selectedIdForKeys !== "map" &&
      !flights.some((flight) => flight.id === selectedIdForKeys)
    ) {
      history.replace("/logbook");
    }
  }, [loaded, flights, selectedIdForKeys, history]);

  if (pathname === "/logbook/map") return <AllFlightsMapPage />;

  const selectedId = /^\/logbook\/(.+)$/.exec(pathname)?.[1];
  const selected = flights.find((flight) => flight.id === selectedId);

  // Deleting the seated flight moves to its list neighbor (next, else
  // previous) instead of dumping back to the bare list — the pilot is
  // usually working DOWN the log. Computed against the pre-refresh list,
  // where the deleted flight still anchors the index.
  function selectNeighborOf(deleted: { id: string }) {
    const index = flights.findIndex((flight) => flight.id === deleted.id);
    const next = flights[index + 1] ?? flights[index - 1];
    history.replace(next ? `/logbook/${next.id}` : "/logbook");
  }
  const empty = loaded && flights.length === 0;
  const totalDistance = flights.reduce(
    (sum, flight) => sum + flight.stats.distanceMeters,
    0,
  );
  const totalDuration = flights.reduce(
    (sum, flight) => sum + flight.stats.durationSeconds,
    0,
  );

  return (
    <div className={styles.split}>
      <aside
        className={styles.pane}
        style={{ width: paneWidth }}
        data-testid="logbook-pane"
      >
        <div
          className={styles.resizer}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize flight list"
          tabIndex={0}
          data-testid="pane-resizer"
          onPointerDown={startPaneDrag}
          onDoubleClick={() => rememberPane(PANE_DEFAULT)}
          onKeyDown={(event) => {
            const delta =
              event.key === "ArrowLeft"
                ? -16
                : event.key === "ArrowRight"
                  ? 16
                  : 0;
            if (!delta) return;
            event.preventDefault();
            rememberPane(clampPane(paneWidthRef.current + delta));
          }}
        />
        {/* Header and totals are pinned OUTSIDE the scroller: the list's
            scroll view starts at pixel zero, so the virtualizer needs no
            leading-margin math at all. */}
        <div className={styles.header} data-testid="pane-header">
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
        {!empty && flights.length > 0 && (
          <div className={styles.totals}>
            <div>
              <b>{flights.length}</b>
              <span>Flights</span>
            </div>
            <div>
              <b>{formatAirtime(totalDuration)}</b>
              <span>Airtime</span>
            </div>
            <div>
              <b>{formatDistance(totalDistance, units)}</b>
              <span>Distance</span>
            </div>
          </div>
        )}
        {empty ? (
          <LogbookEmpty>
            <ConnectFunnel onImport={() => fileInputRef.current?.click()} />
          </LogbookEmpty>
        ) : (
          <div
            className={styles.scroll}
            data-testid="logbook-pane-scroll"
            ref={paneRef}
          >
            <FlightList
              flights={flights}
              units={units}
              scrollRef={paneRef}
              selectedId={selectedId}
              onSelect={(flight) => history.push(`/logbook/${flight.id}`)}
              onDeleted={(deleted) => {
                refresh();
                if (deleted.id === selectedId) selectNeighborOf(deleted);
              }}
            />
          </div>
        )}
      </aside>
      <div className={styles.seat} data-testid="logbook-seat">
        {selected ? (
          <FlightSeat
            id={selected.id}
            active={pathname.startsWith("/logbook")}
            onDeleted={() => {
              refresh();
              selectNeighborOf(selected);
            }}
          />
        ) : (
          !empty && <div className={styles.placeholder}>Select a flight</div>
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
