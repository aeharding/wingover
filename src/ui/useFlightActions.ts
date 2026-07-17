import { useIonAlert } from "@ionic/react";

import { flightTitle } from "../flight/format";
import { flightToGpx } from "../flight/gpx";
import { deleteFlight, type Flight, getTrack } from "../storage/db";
import { exportTextFile } from "./download";

export function useFlightActions() {
  const [presentAlert] = useIonAlert();

  async function exportFlight(flight: Flight) {
    const fixes = await getTrack(flight.id);
    await exportTextFile(
      `${flightTitle(flight)}.gpx`,
      flightToGpx(flight, fixes),
    );
  }

  function confirmDeleteFlight(flight: Flight, onDeleted?: () => void) {
    presentAlert({
      header: "Delete this flight?",
      message: "This cannot be undone.",
      buttons: [
        { text: "Cancel", role: "cancel" },
        {
          text: "Delete",
          role: "destructive",
          handler: () => {
            deleteFlight(flight.id).then(onDeleted);
          },
        },
      ],
    });
  }

  return { exportFlight, confirmDeleteFlight };
}
