//! Spawns the real sidecar binary and proves the memory-job queue flow over
//! RPC: idempotent enqueue via propose_commit, once-claim semantics, and
//! completion via the journal (code-wins: no dedicated enqueue/complete RPCs).

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
        std::env::temp_dir().join(format!("ultracode-memory-jobs-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    base
}

fn extraction_requested(request_id: &str) -> Value {
    json!({
        "kind": "memory-extraction-requested",
        "data": {
            "request_id": request_id,
            "source_session": "ses_1",
            "source_turn": 1,
            "source_end_seq": 10,
            "transcript_artifact_id": "art_1",
            "extractor_version": "v1"
        }
    })
}

fn extracted(request_id: &str, thread_id: &str, raw_memory: &str) -> Value {
    json!({
        "kind": "memory-extracted",
        "data": {
            "request_id": request_id,
            "thread_id": thread_id,
            "source_updated_at": 100,
            "raw_memory": raw_memory,
            "rollout_summary": "summary",
            "rollout_slug": "rollout",
            "cwd": "/repo",
            "git_branch": "main",
            "generated_at": 101
        }
    })
}

#[test]
fn enqueue_same_job_twice_is_idempotent() {
    let dir = base("enqueue-idempotent");
    let mut sidecar = Sidecar::spawn(&dir);

    let first = sidecar.call(
        1,
        "propose_commit",
        json!({ "key": "enqueue:req-1", "kind": extraction_requested("req-1") }),
    );
    assert_eq!(first["error"], Value::Null, "{first}");
    assert_eq!(first["result"]["duplicate"], false);

    let second = sidecar.call(
        2,
        "propose_commit",
        json!({ "key": "enqueue:req-1", "kind": extraction_requested("req-1") }),
    );
    assert_eq!(
        second["result"]["duplicate"], true,
        "second enqueue is a journal-key duplicate: {second}"
    );

    sidecar.kill();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn only_one_claim_returns_the_job() {
    let dir = base("once-claim");
    let mut sidecar = Sidecar::spawn(&dir);

    let enqueue = sidecar.call(
        1,
        "propose_commit",
        json!({ "key": "enqueue:req-claim", "kind": extraction_requested("req-claim") }),
    );
    assert_eq!(enqueue["error"], Value::Null, "{enqueue}");

    let first = sidecar.call(2, "claim_memory_job", json!({}));
    assert_eq!(first["result"]["request_id"], "req-claim");
    assert_eq!(first["result"]["kind"], "memory-extraction-requested");

    let second = sidecar.call(3, "claim_memory_job", json!({}));
    assert_eq!(
        second["result"], Value::Null,
        "second claim must not return the already-claimed job: {second}"
    );

    sidecar.kill();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn completing_an_unknown_request_is_rejected() {
    let dir = base("unknown-complete");
    let mut sidecar = Sidecar::spawn(&dir);

    let response = sidecar.call(
        1,
        "propose_commit",
        json!({
            "key": "complete:req-missing",
            "kind": extracted("req-missing", "thread-missing", "raw")
        }),
    );
    assert_eq!(
        response["error"], "missing memory request: req-missing",
        "completing an unknown request must fail validation: {response}"
    );

    sidecar.kill();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn full_cycle_enqueue_claim_complete_records() {
    let dir = base("full-cycle");
    let mut sidecar = Sidecar::spawn(&dir);

    let enqueue = sidecar.call(
        1,
        "propose_commit",
        json!({ "key": "mem:ses_1:1", "kind": extraction_requested("req-cycle") }),
    );
    assert_eq!(enqueue["error"], Value::Null, "{enqueue}");

    let claim = sidecar.call(2, "claim_memory_job", json!({}));
    assert_eq!(claim["result"]["request_id"], "req-cycle");
    assert_eq!(claim["result"]["kind"], "memory-extraction-requested");
    assert_eq!(claim["result"]["data"]["source_session"], "ses_1");

    let complete = sidecar.call(
        3,
        "propose_commit",
        json!({
            "key": "mem:ses_1:1:done",
            "kind": extracted("req-cycle", "thread-cycle", "raw-cycle")
        }),
    );
    assert_eq!(complete["error"], Value::Null, "{complete}");

    let after = sidecar.call(4, "claim_memory_job", json!({}));
    assert_eq!(
        after["result"], Value::Null,
        "no claimable jobs remain after completion: {after}"
    );

    let records = sidecar.call(5, "list_memory_records", json!({}));
    let records = records["result"].as_array().unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["thread_id"], "thread-cycle");
    assert_eq!(records[0]["raw_memory"], "raw-cycle");

    sidecar.kill();
    let _ = std::fs::remove_dir_all(&dir);
}
