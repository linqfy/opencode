use crate::event::{hash_from_hex, EventKind, Record, SCHEMA_VERSION};
use crate::journal::{segment_path, verify_record, JournalWriter, DEFAULT_MAX_SEGMENT_BYTES};
use std::fmt;
use std::fs::OpenOptions;
use std::io::{self, BufRead, BufReader};
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum RecoveryError {
    Io(io::Error),
    /// A hash-chain or parse failure before the final record. History is
    /// never silently rewritten (spec); operator intervention required.
    CorruptHistory { segment: u32, line: u64, reason: String },
}

impl fmt::Display for RecoveryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RecoveryError::Io(e) => write!(f, "io error: {e}"),
            RecoveryError::CorruptHistory { segment, line, reason } => {
                write!(f, "corrupt journal history at segment {segment} line {line}: {reason}")
            }
        }
    }
}

impl std::error::Error for RecoveryError {}
impl From<io::Error> for RecoveryError {
    fn from(e: io::Error) -> Self {
        RecoveryError::Io(e)
    }
}

#[derive(Debug)]
pub struct OpenedJournal {
    pub writer: JournalWriter,
    /// Raw text of the corrupt final line when a tail truncation happened;
    /// callers log it for diagnosability (spec §16 durability KPIs).
    pub truncated_tail: Option<String>,
    pub idempotency_keys: Vec<(String, u64)>,
}

fn segment_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("segment-") && n.ends_with(".jsonl")))
            .collect(),
        Err(_) => return vec![],
    };
    files.sort();
    files
}

/// Reopens a journal: validates schema, sequence, and hash chain; truncates
/// only a corrupt FINAL record after checksum proof; refuses corrupt history.
pub fn open(dir: &Path, session: &str) -> Result<OpenedJournal, RecoveryError> {
    let files = segment_files(dir);
    if files.is_empty() {
        let writer = JournalWriter::create_with_segment_limit(dir, session, DEFAULT_MAX_SEGMENT_BYTES)?;
        return Ok(OpenedJournal { writer, truncated_tail: None, idempotency_keys: vec![] });
    }

    let mut seq = 0u64;
    let mut prev = crate::event::GENESIS_HASH;
    let mut keys: Vec<(String, u64)> = vec![];
    let mut truncate_at: Option<(PathBuf, u64)> = None;
    let mut truncated_tail: Option<String> = None;

    'outer: for file in &files {
        let segment_index: u32 = file
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_prefix("segment-"))
            .and_then(|n| n.strip_suffix(".jsonl"))
            .and_then(|n| n.parse().ok())
            .ok_or(io::Error::new(io::ErrorKind::InvalidData, "bad segment name"))?;
        let reader = BufReader::new(std::fs::File::open(file)?);
        let mut offset = 0u64;
        let mut line_no = 0u64;
        let is_last_segment = files.last().map(|p| p == file).unwrap_or(false);

        for line in reader.lines() {
            let line = line?;
            line_no += 1;
            let line_len = line.len() as u64 + 1;
            let parsed: Result<Record, _> = serde_json::from_str(&line);
            let valid = match &parsed {
                Ok(record) => {
                    record.event.v == SCHEMA_VERSION
                        && record.event.seq == seq + 1
                        && hash_from_hex(&record.prev).is_ok_and(|p| p == prev)
                        && verify_record(record)
                }
                Err(_) => false,
            };

            if !valid {
                let reason = match &parsed {
                    Ok(record) if record.event.seq != seq + 1 => format!("sequence gap: expected {}, got {}", seq + 1, record.event.seq),
                    Ok(_) => "hash mismatch".to_string(),
                    Err(e) => format!("json parse: {e}"),
                };
                // Truncatable ONLY if this is the final record of the final segment.
                let is_final_record = is_last_segment && {
                    let remaining: io::Result<Vec<String>> = io::BufRead::lines(reader_lines_after(file, offset + line_len)?).collect();
                    remaining.map(|rest| rest.iter().all(|l| l.trim().is_empty())).unwrap_or(false)
                };
                if !is_final_record {
                    return Err(RecoveryError::CorruptHistory { segment: segment_index, line: line_no, reason });
                }
                truncate_at = Some((file.clone(), offset));
                truncated_tail = Some(line.clone());
                break 'outer;
            }

            let record = parsed.map_err(|e| RecoveryError::CorruptHistory { segment: segment_index, line: line_no, reason: e.to_string() })?;
            if let Some(cmd) = &record.event.cmd {
                keys.retain(|(k, _)| k != cmd);
                keys.push((cmd.clone(), record.event.seq));
            }
            prev = hash_from_hex(&record.hash).map_err(|reason| RecoveryError::CorruptHistory { segment: segment_index, line: line_no, reason })?;
            seq = record.event.seq;
            offset += line_len;
        }
    }

    if let Some((file, offset)) = &truncate_at {
        let handle = OpenOptions::new().write(true).open(file)?;
        handle.set_len(*offset)?;
        handle.sync_data()?;
    }

    let last_segment = files.last().unwrap();
    let segment_index: u32 = last_segment
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_prefix("segment-"))
        .and_then(|n| n.strip_suffix(".jsonl"))
        .and_then(|n| n.parse().ok())
        .unwrap_or(0);
    let segment_events = count_lines_excluding_seal(last_segment)?;
    let writer = JournalWriter::resume(
        dir.to_path_buf(),
        session.to_string(),
        seq,
        prev,
        segment_index,
        segment_events,
        DEFAULT_MAX_SEGMENT_BYTES,
    )?;
    Ok(OpenedJournal { writer, truncated_tail, idempotency_keys: keys })
}

