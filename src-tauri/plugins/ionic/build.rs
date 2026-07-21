// No commands: the plugin's whole surface is native webview behavior plus
// Capacitor-named window events dispatched INTO the page.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
