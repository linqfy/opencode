//! One-time legacy import CLI: reads an OpenCode SQLite DB and writes its
//! history into the ultracode journal (spec §18 Stage 2).

use std::path::PathBuf;
use ultracode_events::commit::CommitLog;
use ultracode_events::import::import_legacy;

struct Args {
    source_db: PathBuf,
    journal_dir: PathBuf,
    session: String,
    dry_run: bool,
}

fn parse_args() -> Result<Args, String> {
    let mut source_db = None;
    let mut journal_dir = None;
    let mut session = Some("legacy".to_string());
    let mut dry_run = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--source-db" => source_db = args.next(),
            "--journal-dir" => journal_dir = args.next(),
            "--session" => session = args.next(),
            "--dry-run" => dry_run = true,
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(Args {
        source_db: source_db.map(PathBuf::from).ok_or("missing --source-db")?,
        journal_dir: journal_dir.map(PathBuf::from).ok_or("missing --journal-dir")?,
        session: session.unwrap(),
        dry_run,
    })
}

fn main() {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("import-legacy: {message}");
            std::process::exit(2);
        }
    };

    let mut commit = match CommitLog::open(&args.journal_dir, &args.session) {
        Ok(commit) => commit,
        Err(e) => {
            eprintln!("import-legacy: failed to open journal: {e}");
            std::process::exit(1);
        }
    };

    match import_legacy(&args.source_db, &mut commit, args.dry_run) {
        Ok(report) => {
            println!(
                "import-legacy: {}sessions={} imported, {} skipped; messages={} imported; errors={}",
                if args.dry_run { "[dry-run] " } else { "" },
                report.sessions_imported,
                report.sessions_skipped,
                report.messages_imported,
                report.errors.len(),
            );
            for error in &report.errors {
                eprintln!("import-legacy: error: {error}");
            }
            if !report.errors.is_empty() {
                std::process::exit(1);
            }
        }
        Err(e) => {
            eprintln!("import-legacy: {e}");
            std::process::exit(1);
        }
    }
}
