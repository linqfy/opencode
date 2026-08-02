#![cfg(windows)]

use std::collections::BTreeMap;
use std::fs;
use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use ultracode_sandbox_broker::{dispatch, Request, Roots};

#[test]
fn unsupported_controls_and_unc_roots_are_denied_before_launch() {
    let mut environment = BTreeMap::new();
    environment.insert(
        "SystemRoot".to_string(),
        std::env::var("SystemRoot").unwrap(),
    );
    let writable = dispatch(Request {
        version: 1,
        request_id: "writable-deny".to_string(),
        method: "launch".to_string(),
        executable: Some("C:\\Windows\\System32\\cmd.exe".to_string()),
        args: Some(Vec::new()),
        cwd: Some("C:\\Windows".to_string()),
        roots: Some(Roots {
            read: vec!["C:\\Windows".to_string()],
            writable: vec!["C:\\workspace".to_string()],
        }),
        environment: Some(environment.clone()),
        network: Some("allow".to_string()),
        job_id: None,
    });
    assert_eq!(writable.outcome, "denied");
    assert!(writable.reason.unwrap().contains("writable-root"));
    let unc = dispatch(Request {
        version: 1,
        request_id: "unc-deny".to_string(),
        method: "launch".to_string(),
        executable: Some("C:\\Windows\\System32\\cmd.exe".to_string()),
        args: Some(Vec::new()),
        cwd: Some("C:\\Windows".to_string()),
        roots: Some(Roots {
            read: vec!["\\\\server\\share".to_string()],
            writable: Vec::new(),
        }),
        environment: Some(environment),
        network: Some("allow".to_string()),
        job_id: None,
    });
    assert_eq!(unc.outcome, "denied");
    assert!(unc.reason.unwrap().contains("UNC"));
}

#[test]
fn sibling_directory_is_not_inside_a_read_root() {
    let base = std::env::temp_dir().join(format!(
        "ultracode-sandbox-boundary-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let root = base.join("workspace");
    let sibling = base.join("workspace-other");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&sibling).unwrap();
    let mut environment = BTreeMap::new();
    environment.insert(
        "SystemRoot".to_string(),
        std::env::var("SystemRoot").unwrap(),
    );
    let response = dispatch(Request {
        version: 1,
        request_id: "sibling-boundary".to_string(),
        method: "launch".to_string(),
        executable: Some(format!(
            "{}\\System32\\cmd.exe",
            std::env::var("SystemRoot").unwrap()
        )),
        args: Some(Vec::new()),
        cwd: Some(sibling.display().to_string()),
        roots: Some(Roots {
            read: vec![root.display().to_string()],
            writable: Vec::new(),
        }),
        environment: Some(environment),
        network: Some("allow".to_string()),
        job_id: None,
    });
    assert_eq!(response.outcome, "denied");
    assert!(response.reason.unwrap().contains("outside readable roots"));
    let _ = fs::remove_dir_all(base);
}

#[test]
fn terminated_job_kills_child_and_grandchild() {
    let directory = std::env::temp_dir().join(format!(
        "ultracode-sandbox-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&directory).unwrap();
    let pid_file = directory.join("grandchild.pid");
    let powershell = format!(
        "{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        std::env::var("SystemRoot").unwrap()
    );
    let script = format!(
        "$p=Start-Process -FilePath '{}' -ArgumentList '-NoProfile','-Command','Start-Sleep 30' -PassThru; Set-Content -Path '{}' -Value $p.Id; Wait-Process -Id $p.Id",
        powershell.replace('\'', "''"),
        pid_file.display().to_string().replace('\'', "''")
    );
    let mut environment = BTreeMap::new();
    environment.insert(
        "SystemRoot".to_string(),
        std::env::var("SystemRoot").unwrap(),
    );
    let response = dispatch(Request {
        version: 1,
        request_id: "tree-launch".to_string(),
        method: "launch".to_string(),
        executable: Some(powershell),
        args: Some(vec![
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-Command".to_string(),
            script,
        ]),
        cwd: Some(directory.display().to_string()),
        roots: Some(Roots {
            read: vec![directory.display().to_string()],
            writable: Vec::new(),
        }),
        environment: Some(environment),
        network: Some("allow".to_string()),
        job_id: None,
    });
    assert_eq!(response.outcome, "started", "{response:?}");
    let job_id = response.job_id.unwrap();
    for _ in 0..50 {
        if pid_file.exists() {
            break;
        }
        sleep(Duration::from_millis(20));
    }
    let grandchild_pid = (0..50)
        .find_map(|_| {
            fs::read_to_string(&pid_file)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    sleep(Duration::from_millis(20));
                    None
                })
        })
        .expect("grandchild pid file");
    let terminate = dispatch(Request {
        version: 1,
        request_id: "tree-terminate".to_string(),
        method: "terminate".to_string(),
        executable: None,
        args: None,
        cwd: None,
        roots: None,
        environment: None,
        network: None,
        job_id: Some(job_id),
    });
    assert_eq!(terminate.outcome, "terminated", "{terminate:?}");
    for _ in 0..50 {
        let output = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {grandchild_pid}")])
            .output()
            .unwrap();
        if !String::from_utf8_lossy(&output.stdout).contains(&grandchild_pid) {
            break;
        }
        sleep(Duration::from_millis(20));
    }
    let output = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {grandchild_pid}")])
        .output()
        .unwrap();
    assert!(!String::from_utf8_lossy(&output.stdout).contains(&grandchild_pid));
    let _ = fs::remove_dir_all(directory);
}
