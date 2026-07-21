#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // opener: external links (map attribution) open in the system browser.
    // WKWebView would otherwise swallow the tap or navigate away in-app.
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_wingover::init());
    // The Ionic-on-Tauri compat layer (Capacitor-named keyboard events, webview
    // keyboard handling) + official haptics, which the web layer bridges to
    // Ionic's window.Capacitor haptic hooks (src/tauri-ionic/).
    #[cfg(mobile)]
    let builder = builder
        .plugin(tauri_plugin_ionic::init())
        .plugin(tauri_plugin_haptics::init());
    // WKWebView does NOT reload itself when iOS/macOS kills its content
    // process (memory pressure while backgrounded does this routinely) —
    // without this hook the app stays a dead white view until relaunch.
    // Reloading brings the UI back up to rehydrate from the WAL + native
    // fix queue, per the reliability doctrine.
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    let builder = builder.on_web_content_process_terminate(|webview| {
        if let Err(error) = webview.reload() {
            log::error!("failed to reload webview after content process death: {error}");
        }
    });
    builder
        .setup(|_app| {
            // tao's iOS Window::inner_size() reports the safe-area size, so the
            // WKWebView is created 96pt short (62 status bar + 34 home indicator
            // on notched phones) and anchored at the top, leaving a dead strip
            // at the bottom. Resize it to fill its superview and stop UIKit from
            // re-inserting safe-area scroll insets; the CSS already handles the
            // insets via viewport-fit=cover + env(safe-area-inset-*).
            #[cfg(target_os = "ios")]
            {
                use tauri::Manager;
                let window = _app
                    .get_webview_window("main")
                    .expect("main window must exist");
                window.with_webview(|webview| unsafe {
                    use objc2::msg_send;
                    use objc2::runtime::AnyObject;
                    use objc2_foundation::NSRect;

                    let wk: *mut AnyObject = webview.inner().cast();
                    let scroll: *mut AnyObject = msg_send![wk, scrollView];
                    // UIScrollViewContentInsetAdjustmentBehavior.never
                    let _: () = msg_send![scroll, setContentInsetAdjustmentBehavior: 2isize];
                    let superview: *mut AnyObject = msg_send![wk, superview];
                    if !superview.is_null() {
                        let bounds: NSRect = msg_send![superview, bounds];
                        let _: () = msg_send![wk, setFrame: bounds];
                    }
                })?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running wingover");
}
