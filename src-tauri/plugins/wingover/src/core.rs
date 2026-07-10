// The realtime core (ARCHITECTURE.md): owns the durable session fix
// log and the announcer; lives in the app process, which background
// location keeps alive when the webview is suspended or dead.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use crate::announcer::{Announcer, Waypoint};
use crate::fix::Fix;
use crate::store::SessionStore;

pub struct Core {
    data_dir: PathBuf,
    store: Mutex<Option<SessionStore>>,
    announcer: Mutex<Announcer>,
    running: AtomicBool,
    ingest_spawned: AtomicBool,
}

impl Core {
    pub fn new(data_dir: PathBuf) -> Self {
        let mut announcer = Announcer::default();
        // Waypoint config survives webview death AND app relaunch, so a
        // backgrounded relaunch keeps announcing without JS involvement.
        let waypoints_path = data_dir.join("waypoints.json");
        if let Ok(raw) = std::fs::read_to_string(&waypoints_path) {
            if let Ok(waypoints) = serde_json::from_str::<Vec<Waypoint>>(&raw) {
                announcer.set_waypoints(waypoints);
            }
        }
        Self {
            data_dir,
            store: Mutex::new(None),
            announcer: Mutex::new(announcer),
            running: AtomicBool::new(false),
            ingest_spawned: AtomicBool::new(false),
        }
    }

    fn session_path(&self) -> PathBuf {
        self.data_dir.join("session.jsonl")
    }

    fn with_store<T>(
        &self,
        run: impl FnOnce(&mut SessionStore) -> std::io::Result<T>,
    ) -> std::io::Result<T> {
        let mut guard = self.store.lock().unwrap();
        if guard.is_none() {
            *guard = Some(SessionStore::open(&self.session_path())?);
        }
        run(guard.as_mut().unwrap())
    }

