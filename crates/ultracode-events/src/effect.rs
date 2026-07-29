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
                if let Some(existing) = effects
                    .iter_mut()
                    .find(|e| e.idempotency_key == *idempotency_key)
                {
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
            EventKind::SideEffectDispatched {
                idempotency_key,
                dispatch_identity,
            } => {
                if let Some(existing) = effects
                    .iter_mut()
                    .find(|e| e.idempotency_key == *idempotency_key)
                {
                    existing.state = EffectState::Dispatched;
                    existing.dispatch_identity = Some(dispatch_identity.clone());
                }
            }
            EventKind::SideEffectObserved {
                idempotency_key,
                outcome_hash,
                external_reference,
            } => {
                if let Some(existing) = effects
                    .iter_mut()
                    .find(|e| e.idempotency_key == *idempotency_key)
                {
                    existing.state = EffectState::Observed;
                    existing.outcome_hash = Some(outcome_hash.clone());
                    existing.external_reference = external_reference.clone();
                }
            }
            EventKind::SideEffectOutcomeUnknown {
                idempotency_key,
                reason,
            } => {
                if let Some(existing) = effects
                    .iter_mut()
                    .find(|e| e.idempotency_key == *idempotency_key)
                {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconcileAction {
    /// Terminal success; no reconciliation needed.
    NoAction,
    /// Retry-eligible. The executor MUST still prove no external outcome
    /// exists (via the idempotency key) before actually retrying.
    Retry,
    /// Reconcile by querying the external system using external_reference /
    /// request_hash, then transition to Observed or OutcomeUnknown.
    QueryExternal,
    /// Irreversible / non-queryable: never auto-retry. Requires an explicit
    /// user decision.
    RequireUserDecision,
}

/// A surviving Prepared from an unclean stop is "potentially dispatched".
/// Dispatched and OutcomeUnknown are always potentially dispatched. Observed
/// is resolved. A clean-stop Prepared is provably not dispatched.
pub fn is_potentially_dispatched(effect: &EffectRecord, unclean_stop: bool) -> bool {
    match effect.state {
        EffectState::Observed => false,
        EffectState::Prepared => unclean_stop,
        EffectState::Dispatched | EffectState::OutcomeUnknown => true,
    }
}

/// Applies the spec section 11 reconciliation rules.
pub fn reconcile_decision(effect: &EffectRecord, unclean_stop: bool) -> ReconcileAction {
    if effect.state == EffectState::Observed {
        return ReconcileAction::NoAction;
    }
    // Non-terminal. A clean-stop Prepared that was never dispatched is safely
    // re-preparable; everything else is potentially dispatched.
    let potentially_dispatched = is_potentially_dispatched(effect, unclean_stop);
    if !potentially_dispatched {
        // Clean stop, prepared but never dispatched: no bytes were sent.
        return match effect.policy {
            ReconciliationPolicy::Idempotent => ReconcileAction::Retry,
            ReconciliationPolicy::Queryable => ReconcileAction::QueryExternal,
            ReconciliationPolicy::NeverRetry => ReconcileAction::RequireUserDecision,
        };
    }
    match effect.policy {
        // Idempotent tools reconcile by key; retry-eligible (executor proves
        // no outcome first).
        ReconciliationPolicy::Idempotent => ReconcileAction::Retry,
        // Queryable non-idempotent tools reconcile via external reference.
        ReconciliationPolicy::Queryable => ReconcileAction::QueryExternal,
        // Irreversible / non-queryable: never auto-retry.
        ReconciliationPolicy::NeverRetry => ReconcileAction::RequireUserDecision,
    }
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
        j.append(prepared("k1", "idempotent"), Some("k1".into()))
            .unwrap();
        j.append(
            EventKind::SideEffectDispatched {
                idempotency_key: "k1".into(),
                dispatch_identity: "d1".into(),
            },
            None,
        )
        .unwrap();
        j.append(
            EventKind::SideEffectObserved {
                idempotency_key: "k1".into(),
                outcome_hash: "o".into(),
                external_reference: Some("ref".into()),
            },
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
        j.append(prepared("a", "idempotent"), Some("a".into()))
            .unwrap();
        j.append(prepared("b", "never-retry"), Some("b".into()))
            .unwrap();
        j.append(
            EventKind::SideEffectDispatched {
                idempotency_key: "a".into(),
                dispatch_identity: "da".into(),
            },
            None,
        )
        .unwrap();
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
        j.append(prepared("done", "idempotent"), Some("done".into()))
            .unwrap();
        j.append(
            EventKind::SideEffectObserved {
                idempotency_key: "done".into(),
                outcome_hash: "o".into(),
                external_reference: None,
            },
            None,
        )
        .unwrap();
        j.append(prepared("stuck", "queryable"), Some("stuck".into()))
            .unwrap();
        j.commit_boundary().unwrap();

        let opened = crate::recovery::open(&dir, "ses_1").unwrap();
        let effects = fold_effects(&opened.records);
        let pending = pending_effects(&effects);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].idempotency_key, "stuck");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn record(key: &str, policy: ReconciliationPolicy, state: EffectState) -> EffectRecord {
        EffectRecord {
            idempotency_key: key.into(),
            tool: "deploy".into(),
            request_hash: "h".into(),
            policy,
            state,
            dispatch_identity: None,
            outcome_hash: None,
            external_reference: None,
            reason: None,
            prepared_seq: 1,
        }
    }

    #[test]
    fn observed_is_terminal_no_action() {
        let effect = record("k", ReconciliationPolicy::NeverRetry, EffectState::Observed);
        assert_eq!(reconcile_decision(&effect, true), ReconcileAction::NoAction);
        assert!(!is_potentially_dispatched(&effect, true));
    }

    #[test]
    fn never_retry_never_auto_retries_in_any_non_terminal_state() {
        for state in [
            EffectState::Prepared,
            EffectState::Dispatched,
            EffectState::OutcomeUnknown,
        ] {
            let effect = record("k", ReconciliationPolicy::NeverRetry, state);
            assert_eq!(
                reconcile_decision(&effect, true),
                ReconcileAction::RequireUserDecision
            );
        }
    }

    #[test]
    fn idempotent_is_retry_eligible_when_potentially_dispatched() {
        let dispatched = record(
            "k",
            ReconciliationPolicy::Idempotent,
            EffectState::Dispatched,
        );
        assert_eq!(
            reconcile_decision(&dispatched, true),
            ReconcileAction::Retry
        );
        let unknown = record(
            "k",
            ReconciliationPolicy::Idempotent,
            EffectState::OutcomeUnknown,
        );
        assert_eq!(reconcile_decision(&unknown, true), ReconcileAction::Retry);
    }

    #[test]
    fn queryable_reconciles_externally() {
        let dispatched = record(
            "k",
            ReconciliationPolicy::Queryable,
            EffectState::Dispatched,
        );
        assert_eq!(
            reconcile_decision(&dispatched, true),
            ReconcileAction::QueryExternal
        );
    }

    #[test]
    fn unclean_prepared_is_potentially_dispatched_clean_is_not() {
        let prepared = record("k", ReconciliationPolicy::Idempotent, EffectState::Prepared);
        assert!(is_potentially_dispatched(&prepared, true));
        assert!(!is_potentially_dispatched(&prepared, false));
        // Clean-stop prepared idempotent effect is still retry-eligible (no bytes sent).
        assert_eq!(reconcile_decision(&prepared, false), ReconcileAction::Retry);
        // Clean-stop prepared never-retry effect still needs a user decision.
        let nr = record("k", ReconciliationPolicy::NeverRetry, EffectState::Prepared);
        assert_eq!(
            reconcile_decision(&nr, false),
            ReconcileAction::RequireUserDecision
        );
    }

    #[test]
    fn reconcile_after_a_simulated_crash() {
        // Write three effects, then "crash" (drop the writer without a clean
        // shutdown marker) leaving them in non-terminal states.
        let dir = dir("crash");
        let _ = std::fs::remove_dir_all(&dir);
        {
            let mut j = JournalWriter::create(&dir, "ses_1").unwrap();
            // idempotent, dispatched, no observed outcome -> Retry
            j.append(prepared("idem", "idempotent"), Some("idem".into()))
                .unwrap();
            j.append(
                EventKind::SideEffectDispatched {
                    idempotency_key: "idem".into(),
                    dispatch_identity: "d".into(),
                },
                None,
            )
            .unwrap();
            // queryable, prepared only -> QueryExternal (unclean)
            j.append(prepared("query", "queryable"), Some("query".into()))
                .unwrap();
            // never-retry, dispatched -> RequireUserDecision
            j.append(
                prepared("irreversible", "never-retry"),
                Some("irreversible".into()),
            )
            .unwrap();
            j.append(
                EventKind::SideEffectDispatched {
                    idempotency_key: "irreversible".into(),
                    dispatch_identity: "d2".into(),
                },
                None,
            )
            .unwrap();
            j.commit_boundary().unwrap();
            // dropped here = unclean stop
        }

        // Restart: reopen the journal and reconcile as after an unclean stop.
        let opened = crate::recovery::open(&dir, "ses_1").unwrap();
        let effects = fold_effects(&opened.records);
        let pending = pending_effects(&effects);
        assert_eq!(
            pending.len(),
            3,
            "all three effects are non-terminal after the crash"
        );

        let by_key = |k: &str| effects.iter().find(|e| e.idempotency_key == k).unwrap();
        assert_eq!(
            reconcile_decision(by_key("idem"), true),
            ReconcileAction::Retry
        );
        assert_eq!(
            reconcile_decision(by_key("query"), true),
            ReconcileAction::QueryExternal
        );
        assert_eq!(
            reconcile_decision(by_key("irreversible"), true),
            ReconcileAction::RequireUserDecision
        );

        // None of them is a model-visible success.
        assert!(pending.iter().all(|e| !is_observed(e)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_completed_effect_is_not_pending_after_restart() {
        let dir = dir("completed");
        let _ = std::fs::remove_dir_all(&dir);
        {
            let mut j = JournalWriter::create(&dir, "ses_1").unwrap();
            j.append(prepared("done", "idempotent"), Some("done".into()))
                .unwrap();
            j.append(
                EventKind::SideEffectDispatched {
                    idempotency_key: "done".into(),
                    dispatch_identity: "d".into(),
                },
                None,
            )
            .unwrap();
            j.append(
                EventKind::SideEffectObserved {
                    idempotency_key: "done".into(),
                    outcome_hash: "o".into(),
                    external_reference: None,
                },
                None,
            )
            .unwrap();
            j.commit_boundary().unwrap();
        }
        let opened = crate::recovery::open(&dir, "ses_1").unwrap();
        let effects = fold_effects(&opened.records);
        assert!(
            pending_effects(&effects).is_empty(),
            "observed effect needs no reconciliation"
        );
        assert_eq!(
            reconcile_decision(&effects[0], true),
            ReconcileAction::NoAction
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
