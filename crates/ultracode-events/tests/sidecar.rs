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
    let base = std::env::temp_dir().join(format!("ultracode-sidecar-{name}-{}", std::process::id()));
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

    let kind = json!({ "kind": "session-started", "data": { "client": "test", "client_version": "0" } });
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

    let read = sidecar.call(6, "open_range", json!({ "artifact_id": artifact_id, "scope": "ses_1", "start": 0, "end": 5 }));
    assert_eq!(read["result"]["bytes_hex"], "68656c6c6f");

    let reconciled = sidecar.call(7, "reconcile_effects", json!({ "unclean_stop": true }));
    assert!(reconciled["result"].as_array().unwrap().is_empty(), "no side effects were prepared");

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
        assert_eq!(listed["result"].as_array().unwrap().len(), 1, "event survives the restart");
        // Idempotency also survives: the same key is still a duplicate.
        let kind = json!({ "kind": "turn-started", "data": { "turn": 1 } });
        let retry = sidecar.call(2, "propose_commit", json!({ "key": "cmd_a", "kind": kind }));
        assert_eq!(retry["result"]["duplicate"], true);
        sidecar.kill();
    }

    let _ = std::fs::remove_dir_all(&dir);
}
