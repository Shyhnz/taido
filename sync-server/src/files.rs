//! Attachment files (V2.7 bis): the bytes of each
//! attachment, uploaded in chunks of at most [`sync_proto::MAX_CHUNK_BYTES`] and resumed from
//! the status route, checked against their SHA-256 before being kept, then downloaded (with
//! `Range`) by the other devices of the account.
//!
//! On disk: `<data_dir>/files/<account_id>/<name>`, where `name` is the hex SHA-256 of the
//! account id, a NUL byte and the attachment id ([`storage_name`]): never a string of the client
//! in a path. An upload in progress is `<name>.part`; its length is the number of bytes received
//! (each chunk is appended and synced to disk before it is acknowledged), and the finished file
//! is renamed into place once its hash matches. The `files` table holds the size and hash the
//! upload declared and whether the file is complete.
//!
//! A file exists only for a live attachment of the same account. When the sync applies a
//! deletion of the attachment (soft delete or tombstone), it removes the row in its transaction
//! ([`forget`]) and the bytes are deleted from disk right after the commit
//! ([`FileStore::delete_files`]). File names and contents are never logged (ids only).
//!
//! A `files` row is trusted only while it matches: a complete row whose file is gone from the
//! disk, or a row whose hash is not the attachment's (when the attachment has one), is dropped
//! when it is next read, so the server never says « complete » for a file it cannot serve.
//! Uploads must carry the attachment's hash. A new upload is refused (507 `quota_exceeded`)
//! when it would leave less than [`FileLimits::min_free_bytes`] free on the disk, and a write
//! that finds the disk full drops the upload and answers the same.
//!
//! Files always live on the server's disk, under `<data dir>/files/<account_id>/`.

use std::collections::HashSet;
use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, PoisonError};

use axum::http::HeaderValue;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sync_proto::{
    Entity, ErrorCode, FileStatus, DEFAULT_ACCOUNT_QUOTA_BYTES, DEFAULT_MAX_FILE_BYTES, MAX_ID_LEN,
    PROTOCOL_VERSION,
};

use crate::auth::hex_lower;
use crate::error::{ApiError, ServerError};
use crate::store::{self, Store};

/// Directory of the files inside the data directory.
pub const FILES_DIR: &str = "files";
/// Suffix of an upload in progress.
pub const PART_SUFFIX: &str = ".part";
/// Environment variable of the largest file, in bytes.
pub const ENV_MAX_FILE_BYTES: &str = "TAIDO_MAX_FILE_BYTES";
/// Environment variable of the storage quota of one account, in bytes.
pub const ENV_ACCOUNT_QUOTA_BYTES: &str = "TAIDO_ACCOUNT_QUOTA_BYTES";
/// Environment variable of the free space a new upload must leave on the disk, in bytes.
pub const ENV_MIN_FREE_BYTES: &str = "TAIDO_MIN_FREE_BYTES";
/// Environment variable of the synced data quota of one account (tasks, notes, settings…),
/// in bytes.
pub const ENV_RECORDS_QUOTA_BYTES: &str = "TAIDO_RECORDS_QUOTA_BYTES";
/// Synced data of one account by default (50 MiB; a real account holds a few hundred KiB).
pub const DEFAULT_RECORDS_QUOTA_BYTES: u64 = 50 * 1024 * 1024;
/// Free space kept on the disk by default (2 GiB): room for the database and its backups.
pub const DEFAULT_MIN_FREE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Size limits of the attachment files.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileLimits {
    /// Largest file, in bytes (`413 file_too_large` above).
    pub max_file_bytes: u64,
    /// Total of the account's files, complete ones plus the sizes declared by the uploads in
    /// progress (`507 quota_exceeded` when an upload would go above).
    pub account_quota_bytes: u64,
    /// Free space a new upload must leave on the disk of the files, once complete
    /// (`507 quota_exceeded` below): the database must never find the disk full.
    pub min_free_bytes: u64,
    /// Total of the account's synced row data (`507 quota_exceeded` when a push would grow it
    /// above).
    pub records_quota_bytes: u64,
}

impl Default for FileLimits {
    fn default() -> Self {
        FileLimits {
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
            account_quota_bytes: DEFAULT_ACCOUNT_QUOTA_BYTES,
            min_free_bytes: DEFAULT_MIN_FREE_BYTES,
            records_quota_bytes: DEFAULT_RECORDS_QUOTA_BYTES,
        }
    }
}

