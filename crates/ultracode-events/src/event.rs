use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub const SCHEMA_VERSION: u32 = 1;

static EVENT_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before epoch")
        .as_millis() as u64
}

/// Unique, monotonic-enough event identity: hex(ms)-hex(counter)-hex(pid).
pub fn new_event_id() -> String {
    let counter = EVENT_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:x}-{:x}-{:x}", now_ms(), counter, std::process::id())
}

/// All authoritative event types (spec section 11). serde adjacent tagging
/// renders lines as {"kind": "session-started", "data": {...}}.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "kebab-case")]
pub enum EventKind {
    SessionStarted {
        client: String,
        client_version: String,
    },
    TurnStarted {
        turn: u32,
    },
    UserInputCommitted {
        parts: Vec<BTreeMap<String, serde_json::Value>>,
    },
    ContextPlanned {
        fingerprint: String,
        estimated_tokens: u64,
    },
    PromptCompiled {
        fingerprint: String,
        blocks: Vec<String>,
    },
    ProviderAttemptStarted {
        attempt: u32,
        family: String,
        model: String,
        request_fingerprint: String,
    },
    ProviderAttemptCompleted {
        attempt: u32,
        finish_reason: String,
        usage: Option<BTreeMap<String, u64>>,
    },
    ToolProposed {
        tool: String,
        call_id: String,
    },
    ApprovalResolved {
        call_id: String,
        verdict: String,
        rule: String,
    },
    ToolStarted {
        call_id: String,
        tool: String,
    },
    SideEffectPrepared {
        idempotency_key: String,
        tool: String,
        request_hash: String,
        reconciliation_policy: String,
    },
    SideEffectDispatched {
        idempotency_key: String,
        dispatch_identity: String,
    },
    SideEffectObserved {
        idempotency_key: String,
        outcome_hash: String,
        external_reference: Option<String>,
    },
    SideEffectOutcomeUnknown {
        idempotency_key: String,
        reason: String,
    },
    ToolResultCommitted {
        call_id: String,
        status: String,
        preview_len: u64,
        artifact_ids: Vec<String>,
    },
    ArtifactStored {
        artifact_id: String,
        mime: String,
        byte_length: u64,
        hash: String,
    },
    SemanticCheckpointCreated {
        checkpoint_hash: String,
        recent_tail_start_id: String,
    },
    AgentSpawned {
        agent_id: String,
        parent_agent_id: Option<String>,
        budget: u64,
    },
    AgentStateChanged {
        agent_id: String,
        state: String,
    },
    WorkspaceSnapshotCreated {
        snapshot_id: String,
        baseline_id: String,
    },
    AssistantMessageCommitted {
        message_id: String,
        parts: u32,
    },
    TurnCompleted {
        turn: u32,
    },
    TurnAborted {
        turn: u32,
        reason: String,
    },
    /// An OpenCode session imported from a legacy database (spec §18 Stage 2).
    LegacySessionImported {
        original_session_id: String,
        title: String,
        directory: String,
        message_count: u64,
        source: String,
    },
    /// One OpenCode message imported from a legacy database. `data` is the
    /// raw OpenCode session_message.data JSON text, carried opaquely.
    LegacyMessageImported {
        original_session_id: String,
        original_message_id: String,
        seq: u64,
        message_type: String,
        data: String,
    },
    MemoryExtractionRequested {
        request_id: String,
        source_session: String,
        source_turn: u32,
        source_end_seq: u64,
        transcript_artifact_id: String,
        extractor_version: String,
    },
    MemoryExtracted {
        request_id: String,
        thread_id: String,
        source_updated_at: u64,
        raw_memory: String,
        rollout_summary: String,
        rollout_slug: Option<String>,
        cwd: String,
        git_branch: Option<String>,
        generated_at: u64,
    },
    MemoryConsolidationRequested {
        request_id: String,
        record_thread_ids: Vec<String>,
        consolidator_version: String,
    },
    MemoryConsolidated {
        request_id: String,
        memory_id: String,
        summary: String,
        memory: String,
        source_thread_ids: Vec<String>,
        generated_at: u64,
    },
    MemoryJobFailed {
        request_id: String,
        reason: String,
    },
    MemoryUsageRecorded {
        thread_ids: Vec<String>,
        at_ms: u64,
    },
    TaskSpawned {
        root_id: String,
        task_id: String,
        parent_task_id: Option<String>,
        depth: u8,
        state_changing: bool,
        dependencies: Vec<String>,
        budget: u64,
    },
    TaskStateChanged {
        root_id: String,
        task_id: String,
        state: String,
        reason: Option<String>,
    },
    TaskBudgetReserved {
        root_id: String,
        task_id: String,
        parent: u64,
        child_pool: u64,
        synthesis: u64,
    },
    TaskBudgetUsed {
        root_id: String,
        task_id: String,
        amount: u64,
        target: String,
    },
    TaskBudgetReclaimed {
        root_id: String,
        task_id: String,
        amount: u64,
        target: String,
    },
    WorktreeLeased {
        root_id: String,
        task_id: String,
        worktree_id: String,
    },
    WorktreeReleased {
        root_id: String,
        task_id: String,
        worktree_id: String,
    },
    MailboxMessageSent {
        root_id: String,
        message_id: String,
        sender_task_id: String,
        recipient_task_id: String,
        sequence: u64,
        #[serde(default)]
        summary: String,
        artifact_ids: Vec<String>,
        #[serde(default)]
        changed_paths: Vec<String>,
        test_summary: Option<String>,
        blocked_reason: Option<String>,
    },
    MailboxMessageAcknowledged {
        root_id: String,
        message_id: String,
        recipient_task_id: String,
    },
    TaskCancellationRequested {
        root_id: String,
        task_id: String,
        reason: String,
    },
    TaskCancellationObserved {
        root_id: String,
        task_id: String,
    },
    TaskDeliverableCommitted {
        root_id: String,
        task_id: String,
        status: String,
        summary: String,
        artifact_ids: Vec<String>,
        changed_paths: Vec<String>,
        test_summary: Option<String>,
    },
    /// Internal line written as the final line of a sealed segment at rotation.
    SegmentSeal {
        sealed_events: u64,
        final_hash: String,
    },
}

