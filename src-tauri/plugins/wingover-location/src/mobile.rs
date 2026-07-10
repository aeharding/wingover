use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

tauri::ios_plugin_binding!(init_plugin_wingover_location);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<WingoverLocation<R>> {
    let handle = api.register_ios_plugin(init_plugin_wingover_location)?;
    Ok(WingoverLocation(handle))
}

/// Access to the native location capture APIs.
pub struct WingoverLocation<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> WingoverLocation<R> {
    pub fn start_watch(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("startWatch", ())
            .map_err(Into::into)
    }

    pub fn fixes_since(&self, ts: i64) -> crate::Result<serde_json::Value> {
        self.0
            .run_mobile_plugin("fixesSince", serde_json::json!({ "ts": ts }))
            .map_err(Into::into)
    }

    pub fn stop_watch(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("stopWatch", ())
            .map_err(Into::into)
    }

    pub fn check_permissions(&self) -> crate::Result<serde_json::Value> {
        self.0
            .run_mobile_plugin("checkPermissions", ())
            .map_err(Into::into)
    }

    pub fn request_permissions(&self) -> crate::Result<serde_json::Value> {
        self.0
            .run_mobile_plugin("requestPermissions", ())
            .map_err(Into::into)
    }
}
