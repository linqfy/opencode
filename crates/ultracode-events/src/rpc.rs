//! Newline-delimited JSON-RPC for the event sidecar (spec sections 5 and 11).
//! All wire serialization lives here; committed domain types are not modified.

use crate::artifacts::{ArtifactStore, CredentialClass, Retention};
use crate::commit::{CommitLog, CommitOutcome};
use crate::effect::{self, ReconcileAction};
use crate::event::EventKind;
use crate::projections::{ProjectionStore, TaskDeliverablePage, TaskGraphPage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
pub struct Response {
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ScopedPageRequest {
    root_id: String,
    workspace_directory: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default = "default_page_size")]
    limit: u64,
}

#[derive(Debug, Deserialize)]
struct ApprovalPageRequest {
    workspace_directory: String,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default = "default_page_size")]
    limit: u64,
}

fn default_page_size() -> u64 {
    100
}

fn page_size(limit: u64) -> Result<u64, String> {
    if !(1..=200).contains(&limit) {
        return Err("limit must be between 1 and 200".into());
    }
    Ok(limit)
}

impl Response {
    pub fn ok(id: u64, result: Value) -> Response {
        Response {
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: u64, message: String) -> Response {
        Response {
            id,
            result: None,
            error: Some(message),
        }
    }
}

pub struct SidecarState {
    pub commit: CommitLog,
    pub projections: ProjectionStore,
    pub artifacts: ArtifactStore,
    pub journal_dir: PathBuf,
    pub session: String,
    task_journal: TaskJournal,
}

impl SidecarState {
    /// Opens (resumes) all state idempotently. Works on a fresh directory too.
    pub fn open(
        journal_dir: &Path,
        db_path: &Path,
        artifact_root: &Path,
        session: &str,
    ) -> io::Result<SidecarState> {
        let commit =
            CommitLog::open(journal_dir, session).map_err(|e| io::Error::other(e.to_string()))?;
        let mut projections = ProjectionStore::open(db_path).map_err(io::Error::other)?;
        projections.rebuild(journal_dir, session)?;
        let artifacts = ArtifactStore::open(artifact_root, db_path).map_err(io::Error::other)?;
        let task_journal = task_journal(journal_dir, session).map_err(io::Error::other)?;
        Ok(SidecarState {
            commit,
            projections,
            artifacts,
            journal_dir: journal_dir.to_path_buf(),
            session: session.to_string(),
            task_journal,
        })
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn hex_decode(text: &str) -> Result<Vec<u8>, String> {
    if !text.len().is_multiple_of(2) {
        return Err("hex length must be even".to_string());
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

fn retention_from_str(value: &str) -> Retention {
    Retention::parse(value).unwrap_or(Retention::Workspace)
}

fn credential_from_str(value: &str) -> CredentialClass {
    CredentialClass::parse(value).unwrap_or(CredentialClass::Plain)
}

fn state_name(state: effect::EffectState) -> &'static str {
    match state {
        effect::EffectState::Prepared => "prepared",
        effect::EffectState::Dispatched => "dispatched",
        effect::EffectState::Observed => "observed",
        effect::EffectState::OutcomeUnknown => "outcome-unknown",
    }
}

fn action_name(action: ReconcileAction) -> &'static str {
    match action {
        ReconcileAction::NoAction => "no-action",
        ReconcileAction::Retry => "retry",
        ReconcileAction::QueryExternal => "query-external",
        ReconcileAction::RequireUserDecision => "require-user-decision",
    }
}

pub fn handle_request(state: &mut SidecarState, req: &Request) -> Response {
    match dispatch(state, req) {
        Ok(value) => Response::ok(req.id, value),
        Err(message) => Response::err(req.id, message),
    }
}

fn dispatch(state: &mut SidecarState, req: &Request) -> Result<Value, String> {
    match req.method.as_str() {
        "ping" => Ok(json!({ "ok": true })),

        "propose_commit" => {
            let key = req
                .params
                .get("key")
                .and_then(|v| v.as_str())
                .ok_or("missing key")?;
            let kind: EventKind =
                serde_json::from_value(req.params.get("kind").cloned().ok_or("missing kind")?)
                    .map_err(|e| format!("bad kind: {e}"))?;
            if let Some(record) = state.commit.record_for_key(key) {
                return Ok(
                    json!({ "seq": record.event.seq, "hash": record.hash, "duplicate": true }),
                );
            }
            {
                state.projections.validate_memory_result(&kind)?;
                validate_approval_event(&kind)?;
                validate_task_event_from_journal(&state.task_journal, &kind)?;
            }
            let outcome = state.commit.propose(key, kind).map_err(|e| e.to_string())?;
            let (record, duplicate) = match outcome {
                CommitOutcome::Committed(r) => (r, false),
                CommitOutcome::Duplicate(r) => (r, true),
            };
            if !duplicate {
                apply_task_event(&mut state.task_journal, &record.event.kind)?;
                if state.projections.index_record(&record).is_err() {
                    let _ = state
                        .projections
                        .rebuild(&state.journal_dir.clone(), &state.session);
                }
            }
            Ok(json!({ "seq": record.event.seq, "hash": record.hash, "duplicate": duplicate }))
        }

        "list_events" => {
            let session = req
                .params
                .get("session")
                .and_then(|v| v.as_str())
                .unwrap_or(&state.session);
            let since_seq = req
                .params
                .get("since_seq")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let limit = req
                .params
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(100);
            let events = state
                .projections
                .list_events(session, since_seq, limit)
                .map_err(|e| e.to_string())?;
            let items: Vec<Value> = events
                .iter()
                .map(|e| json!({ "seq": e.seq, "id": e.id, "kind": e.kind, "session": e.session, "ts": e.ts }))
                .collect();
            Ok(json!(items))
        }

        "rebuild_projections" => {
            let session = req
                .params
                .get("session")
                .and_then(|v| v.as_str())
                .unwrap_or(&state.session);
            let count = state
                .projections
                .rebuild(&state.journal_dir.clone(), session)
                .map_err(|e| e.to_string())?;
            Ok(json!({ "count": count }))
        }

        "list_tasks" => {
            let root_id = req
                .params
                .get("root_id")
                .and_then(|v| v.as_str())
                .ok_or("missing root_id")?;
            let workspace_directory = req
                .params
                .get("workspace_directory")
                .and_then(|v| v.as_str())
                .ok_or("missing workspace_directory")?;
            let limit = req
                .params
                .get("limit")
                .map_or(Ok(100), |value| value.as_u64().ok_or("bad limit"))?
                .min(200);
            if !state
                .projections
                .root_matches(root_id, workspace_directory)
                .map_err(|e| e.to_string())?
            {
                return Ok(json!([]));
            }
            serde_json::to_value(
                state
                    .projections
                    .list_tasks(root_id, limit)
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())
        }

        "query_task_graph" => {
            let input: ScopedPageRequest = serde_json::from_value(req.params.clone())
                .map_err(|e| format!("bad task graph request: {e}"))?;
            let limit = page_size(input.limit)?;
            if input.root_id.is_empty() {
                return Err("root_id must not be empty".into());
            }
            if !is_absolute_workspace(&input.workspace_directory) {
                return Err("workspace_directory must be absolute".into());
            }
            if !state
                .projections
                .root_matches(&input.root_id, &input.workspace_directory)
                .map_err(|e| e.to_string())?
            {
                return Ok(json!(TaskGraphPage {
                    tasks: vec![],
                    edges: vec![],
                    next_cursor: None
                }));
            }
            serde_json::to_value(
                state
                    .projections
                    .query_task_graph(&input.root_id, input.cursor.as_deref(), limit)
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())
        }

        "cancel_task" => {
            let root_id = req
                .params
                .get("root_id")
                .and_then(Value::as_str)
                .ok_or("missing root_id")?;
            let task_id = req
                .params
                .get("task_id")
                .and_then(Value::as_str)
                .ok_or("missing task_id")?;
            let workspace_directory = req
                .params
                .get("workspace_directory")
                .and_then(Value::as_str)
                .ok_or("missing workspace_directory")?;
            let reason = req
                .params
                .get("reason")
                .and_then(Value::as_str)
                .ok_or("missing reason")?;
            let key = req
                .params
                .get("idempotency_key")
                .and_then(Value::as_str)
                .ok_or("missing idempotency_key")?;
            if !is_absolute_workspace(workspace_directory) {
                return Err("workspace_directory must be absolute".into());
            }
            if !state
                .projections
                .root_matches(root_id, workspace_directory)
                .map_err(|e| e.to_string())?
            {
                return Err(
                    "task cancellation authorization failed: root workspace mismatch".into(),
                );
            }
            if state.commit.record_for_key(key).is_some() {
                return Ok(json!({ "state": "cancellation_pending" }));
            }
            let kind = EventKind::TaskCancellationRequested {
                root_id: root_id.into(),
                task_id: task_id.into(),
                reason: reason.into(),
            };
            validate_task_event_from_journal(&state.task_journal, &kind)?;
            let outcome = state.commit.propose(key, kind).map_err(|e| e.to_string())?;
            let record = match outcome {
                CommitOutcome::Committed(record) | CommitOutcome::Duplicate(record) => record,
            };
            apply_task_event(&mut state.task_journal, &record.event.kind)?;
            state
                .projections
                .index_record(&record)
                .map_err(|e| e.to_string())?;
            Ok(json!({ "state": "cancellation_pending" }))
        }

        "list_mailbox" => {
            let root_id = req
                .params
                .get("root_id")
                .and_then(|v| v.as_str())
                .ok_or("missing root_id")?;
            let workspace_directory = req
                .params
                .get("workspace_directory")
                .and_then(|v| v.as_str())
                .ok_or("missing workspace_directory")?;
            let recipient_task_id = req
                .params
                .get("recipient_task_id")
                .map(|value| value.as_str().ok_or("bad recipient_task_id"))
                .transpose()?;
            let after_sequence = req
                .params
                .get("after_sequence")
                .map_or(Ok(0), |value| value.as_u64().ok_or("bad after_sequence"))?;
            if recipient_task_id.is_none() && after_sequence != 0 {
                return Err("mailbox cursor requires recipient_task_id".into());
            }
            let limit = req
                .params
                .get("limit")
                .map_or(Ok(100), |value| value.as_u64().ok_or("bad limit"))?
                .min(200);
            if !state
                .projections
                .root_matches(root_id, workspace_directory)
                .map_err(|e| e.to_string())?
            {
                return Ok(json!([]));
            }
            serde_json::to_value(
                state
                    .projections
                    .list_mailbox(root_id, recipient_task_id, after_sequence, limit)
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())
        }

        "list_task_deliverables" => {
            let root_id = req
                .params
                .get("root_id")
                .and_then(|v| v.as_str())
                .ok_or("missing root_id")?;
            let workspace_directory = req
                .params
                .get("workspace_directory")
                .and_then(|v| v.as_str())
                .ok_or("missing workspace_directory")?;
            let limit = req
                .params
                .get("limit")
                .map_or(Ok(100), |value| value.as_u64().ok_or("bad limit"))?
                .min(200);
            if !state
                .projections
                .root_matches(root_id, workspace_directory)
                .map_err(|e| e.to_string())?
            {
                return Ok(json!([]));
            }
            serde_json::to_value(
                state
                    .projections
                    .list_task_deliverables(root_id, limit)
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())
        }

        "query_task_deliverables" => {
            let input: ScopedPageRequest = serde_json::from_value(req.params.clone())
                .map_err(|e| format!("bad deliverables request: {e}"))?;
            let limit = page_size(input.limit)?;
            if input.root_id.is_empty() {
                return Err("root_id must not be empty".into());
            }
            if !is_absolute_workspace(&input.workspace_directory) {
                return Err("workspace_directory must be absolute".into());
            }
            if !state
                .projections
                .root_matches(&input.root_id, &input.workspace_directory)
                .map_err(|e| e.to_string())?
            {
                return Ok(json!(TaskDeliverablePage {
                    items: vec![],
                    next_cursor: None
                }));
            }
            serde_json::to_value(
                state
                    .projections
                    .query_task_deliverables(&input.root_id, input.cursor.as_deref(), limit)
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())
        }

        "list_approval_history" => {
            let input: ApprovalPageRequest = serde_json::from_value(req.params.clone())
                .map_err(|e| format!("bad approval history request: {e}"))?;
            if !is_absolute_workspace(&input.workspace_directory) {
                return Err("workspace_directory must be absolute".into());
            }
            let limit = page_size(input.limit)?;
            let (items, next_cursor) = state
                .projections
                .list_approval_history(
                    &input.workspace_directory,
                    input.project_id.as_deref(),
                    input.cursor.as_deref(),
                    limit,
                )
                .map_err(|e| e.to_string())?;
            Ok(json!({ "items": items, "next_cursor": next_cursor }))
        }

        "list_memory_records" => {
            let limit = match req.params.get("limit") {
                None => 200,
                Some(value) => value.as_u64().ok_or("bad limit")?.min(200),
            };
            let records = state
                .projections
                .list_memory_records(limit)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(records).map_err(|e| e.to_string())
        }

        "list_memory_consolidations" => {
            let limit = match req.params.get("limit") {
                None => 200,
                Some(value) => value.as_u64().ok_or("bad limit")?.min(200),
            };
            let records = state
                .projections
                .list_memory_consolidations(limit)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(records).map_err(|e| e.to_string())
        }

        "claim_memory_job" => match state
            .projections
            .claim_memory_job()
            .map_err(|e| e.to_string())?
        {
            None => Ok(Value::Null),
            Some(job) => serde_json::to_value(job).map_err(|e| e.to_string()),
        },

        "get_memory_record" => {
            let thread_id = req
                .params
                .get("thread_id")
                .and_then(Value::as_str)
                .ok_or("missing thread_id")?;
            let record = state
                .projections
                .get_memory_record(thread_id)
                .map_err(|e| e.to_string())?;
            match record {
                None => Ok(Value::Null),
                Some(record) => serde_json::to_value(record).map_err(|e| e.to_string()),
            }
        }

        "delete_memory_record" => {
            let thread_id = req
                .params
                .get("thread_id")
                .and_then(Value::as_str)
                .ok_or("missing thread_id")?;
            let key = format!("memory-record-deleted:{thread_id}");
            if let Some(record) = state.commit.record_for_key(&key) {
                return Ok(json!({ "seq": record.event.seq, "hash": record.hash, "duplicate": true }));
            }
            if !state
                .projections
                .memory_record_exists(thread_id)
                .map_err(|e| e.to_string())?
            {
                return Err(format!("memory record not found: {thread_id}"));
            }
            propose_memory_mutation(
                state,
                key,
                EventKind::MemoryRecordDeleted {
                    thread_id: thread_id.into(),
                    deleted_at: crate::event::now_ms(),
                },
            )
        }

        "patch_memory_record" => {
            let thread_id = req
                .params
                .get("thread_id")
                .and_then(Value::as_str)
                .ok_or("missing thread_id")?;
            let raw_memory = req.params.get("raw_memory").map(|value| {
                value
                    .as_str()
                    .map(String::from)
                    .ok_or_else(|| "bad raw_memory".to_string())
            });
            let rollout_summary = req.params.get("rollout_summary").map(|value| {
                value
                    .as_str()
                    .map(String::from)
                    .ok_or_else(|| "bad rollout_summary".to_string())
            });
            let rollout_slug = req.params.get("rollout_slug").map(|value| {
                value
                    .as_str()
                    .map(String::from)
                    .ok_or_else(|| "bad rollout_slug".to_string())
            });
            let raw_memory = raw_memory.transpose()?;
            let rollout_summary = rollout_summary.transpose()?;
            let rollout_slug = rollout_slug.transpose()?;
            if raw_memory.is_none() && rollout_summary.is_none() && rollout_slug.is_none() {
                return Err("memory record patch has nothing to patch".into());
            }
            if !state
                .projections
                .memory_record_exists(thread_id)
                .map_err(|e| e.to_string())?
            {
                return Err(format!("memory record not found: {thread_id}"));
            }
            let key = format!(
                "memory-record-patched:{thread_id}:{}",
                crate::event::now_ms()
            );
            propose_memory_mutation(
                state,
                key,
                EventKind::MemoryRecordPatched {
                    thread_id: thread_id.into(),
                    raw_memory,
                    rollout_summary,
                    rollout_slug,
                    edited_by: "user".into(),
                    edited_at: crate::event::now_ms(),
                },
            )
        }

        "put_artifact" => {
            let bytes_hex = req
                .params
                .get("bytes_hex")
                .and_then(|v| v.as_str())
                .ok_or("missing bytes_hex")?;
            let bytes = hex_decode(bytes_hex)?;
            let mime = req
                .params
                .get("mime")
                .and_then(|v| v.as_str())
                .ok_or("missing mime")?;
            let owner_scope = req
                .params
                .get("owner_scope")
                .and_then(|v| v.as_str())
                .ok_or("missing owner_scope")?;
            let retention = retention_from_str(
                req.params
                    .get("retention")
                    .and_then(|v| v.as_str())
                    .unwrap_or("workspace"),
            );
            let credential = credential_from_str(
                req.params
                    .get("credential_class")
                    .and_then(|v| v.as_str())
                    .unwrap_or("plain"),
            );
            let expires_at = req.params.get("expires_at").and_then(|v| v.as_u64());
            let reference = state
                .artifacts
                .put(&bytes, mime, owner_scope, retention, credential, expires_at)
                .map_err(|e| e.to_string())?;
            Ok(json!({
                "artifact_id": reference.artifact_id,
                "mime": reference.mime,
                "byte_length": reference.byte_length,
                "hash": reference.hash,
            }))
        }

        "stat_artifact" => {
            let artifact_id = req
                .params
                .get("artifact_id")
                .and_then(|v| v.as_str())
                .ok_or("missing artifact_id")?;
            let scope = req
                .params
                .get("scope")
                .and_then(|v| v.as_str())
                .ok_or("missing scope")?;
            match state
                .artifacts
                .stat(artifact_id, scope)
                .map_err(|e| e.to_string())?
            {
                None => Ok(Value::Null),
                Some(m) => Ok(json!({
                    "artifact_id": m.artifact_id,
                    "mime": m.mime,
                    "byte_length": m.byte_length,
                    "hash": m.hash,
                    "owner_scope": m.owner_scope,
                    "retention": m.retention.as_str(),
                    "credential_class": m.credential_class.as_str(),
                    "ref_count": m.ref_count,
                    "created_at": m.created_at,
                    "expires_at": m.expires_at,
                })),
            }
        }

        "open_range" => {
            let artifact_id = req
                .params
                .get("artifact_id")
                .and_then(|v| v.as_str())
                .ok_or("missing artifact_id")?;
            let scope = req
                .params
                .get("scope")
                .and_then(|v| v.as_str())
                .ok_or("missing scope")?;
            let start = req
                .params
                .get("start")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let end = req
                .params
                .get("end")
                .and_then(|v| v.as_u64())
                .unwrap_or(u64::MAX);
            let bytes = state
                .artifacts
                .open_range(artifact_id, scope, start, end)
                .map_err(|e| e.to_string())?;
            Ok(json!({ "bytes_hex": hex_encode(&bytes) }))
        }

        "reconcile_effects" => {
            let unclean_stop = req
                .params
                .get("unclean_stop")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let opened = crate::recovery::open(&state.journal_dir.clone(), &state.session)
                .map_err(|e| e.to_string())?;
            let effects = effect::fold_effects(&opened.records);
            let items: Vec<Value> = effects
                .iter()
                .filter(|e| e.state != effect::EffectState::Observed)
                .map(|e| {
                    json!({
                        "idempotency_key": e.idempotency_key,
                        "tool": e.tool,
                        "state": state_name(e.state),
                        "action": action_name(effect::reconcile_decision(e, unclean_stop)),
                    })
                })
                .collect();
            Ok(json!(items))
        }

        other => Err(format!("unknown method: {other}")),
    }
}

/// Appends a journal-backed memory review mutation and indexes it. Idempotent
/// on the key; retries return the original commit flagged as a duplicate.
fn propose_memory_mutation(
    state: &mut SidecarState,
    key: String,
    kind: EventKind,
) -> Result<Value, String> {
    if let Some(record) = state.commit.record_for_key(&key) {
        return Ok(json!({ "seq": record.event.seq, "hash": record.hash, "duplicate": true }));
    }
    let outcome = state.commit.propose(&key, kind).map_err(|e| e.to_string())?;
    let (record, duplicate) = match outcome {
        CommitOutcome::Committed(r) => (r, false),
        CommitOutcome::Duplicate(r) => (r, true),
    };
    if !duplicate {
        state
            .projections
            .index_record(&record)
            .map_err(|e| e.to_string())?;
    }
    Ok(json!({ "seq": record.event.seq, "hash": record.hash, "duplicate": duplicate }))
}

#[derive(Default)]
struct TaskJournal {
    tasks: HashMap<(String, String), JournalTask>,
    worktrees: HashMap<(String, String), String>,
    messages: HashMap<(String, String), String>,
    mailbox_sequences: HashMap<(String, String), u64>,
    deliverables: HashSet<(String, String)>,
}

#[derive(Clone)]
struct JournalTask {
    parent: Option<String>,
    workspace_directory: Option<String>,
    depth: u8,
    state_changing: bool,
    budget: u64,
    state: String,
    reservation: Option<(u64, u64, u64)>,
    used: u64,
    reclaimed: u64,
}

fn task_journal(dir: &Path, session: &str) -> Result<TaskJournal, String> {
    let mut result = TaskJournal::default();
    for record in crate::recovery::open(dir, session)
        .map_err(|e| e.to_string())?
        .records
    {
        match record.event.kind {
            EventKind::TaskSpawned {
                root_id,
                task_id,
                parent_task_id,
                depth,
                state_changing,
                budget,
                workspace_directory,
                ..
            } => {
                result.tasks.insert(
                    (root_id, task_id),
                    JournalTask {
                        parent: parent_task_id,
                        workspace_directory,
                        depth,
                        state_changing,
                        budget,
                        state: "pending".into(),
                        reservation: None,
                        used: 0,
                        reclaimed: 0,
                    },
                );
            }
            EventKind::TaskStateChanged {
                root_id,
                task_id,
                state,
                ..
            } => {
                if let Some(task) = result.tasks.get_mut(&(root_id, task_id)) {
                    task.state = state;
                }
            }
            EventKind::TaskCancellationRequested {
                root_id, task_id, ..
            } => {
                if let Some(task) = result.tasks.get_mut(&(root_id, task_id)) {
                    task.state = "cancelled".into();
                }
            }
            EventKind::TaskBudgetReserved {
                root_id,
                task_id,
                parent,
                child_pool,
                synthesis,
            } => {
                if let Some(task) = result.tasks.get_mut(&(root_id, task_id)) {
                    task.reservation = Some((parent, child_pool, synthesis));
                }
            }
            EventKind::TaskBudgetUsed {
                root_id,
                task_id,
                amount,
                ..
            } => {
                if let Some(task) = result.tasks.get_mut(&(root_id, task_id)) {
                    task.used = task
                        .used
                        .checked_add(amount)
                        .ok_or("task budget use overflow")?;
                }
            }
            EventKind::TaskBudgetReclaimed {
                root_id,
                task_id,
                amount,
                ..
            } => {
                if let Some(task) = result.tasks.get_mut(&(root_id, task_id)) {
                    task.reclaimed = task
                        .reclaimed
                        .checked_add(amount)
                        .ok_or("task budget reclaim overflow")?;
                }
            }
            EventKind::WorktreeLeased {
                root_id,
                task_id,
                worktree_id,
            } => {
                result.worktrees.insert((root_id, worktree_id), task_id);
            }
            EventKind::WorktreeReleased {
                root_id,
                task_id,
                worktree_id,
            } => {
                if result
                    .worktrees
                    .get(&(root_id.clone(), worktree_id.clone()))
                    == Some(&task_id)
                {
                    result.worktrees.remove(&(root_id, worktree_id));
                }
            }
            EventKind::MailboxMessageSent {
                root_id,
                message_id,
                recipient_task_id,
                sequence,
                ..
            } => {
                result
                    .mailbox_sequences
                    .insert((root_id.clone(), recipient_task_id.clone()), sequence);
                result
                    .messages
                    .insert((root_id, message_id), recipient_task_id);
            }
            EventKind::TaskDeliverableCommitted {
                root_id, task_id, ..
            } => {
                result.deliverables.insert((root_id, task_id));
            }
            _ => {}
        }
    }
    Ok(result)
}

fn apply_task_event(journal: &mut TaskJournal, kind: &EventKind) -> Result<(), String> {
    match kind {
        EventKind::TaskSpawned {
            root_id,
            task_id,
            parent_task_id,
            depth,
            state_changing,
            budget,
            workspace_directory,
            ..
        } => {
            if parent_task_id.is_none() {
                let workspace_directory = workspace_directory
                    .as_deref()
                    .ok_or("root workspace directory is required")?;
                if !is_absolute_workspace(workspace_directory) {
                    return Err("root workspace directory must be absolute".into());
                }
                if journal.tasks.iter().any(|((root, _), task)| {
                    root == root_id
                        && task.parent.is_none()
                        && task.workspace_directory.as_deref() != Some(workspace_directory)
                }) {
                    return Err("root workspace mismatch".into());
                }
            } else if workspace_directory.is_some() {
                return Err("only root tasks bind a workspace directory".into());
            }
            journal.tasks.insert(
                (root_id.clone(), task_id.clone()),
                JournalTask {
                    parent: parent_task_id.clone(),
                    workspace_directory: workspace_directory.clone(),
                    depth: *depth,
                    state_changing: *state_changing,
                    budget: *budget,
                    state: "pending".into(),
                    reservation: None,
                    used: 0,
                    reclaimed: 0,
                },
            );
        }
        EventKind::TaskStateChanged {
            root_id,
            task_id,
            state,
            ..
        } => {
            if let Some(task) = journal.tasks.get_mut(&(root_id.clone(), task_id.clone())) {
                task.state = state.clone();
            }
        }
        EventKind::TaskCancellationRequested {
            root_id, task_id, ..
        } => {
            if let Some(task) = journal.tasks.get_mut(&(root_id.clone(), task_id.clone())) {
                task.state = "cancelled".into();
            }
        }
        EventKind::TaskBudgetReserved {
            root_id,
            task_id,
            parent,
            child_pool,
            synthesis,
        } => {
            if let Some(task) = journal.tasks.get_mut(&(root_id.clone(), task_id.clone())) {
                task.reservation = Some((*parent, *child_pool, *synthesis));
            }
        }
        EventKind::TaskBudgetUsed {
            root_id,
            task_id,
            amount,
            ..
        } => {
            if let Some(task) = journal.tasks.get_mut(&(root_id.clone(), task_id.clone())) {
                task.used = task
                    .used
                    .checked_add(*amount)
                    .ok_or("task budget use overflow")?;
            }
        }
        EventKind::TaskBudgetReclaimed {
            root_id,
            task_id,
            amount,
            ..
        } => {
            if let Some(task) = journal.tasks.get_mut(&(root_id.clone(), task_id.clone())) {
                task.reclaimed = task
                    .reclaimed
                    .checked_add(*amount)
                    .ok_or("task budget reclaim overflow")?;
            }
        }
        EventKind::WorktreeLeased {
            root_id,
            task_id,
            worktree_id,
        } => {
            journal
                .worktrees
                .insert((root_id.clone(), worktree_id.clone()), task_id.clone());
        }
        EventKind::WorktreeReleased {
            root_id,
            task_id,
            worktree_id,
        } => {
            if journal
                .worktrees
                .get(&(root_id.clone(), worktree_id.clone()))
                == Some(task_id)
            {
                journal
                    .worktrees
                    .remove(&(root_id.clone(), worktree_id.clone()));
            }
        }
        EventKind::MailboxMessageSent {
            root_id,
            message_id,
            recipient_task_id,
            sequence,
            ..
        } => {
            journal
                .mailbox_sequences
                .insert((root_id.clone(), recipient_task_id.clone()), *sequence);
            journal.messages.insert(
                (root_id.clone(), message_id.clone()),
                recipient_task_id.clone(),
            );
        }
        EventKind::TaskDeliverableCommitted {
            root_id, task_id, ..
        } => {
            journal
                .deliverables
                .insert((root_id.clone(), task_id.clone()));
        }
        _ => {}
    }
    Ok(())
}

fn journal_task<'a>(
    journal: &'a TaskJournal,
    root_id: &str,
    task_id: &str,
) -> Result<&'a JournalTask, String> {
    journal
        .tasks
        .get(&(root_id.into(), task_id.into()))
        .ok_or_else(|| format!("unknown task: {task_id}"))
}

fn validate_task_event_from_journal(journal: &TaskJournal, kind: &EventKind) -> Result<(), String> {
    match kind {
        EventKind::TaskSpawned {
            root_id,
            task_id,
            parent_task_id,
            depth,
            dependencies,
            budget,
            workspace_directory,
            ..
        } => {
            if parent_task_id.is_none() {
                let workspace_directory = workspace_directory
                    .as_deref()
                    .ok_or("root workspace directory is required")?;
                if !is_absolute_workspace(workspace_directory) {
                    return Err("root workspace directory must be absolute".into());
                }
                if journal.tasks.iter().any(|((root, _), task)| {
                    root == root_id
                        && task.parent.is_none()
                        && task.workspace_directory.as_deref() != Some(workspace_directory)
                }) {
                    return Err("root workspace mismatch".into());
                }
            } else if workspace_directory.is_some() {
                return Err("only root tasks bind a workspace directory".into());
            }
            if journal
                .tasks
                .contains_key(&(root_id.clone(), task_id.clone()))
            {
                return Err(format!("duplicate task: {task_id}"));
            }
            if *depth > 2 {
                return Err("task depth exceeds 2".into());
            }
            if let Some(parent) = parent_task_id {
                let parent_task = journal_task(journal, root_id, parent)?;
                if *depth != parent_task.depth + 1 {
                    return Err("child task depth must equal parent depth plus one".into());
                }
                if journal
                    .tasks
                    .iter()
                    .filter(|((root, _), task)| {
                        root == root_id && task.parent.as_deref() == Some(parent)
                    })
                    .count()
                    >= 3
                {
                    return Err(format!("parent already has three children: {parent}"));
                }
                if let Some((_, pool, _)) = parent_task.reservation {
                    let reserved = journal
                        .tasks
                        .iter()
                        .filter(|((root, _), task)| {
                            root == root_id && task.parent.as_deref() == Some(parent)
                        })
                        .try_fold(0u64, |total, (_, task)| {
                            total.checked_add(task.budget.saturating_sub(task.reclaimed))
                        })
                        .ok_or("task child-pool budget exceeded")?;
                    if reserved
                        .checked_add(*budget)
                        .is_none_or(|total| total > pool)
                    {
                        return Err("task child-pool budget exceeded".into());
                    }
                }
            } else if *depth != 0 {
                return Err("root task depth must be 0".into());
            }
            let mut seen = HashSet::new();
            for dependency in dependencies {
                if !seen.insert(dependency) {
                    return Err(format!("duplicate dependency: {dependency}"));
                }
                journal_task(journal, root_id, dependency)?;
            }
        }
        EventKind::TaskStateChanged {
            root_id,
            task_id,
            state,
            ..
        } => {
            let current = &journal_task(journal, root_id, task_id)?.state;
            if !matches!(
                (current.as_str(), state.as_str()),
                ("pending", "running" | "waiting" | "cancelled")
                    | ("waiting", "pending" | "cancelled")
                    | ("running", "completed" | "failed" | "cancelled")
            ) {
                return Err(format!(
                    "invalid task-state transition: {current} -> {state}"
                ));
            }
        }
        EventKind::TaskBudgetReserved {
            root_id,
            task_id,
            parent,
            child_pool,
            synthesis,
        } => {
            let task = journal_task(journal, root_id, task_id)?;
            if task.reservation.is_some() {
                return Err("task budget already reserved".into());
            }
            if parent + child_pool + synthesis != task.budget
                || parent * 10 != task.budget * 6
                || child_pool * 10 != task.budget * 3
                || synthesis * 10 != task.budget
            {
                return Err("invalid task budget split".into());
            }
        }
        EventKind::TaskBudgetUsed {
            root_id,
            task_id,
            amount,
            target,
        } => {
            let task = journal_task(journal, root_id, task_id)?;
            if target != "child-pool" {
                return Err("task budget use must target child-pool".into());
            }
            let Some((_, pool, _)) = task.reservation else {
                return Err("task budget is not reserved".into());
            };
            if matches!(task.state.as_str(), "completed" | "failed" | "cancelled")
                || task
                    .used
                    .checked_add(*amount)
                    .is_none_or(|used| used > pool)
            {
                return Err("task child-pool budget exceeded".into());
            }
        }
        EventKind::TaskBudgetReclaimed {
            root_id,
            task_id,
            amount,
            target,
        } => {
            let task = journal_task(journal, root_id, task_id)?;
            if target != "child-pool"
                || !matches!(task.state.as_str(), "completed" | "failed" | "cancelled")
                || *amount > task.budget.saturating_sub(task.reclaimed)
            {
                return Err("invalid task child-pool reclaim".into());
            }
        }
        EventKind::TaskCancellationRequested {
            root_id, task_id, ..
        } => {
            if matches!(
                journal_task(journal, root_id, task_id)?.state.as_str(),
                "completed" | "failed" | "cancelled"
            ) {
                return Err("task is terminal".into());
            }
        }
        EventKind::TaskCancellationObserved { root_id, task_id } => {
            if journal_task(journal, root_id, task_id)?.state != "cancelled" {
                return Err("task is not cancelled".into());
            }
        }
        EventKind::WorktreeLeased {
            root_id,
            task_id,
            worktree_id,
        } => {
            let task = journal_task(journal, root_id, task_id)?;
            if task.depth == 0 || !task.state_changing || worktree_id.is_empty() {
                return Err("task is not eligible for a worktree".into());
            }
            if journal
                .worktrees
                .contains_key(&(root_id.clone(), worktree_id.clone()))
            {
                return Err(format!("worktree lease collision: {worktree_id}"));
            }
        }
        EventKind::WorktreeReleased {
            root_id,
            task_id,
            worktree_id,
        } => {
            journal_task(journal, root_id, task_id)?;
            if journal
                .worktrees
                .get(&(root_id.clone(), worktree_id.clone()))
                .map(String::as_str)
                != Some(task_id)
            {
                return Err(format!("worktree release mismatch: {worktree_id}"));
            }
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
            ..
        } => {
            validate_mailbox_evidence(
                summary,
                artifact_ids,
                changed_paths,
                test_summary.as_deref(),
                blocked_reason.as_deref(),
            )?;
            journal_task(journal, root_id, sender_task_id)?;
            journal_task(journal, root_id, recipient_task_id)?;
            if journal
                .messages
                .contains_key(&(root_id.clone(), message_id.clone()))
            {
                return Err(format!("duplicate mailbox message: {message_id}"));
            }
            if journal
                .mailbox_sequences
                .get(&(root_id.clone(), recipient_task_id.clone()))
                .is_some_and(|previous| sequence <= previous)
            {
                return Err("mailbox sequence must increase".into());
            }
        }
        EventKind::MailboxMessageAcknowledged {
            root_id,
            message_id,
            recipient_task_id,
        } => {
            journal_task(journal, root_id, recipient_task_id)?;
            if journal
                .messages
                .get(&(root_id.clone(), message_id.clone()))
                .map(String::as_str)
                != Some(recipient_task_id)
            {
                return Err(format!(
                    "mailbox acknowledgement recipient mismatch: {message_id}"
                ));
            }
        }
        EventKind::TaskDeliverableCommitted {
            root_id,
            task_id,
            status,
            ..
        } => {
            let state = &journal_task(journal, root_id, task_id)?.state;
            if !matches!(state.as_str(), "completed" | "failed" | "cancelled") {
                return Err(format!(
                    "task deliverable requires terminal task: {task_id}"
                ));
            }
            if state != status {
                return Err("deliverable status must match task terminal status".into());
            }
            if journal
                .deliverables
                .contains(&(root_id.clone(), task_id.clone()))
            {
                return Err("duplicate deliverable".into());
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_mailbox_evidence(
    summary: &str,
    artifact_ids: &[String],
    changed_paths: &[String],
    test_summary: Option<&str>,
    blocked_reason: Option<&str>,
) -> Result<(), String> {
    validate_mailbox_text("summary", summary, 4096)?;
    if artifact_ids.len() > 256 {
        return Err("invalid mailbox evidence: artifact_ids exceeds 256 entries".into());
    }
    if changed_paths.len() > 256 {
        return Err("invalid mailbox evidence: changed_paths exceeds 256 entries".into());
    }
    validate_mailbox_references("artifact_ids", artifact_ids)?;
    validate_mailbox_references("changed_paths", changed_paths)?;
    if let Some(value) = test_summary {
        validate_mailbox_text("test_summary", value, 4096)?;
    }
    if let Some(value) = blocked_reason {
        validate_mailbox_text("blocked_reason", value, 4096)?;
    }
    Ok(())
}

fn is_absolute_workspace(value: &str) -> bool {
    Path::new(value).is_absolute()
        || value.len() >= 3
            && value.as_bytes()[0].is_ascii_alphabetic()
            && value.as_bytes()[1] == b':'
            && matches!(value.as_bytes()[2], b'\\' | b'/')
}

fn validate_approval_event(kind: &EventKind) -> Result<(), String> {
    let EventKind::ApprovalFinalized {
        workspace_directory,
        project_id,
        ..
    } = kind
    else {
        return Ok(());
    };
    let workspace_directory = workspace_directory
        .as_deref()
        .ok_or("approval audit scope is required")?;
    if !is_absolute_workspace(workspace_directory) {
        return Err("approval audit workspace directory must be absolute".into());
    }
    if project_id.as_deref().is_none_or(str::is_empty) {
        return Err("approval audit project id is required".into());
    }
    Ok(())
}

fn validate_mailbox_references(name: &str, values: &[String]) -> Result<(), String> {
    for value in values {
        validate_mailbox_text(name, value, 1024)?;
        if value.is_empty() {
            return Err(format!(
                "invalid mailbox evidence: {name} contains an empty value"
            ));
        }
    }
    Ok(())
}

fn validate_mailbox_text(name: &str, value: &str, max_bytes: usize) -> Result<(), String> {
    if value.len() > max_bytes {
        return Err(format!(
            "invalid mailbox evidence: {name} exceeds {max_bytes} bytes"
        ));
    }
    if value.chars().any(char::is_control) {
        return Err(format!(
            "invalid mailbox evidence: {name} contains control characters"
        ));
    }
    Ok(())
}

/* Obsolete projection-backed task validation; journal folding is authoritative.
fn validate_task_event(projections: &ProjectionStore, kind: &EventKind) -> Result<(), String> {
    match kind {
        EventKind::TaskSpawned {
            root_id,
            task_id,
            parent_task_id,
            depth,
            dependencies,
            ..
        } => {
            if let Some(existing_root) =
                projections.task_root(task_id).map_err(|e| e.to_string())?
            {
                if existing_root != *root_id {
                    return Err(format!("task exists in different root: {task_id}"));
                }
                return Err(format!("duplicate task: {task_id}"));
            }
            if *depth > 2 {
                return Err("task depth exceeds 2".into());
            }
            if let Some(parent) = parent_task_id {
                if !projections
                    .task_exists(root_id, parent)
                    .map_err(|e| e.to_string())?
                {
                    return Err(format!("parent task does not exist in root: {parent}"));
                }
                if projections
                    .child_count(root_id, parent)
                    .map_err(|e| e.to_string())?
                    >= 3
                {
                    return Err(format!("parent already has three children: {parent}"));
                }
            }
            for dependency in dependencies {
                if !projections
                    .task_exists(root_id, dependency)
                    .map_err(|e| e.to_string())?
                {
                    return Err(format!(
                        "dependency task does not exist in root: {dependency}"
                    ));
                }
            }
        }
        EventKind::TaskStateChanged {
            root_id,
            task_id,
            state,
            ..
        } => {
            let current = require_task(projections, root_id, task_id)?;
            let valid = matches!(
                (current.as_str(), state.as_str()),
                ("pending", "running" | "waiting" | "cancelled")
                    | ("waiting", "pending" | "cancelled")
                    | ("running", "completed" | "failed" | "cancelled")
            );
            if !valid {
                return Err(format!(
                    "invalid task-state transition: {current} -> {state}"
                ));
            }
        }
        EventKind::TaskBudgetReserved {
            root_id, task_id, ..
        }
        | EventKind::TaskBudgetUsed {
            root_id, task_id, ..
        }
        | EventKind::TaskCancellationRequested {
            root_id, task_id, ..
        }
        | EventKind::TaskCancellationObserved { root_id, task_id } => {
            require_task(projections, root_id, task_id)?;
        }
        EventKind::WorktreeLeased {
            root_id,
            task_id,
            worktree_id,
        } => {
            require_task(projections, root_id, task_id)?;
            if projections
                .worktree_owner(root_id, worktree_id)
                .map_err(|e| e.to_string())?
                .is_some()
            {
                return Err(format!("worktree lease collision: {worktree_id}"));
            }
        }
        EventKind::WorktreeReleased {
            root_id,
            task_id,
            worktree_id,
        } => {
            require_task(projections, root_id, task_id)?;
            let owner = projections
                .worktree_owner(root_id, worktree_id)
                .map_err(|e| e.to_string())?;
            if owner.as_deref() != Some(task_id) {
                return Err(format!("worktree release mismatch: {worktree_id}"));
            }
        }
        EventKind::MailboxMessageSent {
            root_id,
            message_id,
            sender_task_id,
            recipient_task_id,
            ..
        } => {
            require_task(projections, root_id, sender_task_id)?;
            require_task(projections, root_id, recipient_task_id)?;
            if projections
                .mailbox_exists(message_id)
                .map_err(|e| e.to_string())?
            {
                return Err(format!("duplicate mailbox message: {message_id}"));
            }
        }
        EventKind::MailboxMessageAcknowledged {
            root_id,
            message_id,
            recipient_task_id,
        } => {
            require_task(projections, root_id, recipient_task_id)?;
            let recipient = projections
                .mailbox_recipient(root_id, message_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("unknown mailbox message: {message_id}"))?;
            if recipient != *recipient_task_id {
                return Err(format!(
                    "mailbox acknowledgement recipient mismatch: {message_id}"
                ));
            }
        }
        EventKind::TaskDeliverableCommitted {
            root_id, task_id, ..
        } => {
            let state = require_task(projections, root_id, task_id)?;
            if !matches!(state.as_str(), "completed" | "failed" | "cancelled") {
                return Err(format!(
                    "task deliverable requires terminal task: {task_id}"
                ));
            }
        }
        _ => {}
    }
    Ok(())
}

fn require_task(
    projections: &ProjectionStore,
    root_id: &str,
    task_id: &str,
) -> Result<String, String> {
    if let Some(state) = projections
        .task_state(root_id, task_id)
        .map_err(|e| e.to_string())?
    {
        return Ok(state);
    }
    if projections
        .task_root(task_id)
        .map_err(|e| e.to_string())?
        .is_some()
    {
        return Err(format!("task belongs to wrong root: {task_id}"));
    }
    Err(format!("unknown task: {task_id}"))
}
*/

#[cfg(test)]
mod tests {
    use super::*;

    fn dirs(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base =
            std::env::temp_dir().join(format!("ultracode-rpc-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        (
            base.join("journal"),
            base.join("proj.db"),
            base.join("blobs"),
        )
    }

    fn req(id: u64, method: &str, params: Value) -> Request {
        Request {
            id,
            method: method.to_string(),
            params,
        }
    }

    #[test]
    fn ping_and_propose_and_list() {
        let (journal, db, blobs) = dirs("basic");
        let mut state = SidecarState::open(&journal, &db, &blobs, "ses_1").unwrap();

        let pong = handle_request(&mut state, &req(1, "ping", json!({})));
        assert_eq!(pong.result.unwrap(), json!({ "ok": true }));

        let kind = json!({ "kind": "turn-started", "data": { "turn": 1 } });
        let committed = handle_request(
            &mut state,
            &req(2, "propose_commit", json!({ "key": "cmd_a", "kind": kind })),
        );
        let result = committed.result.unwrap();
        assert_eq!(result["seq"], 1);
        assert_eq!(result["duplicate"], false);

        // Idempotent retry returns the same seq, flagged duplicate.
        let retry = handle_request(
            &mut state,
            &req(3, "propose_commit", json!({ "key": "cmd_a", "kind": kind })),
        );
        let retry_result = retry.result.unwrap();
        assert_eq!(retry_result["seq"], 1);
        assert_eq!(retry_result["duplicate"], true);

        let listed = handle_request(
            &mut state,
            &req(4, "list_events", json!({ "session": "ses_1" })),
        );
        let events = listed.result.unwrap();
        assert_eq!(events.as_array().unwrap().len(), 1);
        assert_eq!(events[0]["kind"], "turn-started");
        let _ = std::fs::remove_dir_all(journal.parent().unwrap());
    }

    #[test]
    fn artifact_round_trip_over_rpc() {
        let (journal, db, blobs) = dirs("artifact");
        let mut state = SidecarState::open(&journal, &db, &blobs, "ses_1").unwrap();

        let bytes_hex = hex_encode(b"hello rpc");
        let put = handle_request(
            &mut state,
            &req(
                1,
                "put_artifact",
                json!({ "bytes_hex": bytes_hex, "mime": "text/plain", "owner_scope": "ses_1", "retention": "session", "credential_class": "plain" }),
            ),
        );
        let reference = put.result.unwrap();
        let artifact_id = reference["artifact_id"].as_str().unwrap().to_string();

        let stat = handle_request(
            &mut state,
            &req(
                2,
                "stat_artifact",
                json!({ "artifact_id": artifact_id, "scope": "ses_1" }),
            ),
        );
        assert_eq!(stat.result.unwrap()["byte_length"], 9);

        let read = handle_request(
            &mut state,
            &req(
                3,
                "open_range",
                json!({ "artifact_id": artifact_id, "scope": "ses_1", "start": 0, "end": 5 }),
            ),
        );
        let read_hex = read.result.unwrap()["bytes_hex"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(hex_decode(&read_hex).unwrap(), b"hello".to_vec());
        let _ = std::fs::remove_dir_all(journal.parent().unwrap());
    }

    #[test]
    fn unknown_method_returns_an_error_response() {
        let (journal, db, blobs) = dirs("unknown");
        let mut state = SidecarState::open(&journal, &db, &blobs, "ses_1").unwrap();
        let resp = handle_request(&mut state, &req(1, "nope", json!({})));
        assert!(resp.result.is_none());
        assert!(resp.error.unwrap().contains("unknown method"));
        let _ = std::fs::remove_dir_all(journal.parent().unwrap());
    }

    #[test]
    fn memory_results_require_a_running_request_of_the_matching_kind() {
        let (journal, db, blobs) = dirs("memory");
        let mut state = SidecarState::open(&journal, &db, &blobs, "ses_1").unwrap();
        let missing_result = handle_request(
            &mut state,
            &req(
                2,
                "propose_commit",
                json!({
                    "key": "missing-result", "kind": { "kind": "memory-extracted", "data": {
                        "request_id": "missing", "thread_id": "thread-missing", "source_updated_at": 1,
                        "raw_memory": "raw", "rollout_summary": "summary", "rollout_slug": null,
                        "cwd": "/repo", "git_branch": null, "generated_at": 2
                    }}
                }),
            ),
        );
        assert!(missing_result
            .error
            .unwrap()
            .contains("missing memory request"));

        let requested = json!({ "kind": "memory-extraction-requested", "data": {
            "request_id": "req-a", "source_session": "ses_1", "source_turn": 1,
            "source_end_seq": 1, "transcript_artifact_id": "art-a", "extractor_version": "v1"
        }});
        assert!(handle_request(
            &mut state,
            &req(
                2,
                "propose_commit",
                json!({ "key": "request", "kind": requested })
            )
        )
        .error
        .is_none());
        let cross_kind = handle_request(
            &mut state,
            &req(
                3,
                "propose_commit",
                json!({ "key": "cross-kind", "kind": { "kind": "memory-consolidated", "data": {
                    "request_id": "req-a", "memory_id": "memory-a", "summary": "summary", "memory": "memory", "source_thread_ids": [], "generated_at": 2
                }}}),
            ),
        );
        assert!(cross_kind.error.unwrap().contains("wrong kind"));
        assert_eq!(state.projections.count().unwrap(), 1);

        let pending_result = handle_request(
            &mut state,
            &req(
                4,
                "propose_commit",
                json!({ "key": "pending-result", "kind": { "kind": "memory-extracted", "data": {
                    "request_id": "req-a", "thread_id": "thread-a", "source_updated_at": 1, "raw_memory": "raw", "rollout_summary": "summary", "rollout_slug": null, "cwd": "/repo", "git_branch": null, "generated_at": 2
                }}}),
            ),
        );
        assert!(pending_result.error.unwrap().contains("not running"));
        assert_eq!(state.projections.count().unwrap(), 1);

        let claimed = handle_request(&mut state, &req(5, "claim_memory_job", json!({})))
            .result
            .unwrap();
        assert_eq!(claimed["request_id"], "req-a");
        let extracted = json!({ "kind": "memory-extracted", "data": {
            "request_id": "req-a", "thread_id": "thread-a", "source_updated_at": 1,
            "raw_memory": "raw", "rollout_summary": "summary", "rollout_slug": null,
            "cwd": "/repo", "git_branch": null, "generated_at": 2
        }});
        assert!(handle_request(
            &mut state,
            &req(
                6,
                "propose_commit",
                json!({ "key": "result", "kind": extracted })
            )
        )
        .error
        .is_none());
        assert_eq!(
            handle_request(&mut state, &req(7, "claim_memory_job", json!({})))
                .result
                .unwrap(),
            Value::Null
        );
        let records = handle_request(
            &mut state,
            &req(8, "list_memory_records", json!({ "limit": 500 })),
        )
        .result
        .unwrap();
        assert_eq!(records.as_array().unwrap().len(), 1);
        assert_eq!(records[0]["usage_count"], 0);
        for index in 0..200 {
            state.projections.conn_mut().execute(
                "INSERT INTO memory_records (thread_id, source_session, source_turn, source_end_seq, transcript_artifact_id, extractor_version, source_updated_at, raw_memory, rollout_summary, cwd, generated_at, usage_count) VALUES (?1, 'ses_1', 1, 1, 'art', 'v1', 1, 'raw', 'summary', '/repo', 1, 0)",
                rusqlite::params![format!("thread-limit-{index}")],
            ).unwrap();
        }
        let limited = handle_request(
            &mut state,
            &req(9, "list_memory_records", json!({ "limit": 500 })),
        )
        .result
        .unwrap();
        assert_eq!(limited.as_array().unwrap().len(), 200);
        let _ = std::fs::remove_dir_all(journal.parent().unwrap());
    }

    #[test]
    fn memory_record_review_mutations_are_journal_backed_and_survive_rebuild() {
        let (journal, db, blobs) = dirs("memory-review");
        let mut state = SidecarState::open(&journal, &db, &blobs, "ses_1").unwrap();
        let requested = json!({ "kind": "memory-extraction-requested", "data": {
            "request_id": "req-a", "source_session": "ses_1", "source_turn": 1,
            "source_end_seq": 1, "transcript_artifact_id": "art-a", "extractor_version": "v1"
        }});
        assert!(handle_request(&mut state, &req(1, "propose_commit", json!({ "key": "request", "kind": requested }))).error.is_none());
        let claimed = handle_request(&mut state, &req(2, "claim_memory_job", json!({})));
        assert_eq!(claimed.result.unwrap()["request_id"], "req-a");
        let extracted = json!({ "kind": "memory-extracted", "data": {
            "request_id": "req-a", "thread_id": "thread-a", "source_updated_at": 1,
            "raw_memory": "raw", "rollout_summary": "summary", "rollout_slug": null,
            "cwd": "/repo", "git_branch": null, "generated_at": 2
        }});
        assert!(handle_request(&mut state, &req(3, "propose_commit", json!({ "key": "result", "kind": extracted }))).error.is_none());

        let patched = handle_request(&mut state, &req(4, "patch_memory_record", json!({
            "thread_id": "thread-a", "raw_memory": "edited"
        })));
        assert!(patched.error.is_none(), "{patched:?}");
        let record = handle_request(&mut state, &req(5, "get_memory_record", json!({ "thread_id": "thread-a" }))).result.unwrap();
        assert_eq!(record["raw_memory"], "edited");
        assert_eq!(record["rollout_summary"], "summary");
        assert_eq!(record["edited_by"], "user");
        assert!(record["edited_at"].as_u64().unwrap() > 0);

        let empty_patch = handle_request(&mut state, &req(6, "patch_memory_record", json!({ "thread_id": "thread-a" })));
        assert!(empty_patch.error.unwrap().contains("nothing to patch"));

        let deleted = handle_request(&mut state, &req(7, "delete_memory_record", json!({ "thread_id": "thread-a" })));
        assert!(deleted.error.is_none(), "{deleted:?}");
        assert!(handle_request(&mut state, &req(8, "get_memory_record", json!({ "thread_id": "thread-a" }))).result.unwrap().is_null());
        let listed = handle_request(&mut state, &req(9, "list_memory_records", json!({}))).result.unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 0);

        let unknown_delete = handle_request(&mut state, &req(10, "delete_memory_record", json!({ "thread_id": "missing" })));
        assert!(unknown_delete.error.unwrap().contains("not found"));
        let unknown_patch = handle_request(&mut state, &req(11, "patch_memory_record", json!({ "thread_id": "missing", "raw_memory": "x" })));
        assert!(unknown_patch.error.unwrap().contains("not found"));

        state.projections.rebuild(&journal, "ses_1").unwrap();
        assert!(handle_request(&mut state, &req(12, "get_memory_record", json!({ "thread_id": "thread-a" }))).result.unwrap().is_null());
        assert_eq!(handle_request(&mut state, &req(13, "list_memory_records", json!({}))).result.unwrap().as_array().unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(journal.parent().unwrap());
    }

    #[test]
    fn failed_memory_jobs_are_terminal_and_survive_a_rebuild() {
        let (journal, db, blobs) = dirs("memory-failed");
        let mut state = SidecarState::open(&journal, &db, &blobs, "ses_1").unwrap();
        let requested = json!({ "kind": "memory-extraction-requested", "data": {
            "request_id": "req-failed", "source_session": "ses_1", "source_turn": 1,
            "source_end_seq": 1, "transcript_artifact_id": "art-a", "extractor_version": "v1"
        }});
        handle_request(
            &mut state,
            &req(
                1,
                "propose_commit",
                json!({ "key": "request", "kind": requested }),
            ),
        );
        let failed_kind = json!({
            "kind": "memory-job-failed",
            "data": { "request_id": "req-failed", "reason": "invalid memory job" }
        });
        let pending_failure = handle_request(
            &mut state,
            &req(
                2,
                "propose_commit",
                json!({ "key": "memory-job-failed:req-failed", "kind": failed_kind }),
            ),
        );
        assert!(pending_failure.error.unwrap().contains("not running"));
        assert_eq!(state.projections.count().unwrap(), 1);
        state.projections.rebuild(&journal, "ses_1").unwrap();
        assert_eq!(state.projections.count().unwrap(), 1);
        let claimed = handle_request(&mut state, &req(3, "claim_memory_job", json!({})))
            .result
            .unwrap();
        assert_eq!(claimed["request_id"], "req-failed");
        let failed = handle_request(
            &mut state,
            &req(
                4,
                "propose_commit",
                json!({ "key": "memory-job-failed:req-failed", "kind": failed_kind }),
            ),
        );
        assert!(failed.error.is_none());
        let duplicate = handle_request(
            &mut state,
            &req(
                5,
                "propose_commit",
                json!({ "key": "memory-job-failed:req-failed", "kind": failed_kind }),
            ),
        );
        assert_eq!(duplicate.result.unwrap()["duplicate"], true);
        state.projections.rebuild(&journal, "ses_1").unwrap();
        assert_eq!(
            handle_request(&mut state, &req(6, "claim_memory_job", json!({})))
                .result
                .unwrap(),
            Value::Null
        );
        assert_eq!(
            state
                .projections
                .conn()
                .query_row(
                    "SELECT status, failure_reason FROM memory_jobs WHERE request_id = 'req-failed'",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .unwrap(),
            ("failed".to_string(), "invalid memory job".to_string())
        );
        let _ = std::fs::remove_dir_all(journal.parent().unwrap());
    }

    #[test]
    fn task_events_are_validated_before_they_are_appended() {
        let (journal, db, blobs) = dirs("task-validation");
        let mut state = SidecarState::open(&journal, &db, &blobs, "ses_1").unwrap();
        let spawn = |task_id: &str, parent_task_id: Option<&str>, depth: u8| {
            json!({ "kind": "task-spawned", "data": {
                "root_id": "root-a", "task_id": task_id, "parent_task_id": parent_task_id,
                "depth": depth, "state_changing": true, "dependencies": [], "budget": 10,
                "workspace_directory": if parent_task_id.is_none() { Some("C:\\workspace") } else { None }
            }})
        };

        assert!(handle_request(
            &mut state,
            &req(
                1,
                "propose_commit",
                json!({ "key": "root", "kind": spawn("root", None, 0) })
            ),
        )
        .error
        .is_none());
        assert_eq!(state.projections.count().unwrap(), 1);

        for (key, kind, expected) in [
            (
                "wrong-root",
                json!({ "kind": "task-spawned", "data": { "root_id": "root-a", "task_id": "root", "parent_task_id": null, "depth": 0, "state_changing": true, "dependencies": [], "budget": 10, "workspace_directory": "C:\\workspace" }}),
                "duplicate task",
            ),
            (
                "missing-parent",
                spawn("missing-parent", Some("missing"), 1),
                "unknown task",
            ),
            ("too-deep", spawn("too-deep", Some("root"), 3), "depth"),
            (
                "missing-dependency",
                json!({ "kind": "task-spawned", "data": { "root_id": "root-a", "task_id": "missing-dependency", "parent_task_id": null, "depth": 0, "state_changing": true, "dependencies": ["missing"], "budget": 10, "workspace_directory": "C:\\workspace" }}),
                "unknown task",
            ),
            (
                "unknown-state",
                json!({ "kind": "task-state-changed", "data": { "root_id": "root-a", "task_id": "missing", "state": "running", "reason": null }}),
                "unknown task",
            ),
        ] {
            let response = handle_request(
                &mut state,
                &req(2, "propose_commit", json!({ "key": key, "kind": kind })),
            );
            assert!(response.error.unwrap().contains(expected), "key: {key}");
            assert_eq!(state.projections.count().unwrap(), 1);
        }
        let _ = std::fs::remove_dir_all(journal.parent().unwrap());
    }

    #[test]
    fn task_validation_is_journal_authoritative_and_index_failures_acknowledge_commits() {
        let (journal, db, blobs) = dirs("task-journal-authority");
        let mut state = SidecarState::open(&journal, &db, &blobs, "ses_1").unwrap();
        let commit = |state: &mut SidecarState, key: &str, kind: Value| {
            handle_request(
                state,
                &req(1, "propose_commit", json!({ "key": key, "kind": kind })),
            )
        };
        let spawn = |task_id: &str, parent_task_id: Option<&str>, depth: u8| {
            json!({ "kind": "task-spawned", "data": {
                "root_id": "root-a", "task_id": task_id, "parent_task_id": parent_task_id,
                "depth": depth, "state_changing": true, "dependencies": [], "budget": 10,
                "workspace_directory": if parent_task_id.is_none() { Some("C:\\workspace") } else { None }
            }})
        };

        assert!(commit(&mut state, "root", spawn("root", None, 0))
            .error
            .is_none());
        state
            .projections
            .conn_mut()
            .execute_batch("DELETE FROM tasks")
            .unwrap();
        assert!(commit(&mut state, "child", spawn("child", Some("root"), 1))
            .error
            .is_none());

        state.projections.conn_mut().execute_batch(
            "CREATE TRIGGER reject_task_index BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'index failure'); END;",
        ).unwrap();
        let committed = commit(
            &mut state,
            "failed-index",
            spawn("indexed-later", Some("root"), 1),
        );
        assert_eq!(committed.result.unwrap()["duplicate"], false);
        assert_eq!(
            crate::recovery::open(&journal, "ses_1")
                .unwrap()
                .records
                .len(),
            3
        );
        state
            .projections
            .conn_mut()
            .execute_batch("DROP TRIGGER reject_task_index")
            .unwrap();
        assert_eq!(state.projections.rebuild(&journal, "ses_1").unwrap(), 3);
        assert!(state
            .projections
            .task_exists("root-a", "indexed-later")
            .unwrap());
        let _ = std::fs::remove_dir_all(journal.parent().unwrap());
    }

    #[test]
    fn task_graph_budget_and_cancellation_invariants_are_enforced_from_the_journal() {
        let (journal, db, blobs) = dirs("task-invariants");
        let mut state = SidecarState::open(&journal, &db, &blobs, "ses_1").unwrap();
        let commit = |state: &mut SidecarState, key: &str, kind: Value| {
            handle_request(
                state,
                &req(1, "propose_commit", json!({ "key": key, "kind": kind })),
            )
        };
        let spawned = |root: &str,
                       task: &str,
                       parent: Option<&str>,
                       depth: u8,
                       dependencies: Vec<&str>,
                       state_changing: bool| json!({ "kind": "task-spawned", "data": { "root_id": root, "task_id": task, "parent_task_id": parent, "depth": depth, "state_changing": state_changing, "dependencies": dependencies, "budget": 10, "workspace_directory": if parent.is_none() { Some("C:\\workspace") } else { None } } });

        assert!(commit(
            &mut state,
            "root-a",
            spawned("root-a", "same", None, 0, vec![], true)
        )
        .error
        .is_none());
        assert!(commit(
            &mut state,
            "root-b",
            spawned("root-b", "same", None, 0, vec![], true)
        )
        .error
        .is_none());
        for (key, kind, error) in [
            (
                "duplicate",
                spawned("root-a", "same", None, 0, vec![], true),
                "duplicate task",
            ),
            (
                "root-depth",
                spawned("root-a", "bad-root", None, 1, vec![], true),
                "root task depth",
            ),
            (
                "child-depth",
                spawned("root-a", "bad-child", Some("same"), 2, vec![], true),
                "parent depth",
            ),
            (
                "duplicate-dependency",
                spawned("root-a", "bad-deps", None, 0, vec!["same", "same"], true),
                "duplicate dependency",
            ),
            (
                "cross-root-parent",
                spawned("root-c", "cross-parent", Some("same"), 1, vec![], true),
                "unknown task",
            ),
            (
                "cross-root-dependency",
                spawned("root-c", "cross-dependency", None, 0, vec!["same"], true),
                "unknown task",
            ),
        ] {
            assert!(
                commit(&mut state, key, kind).error.unwrap().contains(error),
                "{key}"
            );
        }
        assert!(commit(
            &mut state,
            "child",
            spawned("root-a", "child", Some("same"), 1, vec![], true)
        )
        .error
        .is_none());
        assert!(commit(&mut state, "bad-split", json!({ "kind": "task-budget-reserved", "data": { "root_id": "root-a", "task_id": "child", "parent": 5, "child_pool": 4, "synthesis": 1 }})).error.unwrap().contains("budget split"));
        assert!(commit(&mut state, "reserve", json!({ "kind": "task-budget-reserved", "data": { "root_id": "root-a", "task_id": "child", "parent": 6, "child_pool": 3, "synthesis": 1 }})).error.is_none());
        assert!(commit(&mut state, "reserve-again", json!({ "kind": "task-budget-reserved", "data": { "root_id": "root-a", "task_id": "child", "parent": 6, "child_pool": 3, "synthesis": 1 }})).error.unwrap().contains("already reserved"));
        assert!(commit(&mut state, "wrong-target", json!({ "kind": "task-budget-used", "data": { "root_id": "root-a", "task_id": "child", "amount": 1, "target": "synthesis" }})).error.unwrap().contains("child-pool"));
        assert!(commit(&mut state, "use-pool", json!({ "kind": "task-budget-used", "data": { "root_id": "root-a", "task_id": "child", "amount": 3, "target": "child-pool" }})).error.is_none());
        assert!(commit(&mut state, "overuse", json!({ "kind": "task-budget-used", "data": { "root_id": "root-a", "task_id": "child", "amount": 1, "target": "child-pool" }})).error.unwrap().contains("budget exceeded"));
        let count = state.projections.count().unwrap();
        assert!(commit(&mut state, "overflow", json!({ "kind": "task-budget-used", "data": { "root_id": "root-a", "task_id": "child", "amount": u64::MAX, "target": "child-pool" }})).error.unwrap().contains("budget exceeded"));
        assert_eq!(state.projections.count().unwrap(), count);

        assert!(commit(&mut state, "cancel", json!({ "kind": "task-cancellation-requested", "data": { "root_id": "root-a", "task_id": "child", "reason": "stop" }})).error.is_none());
        assert_eq!(
            state
                .projections
                .task_state("root-a", "child")
                .unwrap()
                .as_deref(),
            Some("cancelled")
        );
        assert!(commit(&mut state, "observe", json!({ "kind": "task-cancellation-observed", "data": { "root_id": "root-a", "task_id": "child" }})).error.is_none());
        assert!(commit(&mut state, "completed-deliverable", json!({ "kind": "task-deliverable-committed", "data": { "root_id": "root-a", "task_id": "child", "status": "completed", "summary": "no", "artifact_ids": [], "changed_paths": [], "test_summary": null }})).error.unwrap().contains("status"));
        assert!(commit(&mut state, "cancelled-deliverable", json!({ "kind": "task-deliverable-committed", "data": { "root_id": "root-a", "task_id": "child", "status": "cancelled", "summary": "yes", "artifact_ids": [], "changed_paths": [], "test_summary": null }})).error.is_none());
        assert!(commit(&mut state, "second-deliverable", json!({ "kind": "task-deliverable-committed", "data": { "root_id": "root-a", "task_id": "child", "status": "cancelled", "summary": "again", "artifact_ids": [], "changed_paths": [], "test_summary": null }})).error.unwrap().contains("duplicate deliverable"));
        assert!(commit(&mut state, "cancel-again", json!({ "kind": "task-cancellation-requested", "data": { "root_id": "root-a", "task_id": "child", "reason": "again" }})).error.unwrap().contains("terminal"));
        let _ = std::fs::remove_dir_all(journal.parent().unwrap());
    }

    #[test]
    fn child_pool_capacity_is_reserved_at_spawn_and_reclaimed_only_after_terminal_state() {
        let (journal, db, blobs) = dirs("task-child-pool-reservation");
        let mut state = SidecarState::open(&journal, &db, &blobs, "ses_1").unwrap();
        let commit = |state: &mut SidecarState, key: &str, kind: Value| {
            handle_request(
                state,
                &req(1, "propose_commit", json!({ "key": key, "kind": kind })),
            )
        };
        let spawned = |task: &str| {
            json!({ "kind": "task-spawned", "data": {
                "root_id": "root", "task_id": task, "parent_task_id": "root-task", "depth": 1,
                "state_changing": true, "dependencies": [], "budget": 20
            }})
        };

        assert!(commit(
            &mut state,
            "root",
            json!({ "kind": "task-spawned", "data": {
                "root_id": "root", "task_id": "root-task", "parent_task_id": null, "depth": 0,
                "state_changing": false, "dependencies": [], "budget": 100, "workspace_directory": "C:\\workspace"
            }})
        )
        .error
        .is_none());
        assert!(commit(&mut state, "root-budget", json!({ "kind": "task-budget-reserved", "data": {
            "root_id": "root", "task_id": "root-task", "parent": 60, "child_pool": 30, "synthesis": 10
        }})).error.is_none());
        assert!(commit(&mut state, "child-a", spawned("child-a"))
            .error
            .is_none());
        assert_eq!(
            commit(&mut state, "child-b", spawned("child-b"))
                .error
                .as_deref(),
            Some("task child-pool budget exceeded")
        );
        assert!(commit(
            &mut state,
            "child-a-running",
            json!({ "kind": "task-state-changed", "data": {
                "root_id": "root", "task_id": "child-a", "state": "running", "reason": null
            }})
        )
        .error
        .is_none());
        assert!(commit(
            &mut state,
            "child-a-failed",
            json!({ "kind": "task-state-changed", "data": {
                "root_id": "root", "task_id": "child-a", "state": "failed", "reason": null
            }})
        )
        .error
        .is_none());
        assert!(commit(
            &mut state,
            "child-a-reclaim",
            json!({ "kind": "task-budget-reclaimed", "data": {
                "root_id": "root", "task_id": "child-a", "amount": 10, "target": "child-pool"
            }})
        )
        .error
        .is_none());
        assert_eq!(
            state
                .projections
                .list_tasks("root", 10)
                .unwrap()
                .into_iter()
                .find(|task| task.task_id == "child-a")
                .unwrap()
                .budget_reclaimed,
            10
        );
        state
            .projections
            .rebuild(&state.journal_dir.clone(), "ses_1")
            .unwrap();
        assert!(
            commit(&mut state, "child-b-after-reclaim", spawned("child-b"))
                .error
                .is_none()
        );
        let _ = std::fs::remove_dir_all(journal.parent().unwrap());
    }

    #[test]
    fn root_scoped_worktrees_mailboxes_and_deliverables_do_not_collide() {
        let (journal, db, blobs) = dirs("task-root-isolation");
        let mut state = SidecarState::open(&journal, &db, &blobs, "ses_1").unwrap();
        let commit = |state: &mut SidecarState, key: &str, kind: Value| {
            handle_request(
                state,
                &req(1, "propose_commit", json!({ "key": key, "kind": kind })),
            )
        };
        for root in ["root-a", "root-b"] {
            assert!(commit(&mut state, &format!("{root}-root"), json!({ "kind": "task-spawned", "data": { "root_id": root, "task_id": "root", "parent_task_id": null, "depth": 0, "state_changing": true, "dependencies": [], "budget": 10, "workspace_directory": "C:\\workspace" }})).error.is_none());
            assert!(commit(&mut state, &format!("{root}-child"), json!({ "kind": "task-spawned", "data": { "root_id": root, "task_id": "child", "parent_task_id": "root", "depth": 1, "state_changing": true, "dependencies": [], "budget": 10 }})).error.is_none());
        }
        assert!(commit(&mut state, "root-worktree", json!({ "kind": "worktree-leased", "data": { "root_id": "root-a", "task_id": "root", "worktree_id": "wt" }})).error.unwrap().contains("eligible"));
        assert!(commit(&mut state, "child-worktree", json!({ "kind": "worktree-leased", "data": { "root_id": "root-a", "task_id": "child", "worktree_id": "wt" }})).error.is_none());
        assert!(commit(&mut state, "other-worktree", json!({ "kind": "worktree-leased", "data": { "root_id": "root-b", "task_id": "child", "worktree_id": "wt" }})).error.is_none());
        for (root, sequence) in [("root-a", 1), ("root-a", 2), ("root-b", 1)] {
            assert!(commit(&mut state, &format!("{root}-message-{sequence}"), json!({ "kind": "mailbox-message-sent", "data": { "root_id": root, "message_id": format!("message-{sequence}"), "sender_task_id": "root", "recipient_task_id": "child", "sequence": sequence, "artifact_ids": [] }})).error.is_none());
        }
        assert!(commit(&mut state, "duplicate-sequence", json!({ "kind": "mailbox-message-sent", "data": { "root_id": "root-a", "message_id": "message-other", "sender_task_id": "root", "recipient_task_id": "child", "sequence": 1, "artifact_ids": [] }})).error.unwrap().contains("mailbox sequence must increase"));
        assert_eq!(
            state
                .projections
                .list_mailbox("root-a", Some("child"), 0, 1)
                .unwrap()[0]
                .sequence,
            1
        );
        assert_eq!(
            state
                .projections
                .list_mailbox("root-a", Some("child"), 1, 1)
                .unwrap()[0]
                .sequence,
            2
        );
        assert!(commit(&mut state, "cross-root-ack", json!({ "kind": "mailbox-message-acknowledged", "data": { "root_id": "root-c", "message_id": "message-1", "recipient_task_id": "child" }})).error.unwrap().contains("unknown task"));
        let _ = std::fs::remove_dir_all(journal.parent().unwrap());
    }

    #[test]
    fn task_mailbox_worktree_and_deliverable_projections_are_durable() {
        let (journal, db, blobs) = dirs("task-projections");
        let mut state = SidecarState::open(&journal, &db, &blobs, "ses_1").unwrap();
        let commit = |state: &mut SidecarState, key: &str, kind: Value| {
            handle_request(
                state,
                &req(1, "propose_commit", json!({ "key": key, "kind": kind })),
            )
        };
        let spawn = |task_id: &str, parent_task_id: Option<&str>| json!({ "kind": "task-spawned", "data": { "root_id": "root-a", "task_id": task_id, "parent_task_id": parent_task_id, "depth": if parent_task_id.is_some() { 1 } else { 0 }, "state_changing": true, "dependencies": [], "budget": 10, "workspace_directory": if parent_task_id.is_none() { Some("C:\\workspace") } else { None } }});

        assert!(commit(&mut state, "root", spawn("root", None))
            .error
            .is_none());
        assert!(
            commit(&mut state, "child-a", spawn("child-a", Some("root")))
                .error
                .is_none()
        );
        assert!(
            commit(&mut state, "child-b", spawn("child-b", Some("root")))
                .error
                .is_none()
        );
        assert!(
            commit(&mut state, "child-c", spawn("child-c", Some("root")))
                .error
                .is_none()
        );
        let count = state.projections.count().unwrap();
        assert!(
            commit(&mut state, "child-d", spawn("child-d", Some("root")))
                .error
                .unwrap()
                .contains("three children")
        );
        assert_eq!(state.projections.count().unwrap(), count);
        assert!(commit(&mut state, "invalid-pending", json!({ "kind": "task-state-changed", "data": { "root_id": "root-a", "task_id": "child-a", "state": "completed", "reason": null }})).error.unwrap().contains("invalid task-state transition"));
        assert!(commit(&mut state, "wrong-root-cancel", json!({ "kind": "task-cancellation-requested", "data": { "root_id": "root-b", "task_id": "child-a", "reason": "stop" }})).error.unwrap().contains("unknown task"));
        assert!(commit(&mut state, "reserve", json!({ "kind": "task-budget-reserved", "data": { "root_id": "root-a", "task_id": "child-a", "parent": 6, "child_pool": 3, "synthesis": 1 }})).error.is_none());
        assert!(commit(&mut state, "used", json!({ "kind": "task-budget-used", "data": { "root_id": "root-a", "task_id": "child-a", "amount": 1, "target": "child-pool" }})).error.is_none());
        assert!(commit(&mut state, "cancel-request", json!({ "kind": "task-cancellation-requested", "data": { "root_id": "root-a", "task_id": "child-a", "reason": "stop" }})).error.is_none());
        assert!(commit(&mut state, "cancel-observed", json!({ "kind": "task-cancellation-observed", "data": { "root_id": "root-a", "task_id": "child-a" }})).error.is_none());

        assert!(commit(&mut state, "running", json!({ "kind": "task-state-changed", "data": { "root_id": "root-a", "task_id": "root", "state": "running", "reason": null }})).error.is_none());
        assert!(commit(&mut state, "completed", json!({ "kind": "task-state-changed", "data": { "root_id": "root-a", "task_id": "root", "state": "completed", "reason": null }})).error.is_none());
        let count = state.projections.count().unwrap();
        assert!(commit(&mut state, "terminal-transition", json!({ "kind": "task-state-changed", "data": { "root_id": "root-a", "task_id": "root", "state": "running", "reason": null }})).error.unwrap().contains("invalid task-state transition"));
        assert_eq!(state.projections.count().unwrap(), count);
        assert_eq!(commit(&mut state, "running", json!({ "kind": "task-state-changed", "data": { "root_id": "root-a", "task_id": "root", "state": "running", "reason": null }})).result.unwrap()["duplicate"], true);

        assert!(commit(&mut state, "lease", json!({ "kind": "worktree-leased", "data": { "root_id": "root-a", "task_id": "child-a", "worktree_id": "wt-a" }})).error.is_none());
        assert!(commit(&mut state, "collision", json!({ "kind": "worktree-leased", "data": { "root_id": "root-a", "task_id": "child-b", "worktree_id": "wt-a" }})).error.unwrap().contains("collision"));
        assert!(commit(&mut state, "bad-release", json!({ "kind": "worktree-released", "data": { "root_id": "root-a", "task_id": "child-b", "worktree_id": "wt-a" }})).error.unwrap().contains("mismatch"));
        assert!(commit(&mut state, "release", json!({ "kind": "worktree-released", "data": { "root_id": "root-a", "task_id": "child-a", "worktree_id": "wt-a" }})).error.is_none());

        for sequence in [1, 2] {
            assert!(commit(&mut state, &format!("message-{sequence}"), json!({ "kind": "mailbox-message-sent", "data": { "root_id": "root-a", "message_id": format!("message-{sequence}"), "sender_task_id": "root", "recipient_task_id": "child-a", "sequence": sequence, "artifact_ids": ["art"] }})).error.is_none());
        }
        assert_eq!(
            state
                .projections
                .list_mailbox("root-a", Some("child-a"), 0, 100)
                .unwrap()
                .iter()
                .map(|message| message.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert!(commit(&mut state, "duplicate-message", json!({ "kind": "mailbox-message-sent", "data": { "root_id": "root-a", "message_id": "message-1", "sender_task_id": "root", "recipient_task_id": "child-a", "sequence": 3, "artifact_ids": [] }})).error.unwrap().contains("duplicate mailbox"));
        assert!(commit(&mut state, "bad-ack", json!({ "kind": "mailbox-message-acknowledged", "data": { "root_id": "root-a", "message_id": "message-1", "recipient_task_id": "child-b" }})).error.unwrap().contains("mismatch"));
        assert!(commit(&mut state, "ack", json!({ "kind": "mailbox-message-acknowledged", "data": { "root_id": "root-a", "message_id": "message-1", "recipient_task_id": "child-a" }})).error.is_none());

        assert!(commit(&mut state, "nonterminal-deliverable", json!({ "kind": "task-deliverable-committed", "data": { "root_id": "root-a", "task_id": "child-a", "status": "completed", "summary": "no", "artifact_ids": [], "changed_paths": [], "test_summary": null }})).error.unwrap().contains("terminal"));
        assert!(commit(&mut state, "deliverable", json!({ "kind": "task-deliverable-committed", "data": { "root_id": "root-a", "task_id": "root", "status": "completed", "summary": "yes", "artifact_ids": ["art"], "changed_paths": ["src/a"], "test_summary": "ok" }})).error.is_none());
        let live_tasks = state.projections.list_tasks("root-a", 500).unwrap();
        let child_a = live_tasks
            .iter()
            .find(|task| task.task_id == "child-a")
            .unwrap();
        assert_eq!(
            (
                child_a.reserved_parent,
                child_a.reserved_child_pool,
                child_a.reserved_synthesis,
                child_a.budget_used,
            ),
            (6, 3, 1, 1)
        );
        let live_mailbox = state
            .projections
            .list_mailbox("root-a", None, 0, 500)
            .unwrap();
        let live_deliverables = state
            .projections
            .list_task_deliverables("root-a", 500)
            .unwrap();
        state.projections.rebuild(&journal, "ses_1").unwrap();
        assert_eq!(
            state.projections.list_tasks("root-a", 500).unwrap(),
            live_tasks
        );
        assert_eq!(
            state
                .projections
                .list_mailbox("root-a", None, 0, 500)
                .unwrap(),
            live_mailbox
        );
        assert_eq!(
            state
                .projections
                .list_task_deliverables("root-a", 500)
                .unwrap(),
            live_deliverables
        );
        let _ = std::fs::remove_dir_all(journal.parent().unwrap());
    }

    #[test]
    fn mailbox_evidence_survives_rebuild_and_rejects_oversized_input_before_append() {
        let (journal, db, blobs) = dirs("mailbox-evidence");
        let mut state = SidecarState::open(&journal, &db, &blobs, "ses_1").unwrap();
        for task_id in ["sender", "recipient"] {
            assert!(handle_request(
                &mut state,
                &req(1, "propose_commit", json!({ "key": task_id, "kind": { "kind": "task-spawned", "data": { "root_id": "root", "task_id": task_id, "parent_task_id": null, "depth": 0, "state_changing": true, "dependencies": [], "budget": 10, "workspace_directory": "C:\\workspace" } } }))
            )
            .error
            .is_none());
        }
        let message = json!({ "kind": "mailbox-message-sent", "data": {
            "root_id": "root", "message_id": "evidence", "sender_task_id": "sender", "recipient_task_id": "recipient", "sequence": 1,
            "summary": "implemented durable evidence", "artifact_ids": ["art-1"], "changed_paths": ["src/a.rs"], "test_summary": "cargo test", "blocked_reason": null
        }});
        assert!(handle_request(
            &mut state,
            &req(
                2,
                "propose_commit",
                json!({ "key": "evidence", "kind": message })
            )
        )
        .error
        .is_none());
        let live = state
            .projections
            .list_mailbox("root", Some("recipient"), 0, 100)
            .unwrap();
        state.projections.rebuild(&journal, "ses_1").unwrap();
        assert_eq!(
            state
                .projections
                .list_mailbox("root", Some("recipient"), 0, 100)
                .unwrap(),
            live
        );
        let evidence = serde_json::to_value(&live[0]).unwrap();
        assert_eq!(evidence["summary"], "implemented durable evidence");
        assert_eq!(evidence["changed_paths"], json!(["src/a.rs"]));
        assert_eq!(evidence["test_summary"], "cargo test");
        assert_eq!(evidence["blocked_reason"], Value::Null);

        let count = state.projections.count().unwrap();
        let rejected = handle_request(
            &mut state,
            &req(
                3,
                "propose_commit",
                json!({ "key": "too-large", "kind": { "kind": "mailbox-message-sent", "data": {
                "root_id": "root", "message_id": "too-large", "sender_task_id": "sender", "recipient_task_id": "recipient", "sequence": 2,
                "summary": "x".repeat(4097), "artifact_ids": [], "changed_paths": [], "test_summary": null, "blocked_reason": null
            } } }),
            ),
        );
        assert_eq!(
            rejected.error.as_deref(),
            Some("invalid mailbox evidence: summary exceeds 4096 bytes")
        );
        assert_eq!(state.projections.count().unwrap(), count);
        let _ = std::fs::remove_dir_all(journal.parent().unwrap());
    }

    #[test]
    fn mailbox_sequences_are_monotonic_after_restart() {
        let (journal, db, blobs) = dirs("mailbox-restart");
        let mut state = SidecarState::open(&journal, &db, &blobs, "ses_1").unwrap();
        for task_id in ["sender", "recipient"] {
            assert!(handle_request(&mut state, &req(1, "propose_commit", json!({ "key": task_id, "kind": { "kind": "task-spawned", "data": { "root_id": "root", "task_id": task_id, "parent_task_id": null, "depth": 0, "state_changing": true, "dependencies": [], "budget": 10, "workspace_directory": "C:\\workspace" } } }))).error.is_none());
        }
        assert!(handle_request(&mut state, &req(2, "propose_commit", json!({ "key": "two", "kind": { "kind": "mailbox-message-sent", "data": { "root_id": "root", "message_id": "two", "sender_task_id": "sender", "recipient_task_id": "recipient", "sequence": 2, "artifact_ids": [] } } }))).error.is_none());
        drop(state);
        let mut state = SidecarState::open(&journal, &db, &blobs, "ses_1").unwrap();
        let count = state.projections.count().unwrap();
        let rejected = handle_request(
            &mut state,
            &req(
                3,
                "propose_commit",
                json!({ "key": "one", "kind": { "kind": "mailbox-message-sent", "data": { "root_id": "root", "message_id": "one", "sender_task_id": "sender", "recipient_task_id": "recipient", "sequence": 1, "artifact_ids": [] } } }),
            ),
        );
        assert_eq!(
            rejected.error.as_deref(),
            Some("mailbox sequence must increase")
        );
        assert_eq!(state.projections.count().unwrap(), count);
        let _ = std::fs::remove_dir_all(journal.parent().unwrap());
    }

    #[test]
    fn mailbox_cursor_requires_recipient_task_id() {
        let (journal, db, blobs) = dirs("mailbox-cursor");
        let mut state = SidecarState::open(&journal, &db, &blobs, "ses_1").unwrap();
        for task_id in ["sender", "a", "b"] {
            assert!(handle_request(&mut state, &req(1, "propose_commit", json!({ "key": task_id, "kind": { "kind": "task-spawned", "data": { "root_id": "root", "task_id": task_id, "parent_task_id": null, "depth": 0, "state_changing": true, "dependencies": [], "budget": 10, "workspace_directory": "C:\\workspace" } } }))).error.is_none());
        }
        for recipient in ["a", "b"] {
            assert!(handle_request(&mut state, &req(2, "propose_commit", json!({ "key": format!("message-{recipient}"), "kind": { "kind": "mailbox-message-sent", "data": { "root_id": "root", "message_id": format!("message-{recipient}"), "sender_task_id": "sender", "recipient_task_id": recipient, "sequence": 1, "artifact_ids": [] } } }))).error.is_none());
        }
        assert_eq!(
            handle_request(
                &mut state,
                &req(
                    3,
                    "list_mailbox",
                    json!({ "root_id": "root", "workspace_directory": "C:\\workspace" })
                )
            )
            .result
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
            2
        );
        assert_eq!(
            handle_request(
                &mut state,
                &req(
                    4,
                    "list_mailbox",
                    json!({ "root_id": "root", "workspace_directory": "C:\\workspace", "after_sequence": 1 })
                )
            )
            .error
            .as_deref(),
            Some("mailbox cursor requires recipient_task_id")
        );
        let _ = std::fs::remove_dir_all(journal.parent().unwrap());
    }

    #[test]
    fn task_queries_default_and_clamp_to_two_hundred_items() {
        let (journal, db, blobs) = dirs("task-query-bounds");
        let mut state = SidecarState::open(&journal, &db, &blobs, "ses_1").unwrap();
        for index in 0..201 {
            let task_id = format!("task-{index:03}");
            let spawned = handle_request(
                &mut state,
                &req(
                    index * 3 + 1,
                    "propose_commit",
                    json!({ "key": format!("spawn-{index}"), "kind": { "kind": "task-spawned", "data": { "root_id": "root-bounds", "task_id": task_id, "parent_task_id": null, "depth": 0, "state_changing": false, "dependencies": [], "budget": 1, "workspace_directory": "C:\\workspace" } } }),
                ),
            );
            assert!(spawned.error.is_none());
            let running = handle_request(
                &mut state,
                &req(
                    index * 3 + 2,
                    "propose_commit",
                    json!({ "key": format!("running-{index}"), "kind": { "kind": "task-state-changed", "data": { "root_id": "root-bounds", "task_id": task_id, "state": "running", "reason": null } } }),
                ),
            );
            assert!(running.error.is_none());
            let completed = handle_request(
                &mut state,
                &req(
                    index * 3 + 3,
                    "propose_commit",
                    json!({ "key": format!("completed-{index}"), "kind": { "kind": "task-state-changed", "data": { "root_id": "root-bounds", "task_id": task_id, "state": "completed", "reason": null } } }),
                ),
            );
            assert!(completed.error.is_none());
            let deliverable = handle_request(
                &mut state,
                &req(
                    1_000 + index,
                    "propose_commit",
                    json!({ "key": format!("deliverable-{index}"), "kind": { "kind": "task-deliverable-committed", "data": { "root_id": "root-bounds", "task_id": task_id, "status": "completed", "summary": "done", "artifact_ids": [], "changed_paths": [], "test_summary": null } } }),
                ),
            );
            assert!(deliverable.error.is_none());
        }
        for sequence in 1..=201 {
            let message = handle_request(
                &mut state,
                &req(
                    2_000 + sequence,
                    "propose_commit",
                    json!({ "key": format!("message-{sequence}"), "kind": { "kind": "mailbox-message-sent", "data": { "root_id": "root-bounds", "message_id": format!("message-{sequence}"), "sender_task_id": "task-000", "recipient_task_id": "task-001", "sequence": sequence, "artifact_ids": [] } } }),
                ),
            );
            assert!(message.error.is_none());
        }
        let tasks = handle_request(
            &mut state,
            &req(
                3_000,
                "list_tasks",
                json!({ "root_id": "root-bounds", "workspace_directory": "C:\\workspace", "limit": 500 }),
            ),
        )
        .result
        .unwrap();
        let mailbox = handle_request(
            &mut state,
            &req(
                3_001,
                "list_mailbox",
                json!({ "root_id": "root-bounds", "workspace_directory": "C:\\workspace", "limit": 500 }),
            ),
        )
        .result
        .unwrap();
        let deliverables = handle_request(
            &mut state,
            &req(
                3_002,
                "list_task_deliverables",
                json!({ "root_id": "root-bounds", "workspace_directory": "C:\\workspace", "limit": 500 }),
            ),
        )
        .result
        .unwrap();
        assert_eq!(tasks.as_array().unwrap().len(), 200);
        assert_eq!(mailbox.as_array().unwrap().len(), 200);
        assert_eq!(deliverables.as_array().unwrap().len(), 200);
        assert_eq!(
            handle_request(
                &mut state,
                &req(
                    3_003,
                    "list_tasks",
                    json!({ "root_id": "root-bounds", "workspace_directory": "C:\\workspace" })
                )
            )
            .result
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
            100
        );
        let _ = std::fs::remove_dir_all(journal.parent().unwrap());
    }
}
