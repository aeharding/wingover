import { useIonAlert } from "@ionic/react";

import { deleteFlight, type Flight, getTrack } from "../storage/db";
import { downloadTextFile } from "./download";
import { flightToGpx } from "./gpx";

export function useFlightActions() {
  const [presentAlert] = useIonAlert();

  async function exportFlight(flight: Flight) {
    const fixes = await getTrack(flight.id);
    downloadTextFile(`${flight.name}.gpx`, flightToGpx(flight, fixes));
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
