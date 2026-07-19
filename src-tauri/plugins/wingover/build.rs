const COMMANDS: &[&str] = &[
    "start_watch",
    "fixes_since",
    "stop_watch",
    "set_waypoints",
    "share_file",
    "check_permissions",
    "request_permissions",
    "current_position",
    "keychain_available",
    "keychain_get",
    "keychain_set",
    "keychain_delete",
    "storekit_products",
    "storekit_current_entitlement",
    "storekit_purchase",
    "storekit_manage_subscriptions",
    "storekit_environment",
    "sign_in_with_apple",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
