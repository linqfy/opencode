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
    pub deleted_at: Option<u64>,
    pub edited_by: Option<String>,
    pub edited_at: Option<u64>,
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

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TaskRecord {
    pub root_id: String,
    pub task_id: String,
    pub parent_task_id: Option<String>,
    pub depth: u8,
    pub state_changing: bool,
    pub budget: u64,
    pub reserved_parent: u64,
    pub reserved_child_pool: u64,
    pub reserved_synthesis: u64,
    pub budget_used: u64,
    pub budget_reclaimed: u64,
    pub state: String,
    pub terminal: Option<TaskTerminal>,
    pub dependencies: Vec<String>,
    pub worktree_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TaskTerminal {
    pub state: String,
    pub reason: Option<String>,
    pub cancellation_observed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TaskGraphEdge {
    pub task_id: String,
    pub dependency_task_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TaskGraphPage {
    pub tasks: Vec<TaskRecord>,
    pub edges: Vec<TaskGraphEdge>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ApprovalRecord {
    pub approval_id: String,
    pub session_id: String,
    pub reply: String,
    pub decision: String,
    pub profile: Option<String>,
    pub profile_version: Option<String>,
    pub grant_scope: Option<String>,
    pub grant_resources: Vec<String>,
    pub expires_at: Option<u64>,
    pub agent: Option<String>,
    pub turn: Option<String>,
    pub recorded_at: u64,
    pub workspace_directory: Option<String>,
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MailboxMessage {
    pub root_id: String,
    pub message_id: String,
    pub sender_task_id: String,
    pub recipient_task_id: String,
    pub sequence: u64,
    pub summary: String,
    pub artifact_ids: Vec<String>,
    pub changed_paths: Vec<String>,
    pub test_summary: Option<String>,
    pub blocked_reason: Option<String>,
    pub acknowledged: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TaskDeliverable {
    pub root_id: String,
    pub task_id: String,
    pub status: String,
    pub summary: String,
    pub artifact_ids: Vec<String>,
    pub changed_paths: Vec<String>,
    pub test_summary: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TaskDeliverablePage {
    pub items: Vec<TaskDeliverable>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct TaskPageCursor {
    root_id: String,
    task_id: String,
}

#[derive(Debug, Serialize)]
struct ApprovalPageCursor<'a> {
    workspace_directory: &'a str,
    project_id: Option<&'a str>,
    recorded_at: u64,
    approval_id: &'a str,
}

#[derive(Debug, Deserialize)]
struct ApprovalPageCursorOwned {
    workspace_directory: String,
    project_id: Option<String>,
    recorded_at: u64,
    approval_id: String,
}

fn terminal_details(
    state: String,
    reason: Option<String>,
    cancellation_observed: bool,
) -> Option<TaskTerminal> {
    matches!(
        state.as_str(),
        "completed" | "failed" | "cancelled" | "budget_exhausted"
    )
    .then_some(TaskTerminal {
        state,
        reason,
        cancellation_observed,
    })
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
        let legacy_tasks = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")?
            .exists([])?
            && !conn
                .prepare("PRAGMA table_info(tasks)")?
                .query_map([], |row| {
                    Ok((row.get::<_, String>(1)?, row.get::<_, u8>(5)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
                .iter()
                .any(|(name, key)| name == "root_id" && *key == 1);
        if legacy_tasks {
            conn.execute_batch("DROP TABLE task_dependencies; DROP TABLE worktree_leases; DROP TABLE mailbox_messages; DROP TABLE task_deliverables; DROP TABLE tasks;")?;
        }
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
                  usage_count INTEGER NOT NULL DEFAULT 0, last_usage INTEGER,
                  deleted_at INTEGER, edited_by TEXT, edited_at INTEGER
              );
               CREATE TABLE IF NOT EXISTS memory_jobs (
                   request_id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL, failure_reason TEXT
               );
               CREATE TABLE IF NOT EXISTS memory_consolidations (
                   memory_id TEXT PRIMARY KEY, summary TEXT NOT NULL, memory TEXT NOT NULL,
                    source_thread_ids TEXT NOT NULL, generated_at INTEGER NOT NULL
              );
              CREATE TABLE IF NOT EXISTS tasks (
                   root_id TEXT NOT NULL, task_id TEXT NOT NULL, parent_task_id TEXT,
                  depth INTEGER NOT NULL, state_changing INTEGER NOT NULL, budget INTEGER NOT NULL,
                  reserved_parent INTEGER NOT NULL DEFAULT 0, reserved_child_pool INTEGER NOT NULL DEFAULT 0,
                   reserved_synthesis INTEGER NOT NULL DEFAULT 0, budget_used INTEGER NOT NULL DEFAULT 0, budget_reclaimed INTEGER NOT NULL DEFAULT 0,
                   state TEXT NOT NULL, cancellation_reason TEXT, cancellation_observed INTEGER NOT NULL DEFAULT 0,
                   PRIMARY KEY(root_id, task_id)
              );
               CREATE INDEX IF NOT EXISTS idx_tasks_root ON tasks(root_id, task_id);
               CREATE TABLE IF NOT EXISTS task_roots (
                   root_id TEXT PRIMARY KEY, workspace_directory TEXT NOT NULL
               );
              CREATE TABLE IF NOT EXISTS task_dependencies (
                  root_id TEXT NOT NULL, task_id TEXT NOT NULL, dependency_task_id TEXT NOT NULL,
                  PRIMARY KEY(root_id, task_id, dependency_task_id)
              );
              CREATE TABLE IF NOT EXISTS worktree_leases (
                  root_id TEXT NOT NULL, worktree_id TEXT NOT NULL, task_id TEXT NOT NULL,
                  PRIMARY KEY(root_id, worktree_id)
              );
               CREATE TABLE IF NOT EXISTS mailbox_messages (
                    root_id TEXT NOT NULL, message_id TEXT NOT NULL, sender_task_id TEXT NOT NULL,
                   recipient_task_id TEXT NOT NULL, sequence INTEGER NOT NULL, summary TEXT NOT NULL, artifact_ids TEXT NOT NULL,
                   changed_paths TEXT NOT NULL, test_summary TEXT, blocked_reason TEXT,
                    acknowledged INTEGER NOT NULL DEFAULT 0,
                   PRIMARY KEY(root_id, message_id), UNIQUE(root_id, recipient_task_id, sequence)
              );
              CREATE INDEX IF NOT EXISTS idx_mailbox_root_recipient_sequence ON mailbox_messages(root_id, recipient_task_id, sequence, message_id);
               CREATE TABLE IF NOT EXISTS task_deliverables (
                   root_id TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL,
                   artifact_ids TEXT NOT NULL, changed_paths TEXT NOT NULL, test_summary TEXT,
                    PRIMARY KEY(root_id, task_id)
               );
               CREATE TABLE IF NOT EXISTS approval_history (
                   approval_id TEXT NOT NULL, session_id TEXT NOT NULL, reply TEXT NOT NULL, decision TEXT NOT NULL,
                   profile TEXT, profile_version TEXT, grant_scope TEXT, grant_resources TEXT NOT NULL,
                   expires_at INTEGER, agent TEXT, turn TEXT, recorded_at INTEGER NOT NULL,
                   workspace_directory TEXT, project_id TEXT,
                   PRIMARY KEY(approval_id, workspace_directory, project_id)
               );
               CREATE INDEX IF NOT EXISTS idx_approval_history_scope_time ON approval_history(grant_scope, recorded_at DESC, approval_id ASC);
               CREATE TABLE IF NOT EXISTS approval_profiles (
                   profile TEXT NOT NULL, version TEXT NOT NULL, rules TEXT NOT NULL, sandbox_profile TEXT, recorded_at INTEGER NOT NULL,
                   PRIMARY KEY(profile, version)
               );
               CREATE TABLE IF NOT EXISTS approval_grants (
                   grant_id TEXT PRIMARY KEY, scope TEXT NOT NULL, action TEXT NOT NULL, resources TEXT NOT NULL,
                   session_id TEXT, expires_at INTEGER, recorded_at INTEGER NOT NULL
               );",
        )?;
        let approval_columns = {
            let mut statement = conn.prepare("PRAGMA table_info(approval_history)")?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        if !approval_columns
            .iter()
            .any(|column| column == "workspace_directory")
        {
            conn.execute_batch(
                "DROP INDEX IF EXISTS idx_approval_history_scope_time;
                 ALTER TABLE approval_history RENAME TO approval_history_legacy;
                 CREATE TABLE approval_history (
                     approval_id TEXT NOT NULL, session_id TEXT NOT NULL, reply TEXT NOT NULL, decision TEXT NOT NULL,
                     profile TEXT, profile_version TEXT, grant_scope TEXT, grant_resources TEXT NOT NULL,
                     expires_at INTEGER, agent TEXT, turn TEXT, recorded_at INTEGER NOT NULL,
                     workspace_directory TEXT, project_id TEXT,
                     PRIMARY KEY(approval_id, workspace_directory, project_id)
                 );
                 INSERT INTO approval_history
                     (approval_id, session_id, reply, decision, profile, profile_version, grant_scope, grant_resources,
                      expires_at, agent, turn, recorded_at, workspace_directory, project_id)
                 SELECT approval_id, session_id, reply, decision, profile, profile_version, grant_scope, grant_resources,
                        expires_at, agent, turn, recorded_at, NULL, NULL
                 FROM approval_history_legacy;
                 DROP TABLE approval_history_legacy;"
            )?;
        }
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_approval_history_scope_time
             ON approval_history(workspace_directory, project_id, recorded_at DESC, approval_id ASC);"
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
        let memory_record_columns = {
            let mut statement = conn.prepare("PRAGMA table_info(memory_records)")?;
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?;
            columns
        };
        for (column, definition) in [
            ("deleted_at", "INTEGER"),
            ("edited_by", "TEXT"),
            ("edited_at", "INTEGER"),
        ] {
            if !memory_record_columns.iter().any(|existing| existing == column) {
                conn.execute(
                    &format!("ALTER TABLE memory_records ADD COLUMN {column} {definition}"),
                    [],
                )?;
            }
        }
        let mailbox_columns = {
            let mut statement = conn.prepare("PRAGMA table_info(mailbox_messages)")?;
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?;
            columns
        };
        for (column, definition) in [
            ("summary", "TEXT NOT NULL DEFAULT ''"),
            ("changed_paths", "TEXT NOT NULL DEFAULT '[]'"),
            ("test_summary", "TEXT"),
            ("blocked_reason", "TEXT"),
        ] {
            if !mailbox_columns.iter().any(|existing| existing == column) {
                conn.execute(
                    &format!("ALTER TABLE mailbox_messages ADD COLUMN {column} {definition}"),
                    [],
                )?;
            }
        }
        let task_columns = {
            let mut statement = conn.prepare("PRAGMA table_info(tasks)")?;
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?;
            columns
        };
        for column in [
            "reserved_parent",
            "reserved_child_pool",
            "reserved_synthesis",
            "budget_used",
            "budget_reclaimed",
        ] {
            if !task_columns.iter().any(|existing| existing == column) {
                conn.execute(
                    &format!("ALTER TABLE tasks ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0"),
                    [],
                )?;
            }
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
            EventKind::MemoryRecordPatched {
                thread_id,
                raw_memory,
                rollout_summary,
                rollout_slug,
                edited_by,
                edited_at,
            } => {
                self.conn.execute(
                    "UPDATE memory_records SET raw_memory = COALESCE(?2, raw_memory),
                     rollout_summary = COALESCE(?3, rollout_summary),
                     rollout_slug = COALESCE(?4, rollout_slug),
                     edited_by = ?5, edited_at = ?6
                     WHERE thread_id = ?1 AND deleted_at IS NULL",
                    params![thread_id, raw_memory, rollout_summary, rollout_slug, edited_by, edited_at],
                )?;
            }
            EventKind::MemoryRecordDeleted { thread_id, deleted_at } => {
                self.conn.execute(
                    "UPDATE memory_records SET deleted_at = ?2 WHERE thread_id = ?1 AND deleted_at IS NULL",
                    params![thread_id, deleted_at],
                )?;
            }
            EventKind::TaskSpawned {
                root_id,
                task_id,
                parent_task_id,
                depth,
                state_changing,
                dependencies,
                budget,
                workspace_directory,
            } => {
                if parent_task_id.is_none() {
                    if let Some(workspace_directory) = workspace_directory {
                        self.conn.execute(
                            "INSERT INTO task_roots (root_id, workspace_directory) VALUES (?1, ?2) ON CONFLICT(root_id) DO NOTHING",
                            params![root_id, workspace_directory],
                        )?;
                    }
                }
                self.conn.execute(
                    "INSERT INTO tasks (task_id, root_id, parent_task_id, depth, state_changing, budget, state) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending')",
                    params![task_id, root_id, parent_task_id, depth, state_changing, budget],
                )?;
                for dependency in dependencies {
                    self.conn.execute(
                        "INSERT INTO task_dependencies (root_id, task_id, dependency_task_id) VALUES (?1, ?2, ?3)",
                        params![root_id, task_id, dependency],
                    )?;
                }
            }
            EventKind::ApprovalFinalized {
                approval_id,
                session_id,
                reply,
                decision,
                profile,
                profile_version,
                grant_scope,
                grant_resources,
                expires_at,
                agent,
                turn,
                recorded_at,
                workspace_directory,
                project_id,
            } => {
                self.conn.execute(
                    "INSERT INTO approval_history (approval_id, session_id, reply, decision, profile, profile_version, grant_scope, grant_resources, expires_at, agent, turn, recorded_at, workspace_directory, project_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                    params![approval_id, session_id, reply, decision, profile, profile_version, grant_scope, serde_json::to_string(grant_resources).map_err(|_| rusqlite::Error::InvalidParameterName("grant resources".into()))?, expires_at, agent, turn, recorded_at, workspace_directory, project_id],
                )?;
            }
            EventKind::ApprovalProfileUpdated {
                profile,
                version,
                rules,
                sandbox_profile,
                recorded_at,
            } => {
                self.conn.execute(
                    "INSERT INTO approval_profiles (profile, version, rules, sandbox_profile, recorded_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(profile, version) DO NOTHING",
                    params![profile, version, serde_json::to_string(rules).map_err(|_| rusqlite::Error::InvalidParameterName("profile rules".into()))?, sandbox_profile, recorded_at],
                )?;
            }
            EventKind::ApprovalGrantUpdated {
                grant_id,
                scope,
                action,
                resources,
                session_id,
                expires_at,
                recorded_at,
            } => {
                self.conn.execute(
                    "INSERT INTO approval_grants (grant_id, scope, action, resources, session_id, expires_at, recorded_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(grant_id) DO NOTHING",
                    params![grant_id, scope, action, serde_json::to_string(resources).map_err(|_| rusqlite::Error::InvalidParameterName("grant resources".into()))?, session_id, expires_at, recorded_at],
                )?;
            }
            EventKind::TaskStateChanged {
                root_id,
                task_id,
                state,
                reason,
            } => {
                self.conn.execute(
                    "UPDATE tasks SET state = ?3, cancellation_reason = COALESCE(?4, cancellation_reason) WHERE root_id = ?1 AND task_id = ?2",
                    params![root_id, task_id, state, reason],
                )?;
            }
            EventKind::TaskBudgetReserved {
                root_id,
                task_id,
                parent,
                child_pool,
                synthesis,
            } => {
                self.conn.execute(
                    "UPDATE tasks SET reserved_parent = ?3, reserved_child_pool = ?4, reserved_synthesis = ?5 WHERE root_id = ?1 AND task_id = ?2",
                    params![root_id, task_id, parent, child_pool, synthesis],
                )?;
            }
            EventKind::TaskBudgetUsed {
                root_id,
                task_id,
                amount,
                ..
            } => {
                self.conn.execute(
                    "UPDATE tasks SET budget_used = budget_used + ?3 WHERE root_id = ?1 AND task_id = ?2",
                    params![root_id, task_id, amount],
                )?;
            }
            EventKind::TaskBudgetReclaimed {
                root_id,
                task_id,
                amount,
                ..
            } => {
                self.conn.execute(
                    "UPDATE tasks SET budget_reclaimed = budget_reclaimed + ?3 WHERE root_id = ?1 AND task_id = ?2",
                    params![root_id, task_id, amount],
                )?;
            }
            EventKind::WorktreeLeased {
                root_id,
                task_id,
                worktree_id,
            } => {
                self.conn.execute("INSERT INTO worktree_leases (root_id, worktree_id, task_id) VALUES (?1, ?2, ?3)", params![root_id, worktree_id, task_id])?;
            }
            EventKind::WorktreeReleased {
                root_id,
                task_id,
                worktree_id,
            } => {
                self.conn.execute("DELETE FROM worktree_leases WHERE root_id = ?1 AND worktree_id = ?2 AND task_id = ?3", params![root_id, worktree_id, task_id])?;
            }
            EventKind::MailboxMessageSent {
                root_id,
                message_id,
                sender_task_id,
                recipient_task_id,
                sequence,
                summary,
                artifact_ids,
                changed_paths,
                test_summary,
                blocked_reason,
            } => {
                self.conn.execute("INSERT INTO mailbox_messages (message_id, root_id, sender_task_id, recipient_task_id, sequence, summary, artifact_ids, changed_paths, test_summary, blocked_reason) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)", params![message_id, root_id, sender_task_id, recipient_task_id, sequence, summary, serde_json::to_string(artifact_ids).map_err(|_| rusqlite::Error::InvalidParameterName("mailbox artifacts".into()))?, serde_json::to_string(changed_paths).map_err(|_| rusqlite::Error::InvalidParameterName("mailbox paths".into()))?, test_summary, blocked_reason])?;
            }
            EventKind::MailboxMessageAcknowledged {
                root_id,
                message_id,
                recipient_task_id,
            } => {
                self.conn.execute("UPDATE mailbox_messages SET acknowledged = 1 WHERE root_id = ?1 AND message_id = ?2 AND recipient_task_id = ?3", params![root_id, message_id, recipient_task_id])?;
            }
            EventKind::TaskCancellationRequested {
                root_id,
                task_id,
                reason,
            } => {
                self.conn.execute(
                    "UPDATE tasks SET state = 'cancelled', cancellation_reason = ?3 WHERE root_id = ?1 AND task_id = ?2",
                    params![root_id, task_id, reason],
                )?;
            }
            EventKind::TaskCancellationObserved { root_id, task_id } => {
                self.conn.execute("UPDATE tasks SET cancellation_observed = 1 WHERE root_id = ?1 AND task_id = ?2", params![root_id, task_id])?;
            }
            EventKind::TaskDeliverableCommitted {
                root_id,
                task_id,
                status,
                summary,
                artifact_ids,
                changed_paths,
                test_summary,
            } => {
                self.conn.execute("INSERT INTO task_deliverables (task_id, root_id, status, summary, artifact_ids, changed_paths, test_summary) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)", params![task_id, root_id, status, summary, serde_json::to_string(artifact_ids).map_err(|_| rusqlite::Error::InvalidParameterName("deliverable artifacts".into()))?, serde_json::to_string(changed_paths).map_err(|_| rusqlite::Error::InvalidParameterName("deliverable paths".into()))?, test_summary])?;
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
                "DELETE FROM events_index; DELETE FROM memory_records; DELETE FROM memory_jobs; DELETE FROM memory_consolidations; DELETE FROM task_dependencies; DELETE FROM worktree_leases; DELETE FROM mailbox_messages; DELETE FROM task_deliverables; DELETE FROM task_roots; DELETE FROM tasks; DELETE FROM approval_history; DELETE FROM approval_profiles; DELETE FROM approval_grants;",
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

    const MEMORY_RECORD_COLUMNS: &str = "thread_id, source_session, source_turn, source_end_seq, transcript_artifact_id, extractor_version, source_updated_at, raw_memory, rollout_summary, rollout_slug, cwd, git_branch, generated_at, usage_count, last_usage, deleted_at, edited_by, edited_at";

    fn memory_record_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryRecord> {
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
            deleted_at: row.get(15)?,
            edited_by: row.get(16)?,
            edited_at: row.get(17)?,
        })
    }

    pub fn list_memory_records(&self, limit: u64) -> Result<Vec<MemoryRecord>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {} FROM memory_records WHERE deleted_at IS NULL ORDER BY usage_count DESC, last_usage DESC, source_updated_at DESC, thread_id ASC LIMIT ?1",
            Self::MEMORY_RECORD_COLUMNS
        ))?;
        let rows = stmt.query_map(params![limit.min(200)], Self::memory_record_from_row)?;
        rows.collect()
    }

    pub fn get_memory_record(
        &self,
        thread_id: &str,
    ) -> Result<Option<MemoryRecord>, rusqlite::Error> {
        self.conn
            .query_row(
                &format!(
                    "SELECT {} FROM memory_records WHERE thread_id = ?1 AND deleted_at IS NULL",
                    Self::MEMORY_RECORD_COLUMNS
                ),
                params![thread_id],
                Self::memory_record_from_row,
            )
            .optional()
    }

    pub fn memory_record_exists(&self, thread_id: &str) -> Result<bool, rusqlite::Error> {
        self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM memory_records WHERE thread_id = ?1 AND deleted_at IS NULL)",
            params![thread_id],
            |row| row.get(0),
        )
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
                (request_id, Some("memory-extraction-requested"))
            }
            EventKind::MemoryConsolidated { request_id, .. } => {
                (request_id, Some("memory-consolidation-requested"))
            }
            EventKind::MemoryJobFailed { request_id, .. } => (request_id, None),
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
        if let Some(expected_kind) = expected_kind {
            if actual_kind != expected_kind {
                return Err(format!("memory request has wrong kind: {request_id}"));
            }
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

    pub fn task_exists(&self, root_id: &str, task_id: &str) -> Result<bool, rusqlite::Error> {
        self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE root_id = ?1 AND task_id = ?2)",
            params![root_id, task_id],
            |row| row.get(0),
        )
    }

    pub fn task_root(&self, task_id: &str) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT root_id FROM tasks WHERE task_id = ?1",
                params![task_id],
                |row| row.get(0),
            )
            .optional()
    }

    pub fn task_state(
        &self,
        root_id: &str,
        task_id: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT state FROM tasks WHERE root_id = ?1 AND task_id = ?2",
                params![root_id, task_id],
                |row| row.get(0),
            )
            .optional()
    }

    pub fn child_count(&self, root_id: &str, task_id: &str) -> Result<u64, rusqlite::Error> {
        self.conn.query_row(
            "SELECT COUNT(*) FROM tasks WHERE root_id = ?1 AND parent_task_id = ?2",
            params![root_id, task_id],
            |row| row.get(0),
        )
    }

    pub fn worktree_owner(
        &self,
        root_id: &str,
        worktree_id: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT task_id FROM worktree_leases WHERE root_id = ?1 AND worktree_id = ?2",
                params![root_id, worktree_id],
                |row| row.get(0),
            )
            .optional()
    }

    pub fn mailbox_recipient(
        &self,
        root_id: &str,
        message_id: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        self.conn.query_row("SELECT recipient_task_id FROM mailbox_messages WHERE root_id = ?1 AND message_id = ?2", params![root_id, message_id], |row| row.get(0)).optional()
    }

    pub fn mailbox_exists(&self, message_id: &str) -> Result<bool, rusqlite::Error> {
        self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM mailbox_messages WHERE message_id = ?1)",
            params![message_id],
            |row| row.get(0),
        )
    }

    pub fn list_tasks(
        &self,
        root_id: &str,
        limit: u64,
    ) -> Result<Vec<TaskRecord>, rusqlite::Error> {
        let mut stmt = self.conn.prepare("SELECT tasks.root_id, tasks.task_id, tasks.parent_task_id, tasks.depth, tasks.state_changing, tasks.budget, tasks.reserved_parent, tasks.reserved_child_pool, tasks.reserved_synthesis, tasks.budget_used, tasks.budget_reclaimed, tasks.state, tasks.cancellation_reason, tasks.cancellation_observed, worktree_leases.worktree_id FROM tasks LEFT JOIN worktree_leases ON worktree_leases.root_id = tasks.root_id AND worktree_leases.task_id = tasks.task_id WHERE tasks.root_id = ?1 ORDER BY tasks.task_id ASC LIMIT ?2")?;
        let rows = stmt.query_map(params![root_id, limit.min(200)], |row| {
            Ok(TaskRecord {
                root_id: row.get(0)?,
                task_id: row.get(1)?,
                parent_task_id: row.get(2)?,
                depth: row.get(3)?,
                state_changing: row.get(4)?,
                budget: row.get(5)?,
                reserved_parent: row.get(6)?,
                reserved_child_pool: row.get(7)?,
                reserved_synthesis: row.get(8)?,
                budget_used: row.get(9)?,
                budget_reclaimed: row.get(10)?,
                state: row.get(11)?,
                terminal: terminal_details(row.get(11)?, row.get(12)?, row.get(13)?),
                dependencies: Vec::new(),
                worktree_id: row.get(14)?,
            })
        })?;
        let mut tasks = rows.collect::<Result<Vec<_>, _>>()?;
        for task in &mut tasks {
            let mut dependencies = self.conn.prepare("SELECT dependency_task_id FROM task_dependencies WHERE root_id = ?1 AND task_id = ?2 ORDER BY dependency_task_id ASC")?;
            task.dependencies = dependencies
                .query_map(params![root_id, task.task_id], |row| row.get(0))?
                .collect::<Result<Vec<String>, _>>()?;
        }
        Ok(tasks)
    }

    pub fn query_task_graph(
        &self,
        root_id: &str,
        cursor: Option<&str>,
        limit: u64,
    ) -> Result<TaskGraphPage, rusqlite::Error> {
        let limit = limit.min(200);
        let after = cursor
            .map(serde_json::from_str::<TaskPageCursor>)
            .transpose()
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
        if let Some(after) = &after {
            if after.root_id != root_id {
                return Err(rusqlite::Error::InvalidQuery);
            }
        }
        let mut stmt = self.conn.prepare("SELECT tasks.root_id, tasks.task_id, tasks.parent_task_id, tasks.depth, tasks.state_changing, tasks.budget, tasks.reserved_parent, tasks.reserved_child_pool, tasks.reserved_synthesis, tasks.budget_used, tasks.budget_reclaimed, tasks.state, tasks.cancellation_reason, tasks.cancellation_observed, worktree_leases.worktree_id FROM tasks LEFT JOIN worktree_leases ON worktree_leases.root_id = tasks.root_id AND worktree_leases.task_id = tasks.task_id WHERE tasks.root_id = ?1 AND (?2 IS NULL OR tasks.task_id > ?2) ORDER BY tasks.task_id ASC LIMIT ?3")?;
        let rows = stmt.query_map(
            params![
                root_id,
                after.as_ref().map(|value| value.task_id.as_str()),
                limit + 1
            ],
            |row| {
                let state: String = row.get(11)?;
                Ok(TaskRecord {
                    root_id: row.get(0)?,
                    task_id: row.get(1)?,
                    parent_task_id: row.get(2)?,
                    depth: row.get(3)?,
                    state_changing: row.get(4)?,
                    budget: row.get(5)?,
                    reserved_parent: row.get(6)?,
                    reserved_child_pool: row.get(7)?,
                    reserved_synthesis: row.get(8)?,
                    budget_used: row.get(9)?,
                    budget_reclaimed: row.get(10)?,
                    terminal: terminal_details(state.clone(), row.get(12)?, row.get(13)?),
                    state,
                    dependencies: Vec::new(),
                    worktree_id: row.get(14)?,
                })
            },
        )?;
        let mut tasks = rows.collect::<Result<Vec<_>, _>>()?;
        let has_more = tasks.len() > limit as usize;
        if has_more {
            tasks.pop();
        }
        let next_cursor = if has_more {
            tasks.last().map(|task| {
                serde_json::to_string(&TaskPageCursor {
                    root_id: root_id.to_string(),
                    task_id: task.task_id.clone(),
                })
                .expect("task cursor serializes")
            })
        } else {
            None
        };
        let task_ids = tasks
            .iter()
            .map(|task| task.task_id.as_str())
            .collect::<Vec<_>>();
        let mut edges = Vec::new();
        for task_id in task_ids {
            let mut dependencies = self.conn.prepare("SELECT dependency_task_id FROM task_dependencies WHERE root_id = ?1 AND task_id = ?2 ORDER BY dependency_task_id ASC")?;
            edges.extend(
                dependencies
                    .query_map(params![root_id, task_id], |row| {
                        Ok(TaskGraphEdge {
                            task_id: task_id.to_string(),
                            dependency_task_id: row.get(0)?,
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?,
            );
        }
        for task in &mut tasks {
            task.dependencies = edges
                .iter()
                .filter(|edge| edge.task_id == task.task_id)
                .map(|edge| edge.dependency_task_id.clone())
                .collect();
        }
        Ok(TaskGraphPage {
            tasks,
            edges,
            next_cursor,
        })
    }

    pub fn list_mailbox(
        &self,
        root_id: &str,
        recipient_task_id: Option<&str>,
        after_sequence: u64,
        limit: u64,
    ) -> Result<Vec<MailboxMessage>, rusqlite::Error> {
        let sql = if recipient_task_id.is_some() {
            "SELECT root_id, message_id, sender_task_id, recipient_task_id, sequence, summary, artifact_ids, changed_paths, test_summary, blocked_reason, acknowledged FROM mailbox_messages WHERE root_id = ?1 AND recipient_task_id = ?2 AND sequence > ?3 ORDER BY sequence ASC, message_id ASC LIMIT ?4"
        } else {
            "SELECT root_id, message_id, sender_task_id, recipient_task_id, sequence, summary, artifact_ids, changed_paths, test_summary, blocked_reason, acknowledged FROM mailbox_messages WHERE root_id = ?1 AND sequence > ?2 ORDER BY sequence ASC, message_id ASC LIMIT ?3"
        };
        let mut stmt = self.conn.prepare(sql)?;
        let map = |row: &rusqlite::Row<'_>| {
            Ok(MailboxMessage {
                root_id: row.get(0)?,
                message_id: row.get(1)?,
                sender_task_id: row.get(2)?,
                recipient_task_id: row.get(3)?,
                sequence: row.get(4)?,
                summary: row.get(5)?,
                artifact_ids: serde_json::from_str(&row.get::<_, String>(6)?).map_err(|_| {
                    rusqlite::Error::InvalidColumnType(
                        6,
                        "artifact_ids".into(),
                        rusqlite::types::Type::Text,
                    )
                })?,
                changed_paths: serde_json::from_str(&row.get::<_, String>(7)?).map_err(|_| {
                    rusqlite::Error::InvalidColumnType(
                        7,
                        "changed_paths".into(),
                        rusqlite::types::Type::Text,
                    )
                })?,
                test_summary: row.get(8)?,
                blocked_reason: row.get(9)?,
                acknowledged: row.get(10)?,
            })
        };
        let rows = match recipient_task_id {
            Some(recipient) => stmt.query_map(
                params![root_id, recipient, after_sequence, limit.min(200)],
                map,
            )?,
            None => stmt.query_map(params![root_id, after_sequence, limit.min(200)], map)?,
        };
        rows.collect()
    }

    pub fn list_task_deliverables(
        &self,
        root_id: &str,
        limit: u64,
    ) -> Result<Vec<TaskDeliverable>, rusqlite::Error> {
        let mut stmt = self.conn.prepare("SELECT root_id, task_id, status, summary, artifact_ids, changed_paths, test_summary FROM task_deliverables WHERE root_id = ?1 ORDER BY task_id ASC LIMIT ?2")?;
        let rows = stmt.query_map(params![root_id, limit.min(200)], |row| {
            Ok(TaskDeliverable {
                root_id: row.get(0)?,
                task_id: row.get(1)?,
                status: row.get(2)?,
                summary: row.get(3)?,
                artifact_ids: serde_json::from_str(&row.get::<_, String>(4)?).map_err(|_| {
                    rusqlite::Error::InvalidColumnType(
                        4,
                        "artifact_ids".into(),
                        rusqlite::types::Type::Text,
                    )
                })?,
                changed_paths: serde_json::from_str(&row.get::<_, String>(5)?).map_err(|_| {
                    rusqlite::Error::InvalidColumnType(
                        5,
                        "changed_paths".into(),
                        rusqlite::types::Type::Text,
                    )
                })?,
                test_summary: row.get(6)?,
            })
        })?;
        rows.collect()
    }

    pub fn query_task_deliverables(
        &self,
        root_id: &str,
        cursor: Option<&str>,
        limit: u64,
    ) -> Result<TaskDeliverablePage, rusqlite::Error> {
        let limit = limit.min(200);
        let after = cursor
            .map(serde_json::from_str::<TaskPageCursor>)
            .transpose()
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
        if let Some(after) = &after {
            if after.root_id != root_id {
                return Err(rusqlite::Error::InvalidQuery);
            }
        }
        let mut stmt = self.conn.prepare("SELECT root_id, task_id, status, summary, artifact_ids, changed_paths, test_summary FROM task_deliverables WHERE root_id = ?1 AND (?2 IS NULL OR task_id > ?2) ORDER BY task_id ASC LIMIT ?3")?;
        let rows = stmt.query_map(
            params![
                root_id,
                after.as_ref().map(|value| value.task_id.as_str()),
                limit + 1
            ],
            |row| {
                Ok(TaskDeliverable {
                    root_id: row.get(0)?,
                    task_id: row.get(1)?,
                    status: row.get(2)?,
                    summary: row.get(3)?,
                    artifact_ids: serde_json::from_str(&row.get::<_, String>(4)?)
                        .map_err(|_| rusqlite::Error::InvalidQuery)?,
                    changed_paths: serde_json::from_str(&row.get::<_, String>(5)?)
                        .map_err(|_| rusqlite::Error::InvalidQuery)?,
                    test_summary: row.get(6)?,
                })
            },
        )?;
        let mut items = rows.collect::<Result<Vec<_>, _>>()?;
        let has_more = items.len() > limit as usize;
        if has_more {
            items.pop();
        }
        let next_cursor = if has_more {
            items.last().map(|item| {
                serde_json::to_string(&TaskPageCursor {
                    root_id: root_id.to_string(),
                    task_id: item.task_id.clone(),
                })
                .expect("deliverable cursor serializes")
            })
        } else {
            None
        };
        Ok(TaskDeliverablePage { items, next_cursor })
    }

    pub fn list_approval_history(
        &self,
        workspace_directory: &str,
        project_id: Option<&str>,
        cursor: Option<&str>,
        limit: u64,
    ) -> Result<(Vec<ApprovalRecord>, Option<String>), rusqlite::Error> {
        let cursor = cursor
            .map(serde_json::from_str::<ApprovalPageCursorOwned>)
            .transpose()
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
        if let Some(cursor) = &cursor {
            if cursor.workspace_directory != workspace_directory
                || cursor.project_id.as_deref() != project_id
            {
                return Err(rusqlite::Error::InvalidQuery);
            }
        }
        let mut stmt = self.conn.prepare(
            "SELECT approval_id, session_id, reply, decision, profile, profile_version, grant_scope, grant_resources,
                    expires_at, agent, turn, recorded_at, workspace_directory, project_id
             FROM approval_history
             WHERE workspace_directory = ?1 AND project_id IS NOT NULL AND (?2 IS NULL OR project_id = ?2)
               AND (?3 IS NULL OR recorded_at < ?3 OR (recorded_at = ?3 AND approval_id > ?4))
             ORDER BY recorded_at DESC, approval_id ASC, workspace_directory ASC, project_id ASC
             LIMIT ?5"
        )?;
        let map = |row: &rusqlite::Row<'_>| {
            Ok(ApprovalRecord {
                approval_id: row.get(0)?,
                session_id: row.get(1)?,
                reply: row.get(2)?,
                decision: row.get(3)?,
                profile: row.get(4)?,
                profile_version: row.get(5)?,
                grant_scope: row.get(6)?,
                grant_resources: serde_json::from_str(&row.get::<_, String>(7)?).map_err(|_| {
                    rusqlite::Error::InvalidColumnType(
                        7,
                        "grant_resources".into(),
                        rusqlite::types::Type::Text,
                    )
                })?,
                expires_at: row.get(8)?,
                agent: row.get(9)?,
                turn: row.get(10)?,
                recorded_at: row.get(11)?,
                workspace_directory: row.get(12)?,
                project_id: row.get(13)?,
            })
        };
        let rows = stmt.query_map(
            params![
                workspace_directory,
                project_id,
                cursor.as_ref().map(|value| value.recorded_at as i64),
                cursor.as_ref().map(|value| value.approval_id.as_str()),
                limit.min(200) + 1,
            ],
            map,
        )?;
        let mut items = rows.collect::<Result<Vec<_>, _>>()?;
        let next_cursor = if items.len() > limit.min(200) as usize {
            let item = items
                .get(limit.min(200) as usize - 1)
                .expect("approval page has a last item");
            let recorded_at = item.recorded_at;
            let approval_id = item.approval_id.clone();
            items.pop();
            Some(
                serde_json::to_string(&ApprovalPageCursor {
                    workspace_directory,
                    project_id,
                    recorded_at,
                    approval_id: &approval_id,
                })
                .expect("approval cursor serializes"),
            )
        } else {
            None
        };
        Ok((items, next_cursor))
    }

    pub fn root_matches(
        &self,
        root_id: &str,
        workspace_directory: &str,
    ) -> Result<bool, rusqlite::Error> {
        self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM task_roots WHERE root_id = ?1 AND workspace_directory = ?2)",
            params![root_id, workspace_directory],
            |row| row.get(0),
        )
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

    #[test]
    fn memory_delete_tombstones_and_excludes_rows_live_and_after_rebuild() {
        let base = dir("memory-delete");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let mut store = ProjectionStore::open(&base.join("proj.db")).unwrap();
        let mut journal = JournalWriter::create(&base.join("journal"), "ses_1").unwrap();
        for kind in [
            memory_requested("req-thread-d-1"),
            memory_extracted("thread-d", 1, "raw"),
            memory_requested("req-thread-e-1"),
            memory_extracted("thread-e", 1, "raw-e"),
        ] {
            let record = journal.append(kind, None).unwrap();
            store.index_record(&record).unwrap();
        }
        let deleted = journal
            .append(
                EventKind::MemoryRecordDeleted {
                    thread_id: "thread-d".into(),
                    deleted_at: 100,
                },
                None,
            )
            .unwrap();
        store.index_record(&deleted).unwrap();
        let live = store.list_memory_records(200).unwrap();
        assert_eq!(
            live.iter().map(|record| record.thread_id.as_str()).collect::<Vec<_>>(),
            vec!["thread-e"]
        );
        store.rebuild(&base.join("journal"), "ses_1").unwrap();
        let rebuilt = store.list_memory_records(200).unwrap();
        assert_eq!(rebuilt, live, "delete tombstone survives journal replay");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn memory_patch_records_user_provenance_and_rebuild_replays_it() {
        let base = dir("memory-patch");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let mut store = ProjectionStore::open(&base.join("proj.db")).unwrap();
        let mut journal = JournalWriter::create(&base.join("journal"), "ses_1").unwrap();
        for kind in [
            memory_requested("req-thread-d-1"),
            memory_extracted("thread-d", 1, "raw"),
        ] {
            let record = journal.append(kind, None).unwrap();
            store.index_record(&record).unwrap();
        }
        let patched = journal
            .append(
                EventKind::MemoryRecordPatched {
                    thread_id: "thread-d".into(),
                    raw_memory: Some("edited".into()),
                    rollout_summary: None,
                    rollout_slug: None,
                    edited_by: "user".into(),
                    edited_at: 200,
                },
                None,
            )
            .unwrap();
        store.index_record(&patched).unwrap();
        let record = store
            .list_memory_records(200)
            .unwrap()
            .into_iter()
            .find(|record| record.thread_id == "thread-d")
            .unwrap();
        assert_eq!(record.raw_memory, "edited");
        assert_eq!(record.rollout_summary, "summary-raw", "untouched fields survive");
        assert_eq!(record.edited_by.as_deref(), Some("user"));
        assert_eq!(record.edited_at, Some(200));
        store.rebuild(&base.join("journal"), "ses_1").unwrap();
        let rebuilt = store
            .list_memory_records(200)
            .unwrap()
            .into_iter()
            .find(|record| record.thread_id == "thread-d")
            .unwrap();
        assert_eq!(rebuilt.raw_memory, "edited");
        assert_eq!(rebuilt.edited_by.as_deref(), Some("user"));
        assert_eq!(rebuilt.edited_at, Some(200));
        let _ = std::fs::remove_dir_all(&base);
    }
}
