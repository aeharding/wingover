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

#[derive(Deserialize)]
struct AvailableResponse {
    available: bool,
}

#[derive(Deserialize)]
struct ValueResponse {
    value: Option<String>,
}

#[derive(Deserialize)]
struct JwsResponse {
    jws: Option<String>,
}

// Sensor/actuator shim: five dumb primitives, all logic lives in Rust.
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

    pub fn keychain_available(&self) -> crate::Result<bool> {
        let response: AvailableResponse = self.0.run_mobile_plugin("keychainAvailable", ())?;
        Ok(response.available)
    }

    pub fn keychain_get(&self, key: &str) -> crate::Result<Option<String>> {
        let response: ValueResponse = self
            .0
            .run_mobile_plugin("keychainGet", serde_json::json!({ "key": key }))?;
        Ok(response.value)
    }

    pub fn keychain_set(&self, key: &str, value: &str) -> crate::Result<()> {
        self.0
            .run_mobile_plugin(
                "keychainSet",
                serde_json::json!({ "key": key, "value": value }),
            )
            .map_err(Into::into)
    }

    pub fn keychain_delete(&self, key: &str) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("keychainDelete", serde_json::json!({ "key": key }))
            .map_err(Into::into)
    }

    pub fn storekit_products(&self, product_ids: Vec<String>) -> crate::Result<serde_json::Value> {
        self.0
            .run_mobile_plugin(
                "storekitProducts",
                serde_json::json!({ "productIds": product_ids }),
            )
            .map_err(Into::into)
    }

    pub fn storekit_current_entitlement(
        &self,
        product_ids: Vec<String>,
    ) -> crate::Result<Option<String>> {
        let response: JwsResponse = self.0.run_mobile_plugin(
            "storekitCurrentEntitlement",
            serde_json::json!({ "productIds": product_ids }),
        )?;
        Ok(response.jws)
    }

    pub fn storekit_purchase(&self, product_id: &str) -> crate::Result<Option<String>> {
        let response: JwsResponse = self.0.run_mobile_plugin(
            "storekitPurchase",
            serde_json::json!({ "productId": product_id }),
        )?;
        Ok(response.jws)
    }

    pub fn sign_in_with_apple(&self) -> crate::Result<String> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct IdentityTokenResponse {
            identity_token: String,
        }
        let response: IdentityTokenResponse =
            self.0.run_mobile_plugin("signInWithApple", ())?;
        Ok(response.identity_token)
    }

    pub fn speak(&self, text: &str) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("speak", serde_json::json!({ "text": text }))
            .map_err(Into::into)
    }

    pub fn share_file(&self, name: &str, content: &str) -> crate::Result<()> {
        self.0
            .run_mobile_plugin(
                "shareFile",
                serde_json::json!({ "name": name, "content": content }),
            )
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

    pub fn current_position(&self) -> crate::Result<Fix> {
        self.0
            .run_mobile_plugin("currentPosition", ())
            .map_err(Into::into)
    }
}
