use crate::event::{
    hash_from_hex, hash_hex, new_event_id, now_ms, Event, EventKind, Record, GENESIS_HASH,
    SCHEMA_VERSION,
};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};

pub const DEFAULT_MAX_SEGMENT_BYTES: u64 = 16 * 1024 * 1024;

pub fn segment_path(dir: &Path, index: u32) -> PathBuf {
    dir.join(format!("segment-{index:05}.jsonl"))
}

/// Computes the chain hash for an event: sha256(prev || "\n" || canonical_json).
pub fn chain_hash(prev: &[u8; 32], event: &Event) -> Result<[u8; 32], serde_json::Error> {
    let canonical = event.canonical_bytes()?;
    let mut hasher = Sha256::new();
    hasher.update(prev);
    hasher.update(b"\n");
    hasher.update(&canonical);
    Ok(hasher.finalize().into())
}

/// Recomputes a persisted line's hash and compares it. Used by recovery.
pub fn verify_record(record: &Record) -> bool {
    let prev = match hash_from_hex(&record.prev) {
        Ok(prev) => prev,
        Err(_) => return false,
    };
    match chain_hash(&prev, &record.event) {
        Ok(actual) => record.hash == hash_hex(&actual),
        Err(_) => false,
    }
}

#[derive(Debug)]
pub struct JournalWriter {
    dir: PathBuf,
    session: String,
    seq: u64,
    prev: [u8; 32],
    segment_index: u32,
    segment_events: u64,
    writer: BufWriter<File>,
    max_segment_bytes: u64,
}

impl JournalWriter {
    /// Creates a fresh journal directory for one session.
    pub fn create(dir: &Path, session: &str) -> io::Result<Self> {
        Self::create_with_segment_limit(dir, session, DEFAULT_MAX_SEGMENT_BYTES)
    }

