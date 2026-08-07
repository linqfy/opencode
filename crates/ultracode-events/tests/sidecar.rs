//! Spawns the real sidecar binary and round-trips every method over stdio.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

struct Sidecar {
    child: Child,
}

impl Sidecar {
    fn spawn(base: &std::path::Path) -> Sidecar {
        let bin = env!("CARGO_BIN_EXE_sidecar");
        let child = Command::new(bin)
            .arg("--journal-dir")
            .arg(base.join("journal"))
            .arg("--db")
            .arg(base.join("proj.db"))
            .arg("--artifacts")
            .arg(base.join("blobs"))
            .arg("--session")
            .arg("ses_1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sidecar");
        Sidecar { child }
    }

    fn call(&mut self, id: u64, method: &str, params: Value) -> Value {
        let request = json!({ "id": id, "method": method, "params": params });
        let mut line = serde_json::to_string(&request).unwrap();
        line.push('\n');
        {
            let stdin = self.child.stdin.as_mut().unwrap();
            stdin.write_all(line.as_bytes()).unwrap();
            stdin.flush().unwrap();
        }
        let stdout = self.child.stdout.as_mut().unwrap();
        let mut reader = BufReader::new(stdout);
        let mut response = String::new();
        reader.read_line(&mut response).unwrap();
        serde_json::from_str(&response).unwrap()
    }

    fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn base(name: &str) -> PathBuf {
    let base =
        std::env::temp_dir().join(format!("ultracode-sidecar-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    base
}

#[test]
fn sidecar_serves_the_full_method_surface() {
    let dir = base("surface");
    let mut sidecar = Sidecar::spawn(&dir);

    let pong = sidecar.call(1, "ping", json!({}));
    assert_eq!(pong["result"]["ok"], true);

    let kind =
        json!({ "kind": "session-started", "data": { "client": "test", "client_version": "0" } });
    let committed = sidecar.call(2, "propose_commit", json!({ "key": "cmd_a", "kind": kind }));
    assert_eq!(committed["result"]["seq"], 1);
    assert_eq!(committed["result"]["duplicate"], false);

    let retry = sidecar.call(3, "propose_commit", json!({ "key": "cmd_a", "kind": kind }));
    assert_eq!(retry["result"]["duplicate"], true);

    let listed = sidecar.call(4, "list_events", json!({ "session": "ses_1" }));
    assert_eq!(listed["result"].as_array().unwrap().len(), 1);

    let bytes_hex = "68656c6c6f"; // "hello"
    let put = sidecar.call(
        5,
        "put_artifact",
        json!({ "bytes_hex": bytes_hex, "mime": "text/plain", "owner_scope": "ses_1", "retention": "workspace", "credential_class": "plain" }),
    );
    let artifact_id = put["result"]["artifact_id"].as_str().unwrap().to_string();

    let read = sidecar.call(
        6,
        "open_range",
        json!({ "artifact_id": artifact_id, "scope": "ses_1", "start": 0, "end": 5 }),
    );
    assert_eq!(read["result"]["bytes_hex"], "68656c6c6f");

    let reconciled = sidecar.call(7, "reconcile_effects", json!({ "unclean_stop": true }));
    assert!(
        reconciled["result"].as_array().unwrap().is_empty(),
        "no side effects were prepared"
    );

    sidecar.kill();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn sidecar_state_survives_a_restart() {
    let dir = base("restart");

    // First lifetime: commit an event.
    {
        let mut sidecar = Sidecar::spawn(&dir);
        let kind = json!({ "kind": "turn-started", "data": { "turn": 1 } });
        sidecar.call(1, "propose_commit", json!({ "key": "cmd_a", "kind": kind }));
        sidecar.kill();
    }

    // Second lifetime: the projection is rebuilt from the journal on open.
    {
        let mut sidecar = Sidecar::spawn(&dir);
        let listed = sidecar.call(1, "list_events", json!({ "session": "ses_1" }));
        assert_eq!(
            listed["result"].as_array().unwrap().len(),
            1,
            "event survives the restart"
        );
        // Idempotency also survives: the same key is still a duplicate.
        let kind = json!({ "kind": "turn-started", "data": { "turn": 1 } });
        let retry = sidecar.call(2, "propose_commit", json!({ "key": "cmd_a", "kind": kind }));
        assert_eq!(retry["result"]["duplicate"], true);
        sidecar.kill();
    }

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn memory_review_patch_and_delete_survive_a_restart() {
    let dir = base("memory-review-durable");
    let extract = |request_id: &str, thread_id: &str| {
        json!({ "kind": "memory-extracted", "data": {
            "request_id": request_id, "thread_id": thread_id, "source_updated_at": 1,
            "raw_memory": "raw", "rollout_summary": "summary", "rollout_slug": null,
            "cwd": "/repo", "git_branch": null, "generated_at": 2
        }})
    };

    {
        let mut sidecar = Sidecar::spawn(&dir);
        for (request_id, thread_id) in [("req-a", "thread-a"), ("req-b", "thread-b")] {
            let requested = json!({ "kind": "memory-extraction-requested", "data": {
                "request_id": request_id, "source_session": "ses_1", "source_turn": 1,
                "source_end_seq": 1, "transcript_artifact_id": "art-a", "extractor_version": "v1"
            }});
            assert!(sidecar.call(
                1,
                "propose_commit",
                json!({ "key": format!("request-{request_id}"), "kind": requested })
            )["error"]
                .is_null());
            assert!(sidecar.call(2, "claim_memory_job", json!({}))["result"]["request_id"]
                .as_str()
                .is_some());
            assert!(sidecar.call(
                3,
                "propose_commit",
                json!({ "key": format!("result-{request_id}"), "kind": extract(request_id, thread_id) })
            )["error"]
                .is_null());
        }
        let patched = sidecar.call(
            4,
            "patch_memory_record",
            json!({ "thread_id": "thread-a", "rollout_summary": "reviewed" }),
        );
        assert!(patched["error"].is_null());
        let deleted = sidecar.call(5, "delete_memory_record", json!({ "thread_id": "thread-b" }));
        assert!(deleted["error"].is_null());
        sidecar.kill();
    }

    {
        let mut sidecar = Sidecar::spawn(&dir);
        let a = sidecar.call(1, "get_memory_record", json!({ "thread_id": "thread-a" }));
        assert_eq!(a["result"]["rollout_summary"], "reviewed");
        assert_eq!(a["result"]["edited_by"], "user");
        assert!(a["result"]["edited_at"].is_u64());
        let b = sidecar.call(2, "get_memory_record", json!({ "thread_id": "thread-b" }));
        assert!(b["result"].is_null(), "delete tombstone survives restart");
        let listed = sidecar.call(3, "list_memory_records", json!({}));
        assert_eq!(listed["result"].as_array().unwrap().len(), 1);
        sidecar.kill();
    }

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn task_roots_are_bound_to_their_workspace_across_rebuilds() {
    let dir = base("root-workspace");
    let root = json!({
        "kind": "task-spawned",
        "data": {
            "root_id": "root_a",
            "task_id": "root_a",
            "parent_task_id": null,
            "depth": 0,
            "state_changing": false,
            "dependencies": [],
            "budget": 100,
            "workspace_directory": "C:\\workspace-a"
        }
    });

    {
        let mut sidecar = Sidecar::spawn(&dir);
        assert!(sidecar.call(
            1,
            "propose_commit",
            json!({ "key": "root-a", "kind": root })
        )["error"]
            .is_null());
        let tasks = sidecar.call(
            2,
            "list_tasks",
            json!({ "root_id": "root_a", "workspace_directory": "C:\\workspace-a" }),
        );
        assert_eq!(tasks["result"].as_array().unwrap().len(), 1);
        let denied = sidecar.call(
            3,
            "list_tasks",
            json!({ "root_id": "root_a", "workspace_directory": "C:\\workspace-b" }),
        );
        assert_eq!(denied["result"], json!([]));
        let mismatch = sidecar.call(
            4,
            "propose_commit",
            json!({
                "key": "root-a-mismatch",
                "kind": {
                    "kind": "task-spawned",
                    "data": {
                        "root_id": "root_a",
                        "task_id": "root_a",
                        "parent_task_id": null,
                        "depth": 0,
                        "state_changing": false,
                        "dependencies": [],
                        "budget": 100,
                        "workspace_directory": "C:\\workspace-b"
                    }
                }
            }),
        );
        assert_eq!(mismatch["error"], "root workspace mismatch");
        sidecar.kill();
    }

    let mut sidecar = Sidecar::spawn(&dir);
    let rebuilt = sidecar.call(1, "rebuild_projections", json!({}));
    assert!(rebuilt["result"]["count"].as_u64().unwrap() >= 1);
    let tasks = sidecar.call(
        2,
        "list_tasks",
        json!({ "root_id": "root_a", "workspace_directory": "C:\\workspace-a" }),
    );
    assert_eq!(tasks["result"].as_array().unwrap().len(), 1);
    sidecar.kill();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn approval_history_is_rebuildable_paged_and_scope_filtered() {
    let dir = base("approval-history");
    let mut sidecar = Sidecar::spawn(&dir);
    for (id, scope, expires_at) in [
        ("approval-1", "session", 1234),
        ("approval-2", "project", 5678),
    ] {
        let response = sidecar.call(
            id.as_bytes()[id.len() - 1] as u64,
            "propose_commit",
            json!({
                "key": id,
                "kind": {
                    "kind": "approval-finalized",
                    "data": {
                        "approval_id": id,
                        "session_id": "ses_1",
                        "reply": "session",
                        "decision": "allow",
                        "profile": "restricted",
                        "profile_version": "4",
                        "grant_scope": scope,
                        "grant_resources": ["src/*"],
                        "expires_at": expires_at,
                        "agent": "test",
                        "turn": "turn_1",
                        "recorded_at": 100,
                        "workspace_directory": "C:\\workspace",
                        "project_id": "project"
                    }
                }
            }),
        );
        assert!(response["error"].is_null());
    }
    let page = sidecar.call(
        3,
        "list_approval_history",
        json!({ "workspace_directory": "C:\\workspace", "project_id": "project", "limit": 1 }),
    );
    assert_eq!(page["result"]["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["result"]["items"][0]["expires_at"], 1234);
    assert_eq!(page["result"]["items"][0]["profile_version"], "4");
    sidecar.kill();

    let mut restarted = Sidecar::spawn(&dir);
    let history = restarted.call(
        1,
        "list_approval_history",
        json!({ "workspace_directory": "C:\\workspace", "limit": 10 }),
    );
    assert_eq!(history["result"]["items"].as_array().unwrap().len(), 2);
    restarted.kill();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn approval_audit_requires_authoritative_scope_and_keeps_same_ids_isolated() {
    let dir = base("approval-scope-authority");
    let mut sidecar = Sidecar::spawn(&dir);
    let missing = sidecar.call(
        1,
        "propose_commit",
        json!({
            "key": "missing-scope",
            "kind": { "kind": "approval-finalized", "data": {
                "approval_id": "same", "session_id": "ses-a", "reply": "session", "decision": "allow",
                "grant_resources": [], "recorded_at": 1
            }}
        }),
    );
    assert_eq!(missing["error"], "approval audit scope is required");

    for (key, workspace, project, recorded_at) in [
        ("approval-a", "C:\\workspace-a", "project-a", 2),
        ("approval-b", "C:\\workspace-b", "project-b", 1),
        ("approval-c", "C:\\workspace-a", "project-a", 1),
    ] {
        let response = sidecar.call(
            recorded_at + 10,
            "propose_commit",
            json!({ "key": key, "kind": { "kind": "approval-finalized", "data": {
                "approval_id": if key == "approval-c" { "other" } else { "same" }, "session_id": key, "reply": "session", "decision": "allow",
                "grant_resources": [], "workspace_directory": workspace, "project_id": project,
                "recorded_at": recorded_at
            }}}),
        );
        assert!(response["error"].is_null(), "{response}");
    }

    let first = sidecar.call(
        20,
        "list_approval_history",
        json!({
            "workspace_directory": "C:\\workspace-a", "limit": 1
        }),
    );
    assert_eq!(first["result"]["items"].as_array().unwrap().len(), 1);
    assert_eq!(first["result"]["items"][0]["recorded_at"], 2);
    let cursor = first["result"]["next_cursor"].as_str().unwrap();
    let second = sidecar.call(
        21,
        "list_approval_history",
        json!({
            "workspace_directory": "C:\\workspace-a", "cursor": cursor, "limit": 1
        }),
    );
    assert_eq!(
        second["result"]["items"].as_array().unwrap().len(),
        1,
        "{second}"
    );
    assert_eq!(second["result"]["items"][0]["recorded_at"], 1);
    let mismatch = sidecar.call(
        22,
        "list_approval_history",
        json!({
            "workspace_directory": "C:\\workspace-b", "project_id": "project-a", "limit": 10
        }),
    );
    assert_eq!(mismatch["result"]["items"], json!([]));
    sidecar.kill();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn legacy_unscoped_approval_audit_rows_are_not_queryable() {
    let dir = base("approval-legacy");
    {
        let mut commit =
            ultracode_events::commit::CommitLog::open(&dir.join("journal"), "ses_1").unwrap();
        commit
            .propose(
                "legacy-approval",
                ultracode_events::event::EventKind::ApprovalFinalized {
                    approval_id: "legacy".into(),
                    session_id: "ses_legacy".into(),
                    reply: "session".into(),
                    decision: "allow".into(),
                    profile: None,
                    profile_version: None,
                    grant_scope: None,
                    grant_resources: vec![],
                    expires_at: None,
                    agent: None,
                    turn: None,
                    recorded_at: 1,
                    workspace_directory: None,
                    project_id: None,
                },
            )
            .unwrap();
    }
    let mut sidecar = Sidecar::spawn(&dir);
    let history = sidecar.call(
        1,
        "list_approval_history",
        json!({
            "workspace_directory": "C:\\workspace", "limit": 10
        }),
    );
    assert_eq!(history["result"]["items"], json!([]));
    sidecar.kill();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn stage7_read_pages_are_scoped_and_cursor_stable() {
    let dir = base("stage7-read-pages");
    let mut sidecar = Sidecar::spawn(&dir);
    for (root, workspace, task) in [
        ("root-a", "C:\\workspace-a", "task-a"),
        ("root-b", "C:\\workspace-b", "task-b"),
    ] {
        let response = sidecar.call(
            task.as_bytes()[task.len() - 1] as u64,
            "propose_commit",
            json!({ "key": task, "kind": { "kind": "task-spawned", "data": {
                "root_id": root, "task_id": task, "parent_task_id": null, "depth": 0,
                "state_changing": false, "dependencies": [], "budget": 10,
                "workspace_directory": workspace
            }}}),
        );
        assert!(response["error"].is_null(), "{response}");
    }
    let second_task = sidecar.call(
        3,
        "propose_commit",
        json!({ "key": "task-a-2", "kind": { "kind": "task-spawned", "data": {
            "root_id": "root-a", "task_id": "task-a-2", "parent_task_id": "task-a", "depth": 1,
            "state_changing": false, "dependencies": ["task-a"], "budget": 5
        }}}),
    );
    assert!(second_task["error"].is_null(), "{second_task}");
    let first = sidecar.call(
        10,
        "query_task_graph",
        json!({
            "root_id": "root-a", "workspace_directory": "C:\\workspace-a", "limit": 1
        }),
    );
    assert_eq!(first["result"]["tasks"].as_array().unwrap().len(), 1);
    let cursor = first["result"]["next_cursor"].as_str().unwrap();
    let second = sidecar.call(11, "query_task_graph", json!({
        "root_id": "root-a", "workspace_directory": "C:\\workspace-a", "cursor": cursor, "limit": 1
    }));
    assert_eq!(second["result"]["tasks"][0]["task_id"], "task-a-2");
    assert_eq!(
        second["result"]["edges"],
        json!([{ "task_id": "task-a-2", "dependency_task_id": "task-a" }])
    );
    assert!(second["result"]["next_cursor"].is_null());

    let mismatch = sidecar.call(
        12,
        "query_task_graph",
        json!({
            "root_id": "root-a", "workspace_directory": "C:\\workspace-b", "limit": 1
        }),
    );
    assert_eq!(
        mismatch["result"],
        json!({"tasks": [], "edges": [], "next_cursor": null})
    );

    let deliverables = sidecar.call(
        13,
        "query_task_deliverables",
        json!({
            "root_id": "root-a", "workspace_directory": "C:\\workspace-a", "limit": 1
        }),
    );
    assert_eq!(deliverables["result"]["items"], json!([]));
    assert!(deliverables["result"].get("bytes").is_none());
    sidecar.kill();
    let _ = std::fs::remove_dir_all(&dir);
}
