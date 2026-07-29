//! One-time importer from an OpenCode SQLite database into the journal.
//! OpenCode message data is carried as opaque raw JSON text (spec §18 Stage 2).

use crate::commit::{CommitLog, CommitOutcome};
use crate::event::EventKind;
use rusqlite::{Connection, OpenFlags};
use std::io;
use std::path::Path;

#[derive(Debug, Default, PartialEq)]
pub struct ImportReport {
    pub sessions_imported: u64,
    pub sessions_skipped: u64,
    pub messages_imported: u64,
    pub errors: Vec<String>,
}

fn source_name(source_db: &Path) -> String {
    source_db
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("opencode.db")
        .to_string()
}

/// Imports all sessions and messages from an OpenCode database into the
/// journal via `commit`. Idempotent: deterministic propose keys mean a re-run
/// skips already-imported rows. In dry-run mode nothing is written.
pub fn import_legacy(
    source_db: &Path,
    commit: &mut CommitLog,
    dry_run: bool,
) -> io::Result<ImportReport> {
    let source = Connection::open_with_flags(source_db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(io::Error::other)?;
    let source_label = source_name(source_db);
    let mut report = ImportReport::default();

    // Read sessions ordered by creation time.
    let mut session_stmt = source
        .prepare("SELECT id, title, directory FROM session ORDER BY time_created ASC, id ASC")
        .map_err(io::Error::other)?;
    let sessions: Vec<(String, String, String)> = session_stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(io::Error::other)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(io::Error::other)?;

    for (session_id, title, directory) in sessions {
        // Count this session's messages.
        let message_count: u64 = source
            .query_row(
                "SELECT COUNT(*) FROM session_message WHERE session_id = ?1",
                rusqlite::params![session_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0) as u64;

        let session_key = format!("legacy-session-{session_id}");

        if dry_run {
            report.sessions_imported += 1;
            report.messages_imported += message_count;
            continue;
        }

        // Import the session header (idempotent by key).
        let session_event = EventKind::LegacySessionImported {
            original_session_id: session_id.clone(),
            title: title.clone(),
            directory: directory.clone(),
            message_count,
            source: source_label.clone(),
        };
        match commit.propose(&session_key, session_event) {
            Ok(CommitOutcome::Committed(_)) => report.sessions_imported += 1,
            Ok(CommitOutcome::Duplicate(_)) => {
                report.sessions_skipped += 1;
                continue; // already imported; its messages are too
            }
            Err(e) => {
                report.errors.push(format!("session {session_id}: {e}"));
                continue;
            }
        }

        // Import each message, ordered by seq.
        let mut message_stmt = match source.prepare(
            "SELECT id, type, seq, data FROM session_message WHERE session_id = ?1 ORDER BY seq ASC",
        ) {
            Ok(stmt) => stmt,
            Err(e) => {
                report.errors.push(format!("session {session_id} messages: {e}"));
                continue;
            }
        };
        let messages: Vec<(String, String, i64, String)> =
            match message_stmt.query_map(rusqlite::params![session_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            }) {
                Ok(rows) => rows.collect::<Result<Vec<_>, _>>().unwrap_or_default(),
                Err(e) => {
                    report
                        .errors
                        .push(format!("session {session_id} message query: {e}"));
                    continue;
                }
            };

        for (message_id, message_type, seq, data) in messages {
            let message_key = format!("legacy-message-{message_id}");
            let message_event = EventKind::LegacyMessageImported {
                original_session_id: session_id.clone(),
                original_message_id: message_id.clone(),
                seq: seq as u64,
                message_type,
                data,
            };
            match commit.propose(&message_key, message_event) {
                Ok(CommitOutcome::Committed(_)) => report.messages_imported += 1,
                Ok(CommitOutcome::Duplicate(_)) => {}
                Err(e) => report.errors.push(format!("message {message_id}: {e}")),
            }
        }
    }

    if !dry_run {
        commit.commit_boundary()?;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::JournalWriter;
    use crate::recovery;
    use std::path::PathBuf;

    const OPENCODE_DDL: &str = "
        CREATE TABLE session (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            title TEXT NOT NULL,
            directory TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL
        );
        CREATE TABLE session_message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            type TEXT NOT NULL,
            seq INTEGER NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
        );
    ";

    fn base(name: &str) -> PathBuf {
        let base =
            std::env::temp_dir().join(format!("ultracode-import-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    fn make_source_db(path: &Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(OPENCODE_DDL).unwrap();
        conn.execute(
            "INSERT INTO session (id, project_id, title, directory, time_created, time_updated) VALUES ('ses_a', 'prj', 'First', '/p/a', 1000, 1000)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session (id, project_id, title, directory, time_created, time_updated) VALUES ('ses_b', 'prj', 'Second', '/p/b', 2000, 2000)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('msg_1', 'ses_a', 'user', 1, 1000, 1000, '{\"text\":\"hi\"}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('msg_2', 'ses_a', 'assistant', 2, 1001, 1001, '{\"content\":[]}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('msg_3', 'ses_b', 'user', 1, 2000, 2000, '{\"text\":\"yo\"}')",
            [],
        )
        .unwrap();
    }

    #[test]
    fn imports_sessions_and_messages() {
        let dir = base("basic");
        let source = dir.join("opencode.db");
        make_source_db(&source);

        let journal = dir.join("journal");
        let mut commit = CommitLog::create(&journal, "legacy").unwrap();
        let report = import_legacy(&source, &mut commit, false).unwrap();

        assert_eq!(report.sessions_imported, 2);
        assert_eq!(report.messages_imported, 3);
        assert!(report.errors.is_empty());

        // The journal now holds 2 session events + 3 message events.
        let opened = recovery::open(&journal, "legacy").unwrap();
        let legacy_events: Vec<_> = opened
            .records
            .iter()
            .filter(|r| {
                matches!(
                    r.event.kind,
                    crate::event::EventKind::LegacySessionImported { .. }
                        | crate::event::EventKind::LegacyMessageImported { .. }
                )
            })
            .collect();
        assert_eq!(legacy_events.len(), 5);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reimport_is_idempotent() {
        let dir = base("idempotent");
        let source = dir.join("opencode.db");
        make_source_db(&source);

        let journal = dir.join("journal");
        let mut commit = CommitLog::create(&journal, "legacy").unwrap();
        let first = import_legacy(&source, &mut commit, false).unwrap();
        assert_eq!(first.sessions_imported, 2);

        let second = import_legacy(&source, &mut commit, false).unwrap();
        assert_eq!(second.sessions_imported, 0);
        assert_eq!(second.sessions_skipped, 2);
        assert_eq!(second.messages_imported, 0);

        // Still only 5 legacy events after the second run.
        let opened = recovery::open(&journal, "legacy").unwrap();
        let legacy_count = opened
            .records
            .iter()
            .filter(|r| {
                matches!(
                    r.event.kind,
                    crate::event::EventKind::LegacySessionImported { .. }
                        | crate::event::EventKind::LegacyMessageImported { .. }
                )
            })
            .count();
        assert_eq!(legacy_count, 5);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dry_run_writes_nothing_but_reports() {
        let dir = base("dryrun");
        let source = dir.join("opencode.db");
        make_source_db(&source);

        let journal = dir.join("journal");
        let mut commit = CommitLog::create(&journal, "legacy").unwrap();
        let report = import_legacy(&source, &mut commit, true).unwrap();
        assert_eq!(report.sessions_imported, 2);
        assert_eq!(report.messages_imported, 3);

        let opened = recovery::open(&journal, "legacy").unwrap();
        assert!(
            opened.records.is_empty(),
            "dry run must not write to the journal"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_source_db_is_an_error_not_a_panic() {
        let dir = base("missing");
        let journal = dir.join("journal");
        let mut commit = CommitLog::create(&journal, "legacy").unwrap();
        let result = import_legacy(&dir.join("nope.db"), &mut commit, false);
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
