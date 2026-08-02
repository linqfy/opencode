use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
pub struct Request {
    pub version: u32,
    pub request_id: String,
    pub method: String,
    pub executable: Option<String>,
    pub args: Option<Vec<String>>,
    pub cwd: Option<String>,
    pub roots: Option<Roots>,
    pub environment: Option<BTreeMap<String, String>>,
    pub network: Option<String>,
    pub job_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Roots {
    pub read: Vec<String>,
    pub writable: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct Response {
    pub version: u32,
    pub request_id: String,
    pub method: String,
    pub outcome: String,
    pub capabilities: Option<Vec<&'static str>>,
    pub job_id: Option<String>,
    pub pid: Option<u32>,
    pub reason: Option<String>,
}

pub fn validate_request(request: &Request) -> Result<(), String> {
    if request.version != PROTOCOL_VERSION {
        return Err("unsupported protocol version".to_string());
    }
    if request.request_id.is_empty() {
        return Err("request_id is required".to_string());
    }
    match request.method.as_str() {
        "probe" => Ok(()),
        "launch" => {
            if request.executable.as_deref().is_none()
                || request.args.is_none()
                || request.cwd.as_deref().is_none()
                || request.roots.is_none()
                || request.environment.is_none()
                || request.network.as_deref().is_none()
            {
                return Err("launch fields are required".to_string());
            }
            if !matches!(request.network.as_deref(), Some("allow") | Some("deny")) {
                return Err("invalid network policy".to_string());
            }
            Ok(())
        }
        "terminate" => {
            if request.job_id.as_deref().is_none() {
                return Err("job_id is required".to_string());
            }
            Ok(())
        }
        _ => Err("unsupported method".to_string()),
    }
}

pub fn dispatch(request: Request) -> Response {
    let request_id = request.request_id.clone();
    let method = request.method.clone();
    if let Err(reason) = validate_request(&request) {
        return denied(request_id, method, reason);
    }
    match method.as_str() {
        "probe" => probe(request_id),
        "launch" => launch(request),
        "terminate" => terminate(request),
        _ => unreachable!(),
    }
}

#[cfg(not(windows))]
fn probe(request_id: String) -> Response {
    Response {
        version: PROTOCOL_VERSION,
        request_id,
        method: "probe".to_string(),
        outcome: "unsupported".to_string(),
        capabilities: Some(Vec::new()),
        job_id: None,
        pid: None,
        reason: Some("Windows Job Object containment is unavailable on this platform".to_string()),
    }
}

#[cfg(windows)]
fn probe(request_id: String) -> Response {
    windows::probe(request_id)
}

#[cfg(not(windows))]
fn launch(request: Request) -> Response {
    denied(
        request.request_id,
        "launch".to_string(),
        "native containment is unsupported".to_string(),
    )
}

#[cfg(windows)]
fn launch(request: Request) -> Response {
    windows::launch(request)
}

#[cfg(not(windows))]
fn terminate(request: Request) -> Response {
    denied(
        request.request_id,
        "terminate".to_string(),
        "native containment is unsupported".to_string(),
    )
}

#[cfg(windows)]
fn terminate(request: Request) -> Response {
    windows::terminate(request)
}

fn denied(request_id: String, method: String, reason: String) -> Response {
    Response {
        version: PROTOCOL_VERSION,
        request_id,
        method,
        outcome: "denied".to_string(),
        capabilities: None,
        job_id: None,
        pid: None,
        reason: Some(reason),
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::ffi::OsStr;
    use std::iter::once;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::MetadataExt;
    use std::ptr::{null, null_mut};
    use std::sync::{Mutex, OnceLock};
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, FALSE, HANDLE};
    use windows_sys::Win32::Security::{
        CreateRestrictedToken, DISABLE_MAX_PRIVILEGE, TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_SESSIONID,
        TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessAsUserW, DeleteProcThreadAttributeList, GetCurrentProcess,
        InitializeProcThreadAttributeList, OpenProcessToken, UpdateProcThreadAttribute,
        CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST,
        PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_JOB_LIST, STARTUPINFOEXW,
    };

    static JOBS: OnceLock<Mutex<BTreeMap<String, usize>>> = OnceLock::new();

    pub fn probe(request_id: String) -> Response {
        Response {
            version: PROTOCOL_VERSION,
            request_id,
            method: "probe".to_string(),
            outcome: "ready".to_string(),
            capabilities: Some(vec![
                "job-object-atomic",
                "explicit-environment",
                "restricted-token",
            ]),
            job_id: None,
            pid: None,
            reason: Some(
                "writable roots and WFP network deny are unavailable and will be denied"
                    .to_string(),
            ),
        }
    }

    pub fn launch(request: Request) -> Response {
        let roots = request.roots.as_ref().expect("validated roots");
        if !roots.writable.is_empty() {
            return denied(
                request.request_id,
                "launch".to_string(),
                "writable-root enforcement is unavailable".to_string(),
            );
        }
        if request.network.as_deref() == Some("deny") {
            return denied(
                request.request_id,
                "launch".to_string(),
                "WFP network deny is unavailable".to_string(),
            );
        }
        if let Err(reason) = validate_paths(request.cwd.as_deref().unwrap(), roots) {
            return denied(request.request_id, "launch".to_string(), reason);
        }
        let executable = request.executable.as_ref().unwrap();
        if let Err(reason) = validate_executable(executable) {
            return denied(request.request_id, "launch".to_string(), reason);
        }
        let args = request.args.as_ref().unwrap();
        match create_contained_process(
            executable,
            args,
            request.cwd.as_ref().unwrap(),
            request.environment.as_ref().unwrap(),
        ) {
            Ok((job, pid)) => {
                let job_id = pid.to_string();
                JOBS.get_or_init(|| Mutex::new(BTreeMap::new()))
                    .lock()
                    .unwrap()
                    .insert(job_id.clone(), job as usize);
                Response {
                    version: PROTOCOL_VERSION,
                    request_id: request.request_id,
                    method: "launch".to_string(),
                    outcome: "started".to_string(),
                    capabilities: None,
                    job_id: Some(job_id),
                    pid: Some(pid),
                    reason: None,
                }
            }
            Err(reason) => denied(request.request_id, "launch".to_string(), reason),
        }
    }

    pub fn terminate(request: Request) -> Response {
        let job_id = request.job_id.as_ref().unwrap();
        let job = JOBS
            .get_or_init(|| Mutex::new(BTreeMap::new()))
            .lock()
            .unwrap()
            .remove(job_id);
        match job {
            Some(job) => {
                let success = unsafe { TerminateJobObject(job as HANDLE, 1) != FALSE };
                unsafe {
                    CloseHandle(job as HANDLE);
                }
                Response {
                    version: PROTOCOL_VERSION,
                    request_id: request.request_id,
                    method: "terminate".to_string(),
                    outcome: if success { "terminated" } else { "failed" }.to_string(),
                    capabilities: None,
                    job_id: None,
                    pid: None,
                    reason: (!success).then(|| {
                        format!("TerminateJobObject failed: {}", unsafe { GetLastError() })
                    }),
                }
            }
            None => denied(
                request.request_id,
                "terminate".to_string(),
                "unknown job_id".to_string(),
            ),
        }
    }

    fn denied(request_id: String, method: String, reason: String) -> Response {
        Response {
            version: PROTOCOL_VERSION,
            request_id,
            method,
            outcome: "denied".to_string(),
            capabilities: None,
            job_id: None,
            pid: None,
            reason: Some(reason),
        }
    }

    fn validate_paths(cwd: &str, roots: &Roots) -> Result<(), String> {
        let cwd = canonical_path(cwd)?;
        let roots = roots
            .read
            .iter()
            .map(|root| canonical_path(root))
            .collect::<Result<Vec<_>, _>>()?;
        if !roots.iter().any(|root| is_contained_path(&cwd, root)) {
            return Err("cwd is outside readable roots".to_string());
        }
        Ok(())
    }

    fn is_contained_path(candidate: &std::path::Path, root: &std::path::Path) -> bool {
        candidate == root || candidate.starts_with(root)
    }

    fn validate_executable(executable: &str) -> Result<(), String> {
        canonical_path(executable).map(|_| ())
    }

    fn canonical_path(path: &str) -> Result<std::path::PathBuf, String> {
        if path.starts_with("\\\\") || path.contains("..") {
            return Err("ambiguous or UNC path is denied".to_string());
        }
        let metadata =
            std::fs::symlink_metadata(path).map_err(|_| "path is unavailable".to_string())?;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("reparse-point path is denied".to_string());
        }
        std::fs::canonicalize(path).map_err(|_| "path cannot be canonicalized".to_string())
    }

    fn create_contained_process(
        executable: &str,
        args: &[String],
        cwd: &str,
        environment: &BTreeMap<String, String>,
    ) -> Result<(HANDLE, u32), String> {
        unsafe {
            let job = CreateJobObjectW(null(), null());
            if job.is_null() {
                return Err(format!("CreateJobObjectW failed: {}", GetLastError()));
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &mut limits as *mut _ as _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == FALSE
            {
                CloseHandle(job);
                return Err(format!(
                    "SetInformationJobObject failed: {}",
                    GetLastError()
                ));
            }
            let mut token: HANDLE = null_mut();
            if OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_DUPLICATE
                    | TOKEN_QUERY
                    | TOKEN_ASSIGN_PRIMARY
                    | TOKEN_ADJUST_DEFAULT
                    | TOKEN_ADJUST_SESSIONID,
                &mut token,
            ) == FALSE
            {
                CloseHandle(job);
                return Err(format!("OpenProcessToken failed: {}", GetLastError()));
            }
            let mut restricted: HANDLE = null_mut();
            if CreateRestrictedToken(
                token,
                DISABLE_MAX_PRIVILEGE,
                0,
                null(),
                0,
                null(),
                0,
                null(),
                &mut restricted,
            ) == FALSE
            {
                CloseHandle(token);
                CloseHandle(job);
                return Err(format!("CreateRestrictedToken failed: {}", GetLastError()));
            }
            let mut attribute_size = 0usize;
            let query_result =
                InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attribute_size);
            let query_error = GetLastError();
            if query_result != FALSE || query_error != 122 {
                CloseHandle(restricted);
                CloseHandle(token);
                CloseHandle(job);
                return Err(format!(
                    "InitializeProcThreadAttributeList size query failed: {}",
                    query_error
                ));
            }
            let mut attribute_bytes = vec![0u8; attribute_size];
            let attributes = attribute_bytes.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
            if InitializeProcThreadAttributeList(attributes, 1, 0, &mut attribute_size) == FALSE {
                let error = GetLastError();
                CloseHandle(restricted);
                CloseHandle(token);
                CloseHandle(job);
                return Err(format!(
                    "InitializeProcThreadAttributeList failed: {}",
                    error
                ));
            }
            if UpdateProcThreadAttribute(
                attributes,
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                &job as *const HANDLE as _,
                size_of::<HANDLE>(),
                null_mut(),
                null_mut(),
            ) == FALSE
            {
                DeleteProcThreadAttributeList(attributes);
                CloseHandle(restricted);
                CloseHandle(token);
                CloseHandle(job);
                return Err(format!(
                    "UpdateProcThreadAttribute failed: {}",
                    GetLastError()
                ));
            }
            let mut startup: STARTUPINFOEXW = zeroed();
            startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
            startup.lpAttributeList = attributes;
            let mut command = format!("\"{}\"", executable);
            for arg in args {
                command.push(' ');
                command.push_str(&quote_arg(arg));
            }
            let mut command_wide: Vec<u16> =
                OsStr::new(&command).encode_wide().chain(once(0)).collect();
            let mut cwd_wide: Vec<u16> = OsStr::new(cwd).encode_wide().chain(once(0)).collect();
            let mut env_wide = Vec::new();
            for (key, value) in environment {
                env_wide.extend(OsStr::new(&format!("{}={}", key, value)).encode_wide());
                env_wide.push(0);
            }
            env_wide.push(0);
            let mut process: PROCESS_INFORMATION = zeroed();
            let created = CreateProcessAsUserW(
                restricted,
                null(),
                command_wide.as_mut_ptr(),
                null(),
                null(),
                FALSE,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                env_wide.as_mut_ptr() as _,
                cwd_wide.as_mut_ptr(),
                &mut startup.StartupInfo,
                &mut process,
            );
            DeleteProcThreadAttributeList(attributes);
            CloseHandle(restricted);
            CloseHandle(token);
            if created == FALSE {
                CloseHandle(job);
                return Err(format!("CreateProcessAsUserW failed: {}", GetLastError()));
            }
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            Ok((job, process.dwProcessId))
        }
    }

    fn quote_arg(value: &str) -> String {
        if value.is_empty() || value.chars().any(char::is_whitespace) {
            format!("\"{}\"", value.replace('"', "\\\""))
        } else {
            value.to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_protocol_version() {
        let request: Request =
            serde_json::from_str(r#"{"version":2,"request_id":"x","method":"probe"}"#).unwrap();
        assert_eq!(
            validate_request(&request),
            Err("unsupported protocol version".to_string())
        );
    }

    #[test]
    fn rejects_missing_launch_fields() {
        let request: Request =
            serde_json::from_str(r#"{"version":1,"request_id":"x","method":"launch"}"#).unwrap();
        assert_eq!(
            validate_request(&request),
            Err("launch fields are required".to_string())
        );
    }
}