impl FileLimits {
    /// Reads [`ENV_MAX_FILE_BYTES`], [`ENV_ACCOUNT_QUOTA_BYTES`], [`ENV_MIN_FREE_BYTES`]
    /// and [`ENV_RECORDS_QUOTA_BYTES`].
    pub fn from_env() -> Result<FileLimits, ServerError> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    /// Unset or blank = the default (of `sync_proto`, [`DEFAULT_MIN_FREE_BYTES`]); else a whole
    /// number of bytes, at most `i64::MAX` (what SQLite stores).
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<FileLimits, ServerError> {
        let read = |key: &str, default: u64| -> Result<u64, ServerError> {
            let Some(value) = lookup(key).filter(|v| !v.trim().is_empty()) else {
                return Ok(default);
            };
            parse_u64(value.trim())
                .filter(|n| i64::try_from(*n).is_ok())
                .ok_or_else(|| {
                    ServerError::Invalid(format!("{key} must be a whole number of bytes"))
                })
        };
        Ok(FileLimits {
            max_file_bytes: read(ENV_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES)?,
            account_quota_bytes: read(ENV_ACCOUNT_QUOTA_BYTES, DEFAULT_ACCOUNT_QUOTA_BYTES)?,
            min_free_bytes: read(ENV_MIN_FREE_BYTES, DEFAULT_MIN_FREE_BYTES)?,
            records_quota_bytes: read(ENV_RECORDS_QUOTA_BYTES, DEFAULT_RECORDS_QUOTA_BYTES)?,
        })
    }
}

/// Decimal digits only (no sign, no spaces).
fn parse_u64(text: &str) -> Option<u64> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// Query of `PUT /api/files/{id}`: `offset` (bytes already received), `size` (whole file) and
/// `sha256` (whole file, 64 lowercase hexadecimal characters), each exactly once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Upload {
    pub offset: u64,
    pub size: u64,
    pub sha256: String,
}

impl Upload {
    /// Parses the query string; 400 `bad_request` when a parameter is missing, repeated or
    /// malformed. Unknown parameters are ignored.
    pub fn from_query(query: Option<&str>) -> Result<Upload, ApiError> {
        let (mut offset, mut size, mut sha256) = (None, None, None);
        for pair in query.unwrap_or("").split('&').filter(|p| !p.is_empty()) {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            let slot = match key {
                "offset" => &mut offset,
                "size" => &mut size,
                "sha256" => &mut sha256,
                _ => continue,
            };
            if slot.replace(value).is_some() {
                return Err(ApiError::bad_request(format!("{key} is given twice")));
            }
        }
        let number = |name: &str, value: Option<&str>| {
            value
                .and_then(parse_u64)
                .ok_or_else(|| ApiError::bad_request(format!("{name} must be a whole number")))
        };
        let offset = number("offset", offset)?;
        let size = number("size", size)?;
        let sha256 = sha256
            .filter(|h| sync_proto::is_sha256_hex(h))
            .ok_or_else(|| {
                ApiError::bad_request("sha256 must be 64 lowercase hexadecimal characters")
            })?
            .to_string();
        Ok(Upload {
            offset,
            size,
            sha256,
        })
    }
}

/// File name on disk of an attachment's file: hex SHA-256 of `account_id`, a NUL byte and
/// `attachment_id`.
pub fn storage_name(account_id: &str, attachment_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(account_id.as_bytes());
    hasher.update([0u8]);
    hasher.update(attachment_id.as_bytes());
    hex_lower(&hasher.finalize())
}

