use serde::{Deserialize, Serialize};

// Wire shape shared with the JS engine (`NativeFix` in nativeSource.ts)
// and the sensor shims. Optional fields are absent when the platform
// reports them invalid.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fix {
    pub timestamp: i64,
    pub latitude: f64,
    pub longitude: f64,
    pub horizontal_accuracy: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub altitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vertical_accuracy: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub course: Option<f64>,
}
