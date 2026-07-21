/**
 * The web half of tauri-plugin-ionic (src-tauri/plugins/ionic): the DOM
 * reactions to the plugin's Capacitor-named keyboard events, and the
 * window.Capacitor facade bridging Ionic's haptic hooks to
 * tauri-plugin-haptics. Kept as one self-contained module so it can move
 * into the plugin's own npm package when extracted.
 */

export { installCapacitorShim } from "./capacitor";
export { installKeyboardLayout } from "./keyboard";
