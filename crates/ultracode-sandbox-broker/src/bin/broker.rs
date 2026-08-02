use std::io::{self, BufRead, Write};
use ultracode_sandbox_broker::{dispatch, Request};

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout());
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => break,
        };
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(request) => dispatch(request),
            Err(error) => ultracode_sandbox_broker::Response {
                version: ultracode_sandbox_broker::PROTOCOL_VERSION,
                request_id: "invalid".to_string(),
                method: "unknown".to_string(),
                outcome: "denied".to_string(),
                capabilities: None,
                job_id: None,
                pid: None,
                reason: Some(format!("invalid JSON request: {error}")),
            },
        };
        let serialized = serde_json::to_string(&response).expect("response is serializable");
        if writeln!(stdout, "{serialized}").is_err() {
            break;
        }
        if stdout.flush().is_err() {
            break;
        }
    }
}
