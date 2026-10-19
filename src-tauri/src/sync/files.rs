//! Attachment files through the sync server (V2.7 bis). The
//! file job runs after each successful sync, outside the sync's run lock, one file at a time:
//!
//! 1. attachments of this Mac without a hash get one (queued for the sync: the server must
//!    know the hash before the file is sent); `local` or `sent` attachments whose file is not
//!    on disk any more become `missing`;
//! 2. files this Mac has and the server not (`local`, or refused before) are sent in chunks
//!    of at most `MAX_CHUNK_BYTES`, once their row is on the server (no outbox entry): an
//!    empty first chunk opens the upload, so that a file too large or a full account is
//!    refused before any byte is sent; after a cut the upload resumes from the server's status
//!    (`received`), a `409 chunk_offset` reads it again;
//! 3. files the server has and this Mac not (`missing`) are downloaded to a hidden
//!    `.<id>.part` next to their place, resumed with `Range` when the row has a hash (a
//!    resumed download is always checked), checked against the hash, then put in place
//!    without ever replacing a file (another name is taken when the place is used).
//!
//! **A file's content never changes once it is shared** (like an e-mail attachment): the job
//! hashes attachments without a hash, and never re-hashes one whose file may be on another
//! device (`shared`: the row came from elsewhere, or the file was complete on the server). A
//! copy edited in place here then stays as it is on this Mac and is never sent under the
//! attachment's hash: the attachment becomes `missing` and its real file is fetched next to
//! the edited copy when the server has it (the attachment points at it only once it is here).
//! A copy edited before it was ever sent is the only content of its attachment: it is hashed
//! again (new hash and size, pushed by the next sync) and sent.
//!
//! Every state the job records is guarded by the hash it worked with: a hash pulled meanwhile
//! names another file, whose state is left alone.
//!
//! A network error leaves the state as it is for the next run; nothing here fails or holds
//! back the sync. Unlinked, nothing is sent; a final state is recorded only while the link
//! the run started with is still there. The logs never hold a file name, a path or any
//! content (attachment ids only).
//!
//! « Télécharger » (2026-10-10, [`save_copy`]) puts a copy of an attachment's file in the
//! Downloads folder; a file not on this Mac yet is first downloaded at once, the job's way
//! (same partial file, same checks, same placement). One download per attachment at a time
//! (`fetch_slot`): the job and « Télécharger » never write the same partial file together.

use std::fs;
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use rusqlite::{params, Connection, OptionalExtension};
use sync_proto::{ErrorCode, MAX_CHUNK_BYTES};

use crate::db::attachments::{self, FileState, Transfer};
use crate::error::{AppError, AppResult};
use crate::sync::client::{ClientError, SyncClient};
use crate::sync::service::SyncEvents;
use crate::sync::store::{self, Link};

/// `409 chunk_offset` answers tolerated for one file in one run before giving up until the
/// next run (another device of the account uploading the same file at the same time).
const MAX_OFFSET_CONFLICTS: u32 = 3;
/// Received bytes are written to disk by blocks of this size, off the async workers.
const WRITE_BLOCK: usize = 1024 * 1024;

/// What one run of the file job did (logs and tests).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FilesReport {
    /// Attachments that got their hash (queued for the next sync).
    pub hashed: usize,
    /// Files now complete on the server (sent in this run, or found there).
    pub uploaded: usize,
    /// Files now here.
    pub downloaded: usize,
    /// Bytes of file content sent in this run.
    pub sent_bytes: u64,
    /// Bytes of file content received in this run.
    pub received_bytes: u64,
    /// Files refused by the server (too large, account full).
    pub refused: usize,
    /// Files left for the next run (network error, not on the server yet, check failed…).
    pub deferred: usize,
}

impl FilesReport {
    fn is_empty(&self) -> bool {
        *self == FilesReport::default()
    }
}

/// Settings of the job: the chunk size (tests use small chunks).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileOptions {
    pub chunk_bytes: usize,
}

impl Default for FileOptions {
    fn default() -> Self {
        FileOptions {
            chunk_bytes: MAX_CHUNK_BYTES,
        }
    }
}

/// One attachment as the job sees it: a task's, or a notebook page's image (`task_id` None).
#[derive(Debug, Clone)]
struct FileRow {
    id: String,
    task_id: Option<String>,
    path: String,
    size: u64,
    sha256: Option<String>,
    /// Its file may be on another device (migration 0018).
    shared: bool,
}

/// An error for the logs, without anything that could hold a path or a file name (database
/// and I/O errors never do; other kinds are named only).
fn quiet(e: &AppError) -> String {
    match e {
        AppError::Db(_) | AppError::Io(_) => e.to_string(),
        other => format!("{:?} error", other.kind()),
    }
}

fn lock(db: &Mutex<Connection>) -> Option<MutexGuard<'_, Connection>> {
    match db.lock() {
        Ok(conn) => Some(conn),
        Err(e) => {
            log::warn!("files: database lock poisoned: {e}");
            None
        }
    }
}

/// Runs `f` under the database lock; an error is logged (no path in it) and gives `None`.
fn with_db<T>(
    db: &Mutex<Connection>,
    what: &str,
    f: impl FnOnce(&Connection) -> AppResult<T>,
) -> Option<T> {
    let conn = lock(db)?;
    match f(&conn) {
        Ok(value) => Some(value),
        Err(e) => {
            log::warn!("files: cannot {what}: {}", quiet(&e));
            None
        }
    }
}

/// Whether `link` is still the stored link (an unlink or a new link stops the job).
fn linked_on(conn: &Connection, link: &Link) -> bool {
    match store::link(conn) {
        Ok(current) => current.is_some_and(|current| current.token == link.token),
        Err(e) => {
            log::warn!("files: cannot read the link: {}", quiet(&e));
            false
        }
    }
}

fn still_linked(db: &Mutex<Connection>, link: &Link) -> bool {
    lock(db).is_some_and(|conn| linked_on(&conn, link))
}

/// Records a file state and tells the UI, only while `link` is still the stored link
/// (checked under the same lock: what a transfer learnt from an old link is never kept) and
/// the attachment still has the hash the job worked with.
fn record(
    db: &Mutex<Connection>,
    events: &dyn SyncEvents,
    link: &Link,
    row: &FileRow,
    state: FileState,
) {
    let Some(conn) = lock(db) else {
        return;
    };
    if !linked_on(&conn, link) {
        return;
    }
    match attachments::set_file_state(&conn, &row.id, row.sha256.as_deref(), state) {
        Ok(true) => tell(&conn, events, row),
        Ok(false) => log::info!("files: {} changed meanwhile, state left as it is", row.id),
        Err(e) => log::warn!(
            "files: cannot record the state of {}: {}",
            row.id,
            quiet(&e)
        ),
    }
}

/// Tells the UI that the attachments of the row's task changed, or the notebook when the row
/// is a page's image.
fn tell(conn: &Connection, events: &dyn SyncEvents, row: &FileRow) {
    match &row.task_id {
        Some(task_id) => events.attachments_changed(conn, std::slice::from_ref(task_id)),
        None => events.notes_changed(conn),
    }
}

