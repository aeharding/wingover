// Every response shape crossing Swift -> Rust -> JS, in one module that
// compiles on every platform. mobile.rs is #[cfg(target_os = "ios")], so
// types defined there are checked by nothing off a Mac — which is how the
// drain error field went missing through four plausible layers.
//
// The canonical payloads live in contract-fixtures/ and are round-tripped
// by the tests at the bottom of this file; the JS side reads the same
// files (src/engine/nativeSource.contract.test.ts).

// Dead on a desktop build by construction: the only consumer of these
// types is mobile.rs, which is iOS-only. Compiling them everywhere is the
// entire point — a shape no platform can check is how the last one broke.
//
// Scoped to the builds where that is true, not blanket: on iOS these types
// DO have a consumer, so an unused one there is a real signal (a response
// shape nothing emits any more) and must stay a warning.
#![cfg_attr(not(target_os = "ios"), allow(dead_code))]

use serde::{Deserialize, Serialize};

use crate::fix::Fix;

// NO #[serde(deny_unknown_fields)] on any of these, deliberately. Swift
// clears its buffer before resolving, so a strict parse that rejects an
// unexpected field discards that second of flight permanently, on device,
// at 1 Hz. The round-trip test below catches a rename in CI instead, at
// no cost to a flight.
#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct DrainResponse {
    pub fixes: Vec<Fix>,
    // The sensor's current health (reduced-accuracy / permission codes,
    // or CoreLocation failure prose); absent when healthy. Reasserted by
    // the sensor on every delivery, so it tracks the truth continuously.
    pub error: Option<String>,
}

