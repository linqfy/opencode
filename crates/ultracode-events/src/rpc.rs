//! Newline-delimited JSON-RPC for the event sidecar (spec sections 5 and 11).
//! All wire serialization lives here; committed domain types are not modified.

use crate::artifacts::{ArtifactStore, CredentialClass, Retention};
use crate::commit::{CommitLog, CommitOutcome};
use crate::effect::{self, ReconcileAction};
use crate::event::EventKind;
use crate::projections::ProjectionStore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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
        Ok(SidecarState {
            commit,
            projections,
            artifacts,
            journal_dir: journal_dir.to_path_buf(),
            session: session.to_string(),
        })
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn hex_decode(text: &str) -> Result<Vec<u8>, String> {
    if text.len() % 2 != 0 {
        return Err("hex length must be even".to_string());
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

fn retention_from_str(value: &str) -> Retention {
    Retention::from_str(value).unwrap_or(Retention::Workspace)
}

fn credential_from_str(value: &str) -> CredentialClass {
    CredentialClass::from_str(value).unwrap_or(CredentialClass::Plain)
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
            state.projections.validate_memory_result(&kind)?;
            let outcome = state.commit.propose(key, kind).map_err(|e| e.to_string())?;
            let (record, duplicate) = match outcome {
                CommitOutcome::Committed(r) => (r, false),
                CommitOutcome::Duplicate(r) => (r, true),
            };
            state
                .projections
                .index_record(&record)
                .map_err(|e| e.to_string())?;
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

        "claim_memory_job" => match state
            .projections
            .claim_memory_job()
            .map_err(|e| e.to_string())?
        {
            None => Ok(Value::Null),
            Some(job) => serde_json::to_value(job).map_err(|e| e.to_string()),
        },

        "fail_memory_job" => {
            let request_id = req
                .params
                .get("request_id")
                .and_then(|value| value.as_str())
                .ok_or("missing request_id")?;
            req.params
                .get("reason")
                .and_then(|value| value.as_str())
                .ok_or("missing reason")?;
            let ok = state
                .projections
                .fail_memory_job(request_id)
                .map_err(|e| e.to_string())?;
            Ok(json!({ "ok": ok }))
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
    fn memory_rpcs_list_claim_and_fail_without_a_second_mutation_protocol() {
        let (journal, db, blobs) = dirs("memory");
        let mut state = SidecarState::open(&journal, &db, &blobs, "ses_1").unwrap();
        let missing = handle_request(&mut state, &req(1, "fail_memory_job", json!({})));
        assert_eq!(missing.error.as_deref(), Some("missing request_id"));

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
                3,
                "propose_commit",
                json!({ "key": "request", "kind": requested })
            )
        )
        .error
        .is_none());
        let claimed = handle_request(&mut state, &req(4, "claim_memory_job", json!({})))
            .result
            .unwrap();
        assert_eq!(claimed["request_id"], "req-a");
        assert_eq!(
            handle_request(
                &mut state,
                &req(
                    5,
                    "fail_memory_job",
                    json!({ "request_id": "req-a", "reason": "retry" })
                )
            )
            .result
            .unwrap()["ok"],
            true
        );
        assert_eq!(
            handle_request(&mut state, &req(6, "claim_memory_job", json!({})))
                .result
                .unwrap()["request_id"],
            "req-a"
        );

        let extracted = json!({ "kind": "memory-extracted", "data": {
            "request_id": "req-a", "thread_id": "thread-a", "source_updated_at": 1,
            "raw_memory": "raw", "rollout_summary": "summary", "rollout_slug": null,
            "cwd": "/repo", "git_branch": null, "generated_at": 2
        }});
        assert!(handle_request(
            &mut state,
            &req(
                7,
                "propose_commit",
                json!({ "key": "result", "kind": extracted })
            )
        )
        .error
        .is_none());
        assert_eq!(
            handle_request(&mut state, &req(8, "claim_memory_job", json!({})))
                .result
                .unwrap(),
            Value::Null
        );
        let records = handle_request(
            &mut state,
            &req(9, "list_memory_records", json!({ "limit": 500 })),
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
            &req(10, "list_memory_records", json!({ "limit": 500 })),
        )
        .result
        .unwrap();
        assert_eq!(limited.as_array().unwrap().len(), 200);
        let _ = std::fs::remove_dir_all(journal.parent().unwrap());
    }
}
