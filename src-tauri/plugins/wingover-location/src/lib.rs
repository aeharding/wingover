// Minimal native location capture for Wingover (iOS; Android later).
//
// Design (PLAN.md "native queue" decision): the native side does capture and
// durable buffering ONLY — CLLocationManager with background delivery, an
// in-memory session queue mirrored to an append-only JSONL file. JS owns all
// flight semantics and PULLS fixes via `fixes_since(cursor)` once a second;
// the same call serves live delivery and post-reload catch-up, so the
// recovery path is exercised constantly. `stop_watch` finalizes: capture
// stops and the session file is deleted.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod error;

#[cfg(not(target_os = "ios"))]
mod desktop;
#[cfg(target_os = "ios")]
mod mobile;

pub use error::{Error, Result};

#[cfg(not(target_os = "ios"))]
pub use desktop::WingoverLocation;
#[cfg(target_os = "ios")]
pub use mobile::WingoverLocation;

mod commands {
    use tauri::{command, AppHandle, Runtime};

    use crate::{Result, WingoverLocationExt};

    #[command]
    pub(crate) async fn start_watch<R: Runtime>(app: AppHandle<R>) -> Result<()> {
        app.wingover_location().start_watch()
    }

    #[command]
    pub(crate) async fn fixes_since<R: Runtime>(
        app: AppHandle<R>,
        ts: i64,
    ) -> Result<serde_json::Value> {
        app.wingover_location().fixes_since(ts)
    }

    #[command]
    pub(crate) async fn stop_watch<R: Runtime>(app: AppHandle<R>) -> Result<()> {
        app.wingover_location().stop_watch()
    }

    #[command]
    pub(crate) async fn check_permissions<R: Runtime>(
        app: AppHandle<R>,
    ) -> Result<serde_json::Value> {
        app.wingover_location().check_permissions()
    }

    #[command]
    pub(crate) async fn request_permissions<R: Runtime>(
        app: AppHandle<R>,
    ) -> Result<serde_json::Value> {
        app.wingover_location().request_permissions()
    }
}

pub trait WingoverLocationExt<R: Runtime> {
    fn wingover_location(&self) -> &WingoverLocation<R>;
}

impl<R: Runtime, T: Manager<R>> WingoverLocationExt<R> for T {
    fn wingover_location(&self) -> &WingoverLocation<R> {
        self.state::<WingoverLocation<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("wingover-location")
        .invoke_handler(tauri::generate_handler![
            commands::start_watch,
            commands::fixes_since,
            commands::stop_watch,
            commands::check_permissions,
            commands::request_permissions,
        ])
        .setup(|app, api| {
            #[cfg(target_os = "ios")]
            let wingover_location = mobile::init(app, api)?;
            #[cfg(not(target_os = "ios"))]
            let wingover_location = desktop::init(app, api)?;
            app.manage(wingover_location);
            Ok(())
        })
        .build()
}
