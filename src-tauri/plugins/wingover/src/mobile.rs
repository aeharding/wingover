use serde::de::DeserializeOwned;
use serde::Deserialize;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::fix::Fix;

tauri::ios_plugin_binding!(init_plugin_wingover);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Wingover<R>> {
    let handle = api.register_ios_plugin(init_plugin_wingover)?;
    Ok(Wingover(handle))
}

#[derive(Deserialize)]
struct DrainResponse {
    fixes: Vec<Fix>,
}

// Sensor/actuator shim: four dumb primitives, all logic lives in Rust.
pub struct Wingover<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Wingover<R> {
    pub fn start_capture(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("startCapture", ())
            .map_err(Into::into)
    }

    pub fn stop_capture(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("stopCapture", ())
            .map_err(Into::into)
    }

    pub fn drain(&self) -> crate::Result<Vec<Fix>> {
        let response: DrainResponse = self.0.run_mobile_plugin("drain", ())?;
        Ok(response.fixes)
    }

    pub fn speak(&self, text: &str) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("speak", serde_json::json!({ "text": text }))
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
