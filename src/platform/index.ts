// The platform seam. The ONE layer allowed to ask where the app is
// running, and the home of the selection modules that act on the answer
// (currentPosition's one-shot source pick). It sits outside src/engine on
// purpose: the engine "never switches on the platform — sources declare
// capabilities and the engine adapts" (ARCHITECTURE.md), so a platform
// question living under src/engine/ was the doctrine's own counterexample.
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
