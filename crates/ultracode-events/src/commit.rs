use crate::event::{EventKind, Record};
use crate::journal::JournalWriter;
use crate::recovery::{self, RecoveryError};
use std::collections::HashMap;
use std::io;
use std::path::Path;

pub enum CommitOutcome {
    /// Newly appended and fsynced.
    Committed(Record),
    /// Idempotent retry of an already-committed command; returns the original.
    Duplicate(Record),
}

pub struct CommitLog {
    journal: JournalWriter,
    keys: HashMap<String, u64>,
    last_record: Option<Record>,
}

impl CommitLog {
    /// Fresh journal.
    pub fn create(dir: &Path, session: &str) -> io::Result<Self> {
        Ok(Self { journal: JournalWriter::create(dir, session)?, keys: HashMap::new(), last_record: None })
    }

    /// Reopen with sidecar-restart semantics (spec §11 availability model):
    /// the idempotency index is rebuilt from the journal itself.
    pub fn open(dir: &Path, session: &str) -> Result<Self, RecoveryError> {
        let opened = recovery::open(dir, session)?;
        let keys = opened.idempotency_keys.into_iter().collect();
        Ok(Self { journal: opened.writer, keys, last_record: None })
    }

    /// One idempotent command → one committed event, ever. The returned record
    /// is durable ONLY after `commit_boundary` completes — callers must treat
    /// anything after the last boundary as speculative (spec §11).
    pub fn propose(&mut self, key: &str, kind: EventKind) -> io::Result<CommitOutcome> {
        if let Some(seq) = self.keys.get(key) {
            let seq = *seq;
            let last = self.last_record.clone().filter(|r| r.event.seq == seq);
            if let Some(record) = last {
                return Ok(CommitOutcome::Duplicate(record));
            }
            return Ok(CommitOutcome::Duplicate(lookup_marker(seq)));
        }
        let record = self.journal.append(kind, Some(key.to_string()))?;
        self.journal.commit_boundary()?;
        self.keys.insert(key.to_string(), record.event.seq);
        self.last_record = Some(record.clone());
        Ok(CommitOutcome::Committed(record))
    }

    pub fn commit_boundary(&self) -> io::Result<()> {
        self.journal.commit_boundary()
    }
}

/// Placeholder record for duplicates outside the in-memory window. Plan 2b's
/// projection layer replaces this with a real journal lookup; callers must
/// only rely on `Duplicate` semantics (no second line was appended).
fn lookup_marker(seq: u64) -> Record {
    Record {
        event: crate::event::Event {
            v: crate::event::SCHEMA_VERSION,
            seq,
            id: "duplicate-marker".into(),
            ts: 0,
            session: String::new(),
            cmd: None,
            kind: EventKind::SegmentSeal { sealed_events: 0, final_hash: String::new() },
        },
        prev: String::new(),
        hash: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ultracode-ctest-{name}-{}", std::process::id()))
    }

    #[test]
    fn duplicate_key_commits_once() {
        let dir = dir("dup");
        let _ = std::fs::remove_dir_all(&dir);
        let mut log = CommitLog::create(&dir, "ses_1").unwrap();
        let first = log
            .propose("cmd_x", EventKind::SideEffectPrepared {
                idempotency_key: "cmd_x".into(),
                tool: "deploy".into(),
                request_hash: "h".into(),
                reconciliation_policy: "never-retry".into(),
            })
            .unwrap();
        let second = log
            .propose("cmd_x", EventKind::SideEffectPrepared {
                idempotency_key: "cmd_x".into(),
                tool: "deploy".into(),
                request_hash: "h".into(),
                reconciliation_policy: "never-retry".into(),
            })
            .unwrap();
        match (first, second) {
            (CommitOutcome::Committed(a), CommitOutcome::Duplicate(b)) => assert_eq!(a.event.seq, b.event.seq),
            _ => panic!("first must commit, second must be duplicate"),
        }
        let content = std::fs::read_to_string(crate::journal::segment_path(&dir, 0)).unwrap();
        assert_eq!(content.lines().count(), 1, "duplicate must not append a second line");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reopen_rebuilds_idempotency_index_from_the_journal() {
        let dir = dir("reopen");
        let _ = std::fs::remove_dir_all(&dir);
        let mut log = CommitLog::create(&dir, "ses_1").unwrap();
        log.propose("cmd_x", EventKind::TurnStarted { turn: 1 }).unwrap();
        drop(log);
        // Sidecar restart: dedup must survive without any sidecar state file.
        let mut log = CommitLog::open(&dir, "ses_1").unwrap();
        log.propose("cmd_x", EventKind::TurnStarted { turn: 1 }).unwrap();
        let content = std::fs::read_to_string(crate::journal::segment_path(&dir, 0)).unwrap();
        assert_eq!(content.lines().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