fn reader_lines_after(path: &Path, byte_offset: u64) -> io::Result<Box<dyn BufRead>> {
    use std::io::{Cursor, Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(byte_offset))?;
    let mut rest = Vec::new();
    file.read_to_end(&mut rest)?;
    // Cursor owns the bytes, so the returned reader is 'static (no E0515).
    Ok(Box::new(Cursor::new(rest)))
}

fn count_lines_excluding_seal(path: &Path) -> io::Result<u64> {
    let content = std::fs::read_to_string(path)?;
    let mut count = 0u64;
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let record: Record = serde_json::from_str(line).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
        if !matches!(record.event.kind, EventKind::SegmentSeal { .. }) {
            count += 1;
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::EventKind;
    use crate::journal::segment_path;
    use std::io::Write;

    fn dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ultracode-rtest-{name}-{}", std::process::id()))
    }

    fn write_three(dir: &Path) -> JournalWriter {
        let mut j = JournalWriter::create_with_segment_limit(dir, "ses_1", 1 << 20).unwrap();
        j.append(EventKind::SessionStarted { client: "t".into(), client_version: "0".into() }, Some("cmd_a".into())).unwrap();
        j.append(EventKind::TurnStarted { turn: 1 }, Some("cmd_b".into())).unwrap();
        j.append(EventKind::TurnCompleted { turn: 1 }, None).unwrap();
        j.commit_boundary().unwrap();
        j
    }

    #[test]
    fn reopen_continues_the_chain_and_collects_keys() {
        let dir = dir("reopen");
        let _ = std::fs::remove_dir_all(&dir);
        drop(write_three(&dir));
        let opened = open(&dir, "ses_1").unwrap();
        assert_eq!(opened.idempotency_keys, vec![("cmd_a".to_string(), 1), ("cmd_b".to_string(), 2)]);
        let mut writer = opened.writer;
        writer.append(EventKind::TurnAborted { turn: 1, reason: "x".into() }, None).unwrap();
        drop(writer);
        let opened = open(&dir, "ses_1").unwrap();
        let mut writer = opened.writer;
        let next = writer.append(EventKind::TurnStarted { turn: 2 }, None).unwrap();
        assert_eq!(next.event.seq, 5);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_final_record_is_truncated_after_checksum_proof() {
        let dir = dir("tail");
        let _ = std::fs::remove_dir_all(&dir);
        drop(write_three(&dir));
        let path = segment_path(&dir, 0);
        // Corrupt the final line's hash field.
        let content = std::fs::read_to_string(&path).unwrap();
        let mut lines: Vec<String> = content.lines().map(String::from).collect();
        let final_line = lines.last_mut().unwrap();
        let marker = "\"hash\":\"";
        let start = final_line.find(marker).unwrap() + marker.len();
        let replacement = if &final_line[start..start + 2] == "00" { "ff" } else { "00" };
        final_line.replace_range(start..start + 2, replacement);
        let corrupted = lines.join("\n") + "\n";
        let mut f = OpenOptions::new().write(true).truncate(true).open(&path).unwrap();
        f.write_all(corrupted.as_bytes()).unwrap();
        f.sync_data().unwrap();
        drop(f);

        let opened = open(&dir, "ses_1").unwrap();
        let mut writer = opened.writer;
        let next = writer.append(EventKind::TurnStarted { turn: 9 }, None).unwrap();
        assert_eq!(next.event.seq, 3, "truncated to two good events");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_middle_record_refuses_without_rewriting() {
        let dir = dir("middle");
        let _ = std::fs::remove_dir_all(&dir);
        drop(write_three(&dir));
        let path = segment_path(&dir, 0);
        // Corrupt the FIRST line (non-tail).
        let content = std::fs::read_to_string(&path).unwrap();
        let mut lines: Vec<&str> = content.lines().collect();
        lines[0] = "{not json";
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        let before = std::fs::read(&path).unwrap();

        let err = open(&dir, "ses_1").unwrap_err();
        match err {
            RecoveryError::CorruptHistory { line, .. } => assert_eq!(line, 1),
            other => panic!("expected CorruptHistory, got {other:?}"),
        }
        let after = std::fs::read(&path).unwrap();
        assert_eq!(before.len(), after.len(), "history must not be rewritten");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