/// `Content-Disposition` of a download (RFC 6266): always `attachment`, the name as an ASCII
/// fallback (`"`, `\`, `%`, control and non-ASCII characters replaced by `_`) and in full,
/// UTF-8 percent-encoded (RFC 8187 / 5987).
pub fn content_disposition(file_name: &str) -> HeaderValue {
    let fallback: String = file_name
        .chars()
        .map(|c| {
            if (c == ' ' || c.is_ascii_graphic()) && !matches!(c, '"' | '\\' | '%') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let mut encoded = String::with_capacity(file_name.len() * 3);
    for byte in file_name.bytes() {
        if byte.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    HeaderValue::from_str(&format!(
        "attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}"
    ))
    .unwrap_or_else(|_| HeaderValue::from_static("attachment"))
}

/// 404 `not_found`: no live attachment with this id in the account, or no file for it.
pub fn missing() -> ApiError {
    ApiError::new(ErrorCode::NotFound, "no such attachment file")
}

fn file_status(received: u64, size: u64, complete: bool) -> FileStatus {
    FileStatus {
        protocol: PROTOCOL_VERSION,
        received,
        size,
        complete,
    }
}

/// The attachment files on disk, their limits, and one lock per file.
pub struct FileStore {
    root: PathBuf,
    max_file_bytes: AtomicU64,
    account_quota_bytes: AtomicU64,
    min_free_bytes: AtomicU64,
    records_quota_bytes: AtomicU64,
    /// Free bytes to use instead of the disk's (tests only; `None` in production).
    free_bytes_override: Mutex<Option<u64>>,
    locks: KeyLocks,
}

/// Where one attachment's file lives.
struct Paths {
    /// [`storage_name`]: also the key of the file's lock.
    name: String,
    dir: PathBuf,
    file: PathBuf,
    part: PathBuf,
}

impl FileStore {
    /// Files under `root` (created when the first chunk arrives).
    pub fn new(root: impl Into<PathBuf>, limits: FileLimits) -> FileStore {
        FileStore {
            root: root.into(),
            max_file_bytes: AtomicU64::new(limits.max_file_bytes),
            account_quota_bytes: AtomicU64::new(limits.account_quota_bytes),
            min_free_bytes: AtomicU64::new(limits.min_free_bytes),
            records_quota_bytes: AtomicU64::new(limits.records_quota_bytes),
            free_bytes_override: Mutex::new(None),
            locks: KeyLocks::default(),
        }
    }

    /// Files under `<data_dir>/files`.
    pub fn in_data_dir(data_dir: &Path, limits: FileLimits) -> FileStore {
        Self::new(data_dir.join(FILES_DIR), limits)
    }

    pub fn limits(&self) -> FileLimits {
        FileLimits {
            max_file_bytes: self.max_file_bytes.load(Ordering::SeqCst),
            account_quota_bytes: self.account_quota_bytes.load(Ordering::SeqCst),
            min_free_bytes: self.min_free_bytes.load(Ordering::SeqCst),
            records_quota_bytes: self.records_quota_bytes.load(Ordering::SeqCst),
        }
    }

    /// Changes the limits of the running server (tests use small ones).
    pub fn set_limits(&self, limits: FileLimits) {
        self.max_file_bytes
            .store(limits.max_file_bytes, Ordering::SeqCst);
        self.account_quota_bytes
            .store(limits.account_quota_bytes, Ordering::SeqCst);
        self.min_free_bytes
            .store(limits.min_free_bytes, Ordering::SeqCst);
        self.records_quota_bytes
            .store(limits.records_quota_bytes, Ordering::SeqCst);
    }

    /// Tests only: the free space the floor check sees (`None`: the disk's).
    pub fn set_free_bytes_for_tests(&self, free: Option<u64>) {
        *self
            .free_bytes_override
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = free;
    }

    /// Free bytes on the disk of the files (the nearest existing folder above them).
    fn free_bytes(&self) -> io::Result<u64> {
        let free = *self
            .free_bytes_override
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(free) = free {
            return Ok(free);
        }
        let existing = self
            .root
            .ancestors()
            .find(|dir| dir.is_dir())
            .unwrap_or(Path::new("/"));
        available_bytes(existing)
    }

    /// Whether a new upload of `size` bytes would leave the disk below the floor. A failed
    /// check lets the upload go (logged): a full disk is still caught when writing.
    pub(crate) fn below_floor(&self, size: u64, min_free: u64) -> bool {
        match self.free_bytes() {
            Ok(free) => free < size.saturating_add(min_free),
            Err(err) => {
                tracing::warn!(error = %err, "free disk space unknown");
                false
            }
        }
    }

    /// Path of the complete file of an attachment (`account_id` is a server UUID).
    pub fn file_path(&self, account_id: &str, attachment_id: &str) -> PathBuf {
        self.root
            .join(account_id)
            .join(storage_name(account_id, attachment_id))
    }

    fn paths(&self, account_id: &str, attachment_id: &str) -> Result<Paths, ServerError> {
        // Account ids are UUIDs made by the server; anything else must never reach a path.
        let safe = !account_id.is_empty()
            && account_id.len() <= 64
            && account_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-');
        if !safe {
            return Err(ServerError::Invalid("unexpected account id".into()));
        }
        let name = storage_name(account_id, attachment_id);
        let dir = self.root.join(account_id);
        Ok(Paths {
            file: dir.join(&name),
            part: dir.join(format!("{name}{PART_SUFFIX}")),
            dir,
            name,
        })
    }

    /// `GET /api/files/{id}/status`: how much of the file the server holds. Without an upload
    /// yet: 0 bytes of the size the attachment declares.
    pub fn status(
        &self,
        store: &Store,
        account_id: &str,
        attachment_id: &str,
    ) -> Result<FileStatus, ApiError> {
        check_attachment_id(attachment_id)?;
        let paths = self.paths(account_id, attachment_id)?;
        let _lock = self.locks.lock(&paths.name)?;
        let (attachment, row) = {
            let conn = store.lock()?;
            let attachment =
                live_attachment(&conn, account_id, attachment_id)?.ok_or_else(missing)?;
            let row = trusted_row(&conn, &paths, account_id, attachment_id, &attachment)?;
            (attachment, row)
        };
        Ok(match row {
            None => file_status(0, attachment.size, false),
            Some(row) if row.complete => file_status(row.size, row.size, true),
            Some(row) => file_status(part_len(&paths.part)?.min(row.size), row.size, false),
        })
    }

    /// `PUT /api/files/{id}`: appends one chunk. In order: 404 when the attachment is not a
    /// live one of the account; 400 when `sha256` is not the attachment's (when it has one);
    /// 413 when `size` is above the limit; a new upload (none yet, or another `size` /
    /// `sha256` than the one in progress, which is dropped) never replaces a complete file
    /// unless it is a valid first chunk (else 409 / 400, nothing changed), is checked against
    /// the quota and the disk's free-space floor (507) and starts from 0; 409 when `offset` is
    /// not the number of bytes received; 400 when the chunk goes past `size`. The chunk is on
    /// disk (fsync) before the answer; a full disk drops the upload (507). With the last byte
    /// the SHA-256 is checked: on a mismatch nothing is kept (400 `hash_mismatch`), else the
    /// file is complete.
    pub fn put_chunk(
        &self,
        store: &Store,
        account_id: &str,
        attachment_id: &str,
        upload: &Upload,
        chunk: &[u8],
    ) -> Result<FileStatus, ApiError> {
        check_attachment_id(attachment_id)?;
        let paths = self.paths(account_id, attachment_id)?;
        let limits = self.limits();
        let _lock = self.locks.lock(&paths.name)?;

        let state = {
            let conn = store.lock()?;
            let attachment =
                live_attachment(&conn, account_id, attachment_id)?.ok_or_else(missing)?;
            if attachment
                .sha256
                .as_deref()
                .is_some_and(|expected| expected != upload.sha256)
            {
                // Another content than the attachment's: its row must be pushed first.
                return Err(ApiError::bad_request("the sha256 is not the attachment's"));
            }
            let (max_file_bytes, quota_bytes) = (limits.max_file_bytes, limits.account_quota_bytes);
            if upload.size > max_file_bytes {
                tracing::warn!(
                    account_id,
                    attachment_id,
                    size = upload.size,
                    "file refused: too large"
                );
                return Err(ApiError::new(
                    ErrorCode::FileTooLarge,
                    format!("files are limited to {max_file_bytes} bytes"),
                ));
            }
            match trusted_row(&conn, &paths, account_id, attachment_id, &attachment)? {
                Some(row) if row.size == upload.size && row.sha256 == upload.sha256 => {
                    if row.complete {
                        UploadState::Complete
                    } else {
                        UploadState::InProgress
                    }
                }
                row => {
                    if row.is_some_and(|row| row.complete) {
                        // A complete file is replaced only by a valid first chunk.
                        if upload.offset != 0 {
                            return Err(ApiError::new(
                                ErrorCode::ChunkOffset,
                                "the next chunk starts at byte 0",
                            ));
                        }
                        if u64::try_from(chunk.len()).unwrap_or(u64::MAX) > upload.size {
                            return Err(ApiError::bad_request(
                                "the chunk goes past the declared size",
                            ));
                        }
                    }
                    let used = used_bytes(&conn, account_id, attachment_id)?;
                    if used.saturating_add(upload.size) > quota_bytes {
                        tracing::warn!(account_id, attachment_id, "file refused: account full");
                        return Err(ApiError::new(
                            ErrorCode::QuotaExceeded,
                            "the account's files would exceed its quota",
                        ));
                    }
                    if self.below_floor(upload.size, limits.min_free_bytes) {
                        tracing::warn!(
                            account_id,
                            attachment_id,
                            "file refused: the server's disk is nearly full"
                        );
                        return Err(disk_full());
                    }
                    start_upload(&conn, account_id, attachment_id, upload)?;
                    UploadState::Started
                }
            }
        };

        let received = match state {
            UploadState::Complete => upload.size,
            UploadState::InProgress => {
                let received = part_len(&paths.part)?;
                if received > upload.size {
                    // Cannot happen through this API; start again rather than stay stuck.
                    remove_if_exists(&paths.part)?;
                    0
                } else {
                    received
                }
            }
            UploadState::Started => {
                // A previous upload (or file) of this attachment is dropped.
                remove_if_exists(&paths.part)?;
                remove_if_exists(&paths.file)?;
                tracing::info!(
                    account_id,
                    attachment_id,
                    size = upload.size,
                    "file upload started"
                );
                0
            }
        };
        if upload.offset != received {
            return Err(ApiError::new(
                ErrorCode::ChunkOffset,
                format!("the next chunk starts at byte {received}"),
            ));
        }
        let end = u64::try_from(chunk.len())
            .ok()
            .and_then(|len| received.checked_add(len))
            .filter(|end| *end <= upload.size)
            .ok_or_else(|| ApiError::bad_request("the chunk goes past the declared size"))?;
        if matches!(state, UploadState::Complete) {
            return Ok(file_status(upload.size, upload.size, true));
        }

        if let Err(err) = append(&paths, chunk, received == 0) {
            if !is_disk_full(&err) {
                return Err(err.into());
            }
            // Nothing of this upload is kept: the space goes back to the database.
            remove_if_exists(&paths.part)?;
            forget(&*store.lock()?, account_id, attachment_id)?;
            tracing::warn!(
                account_id,
                attachment_id,
                "file refused: the server's disk is full"
            );
            return Err(disk_full());
        }
        if end < upload.size {
            return Ok(file_status(end, upload.size, false));
        }

        // The last byte is in: keep the file only if it is the one announced.
        if sha256_file(&paths.part)? != upload.sha256 {
            remove_if_exists(&paths.part)?;
            forget(&*store.lock()?, account_id, attachment_id)?;
            tracing::warn!(
                account_id,
                attachment_id,
                "file hash mismatch: upload dropped"
            );
            return Err(ApiError::new(
                ErrorCode::HashMismatch,
                "the file does not match its sha256",
            ));
        }
        fs::rename(&paths.part, &paths.file).map_err(ServerError::from)?;
        sync_dir(&paths.dir);
        if !mark_complete(&*store.lock()?, account_id, attachment_id, upload)? {
            // The attachment was deleted meanwhile: its deletion removes the file.
            return Err(missing());
        }
        tracing::info!(
            account_id,
            attachment_id,
            size = upload.size,
            "file complete"
        );
        Ok(file_status(upload.size, upload.size, true))
    }

    /// `GET /api/files/{id}`: where the complete file of a live attachment of the account is
    /// (on the disk), and the attachment's file name (for `Content-Disposition`).
    pub fn download(
        &self,
        store: &Store,
        account_id: &str,
        attachment_id: &str,
    ) -> Result<(PathBuf, String), ApiError> {
        check_attachment_id(attachment_id)?;
        let paths = self.paths(account_id, attachment_id)?;
        let _lock = self.locks.lock(&paths.name)?;
        let conn = store.lock()?;
        let attachment = live_attachment(&conn, account_id, attachment_id)?.ok_or_else(missing)?;
        match trusted_row(&conn, &paths, account_id, attachment_id, &attachment)? {
            Some(row) if row.complete => Ok((paths.file, attachment.file_name)),
            _ => Err(missing()),
        }
    }

    /// Deletes from disk the files (complete and partial) of these attachments of the account,
    /// whose rows the sync has just removed ([`forget`]). A failure is logged, by ids only, and
    /// does not fail the caller. A file whose row is back (the attachment was restored and a
    /// new upload started since the commit) is left alone: it is not the deleted one.
    pub fn delete_files(&self, store: &Store, account_id: &str, attachment_ids: &[String]) {
        for attachment_id in attachment_ids {
            if let Err(err) = self.delete_one(store, account_id, attachment_id) {
                tracing::warn!(account_id, attachment_id = %attachment_id, error = %err,
                    "attached file not deleted");
            }
        }
    }

    fn delete_one(
        &self,
        store: &Store,
        account_id: &str,
        attachment_id: &str,
    ) -> Result<(), ServerError> {
        let paths = self.paths(account_id, attachment_id)?;
        let _lock = self.locks.lock(&paths.name)?;
        if file_row(&*store.lock()?, account_id, attachment_id)?.is_some() {
            tracing::info!(
                account_id,
                attachment_id,
                "attached file kept: a new upload started"
            );
            return Ok(());
        }
        let file = remove_if_exists(&paths.file);
        let part = remove_if_exists(&paths.part);
        file.and(part)?;
        tracing::info!(account_id, attachment_id, "attached file deleted");
        Ok(())
    }
}

/// What `put_chunk` found in the `files` table.
enum UploadState {
    /// The same file is already complete.
    Complete,
    /// The same upload is in progress: its `.part` holds the bytes received.
    InProgress,
    /// A new upload was recorded (none before, or another size or hash).
    Started,
}

/// 507 `quota_exceeded` for a server whose disk is (nearly) full: the clients show the same
/// « full » state and try again at their next sync.
fn disk_full() -> ApiError {
    ApiError::new(ErrorCode::QuotaExceeded, "the server's disk is full")
}

/// A write that failed for lack of space (`ENOSPC`, or a disk quota).
fn is_disk_full(err: &ServerError) -> bool {
    matches!(err, ServerError::Io(e)
        if matches!(e.kind(), io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded))
}

/// Free bytes for an unprivileged process on the volume of `path` (`statvfs`).
#[allow(unsafe_code)]
fn available_bytes(path: &Path) -> io::Result<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c_path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path with a NUL byte"))?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `c_path` is a NUL-terminated string and `stat` points to writable memory of the
    // size of a `statvfs`, which the call fills when it returns 0.
    let rc = unsafe { libc::statvfs(c_path.as_ptr(), stat.as_mut_ptr()) };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `statvfs` returned 0, so it initialised `stat`.
    let stat = unsafe { stat.assume_init() };
    // The field types differ between Linux (u64) and macOS (u32 / c_ulong).
    #[allow(clippy::unnecessary_cast)]
    let (blocks, block_size) = (stat.f_bavail as u64, stat.f_frsize as u64);
    Ok(blocks.saturating_mul(block_size))
}

/// The `files` row of the attachment when it can be trusted. A complete row whose file is gone
/// from the disk, or a row whose hash is not the attachment's (when the attachment has one),
/// is dropped with its bytes and reads as no row. Call with the file's lock held.
fn trusted_row(
    conn: &Connection,
    paths: &Paths,
    account_id: &str,
    attachment_id: &str,
    attachment: &Attachment,
) -> Result<Option<FileRow>, ServerError> {
    let Some(row) = file_row(conn, account_id, attachment_id)? else {
        return Ok(None);
    };
    let reason = if attachment
        .sha256
        .as_deref()
        .is_some_and(|expected| expected != row.sha256)
    {
        "not the attachment's hash"
    } else if row.complete && !paths.file.is_file() {
        "missing on disk"
    } else {
        return Ok(Some(row));
    };
    forget(conn, account_id, attachment_id)?;
    remove_if_exists(&paths.part)?;
    remove_if_exists(&paths.file)?;
    tracing::warn!(account_id, attachment_id, reason, "stored file dropped");
    Ok(None)
}

/// An id that cannot be a stored record's id cannot be a live attachment either.
fn check_attachment_id(attachment_id: &str) -> Result<(), ApiError> {
    if attachment_id.trim().is_empty() || attachment_id.len() > MAX_ID_LEN {
        return Err(missing());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Disk
// ---------------------------------------------------------------------------

/// Length of a partial upload; 0 when there is none.
fn part_len(path: &Path) -> Result<u64, ServerError> {
    match fs::metadata(path) {
        Ok(meta) => Ok(meta.len()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(0),
        Err(err) => Err(err.into()),
    }
}

fn remove_if_exists(path: &Path) -> Result<(), ServerError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

/// Appends `chunk` to the partial file (created when `new`) and syncs it to disk.
fn append(paths: &Paths, chunk: &[u8], new: bool) -> Result<(), ServerError> {
    fs::create_dir_all(&paths.dir)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.part)?;
    file.write_all(chunk)?;
    file.sync_all()?;
    if new {
        sync_dir(&paths.dir);
    }
    Ok(())
}

/// Makes a new or renamed directory entry durable (best effort: not every platform can open a
/// directory).
fn sync_dir(dir: &Path) {
    if let Ok(dir) = File::open(dir) {
        let _ = dir.sync_all();
    }
}

fn sha256_file(path: &Path) -> Result<String, ServerError> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hex_lower(&hasher.finalize()))
}

/// One operation at a time on one file (upload, status, deletion), across threads. Taken
/// before the database lock, never while holding it.
#[derive(Default)]
struct KeyLocks {
    busy: Mutex<HashSet<String>>,
    freed: Condvar,
}

struct KeyLock<'a> {
    locks: &'a KeyLocks,
    key: String,
}

impl KeyLocks {
    /// Blocks until no other holder has `key`. Call from blocking code only.
    fn lock(&self, key: &str) -> Result<KeyLock<'_>, ServerError> {
        let mut busy = self.busy.lock().map_err(|_| ServerError::Poisoned)?;
        while busy.contains(key) {
            busy = self.freed.wait(busy).map_err(|_| ServerError::Poisoned)?;
        }
        busy.insert(key.to_string());
        Ok(KeyLock {
            locks: self,
            key: key.to_string(),
        })
    }
}

