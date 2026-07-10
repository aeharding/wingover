const COMMANDS: &[&str] = &[
    "start_watch",
    "fixes_since",
    "stop_watch",
    "set_waypoints",
    "check_permissions",
    "request_permissions",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