fn changed(db: &Mutex<Connection>, events: &dyn SyncEvents, row: &FileRow) {
    if let Some(conn) = lock(db) {
        tell(&conn, events, row);
    }
}

/// Runs blocking file work on Tokio's blocking pool.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> std::io::Result<T> + Send + 'static,
) -> std::io::Result<T> {
    tokio::task::spawn_blocking(f)
        .await
        .unwrap_or_else(|e| Err(std::io::Error::other(e.to_string())))
}

/// SHA-256 and size of a file.
async fn hash_file(path: PathBuf) -> std::io::Result<(String, u64)> {
    blocking(move || {
        let size = fs::metadata(&path)?.len();
        Ok((attachments::sha256_file(&path)?, size))
    })
    .await
}

/// Something (a file, a folder, a link) is at `path`.
fn occupied(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// The download lock of each attachment that someone holds or waits for (weak: an entry
/// nobody uses any more is dropped at the next call).
static FETCH_SLOTS: Mutex<Vec<(String, Weak<tokio::sync::Mutex<()>>)>> = Mutex::new(Vec::new());

/// Waits until no other download of this attachment runs, then holds its slot until the
/// guard is dropped: the file job and « Télécharger » never write the same partial file at
/// once.
async fn fetch_slot(id: &str) -> tokio::sync::OwnedMutexGuard<()> {
    let slot = {
        let mut slots = FETCH_SLOTS.lock().unwrap_or_else(PoisonError::into_inner);
        slots.retain(|(_, slot)| slot.strong_count() > 0);
        let live = slots
            .iter()
            .filter(|(known, _)| known == id)
            .find_map(|(_, slot)| slot.upgrade());
        match live {
            Some(slot) => slot,
            None => {
                let slot = Arc::new(tokio::sync::Mutex::new(()));
                slots.push((id.to_string(), Arc::downgrade(&slot)));
                slot
            }
        }
    };
    slot.lock_owned().await
}

/// One run of the file job (see the module). Does nothing without a link.
pub async fn run(
    db: &Arc<Mutex<Connection>>,
    client: &SyncClient,
    events: &dyn SyncEvents,
    options: FileOptions,
) -> FilesReport {
    let mut report = FilesReport::default();
    let Some(link) = with_db(db, "read the link", store::link).flatten() else {
        return report;
    };
    hash_unhashed(db, &mut report).await;
    mark_missing_files(db, events);

    let uploads = with_db(db, "list the files to send", upload_candidates).unwrap_or_default();
    for row in uploads {
        if !still_linked(db, &link) {
            return report;
        }
        upload_one(db, client, events, &link, &row, options, &mut report).await;
    }
    let downloads = with_db(db, "list the files to fetch", download_candidates).unwrap_or_default();
    for row in downloads {
        if !still_linked(db, &link) {
            return report;
        }
        download_one(db, client, events, &link, &row, &mut report).await;
    }
    if !report.is_empty() {
        log::info!(
            "files: {} hashed, {} sent ({} bytes), {} received ({} bytes), {} refused, {} \
             left for later",
            report.hashed,
            report.uploaded,
            report.sent_bytes,
            report.downloaded,
            report.received_bytes,
            report.refused,
            report.deferred
        );
    }
    report
}

// ---------------------------------------------------------------------------
// Local pass
// ---------------------------------------------------------------------------

/// Attachments made before V2.7 bis get the hash and size of their file: a synced change,
/// pushed by the next sync before the file is sent. Only once: a hash is never recomputed.
async fn hash_unhashed(db: &Mutex<Connection>, report: &mut FilesReport) {
    let rows: Vec<(String, String)> = with_db(db, "list the files to hash", |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, stored_path FROM attachments WHERE sha256 IS NULL \
             AND deleted_at IS NULL ORDER BY created_at, id",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    })
    .unwrap_or_default();
    for (id, path) in rows {
        if !Path::new(&path).is_file() {
            continue;
        }
        match hash_file(PathBuf::from(&path)).await {
            Ok((sha256, size)) => {
                let done = with_db(db, "record a hash", |conn| {
                    Ok(conn.execute(
                        "UPDATE attachments SET sha256 = ?2, size = ?3 WHERE id = ?1 \
                         AND sha256 IS NULL AND deleted_at IS NULL AND stored_path = ?4",
                        params![id, sha256, i64::try_from(size).unwrap_or(i64::MAX), path],
                    )?)
                });
                if done == Some(1) {
                    report.hashed += 1;
                }
            }
            Err(e) => log::warn!("files: cannot hash the file of {id}: {e}"),
        }
    }
}

/// `local`, `sent` or refused attachments whose file is not on disk any more: to download.
fn mark_missing_files(db: &Mutex<Connection>, events: &dyn SyncEvents) {
    let Some(conn) = lock(db) else {
        return;
    };
    let rows: AppResult<Vec<(String, Option<String>, String)>> = (|| {
        let mut stmt = conn.prepare(
            "SELECT id, task_id, stored_path FROM attachments WHERE deleted_at IS NULL \
             AND remote IN ('local', 'sent', 'file_too_large', 'quota_exceeded')",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    })();
    let rows = match rows {
        Ok(rows) => rows,
        Err(e) => {
            log::warn!("files: cannot list the attachments: {}", quiet(&e));
            return;
        }
    };
    let mut tasks: Vec<String> = Vec::new();
    let mut page_images = false;
    for (id, task_id, path) in rows {
        if Path::new(&path).is_file() {
            continue;
        }
        match attachments::set_state(&conn, &id, FileState::Missing) {
            Ok(()) => match task_id {
                Some(task_id) => {
                    if !tasks.contains(&task_id) {
                        tasks.push(task_id);
                    }
                }
                None => page_images = true,
            },
            Err(e) => log::warn!("files: cannot record the state of {id}: {}", quiet(&e)),
        }
    }
    if !tasks.is_empty() {
        events.attachments_changed(&conn, &tasks);
    }
    if page_images {
        events.notes_changed(&conn);
    }
}

fn read_rows(conn: &Connection, sql: &str) -> AppResult<Vec<FileRow>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |r| {
        Ok(FileRow {
            id: r.get(0)?,
            task_id: r.get(1)?,
            path: r.get(2)?,
            size: u64::try_from(r.get::<_, i64>(3)?).unwrap_or(0),
            sha256: r.get(4)?,
            shared: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Live attachments (of tasks and notebook pages) whose file is to be sent: here and not on
/// the server yet (or refused before: the limits may have changed), with a hash, and their
/// row already on the server (no outbox entry: the server refuses a file whose attachment it
/// does not know).
fn upload_candidates(conn: &Connection) -> AppResult<Vec<FileRow>> {
    read_rows(
        conn,
        "SELECT a.id, a.task_id, a.stored_path, a.size, a.sha256, a.shared FROM attachments a \
         WHERE a.deleted_at IS NULL AND a.sha256 IS NOT NULL \
         AND a.remote IN ('local', 'file_too_large', 'quota_exceeded') \
         AND NOT EXISTS (SELECT 1 FROM sync_outbox o \
           WHERE o.entity IN ('attachment', 'note_attachment') AND o.id = a.id) \
         ORDER BY a.created_at, a.id",
    )
}

/// Live attachments (of tasks and notebook pages) whose file is not here: the Mac keeps every
/// file.
fn download_candidates(conn: &Connection) -> AppResult<Vec<FileRow>> {
    read_rows(
        conn,
        "SELECT id, task_id, stored_path, size, sha256, shared FROM attachments \
         WHERE deleted_at IS NULL AND remote = 'missing' \
         ORDER BY created_at, id",
    )
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/// How an upload ended.
enum UploadEnd {
    /// The server has the whole file.
    Sent,
    /// Refused by the server: too large, or the account is full.
    Refused(FileState),
    /// The file is not on disk any more.
    Gone,
    /// The copy here is not the file of the attachment's hash (edited in place): `sha256` and
    /// `size` of what is there, and whether the server ever had the file complete.
    NotThisFile {
        sha256: String,
        size: u64,
        on_server: bool,
    },
    /// Left for the next run.
    Later,
}

/// Why a file request failed, for the logs (no URL: it holds the id and hash only, but the
/// error kind is enough).
fn describe(e: &ClientError) -> String {
    match e {
        ClientError::Offline(_) => "server unreachable".into(),
        ClientError::Status { status, code } => format!("HTTP {status} ({code:?})"),
        ClientError::BadBody(_) => "unreadable response".into(),
        ClientError::Internal(_) => "client error".into(),
    }
}

async fn upload_one(
    db: &Mutex<Connection>,
    client: &SyncClient,
    events: &dyn SyncEvents,
    link: &Link,
    row: &FileRow,
    options: FileOptions,
    report: &mut FilesReport,
) {
    let path = PathBuf::from(&row.path);
    if !path.is_file() {
        record(db, events, link, row, FileState::Missing);
        return;
    }
    let end = {
        let _transfer = attachments::begin_transfer(&row.id, Transfer::Upload);
        changed(db, events, row);
        upload_file(client, link, row, &path, options, report).await
    };
    match end {
        UploadEnd::Sent => {
            report.uploaded += 1;
            record(db, events, link, row, FileState::Sent);
        }
        UploadEnd::Refused(state) => {
            report.refused += 1;
            record(db, events, link, row, state);
        }
        UploadEnd::Gone => record(db, events, link, row, FileState::Missing),
        UploadEnd::NotThisFile {
            sha256,
            size,
            on_server,
        } => {
            report.deferred += 1;
            if !on_server && !row.shared && adopt(db, events, link, row, &sha256, size) {
                // Never sent, nowhere else: the edited copy is the attachment's content.
                log::info!(
                    "files: the copy of {} was changed before it was sent: its new content \
                     will be sent",
                    row.id
                );
                return;
            }
            log::warn!(
                "files: the copy of {} was changed here: kept as it is, never sent",
                row.id
            );
            record(db, events, link, row, FileState::Missing);
        }
        UploadEnd::Later => {
            report.deferred += 1;
            changed(db, events, row);
        }
    }
}

/// The copy of an attachment that was never sent nor received from elsewhere changed before
/// it left: its new hash and size become the attachment's (a synced change, pushed by the next
/// sync, before the file is sent). Only while the row is still that one: same hash, never
/// shared, live, and the link unchanged. Whether it was recorded.
fn adopt(
    db: &Mutex<Connection>,
    events: &dyn SyncEvents,
    link: &Link,
    row: &FileRow,
    sha256: &str,
    size: u64,
) -> bool {
    let Some(conn) = lock(db) else {
        return false;
    };
    if !linked_on(&conn, link) {
        return false;
    }
    let updated = conn.execute(
        "UPDATE attachments SET sha256 = ?3, size = ?4, remote = 'local' \
         WHERE id = ?1 AND sha256 IS ?2 AND shared = 0 AND deleted_at IS NULL \
         AND stored_path = ?5",
        params![
            row.id,
            row.sha256,
            sha256,
            i64::try_from(size).unwrap_or(i64::MAX),
            row.path
        ],
    );
    match updated {
        Ok(1) => {
            tell(&conn, events, row);
            true
        }
        Ok(_) => false,
        Err(e) => {
            log::warn!("files: cannot record the new hash of {}: {e}", row.id);
            false
        }
    }
}

/// `len` bytes of the file from `offset`.
async fn read_chunk(path: PathBuf, offset: u64, len: usize) -> std::io::Result<Vec<u8>> {
    if len == 0 {
        // The empty first chunk: the file is not even opened.
        return Ok(Vec::new());
    }
    blocking(move || {
        let mut file = fs::File::open(&path)?;
        file.seek(SeekFrom::Start(offset))?;
        let mut chunk = vec![0u8; len];
        file.read_exact(&mut chunk)?;
        Ok(chunk)
    })
    .await
}

/// `None` when the copy here is still the file of `sha256`, else how the upload ends: another
/// content (`on_server`: the server holds a complete file of this attachment), the file gone,
/// or unreadable for now.
async fn differs(path: &Path, row: &FileRow, sha256: &str, on_server: bool) -> Option<UploadEnd> {
    match hash_file(path.to_path_buf()).await {
        Ok((actual, size)) if actual == sha256 && size == row.size => None,
        Ok((actual, size)) => Some(UploadEnd::NotThisFile {
            sha256: actual,
            size,
            on_server,
        }),
        Err(e) if e.kind() == ErrorKind::NotFound => Some(UploadEnd::Gone),
        Err(e) => {
            log::warn!("files: cannot read the file of {}: {e}", row.id);
            Some(UploadEnd::Later)
        }
    }
}

async fn upload_file(
    client: &SyncClient,
    link: &Link,
    row: &FileRow,
    path: &Path,
    options: FileOptions,
    report: &mut FilesReport,
) -> UploadEnd {
    let Some(sha256) = row.sha256.as_deref() else {
        return UploadEnd::Later;
    };
    let (url, token) = (link.server_url.as_str(), link.token.as_str());
    let status = match client.file_status(url, token, &row.id).await {
        Ok(status) => status,
        Err(e) => {
            // 404: the server does not know this attachment (deleted there meanwhile).
            log::info!("files: no status for {}: {}", row.id, describe(&e));
            return UploadEnd::Later;
        }
    };
    if status.complete && status.size == row.size {
        // The server has it: this Mac's copy is that file only when it was not edited here.
        return match differs(path, row, sha256, true).await {
            Some(end) => end,
            None => UploadEnd::Sent,
        };
    }
    // Whether the server holds a complete file at all (of another size: an older upload).
    let on_server = status.complete;
    // Checked once, right before the first bytes go: a file the server refuses (too large, a
    // full account) is answered by the empty first chunk and never read.
    let mut checked = false;
    // Bytes the server holds of this upload; another size restarts it from zero.
    let mut offset = if status.size == row.size {
        status.received
    } else {
        0
    };
    let mut opened = status.received > 0 && status.size == row.size;
    let chunk_bytes = options.chunk_bytes.clamp(1, MAX_CHUNK_BYTES) as u64;
    let mut conflicts = 0;
    loop {
        // An empty first chunk opens the upload: limits are checked before any byte goes.
        let len = if opened {
            row.size.saturating_sub(offset).min(chunk_bytes)
        } else {
            0
        };
        if len > 0 && !checked {
            // Bytes are about to go: the copy here must still be the file of this hash.
            if let Some(end) = differs(path, row, sha256, on_server).await {
                return end;
            }
            checked = true;
        }
        let chunk = match read_chunk(path.to_path_buf(), offset, len as usize).await {
            Ok(chunk) => chunk,
            Err(e) if e.kind() == ErrorKind::NotFound => return UploadEnd::Gone,
            // Shorter than checked: changed while it was being sent; the next run decides.
            Err(e) if e.kind() == ErrorKind::UnexpectedEof => return UploadEnd::Later,
            Err(e) => {
                log::warn!("files: cannot read the file of {}: {e}", row.id);
                return UploadEnd::Later;
            }
        };
        match client
            .put_file_chunk(url, token, &row.id, offset, row.size, sha256, chunk)
            .await
        {
            Ok(status) => {
                report.sent_bytes += len;
                if status.complete {
                    return UploadEnd::Sent;
                }
                if opened && status.received <= offset {
                    log::warn!("files: the server kept nothing of a chunk of {}", row.id);
                    return UploadEnd::Later;
                }
                offset = status.received;
                opened = true;
            }
            Err(ClientError::Status {
                code: Some(ErrorCode::ChunkOffset),
                ..
            }) => {
                conflicts += 1;
                if conflicts > MAX_OFFSET_CONFLICTS {
                    return UploadEnd::Later;
                }
                match client.file_status(url, token, &row.id).await {
                    Ok(status) if status.complete && status.size == row.size => {
                        if !checked {
                            if let Some(end) = differs(path, row, sha256, true).await {
                                return end;
                            }
                        }
                        return UploadEnd::Sent;
                    }
                    Ok(status) => {
                        offset = if status.size == row.size {
                            status.received
                        } else {
                            0
                        };
                        opened = status.size == row.size && status.received > 0;
                    }
                    Err(e) => {
                        log::info!("files: no status for {}: {}", row.id, describe(&e));
                        return UploadEnd::Later;
                    }
                }
            }
            Err(ClientError::Status {
                code: Some(ErrorCode::FileTooLarge),
                ..
            }) => return UploadEnd::Refused(FileState::FileTooLarge),
            Err(ClientError::Status {
                code: Some(ErrorCode::QuotaExceeded),
                ..
            }) => return UploadEnd::Refused(FileState::QuotaExceeded),
            Err(ClientError::Status {
                code: Some(ErrorCode::HashMismatch),
                ..
            }) => {
                // Changed while it was being sent: the next run's check decides.
                log::warn!("files: the server found another hash for {}", row.id);
                return UploadEnd::Later;
            }
            Err(e) => {
                log::info!("files: sending {} stopped: {}", row.id, describe(&e));
                return UploadEnd::Later;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/// Why a download stopped before the end. The file job only logs it (the next run tries
/// again); « Télécharger » tells the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stop {
    /// No network, a timeout, nothing received for a while, or a gateway error (502, 503,
    /// 504).
    Network,
    /// The server answered with this error status.
    Status(u16),
    /// The partial file could not be written on this Mac.
    Local(ErrorKind),
    /// The request could not even be built (bad server address).
    Client,
}

/// The stop of a failed request to the server.
fn stop_of(e: &ClientError) -> Stop {
    match e {
        ClientError::Offline(_) | ClientError::BadBody(_) => Stop::Network,
        ClientError::Status {
            status: 502..=504, ..
        } => Stop::Network,
        ClientError::Status { status, .. } => Stop::Status(*status),
        ClientError::Internal(_) => Stop::Client,
    }
}

/// How a download ended.
enum Fetch {
    /// The whole body is in the partial file.
    Done,
    /// The server has no complete file for it (yet, or any more).
    NotThere,
    /// The partial file is wrong (larger than the file, refused range): start again.
    Restart,
    /// Left for the next run (the partial file keeps what arrived), and why.
    Later(Stop),
}

fn remove_quietly(path: &Path) {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => log::warn!("files: cannot remove a partial download: {e}"),
    }
}

/// A free name next to `dest` (same folder, `name (2).ext`…), recorded as the attachment's
/// new stored path (local-only). Used when something already sits at `dest`: a download never
/// replaces a file.
fn relocate_on(conn: &Connection, id: &str, dest: &Path) -> AppResult<PathBuf> {
    let (Some(dir), Some(name)) = (dest.parent(), dest.file_name()) else {
        return Err(AppError::Invalid("no folder or name to relocate to".into()));
    };
    let free = attachments::free_name(conn, dir, &name.to_string_lossy())?;
    conn.execute(
        "UPDATE attachments SET stored_path = ?2 WHERE id = ?1",
        params![id, free.to_string_lossy()],
    )?;
    Ok(free)
}

/// How a download of one attachment's file ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DownloadEnd {
    /// The file is at the attachment's stored path (fetched, or already there).
    Done,
    /// The server has no complete file for it (yet, or any more).
    NotThere,
    /// The transfer stopped (left for later), and why.
    Stopped(Stop),
    /// Anything else (no place for it, a wrong file received, deleted meanwhile…).
    Failed,
}

/// The file job's download of one attachment: once no other download of it runs, and only
/// while the attachment still waits for this very file (« Télécharger » may have fetched it
/// meanwhile, or another hash or place was recorded).
async fn download_one(
    db: &Mutex<Connection>,
    client: &SyncClient,
    events: &dyn SyncEvents,
    link: &Link,
    row: &FileRow,
    report: &mut FilesReport,
) {
    let _slot = fetch_slot(&row.id).await;
    let waiting = with_db(db, "read an attachment", |conn| {
        Ok(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM attachments WHERE id = ?1 AND deleted_at IS NULL \
             AND remote = 'missing' AND sha256 IS ?2 AND stored_path = ?3)",
            params![row.id, row.sha256, row.path],
            |r| r.get::<_, bool>(0),
        )?)
    });
    if waiting == Some(true) {
        download_locked(db, client, events, link, row, report).await;
    }
}

/// Downloads the file of `row` to its stored path (the caller holds its `fetch_slot`).
async fn download_locked(
    db: &Mutex<Connection>,
    client: &SyncClient,
    events: &dyn SyncEvents,
    link: &Link,
    row: &FileRow,
    report: &mut FilesReport,
) -> DownloadEnd {
    let dest = PathBuf::from(&row.path);
    if !dest.is_absolute() || dest.file_name().is_none() {
        report.deferred += 1;
        return DownloadEnd::Failed;
    }
    if occupied(&dest) {
        // Something is already there. This very file: kept, nothing fetched; the upload pass
        // asks the server whether it has it (`local`). Anything else (a copy edited here, a
        // file put there by hand) is never touched: the download goes to a free name next to
        // it, chosen once the file has arrived (`finish_download`), so that the attachment
        // keeps pointing at what is there until then.
        let regular = fs::symlink_metadata(&dest).is_ok_and(|m| m.is_file());
        let same = match (&row.sha256, regular) {
            (Some(expected), true) => hash_file(dest.clone())
                .await
                .is_ok_and(|(sha256, _)| *expected == sha256),
            _ => false,
        };
        if same {
            report.downloaded += 1;
            record(db, events, link, row, FileState::Local);
            return DownloadEnd::Done;
        }
    }
    if let Some(dir) = dest.parent() {
        if let Err(e) = fs::create_dir_all(dir) {
            log::warn!("files: cannot make the folder of {}: {e}", row.id);
            report.deferred += 1;
            return DownloadEnd::Stopped(Stop::Local(e.kind()));
        }
    }
    let part = attachments::partial_path(&dest, &row.id);
    // Resumed only when the result can be checked against the hash.
    let resume_from = match (&row.sha256, fs::symlink_metadata(&part)) {
        (Some(_), Ok(meta)) if meta.is_file() && meta.len() <= row.size => meta.len(),
        _ => {
            remove_quietly(&part);
            0
        }
    };
    let fetched = if resume_from == row.size && row.size > 0 {
        // Everything arrived before a stop: only the check and the move are left.
        Fetch::Done
    } else {
        let _transfer = attachments::begin_transfer(&row.id, Transfer::Download);
        changed(db, events, row);
        let fetched = fetch(client, link, row, &part, resume_from, report).await;
        changed(db, events, row);
        fetched
    };
    match fetched {
        Fetch::Done => {}
        Fetch::NotThere => {
            report.deferred += 1;
            return DownloadEnd::NotThere;
        }
        Fetch::Later(stop) => {
            report.deferred += 1;
            return DownloadEnd::Stopped(stop);
        }
        Fetch::Restart => {
            remove_quietly(&part);
            report.deferred += 1;
            return DownloadEnd::Failed;
        }
    }
    if !checked(row, &part, resume_from > 0).await {
        remove_quietly(&part);
        report.deferred += 1;
        return DownloadEnd::Failed;
    }
    if finish_download(db, events, link, row, &part) {
        report.downloaded += 1;
        DownloadEnd::Done
    } else {
        report.deferred += 1;
        DownloadEnd::Failed
    }
}

/// The downloaded file is the right one: its hash when the row has one, else its size (a
/// resumed download always has a hash, see `download_one`).
async fn checked(row: &FileRow, part: &Path, resumed: bool) -> bool {
    match (&row.sha256, hash_file(part.to_path_buf()).await) {
        (Some(expected), Ok((sha256, _))) => {
            let ok = *expected == sha256;
            if !ok {
                log::warn!("files: the file received for {} has another hash", row.id);
            }
            ok
        }
        (None, Ok((_, size))) => !resumed && size == row.size,
        (_, Err(e)) => {
            log::warn!("files: cannot check the file received for {}: {e}", row.id);
            false
        }
    }
}

/// The value macOS puts in `com.apple.quarantine` for a downloaded file, as browsers and
/// messaging apps write it (`<flags>;<hex Unix time>;<agent>;<event id>`, the event id left
/// empty): flags 0x0081, a download not yet opened.
fn quarantine_value(now: std::time::SystemTime) -> String {
    let secs = now
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("0081;{secs:08x};Taido;")
}

/// Marks a file downloaded from the server as quarantined (`com.apple.quarantine`), so that an
/// app or a script received as an attachment and double-clicked in its folder goes through
/// Gatekeeper like one downloaded with Safari. Best effort: a failure is logged (no path),
/// never fails the download.
#[cfg(target_os = "macos")]
fn quarantine(path: &Path) {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let value = quarantine_value(std::time::SystemTime::now());
    let Ok(c_path) = CString::new(path.as_os_str().as_bytes()) else {
        return;
    };
    let name = c"com.apple.quarantine";
    // SAFETY: both strings are NUL-terminated and live across the call; `value` points to
    // `value.len()` readable bytes; position 0 is required for an attribute that is not a
    // resource fork (setxattr(2)).
    let rc = unsafe {
        libc::setxattr(
            c_path.as_ptr(),
            name.as_ptr(),
            value.as_ptr().cast(),
            value.len(),
            0,
            libc::XATTR_NOFOLLOW,
        )
    };
    if rc != 0 {
        log::warn!(
            "files: cannot mark a downloaded file as quarantined: {}",
            std::io::Error::last_os_error()
        );
    }
}

#[cfg(not(target_os = "macos"))]
fn quarantine(_path: &Path) {}

/// Whether the file carries `com.apple.quarantine` (it came from the server, or from the web).
#[cfg(target_os = "macos")]
pub(crate) fn is_quarantined(path: &Path) -> bool {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let Ok(c_path) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: both strings are NUL-terminated and live across the call; a null buffer of size
    // 0 only asks for the attribute's size (getxattr(2)), nothing is written.
    let size = unsafe {
        libc::getxattr(
            c_path.as_ptr(),
            c"com.apple.quarantine".as_ptr(),
            std::ptr::null_mut(),
            0,
            0,
            libc::XATTR_NOFOLLOW,
        )
    };
    size >= 0
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn is_quarantined(_path: &Path) -> bool {
    false
}

/// Moves a checked download into place, never over a file: a hard link fails when the name
/// is taken (then the partial name goes). A volume without hard links gets a rename after a
/// last check.
fn place(part: &Path, dest: &Path) -> std::io::Result<()> {
    match fs::hard_link(part, dest) {
        Ok(()) => {
            remove_quietly(part);
            Ok(())
        }
        Err(e) if e.kind() == ErrorKind::AlreadyExists => Err(e),
        Err(_) if !occupied(dest) => fs::rename(part, dest),
        Err(e) => Err(e),
    }
}

/// Puts the checked file at the attachment's stored path (another free name when that one
/// was taken meanwhile) and records it, unless the attachment was deleted or the link changed
/// meanwhile. Under the database lock, so that a deletion or an unlink waits for it.
fn finish_download(
    db: &Mutex<Connection>,
    events: &dyn SyncEvents,
    link: &Link,
    row: &FileRow,
    part: &Path,
) -> bool {
    let Some(conn) = lock(db) else {
        return false;
    };
    if !linked_on(&conn, link) {
        // Kept for a later run of this link (a resumed download is checked again).
        return false;
    }
    // Still this attachment, with the hash the file was checked against.
    let live: Option<String> = conn
        .query_row(
            "SELECT stored_path FROM attachments WHERE id = ?1 AND deleted_at IS NULL \
             AND sha256 IS ?2",
            params![row.id, row.sha256],
            |r| r.get(0),
        )
        .optional()
        .unwrap_or(None);
    let Some(stored) = live else {
        remove_quietly(part);
        return false;
    };
    let mut dest = PathBuf::from(stored);
    if dest.parent() != part.parent() {
        remove_quietly(part);
        return false;
    }
    // Before it is in place: never there without it (the hard link shares the attribute).
    quarantine(part);
    let mut placed = false;
    for _ in 0..3 {
        match place(part, &dest) {
            Ok(()) => {
                placed = true;
                break;
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {
                match relocate_on(&conn, &row.id, &dest) {
                    Ok(free) => dest = free,
                    Err(e) => {
                        log::warn!("files: cannot choose a free name: {}", quiet(&e));
                        break;
                    }
                }
            }
            Err(e) => {
                log::warn!("files: cannot put the file of {} in place: {e}", row.id);
                break;
            }
        }
    }
    if !placed {
        remove_quietly(part);
        return false;
    }
    if let Err(e) =
        attachments::set_file_state(&conn, &row.id, row.sha256.as_deref(), FileState::Sent)
    {
        log::warn!(
            "files: cannot record the state of {}: {}",
            row.id,
            quiet(&e)
        );
    }
    tell(&conn, events, row);
    true
}

/// Writes and empties `buffer` at the end of `file`, off the async workers.
async fn write_out(file: &Arc<fs::File>, buffer: &mut Vec<u8>) -> std::io::Result<()> {
    if buffer.is_empty() {
        return Ok(());
    }
    let data = std::mem::replace(buffer, Vec::with_capacity(WRITE_BLOCK));
    let file = Arc::clone(file);
    blocking(move || (&*file).write_all(&data)).await
}

async fn fetch(
    client: &SyncClient,
    link: &Link,
    row: &FileRow,
    part: &Path,
    from: u64,
    report: &mut FilesReport,
) -> Fetch {
    let mut body = match client
        .download_file(&link.server_url, &link.token, &row.id, from)
        .await
    {
        Ok(body) => body,
        Err(ClientError::Status { status: 404, .. }) => return Fetch::NotThere,
        Err(ClientError::Status { status: 416, .. }) => return Fetch::Restart,
        Err(ClientError::BadBody(_)) => return Fetch::Restart,
        Err(e) => {
            log::info!("files: fetching {} stopped: {}", row.id, describe(&e));
            return Fetch::Later(stop_of(&e));
        }
    };
    let append = body.start() > 0;
    let target = part.to_path_buf();
    let opened = blocking(move || {
        if append {
            fs::OpenOptions::new().append(true).open(&target)
        } else {
            fs::File::create(&target)
        }
    })
    .await;
    let file = match opened {
        Ok(file) => Arc::new(file),
        Err(e) => {
            log::warn!("files: cannot write the file of {}: {e}", row.id);
            return Fetch::Later(Stop::Local(e.kind()));
        }
    };
    let mut buffer: Vec<u8> = Vec::with_capacity(WRITE_BLOCK);
    let mut total = body.start();
    let end = loop {
        match body.next_chunk().await {
            Ok(Some(bytes)) => {
                total += bytes.len() as u64;
                if total > row.size {
                    log::warn!("files: the server sent more than the size of {}", row.id);
                    return Fetch::Restart;
                }
                report.received_bytes += bytes.len() as u64;
                buffer.extend_from_slice(&bytes);
                if buffer.len() >= WRITE_BLOCK {
                    if let Err(e) = write_out(&file, &mut buffer).await {
                        log::warn!("files: cannot write the file of {}: {e}", row.id);
                        return Fetch::Later(Stop::Local(e.kind()));
                    }
                }
            }
            Ok(None) => break Fetch::Done,
            Err(e) => {
                log::info!("files: fetching {} stopped: {}", row.id, describe(&e));
                break Fetch::Later(stop_of(&e));
            }
        }
    };
    // What arrived is kept, even after a cut: a later run resumes from it.
    let flushed = match write_out(&file, &mut buffer).await {
        Ok(()) => {
            let file = Arc::clone(&file);
            blocking(move || file.sync_all()).await
        }
        Err(e) => Err(e),
    };
    if let Err(e) = flushed {
        log::warn!("files: cannot write the file of {}: {e}", row.id);
        return Fetch::Later(Stop::Local(e.kind()));
    }
    end
}

// ---------------------------------------------------------------------------
// « Télécharger »
// ---------------------------------------------------------------------------

/// The live attachment `id` as « Télécharger » needs it: the job's row, its state, its name.
fn wanted(conn: &Connection, id: &str) -> AppResult<(FileRow, FileState, String)> {
    conn.query_row(
        "SELECT id, task_id, stored_path, size, sha256, shared, remote, file_name \
         FROM attachments WHERE id = ?1 AND deleted_at IS NULL AND task_id IS NOT NULL",
        [id],
        |r| {
            let row = FileRow {
                id: r.get(0)?,
                task_id: r.get(1)?,
                path: r.get(2)?,
                size: u64::try_from(r.get::<_, i64>(3)?).unwrap_or(0),
                sha256: r.get(4)?,
                shared: r.get(5)?,
            };
            Ok((row, FileState::parse(&r.get::<_, String>(6)?), r.get(7)?))
        },
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("attachment {id}")))
}

/// Name of the copy in the Downloads folder: the attachment's name when it is a plain file
/// name (it may come from another device), else `fichier`.
fn download_name(file_name: &str) -> &str {
    let mut parts = Path::new(file_name).components();
    match (parts.next(), parts.next()) {
        (Some(Component::Normal(_)), None) if !file_name.contains('/') => file_name,
        _ => "fichier",
    }
}

/// « Télécharger » on the Mac (2026-10-10): copies the file of attachment `id` into
/// `downloads` (the user's Downloads folder; a temp folder in tests) under a free name, never
/// over a file (`name (2).ext`…), and returns the copy's path. A file not on this Mac yet
/// (pulled from another device, or its copy gone) is first downloaded now, ahead of the file
/// job, when the Mac is linked: the job's partial file, checks and placement, so the
/// attachment's own copy arrives too. The copy carries the quarantine of its source (a file
/// that came from the server).
///
/// Errors: `not_found` (the attachment is gone), `file_not_here` (not here and no account),
/// `file_not_on_server` (the server does not have it), `sync_offline` (the server could not
/// be reached, a gateway error), `sync_auth` (the server refused the token: reconnect),
/// `sync_server` (another error status), `disk_full` / `file_write_failed` (the file cannot
/// be written on this Mac, in the task's folder or the Downloads folder), `downloads_denied`
/// (macOS refused access to the Downloads folder), `internal` (anything else).
pub async fn save_copy(
    db: &Mutex<Connection>,
    client: &SyncClient,
    events: &dyn SyncEvents,
    id: &str,
    downloads: &Path,
) -> AppResult<PathBuf> {
    let _slot = fetch_slot(id).await;
    let ((row, state, file_name), link) = {
        let conn = db.lock()?;
        (wanted(&conn, id)?, store::link(&conn)?)
    };
    let stored = PathBuf::from(&row.path);
    // Linked, what sits at the place of a `missing` attachment is not its file (a copy edited
    // here): the real one is fetched. Unlinked, the tile shows what is there. A link is never
    // followed (as in the file job).
    let here = regular_file(&stored) && (state != FileState::Missing || link.is_none());
    let source = if here {
        stored
    } else {
        let Some(link) = link else {
            return Err(AppError::FileNotHere(id.to_string()));
        };
        let mut report = FilesReport::default();
        match download_locked(db, client, events, &link, &row, &mut report).await {
            DownloadEnd::Done => {}
            DownloadEnd::NotThere => return Err(AppError::FileNotOnServer(id.to_string())),
            DownloadEnd::Stopped(stop) => return Err(stop_error(id, stop)),
            DownloadEnd::Failed => {
                return Err(AppError::Internal(format!("download of {id} failed")))
            }
        }
        // Its place may have changed: a free name next to a file that was already there.
        let (_, path) = attachments::get(&*db.lock()?, id)?;
        PathBuf::from(path)
    };
    let name = download_name(&file_name).to_string();
    let (dir, id) = (downloads.to_path_buf(), id.to_string());
    tokio::task::spawn_blocking(move || copy_out(&source, &dir, &name, &id))
        .await
        .map_err(|e| AppError::Internal(format!("copy task: {e}")))?
}

/// A regular file is at `path` (a link is not followed).
fn regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_file())
}

/// What the user is told when a download for « Télécharger » stopped.
fn stop_error(id: &str, stop: Stop) -> AppError {
    match stop {
        Stop::Network => AppError::SyncOffline(format!("download of {id} stopped")),
        // The token was refused: the sync says « reconnecte-toi » too.
        Stop::Status(401) => AppError::SyncAuth,
        Stop::Status(status) => AppError::SyncServer(format!("download of {id}: HTTP {status}")),
        Stop::Local(kind) => local_write_error(kind, "the task's folder"),
        Stop::Client => AppError::Internal(format!("download of {id}: bad request")),
    }
}

/// A file that cannot be written on this Mac: the disk (or the user's quota) is full, or
/// anything else (`place` names the folder for the logs, never its path).
fn local_write_error(kind: ErrorKind, place: &str) -> AppError {
    match kind {
        ErrorKind::StorageFull | ErrorKind::QuotaExceeded => {
            AppError::DiskFull(format!("writing in {place}"))
        }
        other => AppError::FileWriteFailed(format!("writing in {place}: {other}")),
    }
}

/// An error writing in the Downloads folder: refused by macOS (privacy: the folder is
/// protected, and the user may have said no), the disk full, or anything else.
fn downloads_error(e: &std::io::Error) -> AppError {
    match e.kind() {
        ErrorKind::PermissionDenied => AppError::DownloadsDenied(e.to_string()),
        kind => local_write_error(kind, "the downloads folder"),
    }
}

/// Copies `source` into `dir` as `name` (`name (2).ext`… when taken): first to a hidden
/// `.<id>.part`, then put in place without replacing anything (`place`), so that a half copy
/// never shows under the real name. The copy carries the quarantine of its source.
///
/// macOS protects the Downloads folder: the first copy asks the user (« Taido V2 souhaite
/// accéder… », `NSDownloadsFolderUsageDescription` in `src-tauri/Info.plist`), again after an
/// update of an app signed ad hoc; a refusal is `downloads_denied`.
fn copy_out(source: &Path, dir: &Path, name: &str, id: &str) -> AppResult<PathBuf> {
    if !regular_file(source) {
        return Err(AppError::NotFound(format!("file of attachment {id}")));
    }
    // Readable first: a failure past this point is the Downloads folder's.
    drop(fs::File::open(source)?);
    fs::create_dir_all(dir).map_err(|e| downloads_error(&e))?;
    let part = attachments::partial_path(&dir.join(name), id);
    // A leftover of a stopped copy is ours (named after the attachment): gone first, so that
    // the new copy never goes through a link left there.
    remove_quietly(&part);
    if let Err(e) = fs::copy(source, &part) {
        remove_quietly(&part);
        return Err(downloads_error(&e));
    }
    // `fs::copy` keeps the extended attributes on macOS; set it anyway if a volume did not.
    if is_quarantined(source) && !is_quarantined(&part) {
        quarantine(&part);
    }
    for _ in 0..5 {
        let dest = attachments::first_free(dir, name, |p| Ok(!occupied(p)))?;
        match place(&part, &dest) {
            Ok(()) => return Ok(dest),
            // Taken meanwhile: the next free name.
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
            Err(e) => {
                remove_quietly(&part);
                return Err(downloads_error(&e));
            }
        }
    }
    remove_quietly(&part);
    Err(AppError::Internal(
        "no free name in the downloads folder".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{now_utc, open_in_memory, test_support};
    use crate::sync::e2e_tests::NoEvents;

    /// A linked database with one pulled attachment `att` of `sha256`, waiting for its file at
    /// `dest`.
    fn pulled(dest: &Path, sha256: &str) -> (Mutex<Connection>, Link, String) {
        let conn = open_in_memory().expect("db");
        let task = test_support::task(&conn, "Devis", None, None);
        let link = Link {
            server_url: "http://127.0.0.1:9".into(),
            token: "token".into(),
            device_id: "mac".into(),
            server_epoch: "epoch".into(),
        };
        store::save_link(&conn, &link).expect("link");
        conn.execute(
            "INSERT INTO attachments (id, task_id, file_name, stored_path, mime_type, size, \
             created_at, updated_at, sha256, remote, shared) \
             VALUES ('att', ?1, 'a.pdf', ?2, 'application/pdf', 3, ?3, ?3, ?4, 'missing', 1)",
            params![task, dest.to_string_lossy(), now_utc(), sha256],
        )
        .expect("attachment");
        (Mutex::new(conn), link, task)
    }

    fn row_of(task: &str, dest: &Path, bytes: &[u8]) -> FileRow {
        FileRow {
            id: "att".into(),
            task_id: Some(task.into()),
            path: dest.to_string_lossy().into_owned(),
            size: bytes.len() as u64,
            sha256: Some(attachments::sha256_bytes(bytes)),
            shared: true,
        }
    }

    fn remote(db: &Mutex<Connection>) -> String {
        db.lock()
            .expect("db")
            .query_row("SELECT remote FROM attachments WHERE id = 'att'", [], |r| {
                r.get(0)
            })
            .expect("remote")
    }

    /// A file checked against a hash is recorded only while the attachment still has that
    /// hash: another one pulled meanwhile names another file.
    #[test]
    fn a_download_counts_only_for_the_hash_it_was_checked_against() {
        let dir = tempfile::tempdir().expect("dir");
        let dest = dir.path().join("a.pdf");
        let (db, link, task) = pulled(&dest, &attachments::sha256_bytes(b"new"));
        let part = attachments::partial_path(&dest, "att");

        fs::write(&part, b"old").expect("part");
        let stale = row_of(&task, &dest, b"old");
        assert!(!finish_download(&db, &NoEvents, &link, &stale, &part));
        assert!(!part.exists() && !dest.exists());
        record(&db, &NoEvents, &link, &stale, FileState::Sent);
        assert_eq!(
            remote(&db),
            "missing",
            "a state for the old hash is ignored"
        );

        fs::write(&part, b"new").expect("part");
        let current = row_of(&task, &dest, b"new");
        assert!(finish_download(&db, &NoEvents, &link, &current, &part));
        assert_eq!(fs::read(&dest).expect("placed"), b"new");
        assert_eq!(remote(&db), "sent");
        #[cfg(target_os = "macos")]
        assert!(
            quarantine_of(&dest).is_some_and(|v| v.starts_with("0081;") && v.ends_with(";Taido;")),
            "{:?}",
            quarantine_of(&dest)
        );
    }

    /// The file's `com.apple.quarantine` attribute, read back with getxattr(2).
    #[cfg(target_os = "macos")]
    fn quarantine_of(path: &Path) -> Option<String> {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let c_path = CString::new(path.as_os_str().as_bytes()).expect("path");
        let mut buf = vec![0u8; 256];
        // SAFETY: NUL-terminated strings, and a writable buffer of `buf.len()` bytes.
        let n = unsafe {
            libc::getxattr(
                c_path.as_ptr(),
                c"com.apple.quarantine".as_ptr(),
                buf.as_mut_ptr().cast(),
                buf.len(),
                0,
                0,
            )
        };
        let n = usize::try_from(n).ok()?;
        String::from_utf8(buf[..n].to_vec()).ok()
    }

    #[test]
    fn the_quarantine_value_is_the_one_browsers_write() {
        let at = std::time::UNIX_EPOCH + std::time::Duration::from_secs(0x6a7f_250c);
        assert_eq!(quarantine_value(at), "0081;6a7f250c;Taido;");
    }

    /// Gatekeeper sees a downloaded file as one from Safari; a file never fails over it.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_downloaded_file_is_quarantined() {
        let dir = tempfile::tempdir().expect("dir");
        let file = dir.path().join("outil.command");
        fs::write(&file, b"#!/bin/sh\necho hi\n").expect("write");
        quarantine(&file);
        let value = quarantine_of(&file).expect("attribute set");
        let fields: Vec<&str> = value.split(';').collect();
        assert_eq!(fields.len(), 4, "{value}");
        assert_eq!((fields[0], fields[2], fields[3]), ("0081", "Taido", ""));
        assert!(u64::from_str_radix(fields[1], 16).is_ok_and(|t| t > 0x6000_0000));
        // A path that does not exist: logged, nothing else.
        quarantine(&dir.path().join("absent"));
    }

    /// « Télécharger »: the job and a download asked by the user never write the same partial
    /// file at once; other attachments are not held up.
    #[tokio::test]
    async fn one_download_per_attachment_at_a_time() {
        let wait = std::time::Duration::from_millis(100);
        let held = fetch_slot("slot-test-a").await;
        let other = tokio::time::timeout(wait, fetch_slot("slot-test-b")).await;
        assert!(other.is_ok(), "another attachment goes");
        let same = tokio::time::timeout(wait, fetch_slot("slot-test-a")).await;
        assert!(same.is_err(), "the same attachment waits");
        drop(held);
        let after =
            tokio::time::timeout(std::time::Duration::from_secs(5), fetch_slot("slot-test-a"));
        assert!(after.await.is_ok(), "then it goes");
    }

    /// The copy keeps a downloaded file's quarantine; a name from another device never leaves
    /// the folder.
    #[test]
    fn a_copy_in_the_downloads_folder_keeps_the_quarantine_and_stays_in_it() {
        let dir = tempfile::tempdir().expect("dir");
        let source = dir.path().join("outil.command");
        fs::write(&source, b"#!/bin/sh\necho hi\n").expect("write");
        quarantine(&source);
        let downloads = dir.path().join("Téléchargements");
        let copy = copy_out(&source, &downloads, "outil.command", "att").expect("copy");
        assert_eq!(copy, downloads.join("outil.command"));
        assert_eq!(
            fs::read(&copy).expect("copy"),
            fs::read(&source).expect("source")
        );
        #[cfg(target_os = "macos")]
        assert!(is_quarantined(&copy));
        assert!(!attachments::partial_path(&copy, "att").exists());

        for name in ["../../evil.sh", "a/b.txt", "..", ".", ""] {
            assert_eq!(download_name(name), "fichier", "{name:?}");
        }
        assert_eq!(download_name("devis (final).pdf"), "devis (final).pdf");
    }

    /// What « Télécharger » says when a download stopped, by cause.
    #[test]
    fn a_stopped_download_is_told_by_its_cause() {
        use crate::error::ErrorKind as Kind;
        let status = |status| ClientError::Status { status, code: None };
        assert_eq!(
            stop_of(&ClientError::Offline("timeout".into())),
            Stop::Network
        );
        for gateway in [502, 503, 504] {
            assert_eq!(stop_of(&status(gateway)), Stop::Network);
        }
        assert_eq!(stop_of(&status(500)), Stop::Status(500));
        assert_eq!(stop_error("att", Stop::Network).kind(), Kind::SyncOffline);
        assert_eq!(stop_error("att", Stop::Status(401)).kind(), Kind::SyncAuth);
        assert_eq!(
            stop_error("att", Stop::Status(500)).kind(),
            Kind::SyncServer
        );
        assert_eq!(
            stop_error("att", Stop::Status(403)).kind(),
            Kind::SyncServer
        );
        for full in [ErrorKind::StorageFull, ErrorKind::QuotaExceeded] {
            assert_eq!(stop_error("att", Stop::Local(full)).kind(), Kind::DiskFull);
        }
        assert_eq!(
            stop_error("att", Stop::Local(ErrorKind::PermissionDenied)).kind(),
            Kind::FileWriteFailed
        );
        let denied = std::io::Error::from(ErrorKind::PermissionDenied);
        assert_eq!(downloads_error(&denied).kind(), Kind::DownloadsDenied);
        let full = std::io::Error::from(ErrorKind::StorageFull);
        assert_eq!(downloads_error(&full).kind(), Kind::DiskFull);
    }

    /// The final move of a download never replaces a file.
    #[test]
    fn a_download_is_put_in_place_without_replacing_anything() {
        let dir = tempfile::tempdir().expect("dir");
        let (part, dest) = (dir.path().join(".id.part"), dir.path().join("a.pdf"));
        fs::write(&part, b"downloaded").expect("part");
        fs::write(&dest, b"already there").expect("dest");
        let refused = place(&part, &dest).expect_err("taken");
        assert_eq!(refused.kind(), ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&dest).expect("dest"), b"already there");
        assert!(part.is_file(), "the download is kept for another name");
        let free = dir.path().join("a (2).pdf");
        place(&part, &free).expect("free name");
        assert_eq!(fs::read(&free).expect("placed"), b"downloaded");
        assert!(!part.exists());
    }
}
