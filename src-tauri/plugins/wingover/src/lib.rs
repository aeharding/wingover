// Wingover's native plugin, structured per ARCHITECTURE.md:
//
//   sensor/actuator layer (Swift; Kotlin later) — capture, drain,
//     permissions, speak. No logic, no storage.
//   realtime core (THIS CRATE, Rust) — durable session fix log,
//     pull-based serving to the JS engine, and the waypoint announcer,
//     all alive while the webview is suspended or dead.
//
// JS pulls `fixes_since(cursor)` once a second; the same call serves live
// delivery and post-reload catch-up. `stop_watch` finalizes: capture stops
// and the session log is deleted. An ingest thread drains the sensor's
// in-memory buffer at 1 Hz, persists first, then announces.

use std::time::Duration;

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod announcer;
mod core;
mod error;
mod fix;
mod store;

#[cfg(not(target_os = "ios"))]
mod desktop;
#[cfg(target_os = "ios")]
mod mobile;

use crate::core::Core;
pub use announcer::Waypoint;
pub use error::{Error, Result};
pub use fix::Fix;

#[cfg(not(target_os = "ios"))]
pub use desktop::Wingover;
#[cfg(target_os = "ios")]
pub use mobile::Wingover;

const INGEST_INTERVAL: Duration = Duration::from_secs(1);

fn spawn_ingest_thread<R: Runtime>(app: tauri::AppHandle<R>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(INGEST_INTERVAL);
        let core = app.state::<Core>();
        if !core.is_running() {
            continue;
        }
        let sensor = app.wingover();
        let batch = match sensor.drain() {
            Ok(batch) => batch,
            Err(error) => {
                eprintln!("wingover plugin drain failed: {error}");
                continue;
            }
        };
        match core.ingest(&batch) {
            Ok(announcements) => {
                for text in announcements {
                    if let Err(error) = sensor.speak(&text) {
                        eprintln!("wingover plugin speak failed: {error}");
                    }
                }
            }
            Err(error) => eprintln!("wingover plugin ingest failed: {error}"),
        }
    });
}

mod commands {
    use tauri::{command, AppHandle, Manager, Runtime};

    use crate::core::Core;
    use crate::{Result, Waypoint, WingoverExt};

    #[command]
    pub(crate) async fn start_watch<R: Runtime>(app: AppHandle<R>) -> Result<()> {
        app.wingover().start_capture()?;
        let core = app.state::<Core>();
        core.start()?;
        if core.claim_ingest_thread() {
            crate::spawn_ingest_thread(app.clone());
        }
        Ok(())
    }

    #[command]
    pub(crate) async fn fixes_since<R: Runtime>(
        app: AppHandle<R>,
        ts: i64,
    ) -> Result<serde_json::Value> {
        let fixes = app.state::<Core>().fixes_since(ts)?;
        Ok(serde_json::json!({ "fixes": fixes }))
    }

    #[command]
    pub(crate) async fn stop_watch<R: Runtime>(app: AppHandle<R>) -> Result<()> {
        app.wingover().stop_capture()?;
        app.state::<Core>().stop()?;
        Ok(())
    }

    #[command]
    pub(crate) async fn set_waypoints<R: Runtime>(
        app: AppHandle<R>,
        waypoints: Vec<Waypoint>,
    ) -> Result<()> {
        app.state::<Core>().set_waypoints(waypoints)?;
        Ok(())
    }

    #[command]
    pub(crate) async fn share_file<R: Runtime>(
        app: AppHandle<R>,
        name: String,
        content: String,
    ) -> Result<()> {
        app.wingover().share_file(&name, &content)
    }

    #[command]
    pub(crate) async fn check_permissions<R: Runtime>(
        app: AppHandle<R>,
    ) -> Result<serde_json::Value> {
        app.wingover().check_permissions()
    }

    #[command]
    pub(crate) async fn request_permissions<R: Runtime>(
        app: AppHandle<R>,
    ) -> Result<serde_json::Value> {
        app.wingover().request_permissions()
    }

    // One-shot position for the map's Center-on-me (no capture session).
    #[command]
    pub(crate) async fn current_position<R: Runtime>(app: AppHandle<R>) -> Result<crate::Fix> {
        app.wingover().current_position()
    }

    // Keychain and StoreKit are pass-through, like share_file: no Core, no
    // state. The sync credential's authority is the server, and the WAL knows
    // nothing about either.

    #[command]
    pub(crate) async fn keychain_available<R: Runtime>(app: AppHandle<R>) -> Result<bool> {
        app.wingover().keychain_available()
    }

    #[command]
    pub(crate) async fn keychain_get<R: Runtime>(
        app: AppHandle<R>,
        key: String,
    ) -> Result<Option<String>> {
        app.wingover().keychain_get(&key)
    }

    #[command]
    pub(crate) async fn keychain_set<R: Runtime>(
        app: AppHandle<R>,
        key: String,
        value: String,
    ) -> Result<()> {
        app.wingover().keychain_set(&key, &value)
    }

    #[command]
    pub(crate) async fn keychain_delete<R: Runtime>(app: AppHandle<R>, key: String) -> Result<()> {
        app.wingover().keychain_delete(&key)
    }

    #[command]
    pub(crate) async fn storekit_products<R: Runtime>(
        app: AppHandle<R>,
        product_ids: Vec<String>,
    ) -> Result<serde_json::Value> {
        app.wingover().storekit_products(product_ids)
    }

    #[command]
    pub(crate) async fn storekit_current_entitlement<R: Runtime>(
        app: AppHandle<R>,
        product_ids: Vec<String>,
    ) -> Result<Option<String>> {
        app.wingover().storekit_current_entitlement(product_ids)
    }

    #[command]
    pub(crate) async fn storekit_purchase<R: Runtime>(
        app: AppHandle<R>,
        product_id: String,
    ) -> Result<Option<String>> {
        app.wingover().storekit_purchase(&product_id)
    }

    #[command]
    pub(crate) async fn storekit_manage_subscriptions<R: Runtime>(
        app: AppHandle<R>,
    ) -> Result<()> {
        app.wingover().storekit_manage_subscriptions()
    }

    #[command]
    pub(crate) async fn sign_in_with_apple<R: Runtime>(app: AppHandle<R>) -> Result<String> {
        app.wingover().sign_in_with_apple()
    }
}

pub trait WingoverExt<R: Runtime> {
    fn wingover(&self) -> &Wingover<R>;
}

impl<R: Runtime, T: Manager<R>> WingoverExt<R> for T {
    fn wingover(&self) -> &Wingover<R> {
        self.state::<Wingover<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("wingover")
        .invoke_handler(tauri::generate_handler![
            commands::start_watch,
            commands::fixes_since,
            commands::stop_watch,
            commands::set_waypoints,
            commands::share_file,
            commands::check_permissions,
            commands::request_permissions,
            commands::current_position,
            commands::keychain_available,
            commands::keychain_get,
            commands::keychain_set,
            commands::keychain_delete,
            commands::storekit_products,
            commands::storekit_current_entitlement,
            commands::storekit_purchase,
            commands::storekit_manage_subscriptions,
            commands::sign_in_with_apple,
        ])
        .setup(|app, api| {
            #[cfg(target_os = "ios")]
            let wingover = mobile::init(app, api)?;
            #[cfg(not(target_os = "ios"))]
            let wingover = desktop::init(app, api)?;
            app.manage(wingover);

            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            app.manage(Core::new(data_dir));
            Ok(())
        })
        .build()
}
