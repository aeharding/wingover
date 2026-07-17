import { useIonViewWillEnter } from "@ionic/react";
import { useEffect, useState } from "react";

import { type Flight, listFlights, onDocsChanged } from "../../storage/db";

/**
 * The logbook, live: loaded on view entry and again whenever a flight doc
 * changes (local writes and replicated pulls alike, so a flight landing
 * from another device appears without a refresh). Shared by LogbookPage
 * and the desktop split's list pane on FlightDetailPage.
 */
export function useFlights(): {
  flights: Flight[];
  // False until the first read lands: an empty logbook and a not-yet-read
  // logbook must render differently (the connect funnel must not flash at
  // existing pilots on a deep link).
  loaded: boolean;
  refresh: () => void;
} {
  const [state, setState] = useState<{ flights: Flight[]; loaded: boolean }>({
    flights: [],
    loaded: false,
  });

  const refresh = () => {
    void listFlights().then((flights) => setState({ flights, loaded: true }));
  };

  useIonViewWillEnter(() => {
    refresh();
  });

  useEffect(() => {
    refresh();
    return onDocsChanged("flight", refresh);
  }, []);

  return { flights: state.flights, loaded: state.loaded, refresh };
}
