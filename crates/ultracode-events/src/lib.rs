//! ultracode-events: append-only, hash-chained, segmented JSONL journal.
//! Sole authoritative writer for canonical session state (spec section 11).

pub mod commit;
pub mod event;
pub mod journal;
pub mod recovery;
