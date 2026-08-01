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
    keys: HashMap<String, Record>,
}

impl CommitLog {
    /// Fresh journal.
    pub fn create(dir: &Path, session: &str) -> io::Result<Self> {
        Ok(Self {
            journal: JournalWriter::create(dir, session)?,
            keys: HashMap::new(),
        })
    }

    /// Reopen with sidecar-restart semantics (spec §11 availability model):
    /// the idempotency index is rebuilt from the journal itself.
    pub fn open(dir: &Path, session: &str) -> Result<Self, RecoveryError> {
        let opened = recovery::open(dir, session)?;
        let keys = opened
            .records
            .iter()
            .filter_map(|record| {
                record
                    .event
                    .cmd
                    .as_ref()
                    .map(|key| (key.clone(), record.clone()))
            })
            .collect();
        Ok(Self {
            journal: opened.writer,
            keys,
        })
    }

    /// One idempotent command → one committed event, ever. The returned record
    /// is durable ONLY after `commit_boundary` completes — callers must treat
    /// anything after the last boundary as speculative (spec §11).
    pub fn propose(&mut self, key: &str, kind: EventKind) -> io::Result<CommitOutcome> {
        if let Some(record) = self.keys.get(key) {
            return Ok(CommitOutcome::Duplicate(record.clone()));
        }
        let record = self.journal.append(kind, Some(key.to_string()))?;
        self.journal.commit_boundary()?;
        self.keys.insert(key.to_string(), record.clone());
        Ok(CommitOutcome::Committed(record))
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.keys.contains_key(key)
    }

    pub fn record_for_key(&self, key: &str) -> Option<Record> {
        self.keys.get(key).cloned()
    }

    pub fn commit_boundary(&self) -> io::Result<()> {
        self.journal.commit_boundary()
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
            .propose(
                "cmd_x",
                EventKind::SideEffectPrepared {
                    idempotency_key: "cmd_x".into(),
                    tool: "deploy".into(),
                    request_hash: "h".into(),
                    reconciliation_policy: "never-retry".into(),
                },
            )
            .unwrap();
        let second = log
            .propose(
                "cmd_x",
                EventKind::SideEffectPrepared {
                    idempotency_key: "cmd_x".into(),
                    tool: "deploy".into(),
                    request_hash: "h".into(),
                    reconciliation_policy: "never-retry".into(),
                },
            )
            .unwrap();
        match (first, second) {
            (CommitOutcome::Committed(a), CommitOutcome::Duplicate(b)) => {
                assert_eq!(a.event.seq, b.event.seq)
            }
            _ => panic!("first must commit, second must be duplicate"),
        }
        let content = std::fs::read_to_string(crate::journal::segment_path(&dir, 0)).unwrap();
        assert_eq!(
            content.lines().count(),
            1,
            "duplicate must not append a second line"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reopen_rebuilds_idempotency_index_from_the_journal() {
        let dir = dir("reopen");
        let _ = std::fs::remove_dir_all(&dir);
        let mut log = CommitLog::create(&dir, "ses_1").unwrap();
        let first = log
            .propose("cmd_x", EventKind::TurnStarted { turn: 1 })
            .unwrap();
        drop(log);
        // Sidecar restart: dedup must survive without any sidecar state file.
        let mut log = CommitLog::open(&dir, "ses_1").unwrap();
        let duplicate = log
            .propose("cmd_x", EventKind::TurnStarted { turn: 1 })
            .unwrap();
        match (first, duplicate) {
            (CommitOutcome::Committed(first), CommitOutcome::Duplicate(duplicate)) => {
                assert_eq!(duplicate, first)
            }
            _ => panic!("reopened retry must return its committed record"),
        }
        let content = std::fs::read_to_string(crate::journal::segment_path(&dir, 0)).unwrap();
        assert_eq!(content.lines().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
