import {
  IonIcon,
  IonItem,
  IonItemOption,
  IonItemOptions,
  IonItemSliding,
  IonLabel,
  IonList,
} from "@ionic/react";
import { shareOutline, trashOutline } from "ionicons/icons";
import { Virtualizer } from "virtua";

import {
  formatDistance,
  formatDuration,
  type Units,
} from "../../flight/format";
import type { Flight } from "../../storage/db";
import { useFlightActions } from "../useFlightActions";

interface FlightListProps {
  flights: Flight[];
  units: Units;
  // The element that scrolls this list (the page content on the phone, the
  // pane on desktop). Virtualization needs the real scroller.
  scrollRef: React.RefObject<HTMLElement | null>;
  // Highlighted row (the flight open in the desktop split's detail seat).
  selectedId?: string;
  // Desktop split rows select in place (no router navigation, so the list
  // and the seat's map never remount); without it rows are phone router
  // links.
  onSelect?: (flight: Flight) => void;
  // Cumulative totals as a strip above the rows (the desktop pane header).
  totalsStrip?: boolean;
  onDeleted: (deleted: Flight) => void;
}

export default function FlightList({
  flights,
  units,
  scrollRef,
  selectedId,
  onSelect,
  totalsStrip,
  onDeleted,
}: FlightListProps) {
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
    <>
      {totalsStrip && flights.length > 0 && (
        <div className="flightlist-totals">
          <div>
            <b>{flights.length}</b>
            <span>Flights</span>
          </div>
          <div>
            <b>{formatDuration(totalDuration)}</b>
            <span>Airtime</span>
          </div>
          <div>
            <b>{formatDistance(totalDistance, units)}</b>
            <span>Distance</span>
          </div>
        </div>
      )}
      <IonList>
        <Virtualizer scrollRef={scrollRef as React.RefObject<HTMLElement>}>
          {flights.map((flight) => (
            <IonItemSliding key={flight.id}>
              <IonItem
                {...(onSelect
                  ? { button: true, onClick: () => onSelect(flight) }
                  : { routerLink: `/logbook/${flight.id}` })}
                detail={!onSelect}
                color={selectedId === flight.id ? "light" : undefined}
              >
                <IonLabel>
                  <h2>{flight.name}</h2>
                  <p>
                    {flight.launchName && `${flight.launchName} · `}
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
                  onClick={() => confirmDeleteFlight(flight, () => onDeleted(flight))}
                >
                  <IonIcon slot="icon-only" icon={trashOutline} />
                </IonItemOption>
              </IonItemOptions>
            </IonItemSliding>
          ))}
        </Virtualizer>
      </IonList>
    </>
  );
}
