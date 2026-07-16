// Desktop/Android stub so the crate (and its permission definitions)
// builds on every platform. Real capture is iOS-only for now; Android
// gets a Kotlin implementation of the same four primitives later.

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::fix::Fix;

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Wingover<R>> {
    Ok(Wingover(std::marker::PhantomData))
}

pub struct Wingover<R: Runtime>(std::marker::PhantomData<fn() -> R>);

impl<R: Runtime> Wingover<R> {
    pub fn start_capture(&self) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn stop_capture(&self) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn drain(&self) -> crate::Result<Vec<Fix>> {
        Err(crate::Error::UnsupportedPlatform)
    }

    // Not an error: the JS credential store PROBES this and falls back to
    // IndexedDB. Answering false is the honest reply on a platform with no
    // Keychain, and it is what keeps the Linux desktop dev ring working.
    pub fn keychain_available(&self) -> crate::Result<bool> {
        Ok(false)
    }

    pub fn keychain_get(&self, _key: &str) -> crate::Result<Option<String>> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn keychain_set(&self, _key: &str, _value: &str) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn keychain_delete(&self, _key: &str) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn storekit_products(&self, _product_ids: Vec<String>) -> crate::Result<serde_json::Value> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn storekit_current_entitlement(
        &self,
        _product_ids: Vec<String>,
    ) -> crate::Result<Option<String>> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn storekit_purchase(&self, _product_id: &str) -> crate::Result<Option<String>> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn storekit_manage_subscriptions(&self) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn sign_in_with_apple(&self) -> crate::Result<String> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn speak(&self, _text: &str) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn share_file(&self, _name: &str, _content: &str) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn check_permissions(&self) -> crate::Result<serde_json::Value> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn request_permissions(&self) -> crate::Result<serde_json::Value> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn current_position(&self) -> crate::Result<Fix> {
        Err(crate::Error::UnsupportedPlatform)
    }
}
