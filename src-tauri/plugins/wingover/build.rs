const COMMANDS: &[&str] = &[
    "start_watch",
    "fixes_since",
    "stop_watch",
    "set_waypoints",
    "share_file",
    "check_permissions",
    "request_permissions",
    "current_position",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
