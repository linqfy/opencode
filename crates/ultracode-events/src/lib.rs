//! ultracode-events: append-only, hash-chained, segmented JSONL journal.
//! Sole authoritative writer for canonical session state (spec section 11).

pub mod artifacts;
pub mod commit;
pub mod effect;
pub mod event;
pub mod import;
pub mod journal;
pub mod projections;
pub mod recovery;
pub mod rpc;