impl Drop for KeyLock<'_> {
    fn drop(&mut self) {
        let mut busy = self
            .locks
            .busy
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        busy.remove(&self.key);
        drop(busy);
        self.locks.freed.notify_all();
    }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/// A row of `files`.
struct FileRow {
    size: u64,
    sha256: String,
    complete: bool,
}

/// What the file routes read of a row that owns a file: an `attachment` (a task's) or a
/// `note_attachment` (a notebook page's image), which share these fields.
#[derive(Debug, Deserialize)]
struct Attachment {
    file_name: String,
    size: u64,
    #[serde(default)]
    sha256: Option<String>,
    deleted_at: Option<String>,
}

/// Entities whose rows own a file.
const FILE_ENTITIES: [Entity; 2] = [Entity::Attachment, Entity::NoteAttachment];

/// The live row (an `attachment` or a `note_attachment`) `attachment_id` of the account
/// (`None`: unknown, deleted, a tombstone, or another entity).
fn live_attachment(
    conn: &Connection,
    account_id: &str,
    attachment_id: &str,
) -> Result<Option<Attachment>, ServerError> {
    for entity in FILE_ENTITIES {
        let data: Option<Option<String>> = conn
            .query_row(
                "SELECT data FROM records WHERE account_id = ?1 AND entity = ?2 AND id = ?3",
                params![account_id, entity.as_str(), attachment_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(Some(json)) = data else {
            continue;
        };
        let data: Attachment =
            serde_json::from_str(&json).map_err(|_| ServerError::CorruptRecord {
                entity: entity.as_str().to_string(),
                id: attachment_id.to_string(),
            })?;
        if data.deleted_at.is_none() {
            return Ok(Some(data));
        }
    }
    Ok(None)
}

fn file_row(
    conn: &Connection,
    account_id: &str,
    attachment_id: &str,
) -> Result<Option<FileRow>, ServerError> {
    let row: Option<(i64, String, bool)> = conn
        .query_row(
            "SELECT size, sha256, complete FROM files WHERE account_id = ?1 AND attachment_id = ?2",
            params![account_id, attachment_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    row.map(|(size, sha256, complete)| {
        let size = u64::try_from(size)
            .map_err(|_| ServerError::Invalid("negative file size in the database".into()))?;
        Ok(FileRow {
            size,
            sha256,
            complete,
        })
    })
    .transpose()
}

/// Bytes of the account's files (complete or not), except those of `except`.
fn used_bytes(conn: &Connection, account_id: &str, except: &str) -> Result<u64, ServerError> {
    let total: i64 = conn.query_row(
        "SELECT COALESCE(SUM(size), 0) FROM files WHERE account_id = ?1 AND attachment_id <> ?2",
        params![account_id, except],
        |r| r.get(0),
    )?;
    Ok(u64::try_from(total).unwrap_or(0))
}

/// Records a new upload of the attachment (replacing any previous one), not complete.
fn start_upload(
    conn: &Connection,
    account_id: &str,
    attachment_id: &str,
    upload: &Upload,
) -> Result<(), ServerError> {
    let size = i64::try_from(upload.size)
        .map_err(|_| ServerError::Invalid("file size out of range".into()))?;
    conn.execute(
        "INSERT INTO files (account_id, attachment_id, size, sha256, complete, updated_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5)
         ON CONFLICT (account_id, attachment_id) DO UPDATE SET
           size = excluded.size, sha256 = excluded.sha256, complete = 0,
           updated_at = excluded.updated_at",
        params![
            account_id,
            attachment_id,
            size,
            upload.sha256,
            store::now_utc()
        ],
    )?;
    Ok(())
}

/// Marks the upload complete; `false` when its row is gone (the attachment was deleted).
fn mark_complete(
    conn: &Connection,
    account_id: &str,
    attachment_id: &str,
    upload: &Upload,
) -> Result<bool, ServerError> {
    let size = i64::try_from(upload.size)
        .map_err(|_| ServerError::Invalid("file size out of range".into()))?;
    let n = conn.execute(
        "UPDATE files SET complete = 1, updated_at = ?1
         WHERE account_id = ?2 AND attachment_id = ?3 AND size = ?4 AND sha256 = ?5",
        params![
            store::now_utc(),
            account_id,
            attachment_id,
            size,
            upload.sha256
        ],
    )?;
    Ok(n > 0)
}

/// Forgets the file of an attachment (its row); `true` when there was one. The sync calls it in
/// its transaction when it applies a deletion of the attachment, then deletes the bytes with
/// [`FileStore::delete_files`] once committed.
pub fn forget(
    conn: &Connection,
    account_id: &str,
    attachment_id: &str,
) -> Result<bool, ServerError> {
    let n = conn.execute(
        "DELETE FROM files WHERE account_id = ?1 AND attachment_id = ?2",
        params![account_id, attachment_id],
    )?;
    Ok(n > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH: &str = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

    #[test]
    fn storage_name_is_the_sha256_of_account_nul_attachment() {
        let expected = hex_lower(&Sha256::digest(b"acc-1\0att-1"));
        assert_eq!(storage_name("acc-1", "att-1"), expected);
        assert_eq!(expected.len(), 64);
        // The separator keeps (« ab », « c ») and (« a », « bc ») apart.
        assert_ne!(storage_name("ab", "c"), storage_name("a", "bc"));
        let store = FileStore::new("/data/files", FileLimits::default());
        assert_eq!(
            store.file_path("acc-1", "../../etc/passwd"),
            PathBuf::from("/data/files/acc-1").join(storage_name("acc-1", "../../etc/passwd"))
        );
    }

    #[test]
    fn account_ids_outside_uuid_characters_never_reach_a_path() {
        let store = FileStore::new("/data/files", FileLimits::default());
        for bad in ["", "..", "a/b", "a\\b", "a b", &"a".repeat(65)] {
            assert!(store.paths(bad, "att").is_err(), "{bad:?}");
        }
        let paths = store
            .paths("6f1c2a54-0000-4000-8000-000000000001", "att")
            .expect("uuid");
        assert_eq!(
            paths.part.file_name().and_then(|n| n.to_str()),
            Some(format!("{}{PART_SUFFIX}", paths.name).as_str())
        );
    }

    #[test]
    fn content_disposition_has_an_ascii_fallback_and_the_utf8_name() {
        assert_eq!(
            content_disposition("facture.pdf"),
            "attachment; filename=\"facture.pdf\"; filename*=UTF-8''facture.pdf"
        );
        assert_eq!(
            content_disposition("Été \"x\" 100%.pdf"),
            "attachment; filename=\"_t_ _x_ 100_.pdf\"; \
             filename*=UTF-8''%C3%89t%C3%A9%20%22x%22%20100%25.pdf"
        );
        // Control characters cannot break the header.
        assert_eq!(
            content_disposition("a\r\nSet-Cookie: x;b"),
            "attachment; filename=\"a__Set-Cookie: x;b\"; \
             filename*=UTF-8''a%0D%0ASet-Cookie%3A%20x%3Bb"
        );
    }

    #[test]
    fn upload_query_needs_offset_size_and_a_lowercase_hash() {
        let ok = Upload::from_query(Some(&format!("offset=5&size=10&sha256={HASH}&x=1")))
            .expect("valid");
        assert_eq!(
            ok,
            Upload {
                offset: 5,
                size: 10,
                sha256: HASH.into()
            }
        );
        for bad in [
            None,
            Some(String::new()),
            Some(format!("size=10&sha256={HASH}")),
            Some(format!("offset=0&sha256={HASH}")),
            Some("offset=0&size=10".to_string()),
            Some(format!("offset=+1&size=10&sha256={HASH}")),
            Some(format!("offset=0&size=-1&sha256={HASH}")),
            Some(format!("offset=0&size=1e3&sha256={HASH}")),
            Some(format!("offset=0&size=99999999999999999999&sha256={HASH}")),
            Some(format!("offset=0&size=10&sha256={}", HASH.to_uppercase())),
            Some(format!("offset=0&offset=0&size=10&sha256={HASH}")),
        ] {
            let err = Upload::from_query(bad.as_deref()).expect_err("refused");
            assert_eq!(err.code, ErrorCode::BadRequest, "{bad:?}");
        }
    }

    #[test]
    fn limits_come_from_the_environment_with_the_protocol_defaults() {
        let none = FileLimits::from_lookup(|_| None).expect("defaults");
        assert_eq!(none, FileLimits::default());
        assert_eq!(none.max_file_bytes, 104_857_600);
        assert_eq!(none.account_quota_bytes, 2_147_483_648);
        assert_eq!(none.min_free_bytes, 2_147_483_648);
        let set = FileLimits::from_lookup(|key| match key {
            ENV_MAX_FILE_BYTES => Some(" 5000 ".into()),
            ENV_ACCOUNT_QUOTA_BYTES => Some("20000".into()),
            ENV_MIN_FREE_BYTES => Some("0".into()),
            _ => None,
        })
        .expect("set");
        assert_eq!(
            set,
            FileLimits {
                max_file_bytes: 5_000,
                account_quota_bytes: 20_000,
                min_free_bytes: 0,
                records_quota_bytes: DEFAULT_RECORDS_QUOTA_BYTES,
            }
        );
        let blank = FileLimits::from_lookup(|_| Some("  ".into())).expect("blank");
        assert_eq!(blank, FileLimits::default());
        for bad in ["100 Mo", "-1", "1.5", "9223372036854775808"] {
            for env in [
                ENV_MAX_FILE_BYTES,
                ENV_MIN_FREE_BYTES,
                ENV_RECORDS_QUOTA_BYTES,
            ] {
                let err = FileLimits::from_lookup(|key| (key == env).then(|| bad.into()))
                    .expect_err("refused");
                assert!(err.to_string().contains(env), "{err}");
            }
        }
    }

    #[test]
    fn a_full_disk_is_told_apart_from_other_write_errors() {
        for errno in [libc::ENOSPC, libc::EDQUOT] {
            let err = ServerError::Io(io::Error::from_raw_os_error(errno));
            assert!(is_disk_full(&err), "{errno}");
        }
        let other = ServerError::Io(io::Error::from_raw_os_error(libc::EACCES));
        assert!(!is_disk_full(&other));
        assert_eq!(disk_full().code, ErrorCode::QuotaExceeded);
        assert_eq!(ErrorCode::QuotaExceeded.http_status(), 507);
    }

    #[test]
    fn the_free_space_is_read_from_the_nearest_existing_folder() {
        let dir = tempfile::tempdir().expect("tmp");
        assert!(available_bytes(dir.path()).expect("statvfs") > 0);
        let store = FileStore::new(dir.path().join("files"), FileLimits::default());
        assert!(
            store.free_bytes().expect("free") > 0,
            "files/ does not exist yet"
        );
        store.set_free_bytes_for_tests(Some(10));
        assert_eq!(store.free_bytes().expect("override"), 10);
        assert!(store.below_floor(1, 10));
        assert!(!store.below_floor(0, 10));
    }

    #[test]
    fn a_file_lock_waits_for_its_holder_only() {
        use std::sync::Arc;
        use std::time::Duration;
        let locks = Arc::new(KeyLocks::default());
        let held = locks.lock("a").expect("a");
        // Another key is free.
        drop(locks.lock("b").expect("b"));
        let (tx, rx) = std::sync::mpsc::channel();
        let waiter = {
            let locks = Arc::clone(&locks);
            std::thread::spawn(move || {
                let _a = locks.lock("a").expect("a again");
                tx.send(()).expect("send");
            })
        };
        assert!(
            rx.recv_timeout(Duration::from_millis(100)).is_err(),
            "still held"
        );
        drop(held);
        rx.recv_timeout(Duration::from_secs(5)).expect("released");
        waiter.join().expect("join");
    }
}
