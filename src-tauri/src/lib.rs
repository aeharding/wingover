#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_geolocation::init());
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
