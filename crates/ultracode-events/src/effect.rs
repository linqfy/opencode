//! Crash-safe side-effect protocol (spec section 11).
//! Effect state is a pure projection over journal events — no state file.

use crate::event::{EventKind, Record};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectState {
    Prepared,
    Dispatched,
    Observed,
    OutcomeUnknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconciliationPolicy {
    Idempotent,
    Queryable,
    NeverRetry,
}

impl ReconciliationPolicy {
    pub fn from_str(value: &str) -> ReconciliationPolicy {
        match value {
            "idempotent" => ReconciliationPolicy::Idempotent,
            "queryable" => ReconciliationPolicy::Queryable,
            _ => ReconciliationPolicy::NeverRetry,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct EffectRecord {
    pub idempotency_key: String,
    pub tool: String,
    pub request_hash: String,
    pub policy: ReconciliationPolicy,
    pub state: EffectState,
    pub dispatch_identity: Option<String>,
    pub outcome_hash: Option<String>,
    pub external_reference: Option<String>,
    pub reason: Option<String>,
    pub prepared_seq: u64,
}

/// Folds SideEffect* journal events into one record per idempotency key,
/// in journal order. Events for an unseen key create the record defensively.
pub fn fold_effects(records: &[Record]) -> Vec<EffectRecord> {
    let mut effects: Vec<EffectRecord> = Vec::new();

    for record in records {
        match &record.event.kind {
            EventKind::SideEffectPrepared {
                idempotency_key,
                tool,
                request_hash,
                reconciliation_policy,
            } => {
                if let Some(existing) = effects.iter_mut().find(|e| e.idempotency_key == *idempotency_key) {
                    existing.state = EffectState::Prepared;
                    continue;
                }
                effects.push(EffectRecord {
                    idempotency_key: idempotency_key.clone(),
                    tool: tool.clone(),
                    request_hash: request_hash.clone(),
                    policy: ReconciliationPolicy::from_str(reconciliation_policy),
                    state: EffectState::Prepared,
                    dispatch_identity: None,
                    outcome_hash: None,
                    external_reference: None,
                    reason: None,
                    prepared_seq: record.event.seq,
                });
            }
            EventKind::SideEffectDispatched { idempotency_key, dispatch_identity } => {
                if let Some(existing) = effects.iter_mut().find(|e| e.idempotency_key == *idempotency_key) {
                    existing.state = EffectState::Dispatched;
                    existing.dispatch_identity = Some(dispatch_identity.clone());
                }
            }
            EventKind::SideEffectObserved { idempotency_key, outcome_hash, external_reference } => {
                if let Some(existing) = effects.iter_mut().find(|e| e.idempotency_key == *idempotency_key) {
                    existing.state = EffectState::Observed;
                    existing.outcome_hash = Some(outcome_hash.clone());
                    existing.external_reference = external_reference.clone();
                }
            }
            EventKind::SideEffectOutcomeUnknown { idempotency_key, reason } => {
                if let Some(existing) = effects.iter_mut().find(|e| e.idempotency_key == *idempotency_key) {
                    existing.state = EffectState::OutcomeUnknown;
                    existing.reason = Some(reason.clone());
                }
            }
            _ => {}
        }
    }

    effects
}

/// Effects in a non-terminal state that need reconciliation.
pub fn pending_effects(effects: &[EffectRecord]) -> Vec<&EffectRecord> {
    effects
        .iter()
        .filter(|e| e.state != EffectState::Observed)
        .collect()
}

/// True when the effect is a terminal, model-visible success.
pub fn is_observed(effect: &EffectRecord) -> bool {
    effect.state == EffectState::Observed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::EventKind;
    use crate::journal::JournalWriter;
    use std::path::PathBuf;

    fn dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ultracode-effect-{name}-{}", std::process::id()))
    }

    fn prepared(key: &str, policy: &str) -> EventKind {
        EventKind::SideEffectPrepared {
            idempotency_key: key.into(),
            tool: "deploy".into(),
            request_hash: "h".into(),
            reconciliation_policy: policy.into(),
        }
    }

    #[test]
    fn fold_reconstructs_a_full_lifecycle() {
        let dir = dir("lifecycle");
        let _ = std::fs::remove_dir_all(&dir);
        let mut j = JournalWriter::create(&dir, "ses_1").unwrap();
        j.append(prepared("k1", "idempotent"), Some("k1".into())).unwrap();
        j.append(EventKind::SideEffectDispatched { idempotency_key: "k1".into(), dispatch_identity: "d1".into() }, None).unwrap();
        j.append(
            EventKind::SideEffectObserved { idempotency_key: "k1".into(), outcome_hash: "o".into(), external_reference: Some("ref".into()) },
            None,
        )
        .unwrap();
        j.commit_boundary().unwrap();

        let opened = crate::recovery::open(&dir, "ses_1").unwrap();
        let effects = fold_effects(&opened.records);
        assert_eq!(effects.len(), 1);
        assert_eq!(effects[0].state, EffectState::Observed);
        assert_eq!(effects[0].dispatch_identity.as_deref(), Some("d1"));
        assert_eq!(effects[0].external_reference.as_deref(), Some("ref"));
        assert!(is_observed(&effects[0]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fold_handles_interleaved_effects() {
        let dir = dir("interleaved");
        let _ = std::fs::remove_dir_all(&dir);
        let mut j = JournalWriter::create(&dir, "ses_1").unwrap();
        j.append(prepared("a", "idempotent"), Some("a".into())).unwrap();
        j.append(prepared("b", "never-retry"), Some("b".into())).unwrap();
        j.append(EventKind::SideEffectDispatched { idempotency_key: "a".into(), dispatch_identity: "da".into() }, None).unwrap();
        j.commit_boundary().unwrap();

        let opened = crate::recovery::open(&dir, "ses_1").unwrap();
        let effects = fold_effects(&opened.records);
        assert_eq!(effects.len(), 2);
        let a = effects.iter().find(|e| e.idempotency_key == "a").unwrap();
        let b = effects.iter().find(|e| e.idempotency_key == "b").unwrap();
        assert_eq!(a.state, EffectState::Dispatched);
        assert_eq!(b.state, EffectState::Prepared);
        assert_eq!(b.policy, ReconciliationPolicy::NeverRetry);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pending_excludes_observed() {
        let dir = dir("pending");
        let _ = std::fs::remove_dir_all(&dir);
        let mut j = JournalWriter::create(&dir, "ses_1").unwrap();
        j.append(prepared("done", "idempotent"), Some("done".into())).unwrap();
        j.append(EventKind::SideEffectObserved { idempotency_key: "done".into(), outcome_hash: "o".into(), external_reference: None }, None).unwrap();
        j.append(prepared("stuck", "queryable"), Some("stuck".into())).unwrap();
        j.commit_boundary().unwrap();

        let opened = crate::recovery::open(&dir, "ses_1").unwrap();
        let effects = fold_effects(&opened.records);
        let pending = pending_effects(&effects);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].idempotency_key, "stuck");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