    pub fn start(&self) -> std::io::Result<()> {
        // An empty store means a new flight: detection state must not
        // leak from the previous one. A mid-flight restart (store has
        // fixes) keeps arm state.
        let fresh = self.with_store(|store| Ok(store.fixes_since(0).is_empty()))?;
        if fresh {
            self.announcer.lock().unwrap().reset_detection();
        }
        self.running.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub fn stop(&self) -> std::io::Result<()> {
        self.running.store(false, Ordering::SeqCst);
        // The flight's waypoints die with its session: without this, a
        // failed set_waypoints at the next start (fire-and-forget) could
        // let a relaunch hydrate the PREVIOUS flight's set and announce it.
        self.announcer.lock().unwrap().set_waypoints(Vec::new());
        let _ = std::fs::remove_file(self.data_dir.join("waypoints.json"));
        self.with_store(|store| store.clear())
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    // The ingest thread is spawned at most once per process; it idles while
    // not running rather than exiting, so start/stop cycles are cheap.
    pub fn claim_ingest_thread(&self) -> bool {
        self.ingest_spawned
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    // Persist the batch FIRST, then decide announcements: audio is
    // fire-and-forget, the log is not.
    pub fn ingest(&self, batch: &[Fix]) -> std::io::Result<Vec<String>> {
        if batch.is_empty() {
            return Ok(Vec::new());
        }
        self.with_store(|store| store.append(batch))?;
        let mut announcer = self.announcer.lock().unwrap();
        let mut announcements = Vec::new();
        for fix in batch {
            announcements.extend(announcer.ingest(fix));
        }
        Ok(announcements)
    }

    pub fn fixes_since(&self, ts: i64) -> std::io::Result<Vec<Fix>> {
        self.with_store(|store| Ok(store.fixes_since(ts)))
    }

    pub fn set_waypoints(&self, waypoints: Vec<Waypoint>) -> std::io::Result<()> {
        let serialized = serde_json::to_string(&waypoints)?;
        std::fs::write(self.data_dir.join("waypoints.json"), serialized)?;
        self.announcer.lock().unwrap().set_waypoints(waypoints);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn core(name: &str) -> Core {
        let dir = std::env::temp_dir()
            .join("wingover-core-tests")
            .join(format!("{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let _ = std::fs::remove_file(dir.join("session.jsonl"));
        let _ = std::fs::remove_file(dir.join("waypoints.json"));
        Core::new(dir)
    }

    fn fix(ts: i64, latitude: f64) -> Fix {
        Fix {
            timestamp: ts,
            latitude,
            longitude: -89.4,
            horizontal_accuracy: 5.0,
            altitude: None,
            vertical_accuracy: None,
            speed: None,
            course: None,
        }
    }

    #[test]
    fn ingest_persists_then_announces() {
        let core = core("ingest");
        core.start().unwrap();
        core.set_waypoints(vec![Waypoint {
            id: "a".into(),
            latitude: 43.0,
            longitude: -89.4,
            radius_m: 200.0,
        }])
        .unwrap();

        let outside = fix(1000, 42.995);
        let inside = fix(2000, 43.0);
        assert!(core.ingest(&[outside]).unwrap().is_empty());
        let announced = core.ingest(&[inside]).unwrap();
        assert_eq!(announced, vec!["Waypoint reached".to_string()]);
        assert_eq!(core.fixes_since(0).unwrap().len(), 2);
        assert_eq!(core.fixes_since(1000).unwrap().len(), 1);
    }

    #[test]
    fn waypoints_survive_a_new_core() {
        let dir;
        {
            let core = core("persist");
            dir = core.data_dir.clone();
            core.set_waypoints(vec![Waypoint {
                id: "a".into(),
                latitude: 43.0,
                longitude: -89.4,
                radius_m: 200.0,
            }])
            .unwrap();
        }
        // Relaunch: waypoints hydrate without JS; announcing still works
        let reborn = Core::new(dir);
        reborn.start().unwrap();
        assert!(reborn.ingest(&[fix(1000, 42.995)]).unwrap().is_empty());
        assert_eq!(
            reborn.ingest(&[fix(2000, 43.0)]).unwrap(),
            vec!["Waypoint reached".to_string()]
        );
    }

    #[test]
    fn stop_clears_the_session_and_waypoints() {
        let core = core("stop");
        core.start().unwrap();
        core.set_waypoints(vec![Waypoint {
            id: "a".into(),
            latitude: 43.0,
            longitude: -89.4,
            radius_m: 200.0,
        }])
        .unwrap();
        core.ingest(&[fix(1000, 43.0)]).unwrap();
        core.stop().unwrap();
        assert!(!core.is_running());
        assert_eq!(core.fixes_since(0).unwrap().len(), 0);
        // A relaunch after a clean stop hydrates no waypoint config: an
        // outside->inside pass over the old waypoint stays silent.
        let reborn = Core::new(core.data_dir.clone());
        reborn.start().unwrap();
        assert!(reborn.ingest(&[fix(2000, 42.995)]).unwrap().is_empty());
        assert!(reborn.ingest(&[fix(3000, 43.0)]).unwrap().is_empty());
    }

    #[test]
    fn detection_resets_between_sessions() {
        let core = core("reset");
        core.start().unwrap();
        core.set_waypoints(vec![Waypoint {
            id: "a".into(),
            latitude: 43.0,
            longitude: -89.4,
            radius_m: 200.0,
        }])
        .unwrap();
        assert!(core.ingest(&[fix(1000, 42.995)]).unwrap().is_empty());
        assert_eq!(
            core.ingest(&[fix(2000, 43.0)]).unwrap(),
            vec!["Waypoint reached".to_string()]
        );
        // Exit, then end the flight with the waypoint armed-outside.
        assert!(core.ingest(&[fix(3000, 42.995)]).unwrap().is_empty());
        core.stop().unwrap();
        // Next flight: a first fix inside must arm silently, not announce.
        core.start().unwrap();
        assert!(core.ingest(&[fix(4000, 43.0)]).unwrap().is_empty());
    }
}
