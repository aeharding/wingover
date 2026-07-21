// tauri-plugin-ionic: a compat layer so Ionic apps run natively-smooth on
// Tauri. The design principle is to dispatch the events and apply the webview
// behaviors that CAPACITOR would have — Ionic's components (tab bar, footer,
// keyboard controller) already listen for Capacitor's window events, so the
// web layer lights up with zero glue.
//
// Today (iOS): the on-screen-keyboard suite in IonicPlugin.swift —
// keyboardWillShow/keyboardWillHide CustomEvents (with keyboardHeight),
// outer-scroll-view pinning while the keyboard is up, the input accessory
// bar swizzle, programmatic-focus keyboard, native overscroll bounce, and
// the `statusTap` CustomEvent on status-bar taps (enable Ionic's built-in
// scroll-to-top with setupIonicReact({ statusTap: true }) — its default is
// hybrid-only). Desktop/Android: inert.
//
// The web half (resize <ion-app>, html.keyboard-open, the window.Capacitor
// haptics facade) lives with the consuming app for now: src/tauri-ionic/.
//
// REQUIREMENT: the webview must present a real iPhone user agent. Ionic's
// runtime platform detection (isPlatform) is UA-based, and it gates behaviors
// like toggle/picker haptics — a bare custom `userAgent` in tauri.conf.json
// makes Ionic silently treat the app as desktop. If an app identity token is
// needed, APPEND it to a standard iPhone UA (Capacitor's appendUserAgent
// semantics), never replace the UA.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_ionic);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("ionic")
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            _api.register_ios_plugin(init_plugin_ionic)?;
            Ok(())
        })
        .build()
}