    pub fn create_with_segment_limit(
        dir: &Path,
        session: &str,
        max_segment_bytes: u64,
    ) -> io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(segment_path(dir, 0))?;
        Ok(Self {
            dir: dir.to_path_buf(),
            session: session.to_string(),
            seq: 0,
            prev: GENESIS_HASH,
            segment_index: 0,
            segment_events: 0,
            writer: BufWriter::new(file),
            max_segment_bytes,
        })
    }

    /// Reopens a journal in the exact recovered chain state. Called only by
    /// recovery::open — never directly by callers.
    pub(crate) fn resume(
        dir: PathBuf,
        session: String,
        seq: u64,
        prev: [u8; 32],
        segment_index: u32,
        segment_events: u64,
        max_segment_bytes: u64,
    ) -> io::Result<Self> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(segment_path(&dir, segment_index))?;
        Ok(Self {
            dir,
            session,
            seq,
            prev,
            segment_index,
            segment_events,
            writer: BufWriter::new(file),
            max_segment_bytes,
        })
    }

    pub fn session(&self) -> &str {
        &self.session
    }

    /// Appends one event and returns its persisted record.
    /// NOTE: this flushes the BufWriter but does NOT fsync; fsync happens only
    /// at commit boundaries (call `commit_boundary`). Crash-correct by design.
    pub fn append(&mut self, kind: EventKind, cmd: Option<String>) -> io::Result<Record> {
        let event = Event {
            v: SCHEMA_VERSION,
            seq: self.seq + 1,
            id: new_event_id(),
            ts: now_ms(),
            session: self.session.clone(),
            cmd,
            kind,
        };
        let hash = chain_hash(&self.prev, &event).map_err(io::Error::other)?;
        let record = Record {
            event,
            prev: hash_hex(&self.prev),
            hash: hash_hex(&hash),
        };
        let mut line = serde_json::to_vec(&record).map_err(io::Error::other)?;
        line.push(b'\n');
        self.writer.write_all(&line)?;
        self.writer.flush()?;
        self.seq = record.event.seq;
        self.prev = hash;
        self.segment_events += 1;
        if self.writer.get_ref().metadata()?.len() >= self.max_segment_bytes {
            self.rotate()?;
        }
        Ok(record)
    }

    /// Durable boundary: everything appended so far is on stable storage.
    pub fn commit_boundary(&self) -> io::Result<()> {
        self.writer.get_ref().sync_data()
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn rotate(&mut self) -> io::Result<()> {
        // Seal the current segment with a terminal record, then open the next.
        self.writer.flush()?;
        let seal = Event {
            v: SCHEMA_VERSION,
            seq: self.seq + 1,
            id: new_event_id(),
            ts: now_ms(),
            session: self.session.clone(),
            cmd: None,
            kind: EventKind::SegmentSeal {
                sealed_events: self.segment_events,
                final_hash: hash_hex(&self.prev),
            },
        };
        let hash = chain_hash(&self.prev, &seal).map_err(io::Error::other)?;
        let record = Record {
            event: seal,
            prev: hash_hex(&self.prev),
            hash: hash_hex(&hash),
        };
        let mut line = serde_json::to_vec(&record).map_err(io::Error::other)?;
        line.push(b'\n');
        self.writer.write_all(&line)?;
        self.writer.flush()?;
        self.writer.get_ref().sync_data()?;
        self.seq = record.event.seq;
        self.prev = hash;
        self.segment_index += 1;
        self.segment_events = 0;
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(segment_path(&self.dir, self.segment_index))?;
        self.writer = BufWriter::new(file);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::hash_hex;

    fn dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ultracode-jtest-{name}-{}", std::process::id()))
    }

    #[test]
    fn appended_events_form_a_verifiable_chain() {
        let dir = dir("chain");
        let _ = std::fs::remove_dir_all(&dir);
        let mut journal = JournalWriter::create(&dir, "ses_1").unwrap();
        let r1 = journal
            .append(
                EventKind::SessionStarted {
                    client: "test".into(),
                    client_version: "0".into(),
                },
                None,
            )
            .unwrap();
        let r2 = journal
            .append(EventKind::TurnStarted { turn: 1 }, Some("cmd_a".into()))
            .unwrap();
        assert_eq!(r1.prev, hash_hex(&GENESIS_HASH));
        assert_eq!(r2.prev, r1.hash);
        assert_eq!(r2.event.seq, 2);
        assert!(verify_record(&r1) && verify_record(&r2));
        journal.commit_boundary().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_line_on_disk_parses_and_verifies() {
        let dir = dir("disk");
        let _ = std::fs::remove_dir_all(&dir);
        let mut journal = JournalWriter::create(&dir, "ses_1").unwrap();
        for turn in 1..=3 {
            journal
                .append(EventKind::TurnStarted { turn }, None)
                .unwrap();
        }
        journal.commit_boundary().unwrap();
        let content = std::fs::read_to_string(segment_path(&dir, 0)).unwrap();
        let lines: Vec<Record> = content
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 3);
        for line in &lines {
            assert!(verify_record(line));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn small_segment_limit_rotates_with_a_seal() {
        let dir = dir("rotate");
        let _ = std::fs::remove_dir_all(&dir);
        let mut journal = JournalWriter::create_with_segment_limit(&dir, "ses_1", 256).unwrap();
        for i in 0..6 {
            journal
                .append(
                    EventKind::ProviderAttemptCompleted {
                        attempt: i,
                        finish_reason: "stop".into(),
                        usage: None,
                    },
                    None,
                )
                .unwrap();
        }
        journal.commit_boundary().unwrap();
        let first = std::fs::read_to_string(segment_path(&dir, 0)).unwrap();
        let seal = first.lines().last().unwrap();
        let seal_record: Record = serde_json::from_str(seal).unwrap();
        match seal_record.event.kind {
            EventKind::SegmentSeal { sealed_events, .. } => assert!(sealed_events >= 1),
            other => panic!("last line must be a segment seal, got {other:?}"),
        }
        assert!(verify_record(&seal_record));
        assert!(segment_path(&dir, 1).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