/// One unsigned journal record; the hash of this is the chain link.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub v: u32,
    pub seq: u64,
    pub id: String,
    pub ts: u64,
    pub session: String,
    /// Idempotency key of the proposing command; None for internal lines.
    pub cmd: Option<String>,
    #[serde(flatten)]
    pub kind: EventKind,
}

/// The hashed, on-disk line form.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Record {
    #[serde(flatten)]
    pub event: Event,
    pub prev: String,
    pub hash: String,
}

pub fn hash_hex(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn hash_from_hex(hex: &str) -> Result<[u8; 32], String> {
    if hex.len() != 64 {
        return Err(format!("hash must be 64 hex chars, got {}", hex.len()));
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

pub const GENESIS_HASH: [u8; 32] = [0u8; 32];

impl Event {
    /// Canonical bytes for hashing. Struct field order is declaration order;
    /// open maps are BTreeMap; no floats. This function is frozen by tests.
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, serde_json::Error> {
        serde_json::to_vec(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_ids_are_unique_and_clock_first() {
        let a = new_event_id();
        let b = new_event_id();
        assert_ne!(a, b);
        let counter_a = a.split('-').nth(1).unwrap();
        let counter_b = b.split('-').nth(1).unwrap();
        assert!(
            u64::from_str_radix(counter_b, 16).unwrap()
                > u64::from_str_radix(counter_a, 16).unwrap()
        );
        assert_eq!(a.split('-').count(), 3);
    }

    #[test]
    fn kind_tags_are_kebab_case() {
        let event = Event {
            v: SCHEMA_VERSION,
            seq: 1,
            id: "id".into(),
            ts: 1,
            session: "ses_1".into(),
            cmd: None,
            kind: EventKind::SideEffectPrepared {
                idempotency_key: "k".into(),
                tool: "t".into(),
                request_hash: "h".into(),
                reconciliation_policy: "idempotent".into(),
            },
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(
            json.contains("\"kind\":\"side-effect-prepared\""),
            "got: {json}"
        );
    }

    #[test]
    fn canonical_bytes_are_deterministic_regardless_of_map_insertion_order() {
        let mut a = BTreeMap::new();
        a.insert("z".to_string(), serde_json::json!(1));
        a.insert("a".to_string(), serde_json::json!(2));
        let mut b = BTreeMap::new();
        b.insert("a".to_string(), serde_json::json!(2));
        b.insert("z".to_string(), serde_json::json!(1));
        let make = |parts| Event {
            v: SCHEMA_VERSION,
            seq: 1,
            id: "id".into(),
            ts: 1,
            session: "s".into(),
            cmd: None,
            kind: EventKind::UserInputCommitted { parts },
        };
        assert_eq!(
            make(vec![a]).canonical_bytes().unwrap(),
            make(vec![b]).canonical_bytes().unwrap()
        );
    }

    #[test]
    fn record_round_trips() {
        let record = Record {
            event: Event {
                v: SCHEMA_VERSION,
                seq: 1,
                id: "id".into(),
                ts: 1,
                session: "s".into(),
                cmd: Some("cmd_1".into()),
                kind: EventKind::TurnStarted { turn: 1 },
            },
            prev: hash_hex(&GENESIS_HASH),
            hash: "ab".repeat(32),
        };
        let json = serde_json::to_string(&record).unwrap();
        let back: Record = serde_json::from_str(&json).unwrap();
        assert_eq!(record, back);
    }

    #[test]
    fn hash_hex_round_trip() {
        let h = GENESIS_HASH;
        assert_eq!(hash_from_hex(&hash_hex(&h)).unwrap(), h);
        assert!(hash_from_hex("zz").is_err());
        assert!(hash_from_hex("ab").is_err());
    }

    #[test]
    fn legacy_event_kinds_round_trip() {
        let session_kind = EventKind::LegacySessionImported {
            original_session_id: "ses_abc".into(),
            title: "Imported session".into(),
            directory: "/projects/x".into(),
            message_count: 3,
            source: "opencode.db".into(),
        };
        let json = serde_json::to_string(&session_kind).unwrap();
        assert!(json.contains("\"kind\":\"legacy-session-imported\""));
        let back: EventKind = serde_json::from_str(&json).unwrap();
        assert_eq!(back, session_kind);

        let message_kind = EventKind::LegacyMessageImported {
            original_session_id: "ses_abc".into(),
            original_message_id: "msg_1".into(),
            seq: 1,
            message_type: "assistant".into(),
            data: "{\"content\":[]}".into(),
        };
        let json = serde_json::to_string(&message_kind).unwrap();
        assert!(json.contains("\"kind\":\"legacy-message-imported\""));
        let back: EventKind = serde_json::from_str(&json).unwrap();
        assert_eq!(back, message_kind);
    }

    #[test]
    fn memory_event_kinds_round_trip_with_kebab_case_tags() {
        let kinds = vec![
            serde_json::json!({
                "kind": "memory-extraction-requested",
                "data": {
                    "request_id": "req_extract",
                    "source_session": "ses_1",
                    "source_turn": 2,
                    "source_end_seq": 10,
                    "transcript_artifact_id": "art_1",
                    "extractor_version": "v1"
                }
            }),
            serde_json::json!({
                "kind": "memory-extracted",
                "data": {
                    "request_id": "req_extract",
                    "thread_id": "thread_1",
                    "source_updated_at": 100,
                    "raw_memory": "raw",
                    "rollout_summary": "summary",
                    "rollout_slug": "rollout",
                    "cwd": "/repo",
                    "git_branch": "main",
                    "generated_at": 101
                }
            }),
            serde_json::json!({
                "kind": "memory-consolidation-requested",
                "data": {
                    "request_id": "req_consolidate",
                    "record_thread_ids": ["thread_1"],
                    "consolidator_version": "v1"
                }
            }),
            serde_json::json!({
                "kind": "memory-consolidated",
                "data": {
                    "request_id": "req_consolidate",
                    "memory_id": "mem_1",
                    "summary": "summary",
                    "memory": "memory",
                    "source_thread_ids": ["thread_1"],
                    "generated_at": 102
                }
            }),
            serde_json::json!({
                "kind": "memory-usage-recorded",
                "data": { "thread_ids": ["thread_1"], "at_ms": 103 }
            }),
        ];

        for json in kinds {
            let kind: EventKind =
                serde_json::from_value(json.clone()).expect("memory event parses");
            assert_eq!(serde_json::to_value(kind).unwrap(), json);
        }
    }
}
