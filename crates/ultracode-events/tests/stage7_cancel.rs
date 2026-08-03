use serde_json::json;
use ultracode_events::rpc::{handle_request, Request, SidecarState};

#[test]
fn cancellation_requires_scope_and_is_idempotent() {
    let dir = std::env::temp_dir().join(format!("ultracode-stage7-cancel-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let journal = dir.join("journal");
    let db = dir.join("events.db");
    let artifacts = dir.join("artifacts");
    let mut state = SidecarState::open(&journal, &db, &artifacts, "session").unwrap();
    let root = handle_request(
        &mut state,
        &Request {
            id: 0,
            method: "propose_commit".into(),
            params: json!({
                "key": "spawn-root",
                "kind": { "kind": "task-spawned", "data": {
                    "root_id": "root", "task_id": "task", "parent_task_id": null, "depth": 0,
                    "state_changing": false, "dependencies": [], "budget": 10,
                    "workspace_directory": "C:\\workspace"
                }}
            }),
        },
    );
    assert!(root.error.is_none());
    let response = handle_request(
        &mut state,
        &Request {
            id: 1,
            method: "cancel_task".into(),
            params: json!({
                "root_id": "root",
                "task_id": "task",
                "workspace_directory": "C:\\workspace",
                "reason": "stop",
                "idempotency_key": "cancel:root:task"
            }),
        },
    );
    assert_eq!(response.result.unwrap()["state"], "cancellation_pending");
    let duplicate = handle_request(
        &mut state,
        &Request {
            id: 2,
            method: "cancel_task".into(),
            params: json!({
                "root_id": "root",
                "task_id": "task",
                "workspace_directory": "C:\\workspace",
                "reason": "stop",
                "idempotency_key": "cancel:root:task"
            }),
        },
    );
    assert_eq!(duplicate.result.unwrap()["state"], "cancellation_pending");
    let mismatch = handle_request(
        &mut state,
        &Request {
            id: 3,
            method: "cancel_task".into(),
            params: json!({
                "root_id": "root",
                "task_id": "task",
                "workspace_directory": "C:\\other",
                "reason": "stop",
                "idempotency_key": "cancel:root:task:other"
            }),
        },
    );
    assert!(mismatch.error.unwrap().contains("authorization"));
    let _ = std::fs::remove_dir_all(dir);
}
