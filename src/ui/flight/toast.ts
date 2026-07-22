import styles from "./toast.module.css";

/**
 * Imperative, body-level, framework-free toast. It must outlive the
 * component that fires it: saving a flight swaps the nav shell back in
 * and remounts the flight surface in the same beat, which is exactly why
 * the Ionic toast CONTROLLER was used here before Ionic left the flight
 * path. A plain element on <body> survives any React tree churn at all.
 */
export function showToast(message: string): void {
  const el = document.createElement("div");
  el.className = styles.toast;
  el.setAttribute("role", "status");
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => {
    el.classList.add(styles.out);
    setTimeout(() => el.remove(), 400);
  }, 2000);
}
