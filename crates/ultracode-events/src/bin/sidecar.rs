//! Event sidecar: hosts the journal/projections/artifacts/effect ledger and
//! serves newline-delimited JSON-RPC over stdio (spec sections 5 and 11).

use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use ultracode_events::rpc::{self, Request, SidecarState};

struct Args {
    journal_dir: PathBuf,
    db: PathBuf,
    artifacts: PathBuf,
    session: String,
}

fn parse_args() -> Result<Args, String> {
    let mut journal_dir = None;
    let mut db = None;
    let mut artifacts = None;
    let mut session = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--journal-dir" => journal_dir = args.next(),
            "--db" => db = args.next(),
            "--artifacts" => artifacts = args.next(),
            "--session" => session = args.next(),
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(Args {
        journal_dir: journal_dir.map(PathBuf::from).ok_or("missing --journal-dir")?,
        db: db.map(PathBuf::from).ok_or("missing --db")?,
        artifacts: artifacts.map(PathBuf::from).ok_or("missing --artifacts")?,
        session: session.ok_or("missing --session")?,
    })
}

fn main() {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("sidecar: {message}");
            std::process::exit(2);
        }
    };

    let mut state = match SidecarState::open(&args.journal_dir, &args.db, &args.artifacts, &args.session) {
        Ok(state) => state,
        Err(e) => {
            eprintln!("sidecar: failed to open state: {e}");
            std::process::exit(1);
        }
    };

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(request) => rpc::handle_request(&mut state, &request),
            Err(e) => rpc::Response::err(0, format!("bad request: {e}")),
        };
        let payload = match serde_json::to_string(&response) {
            Ok(payload) => payload,
            Err(e) => format!("{{\"id\":0,\"error\":\"bad response: {e}\"}}"),
        };
        if writeln!(out, "{payload}").is_err() {
            break;
        }
        let _ = out.flush();
    }
}
