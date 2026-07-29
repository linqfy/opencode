//! Content-addressed artifact store with retention and credential lifecycle.
//! Bytes are written and fsynced before the metadata row is visible; ids are
//! sha256(bytes) hex, so identical bytes dedupe to one blob.

use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Retention {
    Turn,
    Session,
    Workspace,
    Pinned,
}

impl Retention {
    pub fn as_str(&self) -> &'static str {
        match self {
            Retention::Turn => "turn",
            Retention::Session => "session",
            Retention::Workspace => "workspace",
            Retention::Pinned => "pinned",
        }
    }

    pub fn from_str(value: &str) -> Option<Retention> {
        match value {
            "turn" => Some(Retention::Turn),
            "session" => Some(Retention::Session),
            "workspace" => Some(Retention::Workspace),
            "pinned" => Some(Retention::Pinned),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialClass {
    Plain,
    Encrypted,
    NoPersist,
}

impl CredentialClass {
    pub fn as_str(&self) -> &'static str {
        match self {
            CredentialClass::Plain => "plain",
            CredentialClass::Encrypted => "encrypted",
            CredentialClass::NoPersist => "no-persist",
        }
    }

    pub fn from_str(value: &str) -> Option<CredentialClass> {
        match value {
            "plain" => Some(CredentialClass::Plain),
            "encrypted" => Some(CredentialClass::Encrypted),
            "no-persist" => Some(CredentialClass::NoPersist),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArtifactRef {
    pub artifact_id: String,
    pub mime: String,
    pub byte_length: u64,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArtifactMetadata {
    pub artifact_id: String,
    pub mime: String,
    pub byte_length: u64,
    pub hash: String,
    pub owner_scope: String,
    pub retention: Retention,
    pub credential_class: CredentialClass,
    pub ref_count: i64,
    pub created_at: u64,
    pub expires_at: Option<u64>,
}

fn hex(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().into()
}

pub struct ArtifactStore {
    root: PathBuf,
    conn: Connection,
}

impl ArtifactStore {
    pub fn open(root: &Path, db_path: &Path) -> Result<Self, rusqlite::Error> {
        fs::create_dir_all(root).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        let conn = Connection::open(db_path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS artifact_meta (
                 artifact_id TEXT PRIMARY KEY,
                 mime TEXT NOT NULL,
                 byte_length INTEGER NOT NULL,
                 hash TEXT NOT NULL,
                 owner_scope TEXT NOT NULL,
                 retention TEXT NOT NULL,
                 credential_class TEXT NOT NULL,
                 ref_count INTEGER NOT NULL DEFAULT 1,
                 created_at INTEGER NOT NULL,
                 expires_at INTEGER
             );",
        )?;
        Ok(Self { root: root.to_path_buf(), conn })
    }

    fn blob_path(&self, artifact_id: &str) -> PathBuf {
        let aa = &artifact_id[0..2];
        let bb = &artifact_id[2..4];
        self.root.join(aa).join(bb).join(artifact_id)
    }

    /// Stores bytes content-addressed. Bytes are fsynced before the metadata
    /// row is inserted. NoPersist artifacts store metadata only.
    pub fn put(
        &mut self,
        bytes: &[u8],
        mime: &str,
        owner_scope: &str,
        retention: Retention,
        credential_class: CredentialClass,
        expires_at: Option<u64>,
    ) -> io::Result<ArtifactRef> {
        let digest = sha256(bytes);
        let artifact_id = hex(&digest);
        let byte_length = bytes.len() as u64;

        if credential_class != CredentialClass::NoPersist {
            let path = self.blob_path(&artifact_id);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            if !path.exists() {
                use std::io::Write;
                let tmp = path.with_extension("tmp");
                // Write through a writable handle and fsync THAT handle: on
                // Windows, FlushFileBuffers requires write access, so reopening
                // read-only to sync would fail.
                let mut file = fs::OpenOptions::new().write(true).create(true).truncate(true).open(&tmp)?;
                file.write_all(bytes)?;
                file.sync_all()?;
                drop(file);
                fs::rename(&tmp, &path)?;
            }
        }

        let created_at = crate::event::now_ms();
        self.conn
            .execute(
                "INSERT OR IGNORE INTO artifact_meta
                 (artifact_id, mime, byte_length, hash, owner_scope, retention, credential_class, ref_count, created_at, expires_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9)",
                params![
                    artifact_id,
                    mime,
                    byte_length as i64,
                    artifact_id,
                    owner_scope,
                    retention.as_str(),
                    credential_class.as_str(),
                    created_at as i64,
                    expires_at.map(|v| v as i64)
                ],
            )
            .map_err(io::Error::other)?;

        Ok(ArtifactRef {
            artifact_id: artifact_id.clone(),
            mime: mime.to_string(),
            byte_length,
            hash: artifact_id.clone(),
        })
    }

    pub fn stat(&self, artifact_id: &str, requester_scope: &str) -> io::Result<Option<ArtifactMetadata>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT artifact_id, mime, byte_length, hash, owner_scope, retention, credential_class, ref_count, created_at, expires_at
                 FROM artifact_meta WHERE artifact_id = ?1",
            )
            .map_err(io::Error::other)?;
        let mut rows = stmt
            .query_map(params![artifact_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, Option<i64>>(9)?,
                ))
            })
            .map_err(io::Error::other)?;
        match rows.next() {
            None => Ok(None),
            Some(Err(e)) => Err(io::Error::other(e)),
            Some(Ok((id, mime, byte_length, hash, owner_scope, retention, credential_class, ref_count, created_at, expires_at))) => {
                if owner_scope != requester_scope {
                    return Ok(None);
                }
                Ok(Some(ArtifactMetadata {
                    artifact_id: id,
                    mime,
                    byte_length: byte_length as u64,
                    hash,
                    owner_scope,
                    retention: Retention::from_str(&retention).unwrap_or(Retention::Workspace),
                    credential_class: CredentialClass::from_str(&credential_class).unwrap_or(CredentialClass::Plain),
                    ref_count,
                    created_at: created_at as u64,
                    expires_at: expires_at.map(|v| v as u64),
                }))
            }
        }
    }

    /// Reads a byte range [start, end) of a stored artifact. NoPersist
    /// artifacts have no bytes and fail.
    pub fn open_range(
        &self,
        artifact_id: &str,
        requester_scope: &str,
        start: u64,
        end: u64,
    ) -> io::Result<Vec<u8>> {
        let meta = self.stat(artifact_id, requester_scope)?;
        let meta = meta.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "artifact not found or out of scope"))?;
        if meta.credential_class == CredentialClass::NoPersist {
            return Err(io::Error::new(io::ErrorKind::Unsupported, "NoPersist artifact has no stored bytes"));
        }
        let bytes = fs::read(self.blob_path(artifact_id))?;
        let start = start.min(bytes.len() as u64) as usize;
        let end = end.min(bytes.len() as u64) as usize;
        if end <= start {
            return Ok(Vec::new());
        }
        Ok(bytes[start..end].to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dirs(name: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("ultracode-art-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("blobs");
        let db = base.join("art.db");
        (root, db)
    }

    #[test]
    fn put_then_stat_round_trips() {
        let (root, db) = dirs("roundtrip");
        let mut store = ArtifactStore::open(&root, &db).unwrap();
        let reference = store.put(b"hello world", "text/plain", "ses_1", Retention::Session, CredentialClass::Plain, None).unwrap();
        assert_eq!(reference.byte_length, 11);
        assert_eq!(reference.artifact_id.len(), 64);

        let meta = store.stat(&reference.artifact_id, "ses_1").unwrap().unwrap();
        assert_eq!(meta.mime, "text/plain");
        assert_eq!(meta.byte_length, 11);
        assert_eq!(meta.retention, Retention::Session);
        assert_eq!(meta.ref_count, 1);
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn identical_bytes_dedupe_to_one_blob() {
        let (root, db) = dirs("dedupe");
        let mut store = ArtifactStore::open(&root, &db).unwrap();
        let a = store.put(b"same", "text/plain", "ses_1", Retention::Workspace, CredentialClass::Plain, None).unwrap();
        let b = store.put(b"same", "text/plain", "ses_1", Retention::Workspace, CredentialClass::Plain, None).unwrap();
        assert_eq!(a.artifact_id, b.artifact_id);
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn open_range_reads_a_slice() {
        let (root, db) = dirs("range");
        let mut store = ArtifactStore::open(&root, &db).unwrap();
        let reference = store.put(b"0123456789", "text/plain", "ses_1", Retention::Workspace, CredentialClass::Plain, None).unwrap();
        let slice = store.open_range(&reference.artifact_id, "ses_1", 2, 6).unwrap();
        assert_eq!(slice, b"2345".to_vec());
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn stat_is_scope_gated() {
        let (root, db) = dirs("scope");
        let mut store = ArtifactStore::open(&root, &db).unwrap();
        let reference = store.put(b"secret", "text/plain", "ses_1", Retention::Workspace, CredentialClass::Plain, None).unwrap();
        assert!(store.stat(&reference.artifact_id, "ses_1").unwrap().is_some());
        assert!(store.stat(&reference.artifact_id, "ses_other").unwrap().is_none());
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn no_persist_artifact_has_no_bytes() {
        let (root, db) = dirs("nopersist");
        let mut store = ArtifactStore::open(&root, &db).unwrap();
        let reference = store.put(b"api-key", "text/plain", "ses_1", Retention::Turn, CredentialClass::NoPersist, None).unwrap();
        let meta = store.stat(&reference.artifact_id, "ses_1").unwrap().unwrap();
        assert_eq!(meta.credential_class, CredentialClass::NoPersist);
        let err = store.open_range(&reference.artifact_id, "ses_1", 0, 7).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::Unsupported);
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }
}
