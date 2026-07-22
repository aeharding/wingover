import styles from "./endpointMarker.module.css";

/**
 * The launch/landing dot dropped on a flight's track ends — shared by the
 * phone detail page and the desktop seat (both used to hand-roll the same
 * helper and reach into the same classes).
 */
export function endpointMarker(
  kind: "launch" | "landing",
  testId: string,
): HTMLElement {
  const element = document.createElement("div");
  element.className = `${styles.marker} ${styles[kind]}`;
  element.setAttribute("data-testid", testId);
  return element;
}
