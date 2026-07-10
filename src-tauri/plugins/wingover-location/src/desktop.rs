// Desktop/Android stub so the crate (and its permission definitions)
// builds on every platform. Real capture is iOS-only for now; Android
// gets a Kotlin foreground-service implementation later.

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<WingoverLocation<R>> {
    Ok(WingoverLocation(std::marker::PhantomData))
}

pub struct WingoverLocation<R: Runtime>(std::marker::PhantomData<fn() -> R>);

impl<R: Runtime> WingoverLocation<R> {
    pub fn start_watch(&self) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn fixes_since(&self, _ts: i64) -> crate::Result<serde_json::Value> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn stop_watch(&self) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn check_permissions(&self) -> crate::Result<serde_json::Value> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn request_permissions(&self) -> crate::Result<serde_json::Value> {
        Err(crate::Error::UnsupportedPlatform)
    }
}
