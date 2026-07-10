// Durable session fix log, owned by the Rust core (ARCHITECTURE.md).
// Append-only JSONL in the app data directory: every drained fix is written
// and flushed before it is served to any consumer, so a crash loses at most
// the sensor's in-memory drain window (the accepted torn-tail class). The
// file is cleared only at flight finalization.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

use crate::fix::Fix;

pub struct SessionStore {
    path: PathBuf,
    fixes: Vec<Fix>,
    writer: Option<BufWriter<File>>,
}

impl SessionStore {
    // Hydrates from an existing session file if present. A torn final line
    // (crash mid-write) is dropped silently by design.
    pub fn open(path: &Path) -> std::io::Result<Self> {
        let mut fixes = Vec::new();
        if path.exists() {
            let reader = BufReader::new(File::open(path)?);
            for line in reader.lines() {
                let line = line?;
                if let Ok(fix) = serde_json::from_str::<Fix>(&line) {
                    fixes.push(fix);
                }
            }
        }
        Ok(Self {
            path: path.to_path_buf(),
            fixes,
            writer: None,
        })
    }

    // Drops out-of-order fixes: after a relaunch the sensor's dedupe state
    // is gone and CoreLocation can redeliver a cached old fix — the durable
    // log is the ordering authority.
    pub fn append(&mut self, batch: &[Fix]) -> std::io::Result<()> {
        let last = self.fixes.last().map_or(i64::MIN, |fix| fix.timestamp);
        let fresh: Vec<&Fix> = batch
            .iter()
            .scan(last, |cursor, fix| {
                Some(if fix.timestamp > *cursor {
                    *cursor = fix.timestamp;
                    Some(fix)
                } else {
                    None
                })
            })
            .flatten()
            .collect();
        if fresh.is_empty() {
            return Ok(());
        }
        if self.writer.is_none() {
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)?;
            self.writer = Some(BufWriter::new(file));
        }
        let writer = self.writer.as_mut().unwrap();
        for fix in &fresh {
            serde_json::to_writer(&mut *writer, fix)?;
            writer.write_all(b"\n")?;
        }
        writer.flush()?;
        self.fixes.extend(fresh.into_iter().cloned());
        Ok(())
    }

    pub fn fixes_since(&self, ts: i64) -> Vec<Fix> {
        // Fixes are appended in timestamp order; scan back from the end.
        let start = self
            .fixes
            .iter()
            .rposition(|fix| fix.timestamp <= ts)
            .map_or(0, |index| index + 1);
        self.fixes[start..].to_vec()
    }

    pub fn clear(&mut self) -> std::io::Result<()> {
        self.fixes.clear();
        self.writer = None;
        if self.path.exists() {
            std::fs::remove_file(&self.path)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fix(ts: i64) -> Fix {
        Fix {
            timestamp: ts,
            latitude: 43.0,
            longitude: -89.4,
            horizontal_accuracy: 5.0,
            altitude: Some(300.0),
            vertical_accuracy: Some(8.0),
            speed: Some(10.0),
            course: Some(90.0),
        }
    }

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("wingover-store-tests");
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(format!("{name}-{}.jsonl", std::process::id()))
    }

    #[test]
    fn appends_serves_and_hydrates() {
        let path = temp_path("roundtrip");
        let _ = std::fs::remove_file(&path);

        let mut store = SessionStore::open(&path).unwrap();
        store.append(&[fix(1000), fix(2000), fix(3000)]).unwrap();
        assert_eq!(store.fixes_since(0).len(), 3);
        assert_eq!(store.fixes_since(1000).len(), 2);
        assert_eq!(store.fixes_since(3000).len(), 0);

        // Crash: a fresh process hydrates everything that was flushed
        let reborn = SessionStore::open(&path).unwrap();
        assert_eq!(reborn.fixes_since(0).len(), 3);
        assert_eq!(reborn.fixes_since(1500), store.fixes_since(1500));

        let mut cleanup = reborn;
        cleanup.clear().unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn tolerates_a_torn_tail() {
        let path = temp_path("torn");
        let _ = std::fs::remove_file(&path);
        {
            let mut store = SessionStore::open(&path).unwrap();
            store.append(&[fix(1000), fix(2000)]).unwrap();
        }
        // Simulate a crash mid-write of a third fix
        use std::io::Write as _;
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"timestamp\":3000,\"lat").unwrap();
        drop(file);

        let store = SessionStore::open(&path).unwrap();
        assert_eq!(store.fixes_since(0).len(), 2);
        assert_eq!(store.fixes_since(1999).len(), 1);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn drops_stale_redelivered_fixes() {
        let path = temp_path("stale");
        let _ = std::fs::remove_file(&path);
        let mut store = SessionStore::open(&path).unwrap();
        store.append(&[fix(1000), fix(2000)]).unwrap();
        // Relaunch redelivery: an old cached fix plus a genuinely new one
        store.append(&[fix(1500), fix(3000)]).unwrap();
        let timestamps: Vec<i64> = store
            .fixes_since(0)
            .iter()
            .map(|fix| fix.timestamp)
            .collect();
        assert_eq!(timestamps, vec![1000, 2000, 3000]);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn clear_then_reopen_is_empty() {
        let path = temp_path("clear");
        let _ = std::fs::remove_file(&path);
        let mut store = SessionStore::open(&path).unwrap();
        store.append(&[fix(1000)]).unwrap();
        store.clear().unwrap();
        store.append(&[fix(5000)]).unwrap();
        let reborn = SessionStore::open(&path).unwrap();
        assert_eq!(reborn.fixes_since(0).len(), 1);
        assert_eq!(reborn.fixes_since(0)[0].timestamp, 5000);
        let _ = std::fs::remove_file(&path);
    }
}
