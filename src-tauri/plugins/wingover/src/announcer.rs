// Waypoint announcement decisions (ARCHITECTURE.md: real-time side effect,
// evaluated on ingest while the webview may be suspended). Semantics are
// pinned by the shared golden vectors in src/announce/golden.json, executed
// here and by the TS twin (src/flight/waypoints.ts) — divergence fails CI
// in both languages.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::fix::Fix;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Waypoint {
    pub id: String,
    pub latitude: f64,
    pub longitude: f64,
    pub radius_m: f64,
}

#[derive(Default)]
pub struct Announcer {
    waypoints: Vec<Waypoint>,
    // true = currently inside; entries absent until the first fix arms them
    inside: HashMap<String, bool>,
}

fn haversine_meters(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const EARTH_RADIUS_M: f64 = 6_371_000.0;
    let phi1 = lat1.to_radians();
    let phi2 = lat2.to_radians();
    let d_phi = (lat2 - lat1).to_radians();
    let d_lambda = (lon2 - lon1).to_radians();
    let a = (d_phi / 2.0).sin().powi(2) + phi1.cos() * phi2.cos() * (d_lambda / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_M * a.sqrt().asin()
}

impl Announcer {
    // Detection state is flight-scoped: a new session re-arms from its
    // first fix (which stays silent), never inheriting the previous
    // flight's inside/outside map.
    pub fn reset_detection(&mut self) {
        self.inside.clear();
    }

    // Keeps arm state for waypoints whose definition is unchanged; a moved
    // or resized waypoint re-arms from the next fix.
    pub fn set_waypoints(&mut self, waypoints: Vec<Waypoint>) {
        let mut inside = HashMap::new();
        for waypoint in &waypoints {
            if let Some(previous) = self.waypoints.iter().find(|w| w.id == waypoint.id) {
                if previous == waypoint {
                    if let Some(state) = self.inside.get(&waypoint.id) {
                        inside.insert(waypoint.id.clone(), *state);
                    }
                }
            }
        }
        self.waypoints = waypoints;
        self.inside = inside;
    }

    // Returns the announcements this fix triggers, in waypoint order.
    pub fn ingest(&mut self, fix: &Fix) -> Vec<String> {
        let mut announcements = Vec::new();
        for waypoint in &self.waypoints {
            let now_inside = haversine_meters(
                fix.latitude,
                fix.longitude,
                waypoint.latitude,
                waypoint.longitude,
            ) <= waypoint.radius_m;
            match self.inside.get(&waypoint.id) {
                // First fix arms without announcing: launching from inside
                // your own waypoint must not speak.
                None => {
                    self.inside.insert(waypoint.id.clone(), now_inside);
                }
                Some(false) if now_inside => {
                    self.inside.insert(waypoint.id.clone(), true);
                    announcements.push("Waypoint reached".to_string());
                }
                Some(true) if !now_inside => {
                    self.inside.insert(waypoint.id.clone(), false);
                }
                _ => {}
            }
        }
        announcements
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GoldenFix {
        timestamp: i64,
        latitude: f64,
        longitude: f64,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GoldenAnnouncement {
        at_timestamp: i64,
        text: String,
    }

    #[derive(Deserialize)]
    struct GoldenCase {
        name: String,
        waypoints: Vec<Waypoint>,
        fixes: Vec<GoldenFix>,
        announcements: Vec<GoldenAnnouncement>,
    }

    #[derive(Deserialize)]
    struct Golden {
        cases: Vec<GoldenCase>,
    }

    fn to_fix(golden: &GoldenFix) -> Fix {
        Fix {
            timestamp: golden.timestamp,
            latitude: golden.latitude,
            longitude: golden.longitude,
            horizontal_accuracy: 5.0,
            altitude: None,
            vertical_accuracy: None,
            speed: None,
            course: None,
        }
    }

    #[test]
    fn golden_vectors() {
        let golden: Golden =
            serde_json::from_str(include_str!("../../../../src/flight/golden.json"))
                .expect("golden vectors parse");
        for case in golden.cases {
            let mut announcer = Announcer::default();
            announcer.set_waypoints(case.waypoints.clone());
            let mut produced = Vec::new();
            for fix in &case.fixes {
                for text in announcer.ingest(&to_fix(fix)) {
                    produced.push((fix.timestamp, text));
                }
            }
            let expected: Vec<(i64, String)> = case
                .announcements
                .iter()
                .map(|a| (a.at_timestamp, a.text.clone()))
                .collect();
            assert_eq!(produced, expected, "case: {}", case.name);
        }
    }

    #[test]
    fn unchanged_waypoints_keep_arm_state_across_set() {
        let waypoint = Waypoint {
            id: "a".into(),
            latitude: 43.0,
            longitude: -89.4,
            radius_m: 200.0,
        };
        let inside = Fix {
            timestamp: 1000,
            latitude: 43.0,
            longitude: -89.4,
            horizontal_accuracy: 5.0,
            altitude: None,
            vertical_accuracy: None,
            speed: None,
            course: None,
        };
        let mut announcer = Announcer::default();
        announcer.set_waypoints(vec![waypoint.clone()]);
        assert!(announcer.ingest(&inside).is_empty()); // armed inside, silent
        announcer.set_waypoints(vec![waypoint]); // unchanged definition
                                                 // Still considered inside: re-setting must not cause an announcement
        assert!(announcer.ingest(&inside).is_empty());
    }
}
