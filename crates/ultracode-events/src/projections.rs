//! SQLite-WAL projections — always a projection of the journal, never canonical.
//! The journal is the sole source of truth; `rebuild` truncates and replays.

use crate::event::{EventKind, Record};
use crate::recovery;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
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

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MemoryRecord {
    pub thread_id: String,
    pub source_session: String,
    pub source_turn: u32,
    pub source_end_seq: u64,
    pub transcript_artifact_id: String,
    pub extractor_version: String,
    pub source_updated_at: u64,
    pub raw_memory: String,
    pub rollout_summary: String,
    pub rollout_slug: Option<String>,
    pub cwd: String,
    pub git_branch: Option<String>,
    pub generated_at: u64,
    pub usage_count: u64,
    pub last_usage: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MemoryJob {
    pub request_id: String,
    pub kind: String,
    pub data: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MemoryConsolidation {
    pub memory_id: String,
    pub summary: String,
    pub memory: String,
    pub source_thread_ids: Vec<String>,
    pub generated_at: u64,
}

#[derive(Deserialize)]
struct MemoryExtractionSource {
    source_session: String,
    source_turn: u32,
    source_end_seq: u64,
    transcript_artifact_id: String,
    extractor_version: String,
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
              CREATE INDEX IF NOT EXISTS idx_events_session ON events_index(session, seq);
              CREATE TABLE IF NOT EXISTS memory_records (
                  thread_id TEXT PRIMARY KEY, source_session TEXT NOT NULL, source_turn INTEGER NOT NULL,
                  source_end_seq INTEGER NOT NULL, transcript_artifact_id TEXT NOT NULL, extractor_version TEXT NOT NULL,
                  source_updated_at INTEGER NOT NULL,
                  raw_memory TEXT NOT NULL, rollout_summary TEXT NOT NULL, rollout_slug TEXT,
                  cwd TEXT NOT NULL, git_branch TEXT, generated_at INTEGER NOT NULL,
                  usage_count INTEGER NOT NULL DEFAULT 0, last_usage INTEGER
              );
               CREATE TABLE IF NOT EXISTS memory_jobs (
                   request_id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL, failure_reason TEXT
               );
               CREATE TABLE IF NOT EXISTS memory_consolidations (
                   memory_id TEXT PRIMARY KEY, summary TEXT NOT NULL, memory TEXT NOT NULL,
                   source_thread_ids TEXT NOT NULL, generated_at INTEGER NOT NULL
             );",
        )?;
        let has_failure_reason = {
            let mut statement = conn.prepare("PRAGMA table_info(memory_jobs)")?;
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?;
            columns.iter().any(|column| column == "failure_reason")
        };
        if !has_failure_reason {
            conn.execute("ALTER TABLE memory_jobs ADD COLUMN failure_reason TEXT", [])?;
        }
        Ok(Self {
            conn,
            path: path.to_path_buf(),
        })
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
        match &record.event.kind {
            EventKind::MemoryExtractionRequested { request_id, .. }
            | EventKind::MemoryConsolidationRequested { request_id, .. } => {
                let value = serde_json::to_value(&record.event.kind)
                    .map_err(|_| rusqlite::Error::InvalidParameterName("memory job data".into()))?;
                let kind = value["kind"].as_str().ok_or_else(|| {
                    rusqlite::Error::InvalidParameterName("memory job kind".into())
                })?;
                self.conn.execute(
                    "INSERT OR IGNORE INTO memory_jobs (request_id, kind, data, status) VALUES (?1, ?2, ?3, 'pending')",
                    params![request_id, kind, value["data"].to_string()],
                )?;
            }
            EventKind::MemoryExtracted {
                request_id,
                thread_id,
                source_updated_at,
                raw_memory,
                rollout_summary,
                rollout_slug,
                cwd,
                git_branch,
                generated_at,
            } => {
                let source = self.memory_extraction_source(request_id)?;
                self.complete_memory_job(request_id)?;
                self.conn.execute(
                    "INSERT INTO memory_records (thread_id, source_session, source_turn, source_end_seq, transcript_artifact_id, extractor_version, source_updated_at, raw_memory, rollout_summary, rollout_slug, cwd, git_branch, generated_at, usage_count, last_usage)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, NULL)
                     ON CONFLICT(thread_id) DO UPDATE SET source_session = excluded.source_session, source_turn = excluded.source_turn,
                     source_end_seq = excluded.source_end_seq, transcript_artifact_id = excluded.transcript_artifact_id, extractor_version = excluded.extractor_version,
                     source_updated_at = excluded.source_updated_at, raw_memory = excluded.raw_memory,
                     rollout_summary = excluded.rollout_summary, rollout_slug = excluded.rollout_slug, cwd = excluded.cwd,
                     git_branch = excluded.git_branch, generated_at = excluded.generated_at
                     WHERE excluded.source_updated_at >= memory_records.source_updated_at",
                    params![thread_id, source.source_session, source.source_turn, source.source_end_seq, source.transcript_artifact_id, source.extractor_version, source_updated_at, raw_memory, rollout_summary, rollout_slug, cwd, git_branch, generated_at],
                )?;
            }
            EventKind::MemoryConsolidated {
                request_id,
                memory_id,
                summary,
                memory,
                source_thread_ids,
                generated_at,
            } => {
                self.complete_memory_job(request_id)?;
                self.conn.execute(
                    "INSERT INTO memory_consolidations (memory_id, summary, memory, source_thread_ids, generated_at) VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(memory_id) DO UPDATE SET summary = excluded.summary, memory = excluded.memory, source_thread_ids = excluded.source_thread_ids, generated_at = excluded.generated_at",
                    params![memory_id, summary, memory, serde_json::to_string(source_thread_ids).map_err(|_| rusqlite::Error::InvalidParameterName("consolidation sources".into()))?, generated_at],
                )?;
            }
            EventKind::MemoryJobFailed { request_id, reason } => {
                self.conn.execute(
                    "UPDATE memory_jobs SET status = 'failed', failure_reason = ?2 WHERE request_id = ?1 AND status != 'completed'",
                    params![request_id, reason],
                )?;
            }
            EventKind::MemoryUsageRecorded { thread_ids, at_ms } => {
                for thread_id in thread_ids.iter().collect::<HashSet<_>>() {
                    self.conn.execute(
                        "UPDATE memory_records SET usage_count = usage_count + 1, last_usage = ?2 WHERE thread_id = ?1",
                        params![thread_id, at_ms],
                    )?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn complete_memory_job(&mut self, request_id: &str) -> Result<(), rusqlite::Error> {
        let exists: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM memory_jobs WHERE request_id = ?1)",
            params![request_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(rusqlite::Error::InvalidParameterName(format!(
                "missing memory request: {request_id}"
            )));
        }
        self.conn.execute(
            "UPDATE memory_jobs SET status = 'completed' WHERE request_id = ?1",
            params![request_id],
        )?;
        Ok(())
    }

    fn memory_extraction_source(
        &self,
        request_id: &str,
    ) -> Result<MemoryExtractionSource, rusqlite::Error> {
        let (kind, data): (String, String) = self.conn.query_row(
            "SELECT kind, data FROM memory_jobs WHERE request_id = ?1",
            params![request_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if kind != "memory-extraction-requested" {
            return Err(rusqlite::Error::InvalidParameterName(format!(
                "memory extraction request has wrong kind: {request_id}"
            )));
        }
        serde_json::from_str(&data)
            .map_err(|_| rusqlite::Error::InvalidParameterName("memory request data".into()))
    }

    /// Truncates the projection and replays the whole journal. Returns the
    /// number of events indexed.
    pub fn rebuild(&mut self, journal_dir: &Path, session: &str) -> io::Result<usize> {
        self.conn
            .execute_batch(
                "DELETE FROM events_index; DELETE FROM memory_records; DELETE FROM memory_jobs; DELETE FROM memory_consolidations;",
            )
            .map_err(io::Error::other)?;
        let opened = recovery::open(journal_dir, session).map_err(io::Error::other)?;
        let mut count = 0usize;
        for record in &opened.records {
            self.index_record(record).map_err(io::Error::other)?;
            count += 1;
        }
        self.conn
            .execute(
                "UPDATE memory_jobs SET status = 'pending' WHERE status = 'running'",
                [],
            )
            .map_err(io::Error::other)?;
        Ok(count)
    }

    pub fn list_memory_records(&self, limit: u64) -> Result<Vec<MemoryRecord>, rusqlite::Error> {
        let mut stmt = self.conn.prepare("SELECT thread_id, source_session, source_turn, source_end_seq, transcript_artifact_id, extractor_version, source_updated_at, raw_memory, rollout_summary, rollout_slug, cwd, git_branch, generated_at, usage_count, last_usage FROM memory_records ORDER BY usage_count DESC, last_usage DESC, source_updated_at DESC, thread_id ASC LIMIT ?1")?;
        let rows = stmt.query_map(params![limit.min(200)], |row| {
            Ok(MemoryRecord {
                thread_id: row.get(0)?,
                source_session: row.get(1)?,
                source_turn: row.get(2)?,
                source_end_seq: row.get(3)?,
                transcript_artifact_id: row.get(4)?,
                extractor_version: row.get(5)?,
                source_updated_at: row.get(6)?,
                raw_memory: row.get(7)?,
                rollout_summary: row.get(8)?,
                rollout_slug: row.get(9)?,
                cwd: row.get(10)?,
                git_branch: row.get(11)?,
                generated_at: row.get(12)?,
                usage_count: row.get(13)?,
                last_usage: row.get(14)?,
            })
        })?;
        rows.collect()
    }

    pub fn list_memory_consolidations(
        &self,
        limit: u64,
    ) -> Result<Vec<MemoryConsolidation>, rusqlite::Error> {
        let mut stmt = self.conn.prepare("SELECT memory_id, summary, memory, source_thread_ids, generated_at FROM memory_consolidations ORDER BY generated_at DESC, memory_id ASC LIMIT ?1")?;
        let rows = stmt.query_map(params![limit.min(200)], |row| {
            Ok(MemoryConsolidation {
                memory_id: row.get(0)?,
                summary: row.get(1)?,
                memory: row.get(2)?,
                source_thread_ids: serde_json::from_str(&row.get::<_, String>(3)?).map_err(
                    |_| {
                        rusqlite::Error::InvalidColumnType(
                            3,
                            "source_thread_ids".into(),
                            rusqlite::types::Type::Text,
                        )
                    },
                )?,
                generated_at: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn claim_memory_job(&mut self) -> Result<Option<MemoryJob>, rusqlite::Error> {
        let job = self.conn.query_row("SELECT request_id, kind, data FROM memory_jobs WHERE status = 'pending' ORDER BY request_id ASC LIMIT 1", [], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))).optional()?;
        let Some((request_id, kind, data)) = job else {
            return Ok(None);
        };
        self.conn.execute("UPDATE memory_jobs SET status = 'running' WHERE request_id = ?1 AND status = 'pending'", params![request_id])?;
        Ok(Some(MemoryJob {
            request_id,
            kind,
            data: serde_json::from_str(&data)
                .map_err(|_| rusqlite::Error::InvalidParameterName("memory job data".into()))?,
        }))
    }

    pub fn validate_memory_result(&self, kind: &EventKind) -> Result<(), String> {
        let (request_id, expected_kind) = match kind {
            EventKind::MemoryExtracted { request_id, .. } => {
                (request_id, "memory-extraction-requested")
            }
            EventKind::MemoryConsolidated { request_id, .. } => {
                (request_id, "memory-consolidation-requested")
            }
            _ => return Ok(()),
        };
        let job: Option<(String, String)> = self
            .conn
            .query_row(
                "SELECT kind, status FROM memory_jobs WHERE request_id = ?1",
                params![request_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some((actual_kind, status)) = job else {
            return Err(format!("missing memory request: {request_id}"));
        };
        if actual_kind != expected_kind {
            return Err(format!("memory request has wrong kind: {request_id}"));
        }
        if status != "running" {
            return Err(format!("memory request is not running: {request_id}"));
        }
        Ok(())
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
        j.append(
            EventKind::SessionStarted {
                client: "t".into(),
                client_version: "0".into(),
            },
            None,
        )
        .unwrap();
        j.append(EventKind::TurnStarted { turn: 1 }, None).unwrap();
        j.append(EventKind::TurnCompleted { turn: 1 }, None)
            .unwrap();
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
        assert_eq!(
            store.count().unwrap(),
            3,
            "rebuild must truncate, not append"
        );
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

    #[test]
    fn projections_and_artifacts_survive_a_reopen() {
        use crate::artifacts::{ArtifactStore, CredentialClass, Retention};
        use crate::commit::CommitLog;

        let base = std::env::temp_dir().join(format!("ultracode-integ-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let jdir = base.join("journal");
        let blobs = base.join("blobs");
        let db = base.join("proj.db");

        // First "session": commit events + store an artifact.
        {
            let mut log = CommitLog::create(&jdir, "ses_1").unwrap();
            log.propose(
                "cmd_a",
                EventKind::SessionStarted {
                    client: "t".into(),
                    client_version: "0".into(),
                },
            )
            .unwrap();
            log.propose("cmd_b", EventKind::TurnStarted { turn: 1 })
                .unwrap();
            let mut artifacts = ArtifactStore::open(&blobs, &db).unwrap();
            let reference = artifacts
                .put(
                    b"tool output",
                    "text/plain",
                    "ses_1",
                    Retention::Session,
                    CredentialClass::Plain,
                    None,
                )
                .unwrap();
            log.propose(
                "cmd_c",
                EventKind::ArtifactStored {
                    artifact_id: reference.artifact_id.clone(),
                    mime: "text/plain".into(),
                    byte_length: reference.byte_length,
                    hash: reference.hash.clone(),
                },
            )
            .unwrap();
        }

        // Reopen (simulating a sidecar restart) and rebuild projections.
        let mut store = ProjectionStore::open(&db).unwrap();
        let n = store.rebuild(&jdir, "ses_1").unwrap();
        assert_eq!(n, 3);
        let kinds: Vec<String> = store
            .list_events("ses_1", 0, 10)
            .unwrap()
            .into_iter()
            .map(|e| e.kind)
            .collect();
        assert_eq!(
            kinds,
            vec!["session-started", "turn-started", "artifact-stored"]
        );

        // The artifact bytes are still readable after the restart.
        let artifacts = ArtifactStore::open(&blobs, &db).unwrap();
        let events = store.list_events("ses_1", 0, 10).unwrap();
        let artifact_event = events.iter().find(|e| e.kind == "artifact-stored").unwrap();
        // Recover the artifact id from the journal record via a fresh read.
        let opened = recovery::open(&jdir, "ses_1").unwrap();
        let stored = opened
            .records
            .iter()
            .find(|r| matches!(r.event.kind, crate::event::EventKind::ArtifactStored { .. }))
            .unwrap();
        let artifact_id = match &stored.event.kind {
            crate::event::EventKind::ArtifactStored { artifact_id, .. } => artifact_id.clone(),
            _ => unreachable!(),
        };
        let _ = artifact_event;
        let bytes = artifacts.open_range(&artifact_id, "ses_1", 0, 100).unwrap();
        assert_eq!(bytes, b"tool output".to_vec());

        let _ = std::fs::remove_dir_all(&base);
    }

    fn memory_extracted(thread_id: &str, source_updated_at: u64, raw_memory: &str) -> EventKind {
        EventKind::MemoryExtracted {
            request_id: format!("req-{thread_id}-{source_updated_at}"),
            thread_id: thread_id.into(),
            source_updated_at,
            raw_memory: raw_memory.into(),
            rollout_summary: format!("summary-{raw_memory}"),
            rollout_slug: Some("rollout".into()),
            cwd: "/repo".into(),
            git_branch: Some("main".into()),
            generated_at: source_updated_at + 1,
        }
    }

    fn memory_requested(request_id: &str) -> EventKind {
        EventKind::MemoryExtractionRequested {
            request_id: request_id.into(),
            source_session: "ses_1".into(),
            source_turn: 1,
            source_end_seq: 1,
            transcript_artifact_id: "art".into(),
            extractor_version: "v1".into(),
        }
    }

    #[test]
    fn memory_live_index_and_rebuild_are_equivalent() {
        let jdir = dir("memory-rebuild-j");
        let dbdir = dir("memory-rebuild-db");
        let _ = std::fs::remove_dir_all(&jdir);
        let _ = std::fs::remove_dir_all(&dbdir);
        std::fs::create_dir_all(&dbdir).unwrap();
        let mut journal = JournalWriter::create(&jdir, "ses_1").unwrap();
        let requested = journal
            .append(
                EventKind::MemoryExtractionRequested {
                    request_id: "req-thread-a-10".into(),
                    source_session: "ses_1".into(),
                    source_turn: 1,
                    source_end_seq: 2,
                    transcript_artifact_id: "art-a".into(),
                    extractor_version: "v1".into(),
                },
                None,
            )
            .unwrap();
        let extracted = journal
            .append(memory_extracted("thread-a", 10, "raw-a"), None)
            .unwrap();
        journal.commit_boundary().unwrap();

        let mut live = ProjectionStore::open(&dbdir.join("live.db")).unwrap();
        live.index_record(&requested).unwrap();
        live.index_record(&extracted).unwrap();
        let live_records = live.list_memory_records(200).unwrap();

        let mut rebuilt = ProjectionStore::open(&dbdir.join("rebuilt.db")).unwrap();
        rebuilt.rebuild(&jdir, "ses_1").unwrap();
        assert_eq!(rebuilt.list_memory_records(200).unwrap(), live_records);
        assert_eq!(rebuilt.claim_memory_job().unwrap(), None);
        let _ = std::fs::remove_dir_all(&jdir);
        let _ = std::fs::remove_dir_all(&dbdir);
    }

    #[test]
    fn newer_memory_replaces_content_and_preserves_usage() {
        let base = dir("memory-newer");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let mut store = ProjectionStore::open(&base.join("proj.db")).unwrap();
        let mut journal = JournalWriter::create(&base.join("journal"), "ses_1").unwrap();
        for kind in [
            memory_requested("req-thread-a-10"),
            memory_extracted("thread-a", 10, "old"),
            EventKind::MemoryUsageRecorded {
                thread_ids: vec!["thread-a".into()],
                at_ms: 50,
            },
            memory_requested("req-thread-a-11"),
            memory_extracted("thread-a", 11, "new"),
            memory_requested("req-thread-a-9"),
            memory_extracted("thread-a", 9, "stale"),
        ] {
            let record = journal.append(kind, None).unwrap();
            store.index_record(&record).unwrap();
        }
        let record = store.list_memory_records(200).unwrap().pop().unwrap();
        assert_eq!(record.raw_memory, "new");
        assert_eq!(record.source_session, "ses_1");
        assert_eq!(record.source_turn, 1);
        assert_eq!(record.source_end_seq, 1);
        assert_eq!(record.transcript_artifact_id, "art");
        assert_eq!(record.extractor_version, "v1");
        assert_eq!(record.usage_count, 1);
        assert_eq!(record.last_usage, Some(50));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn memory_usage_is_deduplicated_and_records_are_ranked() {
        let base = dir("memory-usage");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let mut store = ProjectionStore::open(&base.join("proj.db")).unwrap();
        let mut journal = JournalWriter::create(&base.join("journal"), "ses_1").unwrap();
        for kind in [
            memory_requested("req-thread-c-2"),
            memory_extracted("thread-c", 2, "c"),
            memory_requested("req-thread-b-3"),
            memory_extracted("thread-b", 3, "b"),
            memory_requested("req-thread-a-3"),
            memory_extracted("thread-a", 3, "a"),
            EventKind::MemoryUsageRecorded {
                thread_ids: vec![
                    "thread-a".into(),
                    "thread-a".into(),
                    "thread-b".into(),
                    "unknown".into(),
                ],
                at_ms: 10,
            },
            EventKind::MemoryUsageRecorded {
                thread_ids: vec!["thread-a".into()],
                at_ms: 11,
            },
        ] {
            let record = journal.append(kind, None).unwrap();
            store.index_record(&record).unwrap();
        }
        let records = store.list_memory_records(200).unwrap();
        assert_eq!(
            records
                .iter()
                .map(|record| record.thread_id.as_str())
                .collect::<Vec<_>>(),
            vec!["thread-a", "thread-b", "thread-c"]
        );
        assert_eq!(records[0].usage_count, 2);
        assert_eq!(records[0].last_usage, Some(11));
        assert_eq!(records[1].usage_count, 1);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn memory_request_jobs_are_idempotent_and_restart_requeues_claims() {
        let base = dir("memory-jobs");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let mut store = ProjectionStore::open(&base.join("proj.db")).unwrap();
        let mut journal = JournalWriter::create(&base.join("journal"), "ses_1").unwrap();
        for request_id in ["req-b", "req-a", "req-a"] {
            let record = journal
                .append(
                    EventKind::MemoryExtractionRequested {
                        request_id: request_id.into(),
                        source_session: "ses_1".into(),
                        source_turn: 1,
                        source_end_seq: 1,
                        transcript_artifact_id: "art".into(),
                        extractor_version: "v1".into(),
                    },
                    None,
                )
                .unwrap();
            store.index_record(&record).unwrap();
        }
        assert_eq!(
            store.claim_memory_job().unwrap().unwrap().request_id,
            "req-a"
        );
        assert!(store.claim_memory_job().unwrap().is_some());
        store.rebuild(&base.join("journal"), "ses_1").unwrap();
        assert_eq!(
            store.claim_memory_job().unwrap().unwrap().request_id,
            "req-a"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn extraction_result_completes_its_request_job() {
        let base = dir("memory-complete");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let mut store = ProjectionStore::open(&base.join("proj.db")).unwrap();
        let mut journal = JournalWriter::create(&base.join("journal"), "ses_1").unwrap();
        let request = journal
            .append(
                EventKind::MemoryExtractionRequested {
                    request_id: "req-a".into(),
                    source_session: "ses_1".into(),
                    source_turn: 1,
                    source_end_seq: 1,
                    transcript_artifact_id: "art".into(),
                    extractor_version: "v1".into(),
                },
                None,
            )
            .unwrap();
        store.index_record(&request).unwrap();
        let result = journal
            .append(
                EventKind::MemoryExtracted {
                    request_id: "req-a".into(),
                    thread_id: "thread-a".into(),
                    source_updated_at: 1,
                    raw_memory: "raw".into(),
                    rollout_summary: "summary".into(),
                    rollout_slug: None,
                    cwd: "/repo".into(),
                    git_branch: None,
                    generated_at: 2,
                },
                None,
            )
            .unwrap();
        store.index_record(&result).unwrap();
        assert_eq!(store.claim_memory_job().unwrap(), None);
        let _ = std::fs::remove_dir_all(&base);
    }
}
