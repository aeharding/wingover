import {
  IonIcon,
  IonItem,
  IonItemOption,
  IonItemOptions,
  IonItemSliding,
  IonList,
} from "@ionic/react";
import { shareOutline, trashOutline } from "ionicons/icons";
import { useEffect, useRef } from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";

import {
  formatAirtime,
  formatDistance,
  formatFlightDate,
  type Units,
} from "../../flight/format";
import type { Flight } from "../../storage/db";
import { useFlightActions } from "../useFlightActions";

import "./FlightList.css";

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
  onDeleted: (deleted: Flight) => void;
}

/**
 * What the row leads with: the pilot's name, else the launch site, else
 * the date (names are optional; recording mints none). The sub line
 * carries whatever the title didn't say.
 */
function rowTitle(flight: Flight): { title: string; sub: string | null } {
  const date = formatFlightDate(flight.startedAt);
  if (flight.name) {
    return {
      title: flight.name,
      sub: flight.launchName ? `${flight.launchName} · ${date}` : date,
    };
  }
  if (flight.launchName) return { title: flight.launchName, sub: date };
  return { title: date, sub: null };
}

export default function FlightList({
  flights,
  units,
  scrollRef,
  selectedId,
  onSelect,
  onDeleted,
}: FlightListProps) {
  const { exportFlight, confirmDeleteFlight } = useFlightActions();
  const virtualizer = useRef<VirtualizerHandle>(null);
  const lastScrolledTo = useRef<string | undefined>(undefined);

  // The virtualizer's own scrollToIndex, not a DOM query: an off-screen
  // row isn't mounted, but virtua knows its offset regardless. Guarded to
  // fire only when the SELECTION changes, so a background list refresh
  // never yanks the scroll position back to the selected row.
  useEffect(() => {
    if (!selectedId || lastScrolledTo.current === selectedId) return;
    lastScrolledTo.current = selectedId;
    const index = flights.findIndex((flight) => flight.id === selectedId);
    if (index >= 0) {
      virtualizer.current?.scrollToIndex(index, { align: "nearest" });
    }
  }, [selectedId, flights]);

  return (
    <>
      <IonList>
        <Virtualizer
          ref={virtualizer}
          scrollRef={scrollRef as React.RefObject<HTMLElement>}
        >
          {flights.map((flight) => {
            const { title, sub } = rowTitle(flight);
            return (
              <IonItemSliding key={flight.id}>
                <IonItem
                  {...(onSelect
                    ? { button: true, onClick: () => onSelect(flight) }
                    : { routerLink: `/logbook/${flight.id}` })}
                  detail={!onSelect}
                  color={selectedId === flight.id ? "light" : undefined}
                >
                  {/* Identity left, metrics right: the numbers sit at the
                    same x every row (tabular, right-aligned), so they read
                    as columns down the list instead of a dot-separated
                    run-on per row. */}
                  {/* NOT inside IonLabel: ion-label's scoped stylesheet
                      owns descendant h2/p text layout (::slotted(*) h2
                      { overflow: inherit }) at specificity equal to any
                      single-class rule of ours, so who wins depends on
                      style injection order, which differs dev vs prod.
                      A plain slotted div is outside the label's scope
                      class and the fight cannot exist. */}
                  <div className="flight-row">
                    <div className="flight-row-id">
                      <h2>{title}</h2>
                      {sub && <p>{sub}</p>}
                    </div>
                    <div className="flight-row-stats">
                      <div className="flight-row-duration">
                        {formatAirtime(flight.stats.durationSeconds)}
                      </div>
                      <div className="flight-row-distance">
                        {formatDistance(flight.stats.distanceMeters, units)}
                      </div>
                    </div>
                  </div>
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
                    onClick={() =>
                      confirmDeleteFlight(flight, () => onDeleted(flight))
                    }
                  >
                    <IonIcon slot="icon-only" icon={trashOutline} />
                  </IonItemOption>
                </IonItemOptions>
              </IonItemSliding>
            );
          })}
        </Virtualizer>
      </IonList>
    </>
  );
}