// What the JS engine polls at 1 Hz. Sensor health rides along with every
// poll: fixes with no error is a healthy stream; an error with no fixes
// is a dead or reduced source the engine must surface.
#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct FixesResponse {
    pub fixes: Vec<Fix>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct AvailableResponse {
    pub available: bool,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct ValueResponse {
    pub value: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct JwsResponse {
    pub jws: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct EnvironmentResponse {
    pub environment: String,
}

// The one response whose field is required: a rename fails loudly here
// rather than degrading to None.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IdentityTokenResponse {
    pub identity_token: String,
}

#[cfg(test)]
mod contract {
    use serde::de::DeserializeOwned;
    use serde_json::Value;

    use super::*;
    use crate::announcer::Waypoint;
    use crate::core::Core;

    const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/contract-fixtures");

    fn fixtures() -> Vec<(String, Value)> {
        let mut loaded = Vec::new();
        for entry in std::fs::read_dir(DIR).expect("contract-fixtures directory") {
            let path = entry.unwrap().path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let raw = std::fs::read_to_string(&path).unwrap();
            let fixture = serde_json::from_str(&raw)
                .unwrap_or_else(|error| panic!("{name}: invalid JSON: {error}"));
            loaded.push((name, fixture));
        }
        loaded.sort_by(|left, right| left.0.cmp(&right.0));
        loaded
    }

    fn fixture(name: &str) -> Value {
        let raw = std::fs::read_to_string(std::path::Path::new(DIR).join(name)).unwrap();
        serde_json::from_str(&raw).unwrap()
    }

    // Two spellings that are one statement on this wire, normalized so
    // neither side's dialect decides the comparison: absent equals null
    // (Swift omits a healthy error key, Rust emits null), and JSON has a
    // single number type (a fixture's 6 is Rust's 6.0).
    fn normalize(value: Value) -> Value {
        match value {
            Value::Object(map) => Value::Object(
                map.into_iter()
                    .filter(|(_, field)| !field.is_null())
                    .map(|(key, field)| (key, normalize(field)))
                    .collect(),
            ),
            Value::Array(items) => Value::Array(items.into_iter().map(normalize).collect()),
            Value::Number(number) => serde_json::json!(number.as_f64().unwrap()),
            other => other,
        }
    }

    // Deserializing proves nothing: serde ignores unknown fields, so a
    // renamed key parses into None and passes every is_ok() assertion
    // ever written. Only re-serializing shows the hole.
    fn assert_preserved<T: DeserializeOwned + Serialize>(name: &str, payload: &Value) {
        let parsed: T = serde_json::from_value(payload.clone())
            .unwrap_or_else(|error| panic!("{name}: does not deserialize: {error}"));
        let round_tripped = serde_json::to_value(&parsed).unwrap();
        assert_eq!(
            normalize(payload.clone()),
            normalize(round_tripped),
            "{name}: a field the fixture carries did not survive the real serde types"
        );
    }

    fn response<'a>(name: &str, fixture: &'a Value) -> &'a Value {
        fixture
            .get("response")
            .unwrap_or_else(|| panic!("{name}: fixture has no response"))
    }

    // A fixture's expect.rust is a claim about what THIS ring reads, and an
    // unread claim is decoration: the round trip above proves the keys
    // survive serde, not that the values arrive with the meaning the
    // fixture says they have. The two fix-carrying surfaces are where that
    // distinction cost a flight (an error field that parsed into None), so
    // both are asserted, and a fixture on either surface that declares no
    // expectation fails rather than passing quietly.
    fn assert_rust_reading(name: &str, fixture: &Value, fixes: usize, error: Option<&str>) {
        let expected = fixture
            .get("expect")
            .and_then(|expect| expect.get("rust"))
            .unwrap_or_else(|| panic!("{name}: fix-carrying fixture declares no expect.rust"));
        assert_eq!(
            expected["fixes"].as_u64().map(|count| count as usize),
            Some(fixes),
            "{name}: expect.rust.fixes disagrees with what the real types parsed"
        );
        assert_eq!(
            expected["error"].as_str(),
            error,
            "{name}: expect.rust.error disagrees with what the real types parsed"
        );
    }

    #[test]
    fn every_fixture_survives_the_real_types() {
        let loaded = fixtures();
        // A floor at the current count, not a token one: fixtures only ever
        // get added, so this catches a directory that quietly stopped being
        // read (a bad glob, a moved folder) instead of passing on two files.
        assert!(
            loaded.len() >= 32,
            "contract-fixtures looks empty: {} files",
            loaded.len()
        );
        for (name, fixture) in loaded {
            let surface = fixture["surface"]
                .as_str()
                .unwrap_or_else(|| panic!("{name}: fixture has no surface"));
            match surface {
                "drain" => {
                    let payload = response(&name, &fixture);
                    assert_preserved::<DrainResponse>(&name, payload);
                    let parsed: DrainResponse = serde_json::from_value(payload.clone()).unwrap();
                    assert_rust_reading(&name, &fixture, parsed.fixes.len(), parsed.error.as_deref())
                }
                "fixes_since" => {
                    let payload = response(&name, &fixture);
                    assert_preserved::<FixesResponse>(&name, payload);
                    let parsed: FixesResponse = serde_json::from_value(payload.clone()).unwrap();
                    assert_rust_reading(&name, &fixture, parsed.fixes.len(), parsed.error.as_deref())
                }
                "current_position" => assert_preserved::<Fix>(&name, response(&name, &fixture)),
                "keychain_get" => {
                    assert_preserved::<ValueResponse>(&name, response(&name, &fixture))
                }
                "keychain_available" => {
                    assert_preserved::<AvailableResponse>(&name, response(&name, &fixture))
                }
                "storekit_current_entitlement" | "storekit_purchase" => {
                    assert_preserved::<JwsResponse>(&name, response(&name, &fixture))
                }
                "storekit_environment" => {
                    assert_preserved::<EnvironmentResponse>(&name, response(&name, &fixture))
                }
                "sign_in_with_apple" => {
                    assert_preserved::<IdentityTokenResponse>(&name, response(&name, &fixture))
                }
                "set_waypoints" => {
                    assert_preserved::<Vec<Waypoint>>(&name, &fixture["request"]["waypoints"])
                }
                // Rust carries these across untouched (serde_json::Value)
                // or never sees them at all: Swift and JS are the two ends
                // and the fixture is their agreement, not ours.
                "check_permissions"
                | "request_permissions"
                | "storekit_products"
                | "speak"
                | "share_file"
                | "keychain_set"
                | "keychain_delete" => {}
                other => {
                    panic!("{name}: no Rust reader claims surface {other:?} — add a match arm")
                }
            }
        }
    }

    // The severed channel, end to end in one language: the Swift payload
    // parses, the code lands in the core, and the poll JS reads carries it
    // out again. Every hop had a passing test while the whole path was
    // broken, so the assertion has to span all three.
    #[test]
    fn the_sensor_error_reaches_fixes_since() {
        let dir = std::env::temp_dir()
            .join("wingover-contract-tests")
            .join(std::process::id().to_string());
        std::fs::create_dir_all(&dir).unwrap();
        let _ = std::fs::remove_file(dir.join("session.jsonl"));
        let _ = std::fs::remove_file(dir.join("waypoints.json"));

        let drained: DrainResponse =
            serde_json::from_value(fixture("drain.reduced-accuracy.json")["response"].clone())
                .unwrap();
        assert_eq!(drained.error.as_deref(), Some("reduced-accuracy"));

        let core = Core::new(dir);
        core.start().unwrap();
        core.ingest(&drained.fixes).unwrap();
        core.set_sensor_error(drained.error);

        let served = FixesResponse {
            fixes: core.fixes_since(0).unwrap(),
            error: core.sensor_error(),
        };
        assert_eq!(
            normalize(serde_json::to_value(&served).unwrap()),
            normalize(fixture("fixes_since.stale-error-with-fixes.json")["response"].clone()),
            "the drained sensor code must reach the shape JS polls"
        );

        core.stop().unwrap();
    }
}
