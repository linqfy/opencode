//! SQLite-WAL projections — always a projection of the journal, never canonical.
//! The journal is the sole source of truth; `rebuild` truncates and replays.

use crate::event::Record;
use crate::recovery;
use rusqlite::{params, Connection};
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct IndexedEvent {
    pub seq: u64,
    pub id: String,
    pub kind: String,
    pub session: String,
    pub ts: u64,
}

pub struct ProjectionStore {
    conn: Connection,
    path: PathBuf,
}

impl ProjectionStore {
    pub fn open(path: &Path) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS events_index (
                 seq INTEGER PRIMARY KEY,
                 id TEXT NOT NULL,
                 kind TEXT NOT NULL,
                 session TEXT NOT NULL,
                 ts INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_events_session ON events_index(session, seq);",
        )?;
        Ok(Self { conn, path: path.to_path_buf() })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    pub fn conn_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }

    /// Kebab-case kind name, derived from the serde tag so it never drifts
    /// from the event schema.
    pub fn kind_name(kind: &crate::event::EventKind) -> String {
        serde_json::to_value(kind)
            .ok()
            .and_then(|v| v.get("kind").and_then(|k| k.as_str()).map(String::from))
            .unwrap_or_else(|| "unknown".to_string())
    }

    pub fn index_record(&mut self, record: &Record) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT OR REPLACE INTO events_index (seq, id, kind, session, ts) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                record.event.seq,
                record.event.id,
                Self::kind_name(&record.event.kind),
                record.event.session,
                record.event.ts
            ],
        )?;
        Ok(())
    }

    /// Truncates the projection and replays the whole journal. Returns the
    /// number of events indexed.
    pub fn rebuild(&mut self, journal_dir: &Path, session: &str) -> io::Result<usize> {
        self.conn
            .execute("DELETE FROM events_index", [])
            .map_err(io::Error::other)?;
        let opened = recovery::open(journal_dir, session).map_err(io::Error::other)?;
        let mut count = 0usize;
        for record in &opened.records {
            self.index_record(record).map_err(io::Error::other)?;
            count += 1;
        }
        Ok(count)
    }

    pub fn list_events(
        &self,
        session: &str,
        since_seq: u64,
        limit: u64,
    ) -> Result<Vec<IndexedEvent>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT seq, id, kind, session, ts FROM events_index WHERE session = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![session, since_seq, limit], |row| {
            Ok(IndexedEvent {
                seq: row.get(0)?,
                id: row.get(1)?,
                kind: row.get(2)?,
                session: row.get(3)?,
                ts: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn count(&self) -> Result<u64, rusqlite::Error> {
        self.conn
            .query_row("SELECT COUNT(*) FROM events_index", [], |row| row.get(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::EventKind;
    use crate::journal::JournalWriter;

    fn dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ultracode-proj-{name}-{}", std::process::id()))
    }

    fn write_journal(dir: &Path) {
        let mut j = JournalWriter::create(dir, "ses_1").unwrap();
        j.append(EventKind::SessionStarted { client: "t".into(), client_version: "0".into() }, None).unwrap();
        j.append(EventKind::TurnStarted { turn: 1 }, None).unwrap();
        j.append(EventKind::TurnCompleted { turn: 1 }, None).unwrap();
        j.commit_boundary().unwrap();
    }

    #[test]
    fn open_creates_the_events_index_table() {
        let dir = dir("open");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = ProjectionStore::open(&dir.join("proj.db")).unwrap();
        assert_eq!(store.count().unwrap(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rebuild_replays_the_journal_into_the_index() {
        let jdir = dir("rebuild-j");
        let dbdir = dir("rebuild-db");
        let _ = std::fs::remove_dir_all(&jdir);
        let _ = std::fs::remove_dir_all(&dbdir);
        std::fs::create_dir_all(&dbdir).unwrap();
        write_journal(&jdir);

        let mut store = ProjectionStore::open(&dbdir.join("proj.db")).unwrap();
        let n = store.rebuild(&jdir, "ses_1").unwrap();
        assert_eq!(n, 3);
        assert_eq!(store.count().unwrap(), 3);

        let events = store.list_events("ses_1", 0, 10).unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].kind, "session-started");
        assert_eq!(events[1].kind, "turn-started");
        assert_eq!(events[2].kind, "turn-completed");
        assert_eq!(events[0].seq, 1);
        assert_eq!(events[2].seq, 3);
        let _ = std::fs::remove_dir_all(&jdir);
        let _ = std::fs::remove_dir_all(&dbdir);
    }

    #[test]
    fn rebuild_is_idempotent() {
        let jdir = dir("idem-j");
        let dbdir = dir("idem-db");
        let _ = std::fs::remove_dir_all(&jdir);
        let _ = std::fs::remove_dir_all(&dbdir);
        std::fs::create_dir_all(&dbdir).unwrap();
        write_journal(&jdir);

        let mut store = ProjectionStore::open(&dbdir.join("proj.db")).unwrap();
        store.rebuild(&jdir, "ses_1").unwrap();
        store.rebuild(&jdir, "ses_1").unwrap();
        assert_eq!(store.count().unwrap(), 3, "rebuild must truncate, not append");
        let _ = std::fs::remove_dir_all(&jdir);
        let _ = std::fs::remove_dir_all(&dbdir);
    }

    #[test]
    fn list_events_respects_since_seq_and_limit() {
        let jdir = dir("list-j");
        let dbdir = dir("list-db");
        let _ = std::fs::remove_dir_all(&jdir);
        let _ = std::fs::remove_dir_all(&dbdir);
        std::fs::create_dir_all(&dbdir).unwrap();
        write_journal(&jdir);

        let mut store = ProjectionStore::open(&dbdir.join("proj.db")).unwrap();
        store.rebuild(&jdir, "ses_1").unwrap();
        let tail = store.list_events("ses_1", 1, 10).unwrap();
        assert_eq!(tail.len(), 2);
        assert_eq!(tail[0].seq, 2);
        let limited = store.list_events("ses_1", 0, 2).unwrap();
        assert_eq!(limited.len(), 2);
        let _ = std::fs::remove_dir_all(&jdir);
        let _ = std::fs::remove_dir_all(&dbdir);
    }
}
