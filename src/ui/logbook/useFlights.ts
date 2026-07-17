import { useIonViewWillEnter } from "@ionic/react";
import { useEffect, useState } from "react";

import { type Flight, listFlights, onDocsChanged } from "../../storage/db";

/**
 * The logbook, live: loaded on view entry and again whenever a flight doc
 * changes (local writes and replicated pulls alike, so a flight landing
 * from another device appears without a refresh). Shared by LogbookPage
 * and the desktop split's list pane on FlightDetailPage.
 */
export function useFlights(): { flights: Flight[]; refresh: () => void } {
  const [flights, setFlights] = useState<Flight[]>([]);

  const refresh = () => {
    void listFlights().then(setFlights);
  };

  useIonViewWillEnter(() => {
    refresh();
  });

  useEffect(() => {
    refresh();
    return onDocsChanged("flight", refresh);
  }, []);

  return { flights, refresh };
}
