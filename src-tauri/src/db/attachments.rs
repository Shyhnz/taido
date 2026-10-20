//! Attachments. A file attached to a task is **copied** into
//! `<app folder>/Attachments/<project>/<task>/` (by design: never into a code folder), so that
//! Claude can read it (`--add-dir`, and its path in the context file). The copy belongs to the
//! app: removing the attachment removes the copy, never the original.
//!
//! Each attachment keeps the SHA-256 of its file (`sha256`, synced) and where its
//! file stands with the account's server (`remote`, local-only, [`FileState`]); the sync's
//! file job (`sync::files`) sends and fetches the files.

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::db::{new_id, now_utc, subjects, tasks, workspace};
use crate::error::{AppError, AppResult};
use crate::i18n;
use crate::model::{Attachment, AttachmentInfo, AttachmentRemote, NoteAttachment};

/// Folder of every attachment, in the app's folder.
#[cfg(test)]
pub const FOLDER_NAME: &str = "Pièces jointes";

/// `<app folder>/Attachments` (`Pièces jointes` in French, or whichever exists).
fn attachments_dir(conn: &Connection, root: &Path) -> PathBuf {
    root.join(i18n::folder_name(
        root,
        i18n::current_language(conn),
        i18n::ATTACHMENTS,
    ))
}
/// Largest image a preview is made of (bytes).
const PREVIEW_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// What an attachment belongs to: a task, or a page of a project's notebook (its images).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachmentOwner<'a> {
    Task(&'a str),
    NotePage(&'a str),
}

/// Folder of a notebook's images inside a project's attachment folder.
pub const NOTES_FOLDER_NAME: &str = "Notes";

/// Where this Mac's file of an attachment stands with the account's server
/// (`attachments.remote`, local-only, migration 0017).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileState {
    /// The file is here and not on the server yet (or not known to be).
    Local,
    /// The server has the file.
    Sent,
    /// The row is here, the file is not: to download.
    Missing,
    /// The server refused it: larger than its limit per file.
    FileTooLarge,
    /// The server refused it: the account's space is full.
    QuotaExceeded,
}

impl FileState {
    pub fn as_str(self) -> &'static str {
        match self {
            FileState::Local => "local",
            FileState::Sent => "sent",
            FileState::Missing => "missing",
            FileState::FileTooLarge => "file_too_large",
            FileState::QuotaExceeded => "quota_exceeded",
        }
    }

    /// The column's value; anything else reads as `local` (the job checks it again).
    pub fn parse(value: &str) -> FileState {
        match value {
            "sent" => FileState::Sent,
            "missing" => FileState::Missing,
            "file_too_large" => FileState::FileTooLarge,
            "quota_exceeded" => FileState::QuotaExceeded,
            _ => FileState::Local,
        }
    }
}

/// Sets an attachment's [`FileState`] (local-only: nothing is queued for the sync).
pub fn set_state(conn: &Connection, id: &str, state: FileState) -> AppResult<()> {
    conn.execute(
        "UPDATE attachments SET remote = ?2 WHERE id = ?1",
        params![id, state.as_str()],
    )?;
    Ok(())
}

/// Sets the [`FileState`] of an attachment whose file is still the one of `sha256` (the hash
/// the file job worked with): when another hash was pulled meanwhile, that is another file
/// and its state is left alone. [`FileState::Sent`] also records that the file may now be on
/// other devices (`shared`, migration 0018). Whether the row was updated.
pub fn set_file_state(
    conn: &Connection,
    id: &str,
    sha256: Option<&str>,
    state: FileState,
) -> AppResult<bool> {
    let n = conn.execute(
        "UPDATE attachments SET remote = ?2, shared = (shared OR ?4)          WHERE id = ?1 AND sha256 IS ?3",
        params![id, state.as_str(), sha256, state == FileState::Sent],
    )?;
    Ok(n > 0)
}

/// After a link or a server reset (new account, restored server): every file this Mac sent
/// or saw refused is checked again with the server (`local`); the file job sends it when
/// the server does not have it.
pub fn recheck_after_link(conn: &Connection) -> AppResult<usize> {
    Ok(conn.execute(
        "UPDATE attachments SET remote = 'local' \
         WHERE remote IN ('sent', 'file_too_large', 'quota_exceeded')",
        [],
    )?)
}

/// Lowercase hexadecimal SHA-256 of some bytes.
pub fn sha256_bytes(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// Lowercase hexadecimal SHA-256 of a file, read by 1 MiB blocks.
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(char::from(DIGITS[usize::from(b >> 4)]));
        out.push(char::from(DIGITS[usize::from(b & 0x0f)]));
    }
    out
}

/// A file transfer of the file job, shown on the attachment's tile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transfer {
    Upload,
    Download,
}

/// Transfers in progress (attachment id, direction), in memory: none after a restart.
static TRANSFERS: Mutex<Vec<(String, Transfer)>> = Mutex::new(Vec::new());

/// A transfer in progress, until dropped.
pub struct TransferGuard {
    id: String,
}

/// Marks a transfer as running until the guard is dropped.
pub fn begin_transfer(id: &str, kind: Transfer) -> TransferGuard {
    let mut list = TRANSFERS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    list.retain(|(known, _)| known != id);
    list.push((id.to_string(), kind));
    TransferGuard { id: id.to_string() }
}

impl Drop for TransferGuard {
    fn drop(&mut self) {
        TRANSFERS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|(known, _)| *known != self.id);
    }
}

fn transfer_of(id: &str) -> Option<Transfer> {
    TRANSFERS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .iter()
        .find(|(known, _)| known == id)
        .map(|(_, kind)| *kind)
}

/// The tile's indicator. Without an account, nothing: attachments look as before file sync (a
/// missing file shows « fichier introuvable »).
fn remote_view(id: &str, state: FileState, exists: bool, linked: bool) -> AttachmentRemote {
    if !linked {
        return AttachmentRemote::None;
    }
    match transfer_of(id) {
        Some(Transfer::Upload) => return AttachmentRemote::Uploading,
        Some(Transfer::Download) => return AttachmentRemote::Downloading,
        None => {}
    }
    match state {
        FileState::FileTooLarge => AttachmentRemote::TooLarge,
        FileState::QuotaExceeded => AttachmentRemote::QuotaFull,
        // Its file is not here (a copy edited here is not it): the file job fetches it, or
        // keeps it « à télécharger » when no device has it any more.
        FileState::Missing => AttachmentRemote::ToDownload,
        _ if !exists => AttachmentRemote::ToDownload,
        FileState::Local => AttachmentRemote::LocalOnly,
        FileState::Sent => AttachmentRemote::None,
    }
}

/// Folder of a task's attachments: the one its first attachment went to (a renamed task keeps
/// it), else `<app folder>/Attachments/<project>/<title> (<end of id>)`. `None` before the
/// app folder exists.
pub fn folder_of(conn: &Connection, task_id: &str) -> AppResult<Option<PathBuf>> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT stored_path FROM attachments WHERE task_id = ?1 ORDER BY created_at LIMIT 1",
            [task_id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(parent) = existing.as_deref().and_then(|p| Path::new(p).parent()) {
        return Ok(Some(parent.to_path_buf()));
    }
    let Some(root) = workspace::root(conn)? else {
        return Ok(None);
    };
    let task = tasks::load(conn, task_id)?;
    let project = match &task.subject_id {
        Some(s) => subjects::folder_name(&subjects::get(conn, s)?.name),
        None => workspace::no_project_name(conn, &root).to_string(),
    };
    let short: String = task
        .id
        .chars()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let name = format!("{} ({short})", subjects::folder_name(&task.title));
    Ok(Some(attachments_dir(conn, &root).join(project).join(name)))
}

/// Folder of an owner's attachments: [`folder_of`] for a task; for a page, the one its first
/// image went to, else `<app folder>/Attachments/<project>/Notes`. `None` before the app
/// folder exists.
pub fn owner_folder(conn: &Connection, owner: AttachmentOwner<'_>) -> AppResult<Option<PathBuf>> {
    let page_id = match owner {
        AttachmentOwner::Task(task_id) => return folder_of(conn, task_id),
        AttachmentOwner::NotePage(page_id) => page_id,
    };
    let existing: Option<String> = conn
        .query_row(
            "SELECT stored_path FROM attachments WHERE note_page_id = ?1 \
             ORDER BY created_at LIMIT 1",
            [page_id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(parent) = existing.as_deref().and_then(|p| Path::new(p).parent()) {
        return Ok(Some(parent.to_path_buf()));
    }
    let Some(root) = workspace::root(conn)? else {
        return Ok(None);
    };
    let subject_id: String = conn
        .query_row(
            "SELECT subject_id FROM note_pages WHERE id = ?1 AND deleted_at IS NULL",
            [page_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("note page {page_id}")))?;
    let project = subjects::folder_name(&subjects::get(conn, &subject_id)?.name);
    Ok(Some(
        attachments_dir(conn, &root)
            .join(project)
            .join(NOTES_FOLDER_NAME),
    ))
}

/// Where a pulled attachment (sync: metadata only, no file on this Mac) points: the
/// owner's attachment folder when it can be resolved ([`owner_folder`]: the task's, or the
/// page's `<project>/Notes`), else an absolute placeholder
/// `<app folder>/Attachments/<task or page id>/<file name>` (the owner or its project is
/// deleted, or the app folder is not recorded yet: `~/Taido`). Never relative.
///
/// The path is a free one (`free_name`): it never points at a local copy or at another
/// attachment's path, so deleting one attachment cannot remove another's file. A name that is
/// not a plain file name (`.`, `..`) becomes `file`.
pub fn pulled_path(
    conn: &Connection,
    owner: AttachmentOwner<'_>,
    file_name: &str,
) -> AppResult<PathBuf> {
    let owner_id = match owner {
        AttachmentOwner::Task(id) | AttachmentOwner::NotePage(id) => id,
    };
    let mut parts = Path::new(file_name).components();
    let name = match (parts.next(), parts.next()) {
        (Some(Component::Normal(_)), None) => file_name,
        _ => "file",
    };
    match owner_folder(conn, owner) {
        Ok(Some(folder)) => return free_name(conn, &folder, name),
        Ok(None) | Err(AppError::NotFound(_)) => {}
        Err(e) => return Err(e),
    }
    let root = match workspace::root(conn)? {
        Some(root) => root,
        None => std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|home| home.is_absolute())
            .unwrap_or_else(std::env::temp_dir)
            .join(workspace::FOLDER_NAME),
    };
    free_name(conn, &attachments_dir(conn, &root).join(owner_id), name)
}

/// Whether a live attachment other than `except` has the stored path `path`. Compared without
/// ASCII case, as the default macOS volume does.
fn path_in_use(conn: &Connection, path: &Path, except: Option<&str>) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM attachments WHERE stored_path = ?1 COLLATE NOCASE \
         AND deleted_at IS NULL AND id IS NOT ?2)",
        params![path.to_string_lossy(), except],
        |r| r.get(0),
    )?)
}

/// A path in `dir` taken neither on disk nor by a live attachment (a pulled one has no file
/// on this Mac): `name`, else `name (2).ext`, `name (3).ext`…
pub(crate) fn free_name(conn: &Connection, dir: &Path, name: &str) -> AppResult<PathBuf> {
    first_free(dir, name, |p| {
        Ok(!p.exists() && !path_in_use(conn, p, None)?)
    })
}

/// The first of `name`, `name (2).ext`, `name (3).ext`… in `dir` that `is_free` accepts.
pub(crate) fn first_free(
    dir: &Path,
    name: &str,
    mut is_free: impl FnMut(&Path) -> AppResult<bool>,
) -> AppResult<PathBuf> {
    let candidate = dir.join(name);
    if is_free(&candidate)? {
        return Ok(candidate);
    }
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let ext = path.extension().and_then(|e| e.to_str());
    for n in 2..=u32::MAX {
        let numbered = match ext {
            Some(ext) => dir.join(format!("{stem} ({n}).{ext}")),
            None => dir.join(format!("{stem} ({n})")),
        };
        if is_free(&numbered)? {
            return Ok(numbered);
        }
    }
    Err(AppError::Invalid(format!("no free file name for {name}")))
}

/// MIME type from the extension (what the UI needs: images get a preview).
pub fn mime_of(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "pdf" => "application/pdf",
        "txt" | "md" | "csv" | "log" => "text/plain",
        "json" => "application/json",
        "eml" => "message/rfc822",
        "zip" => "application/zip",
        "doc" | "docx" => "application/msword",
        "xls" | "xlsx" => "application/vnd.ms-excel",
        "ppt" | "pptx" => "application/vnd.ms-powerpoint",
        "mp4" | "mov" => "video/mp4",
        "mp3" | "m4a" | "wav" => "audio/mpeg",
        _ => "application/octet-stream",
    }
}

/// A new attachment of a file just copied here (`remote` = `local`: the file job sends it).
fn insert(
    conn: &Connection,
    owner: AttachmentOwner<'_>,
    file_name: &str,
    stored: &Path,
    sha256: &str,
) -> AppResult<String> {
    let size = fs::metadata(stored)?.len();
    let now = now_utc();
    let (task_id, note_page_id) = match owner {
        AttachmentOwner::Task(id) => (Some(id), None),
        AttachmentOwner::NotePage(id) => (None, Some(id)),
    };
    let id = new_id();
    conn.execute(
        "INSERT INTO attachments (id, task_id, note_page_id, file_name, stored_path, \
         mime_type, size, created_at, updated_at, sha256, remote) \
         VALUES (?1, ?2, ?9, ?3, ?4, ?5, ?6, ?7, ?7, ?8, 'local')",
        params![
            id,
            task_id,
            file_name,
            stored.to_string_lossy(),
            mime_of(file_name),
            i64::try_from(size).unwrap_or(i64::MAX),
            now,
            sha256,
            note_page_id
        ],
    )?;
    Ok(id)
}

fn owner_dir(conn: &Connection, owner: AttachmentOwner<'_>) -> AppResult<PathBuf> {
    match owner {
        AttachmentOwner::Task(task_id) => tasks::ensure_exists(conn, task_id)?,
        AttachmentOwner::NotePage(page_id) => {
            crate::db::notes::get_page(conn, page_id)?;
        }
    }
    let dir = owner_folder(conn, owner)?
        .ok_or_else(|| AppError::Invalid("the app folder does not exist yet".into()))?;
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// A notebook page holds only images: its files are
/// shown in its text. A task takes any file.
fn ensure_owner_takes(owner: AttachmentOwner<'_>, file_name: &str) -> AppResult<()> {
    match owner {
        AttachmentOwner::NotePage(_) if !mime_of(file_name).starts_with("image/") => Err(
            AppError::Invalid(format!("not an image for a page: {file_name}")),
        ),
        _ => Ok(()),
    }
}

/// Copies files (absolute paths) into the owner's folder. Folders are refused, and for a
/// page every file that is not an image (before anything is copied).
pub fn add_files(
    conn: &Connection,
    owner: AttachmentOwner<'_>,
    paths: &[String],
) -> AppResult<Vec<String>> {
    for source in paths {
        ensure_owner_takes(owner, source.trim())?;
    }
    let dir = owner_dir(conn, owner)?;
    let mut added = Vec::new();
    for source in paths {
        let source = Path::new(source.trim());
        if !source.is_absolute() || !source.is_file() {
            return Err(AppError::Invalid(format!(
                "not a file: {}",
                source.display()
            )));
        }
        let name = source
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_string();
        let target = free_name(conn, &dir, &name)?;
        fs::copy(source, &target)?;
        let sha256 = sha256_file(&target)?;
        let file_name = target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&name)
            .to_string();
        added.push(insert(conn, owner, &file_name, &target, &sha256)?);
    }
    Ok(added)
}

/// A pasted file (a screenshot): its bytes, base64-encoded, saved under `name`.
pub fn add_data(
    conn: &Connection,
    owner: AttachmentOwner<'_>,
    name: &str,
    base64: &str,
) -> AppResult<String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.trim())
        .map_err(|e| AppError::Invalid(format!("bad pasted data: {e}")))?;
    let name = subjects::folder_name(name);
    let name = if name.is_empty() {
        "capture.png".to_string()
    } else {
        name
    };
    ensure_owner_takes(owner, &name)?;
    let dir = owner_dir(conn, owner)?;
    let target = free_name(conn, &dir, &name)?;
    let sha256 = sha256_bytes(&bytes);
    fs::write(&target, bytes)?;
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&name)
        .to_string();
    insert(conn, owner, &file_name, &target, &sha256)
}

/// Copies a live attachment's file (another page's image, or a task's) as a new image of
/// `page_id`: an image cut from a page and pasted in another gets its own file there, so the
/// first page's cleanup never takes it away. `NotFound` when the file is not on this device.
pub fn copy_to_page(conn: &Connection, id: &str, page_id: &str) -> AppResult<String> {
    let path = stored_path(conn, id)?;
    let source = Path::new(&path);
    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image")
        .to_string();
    ensure_owner_takes(AttachmentOwner::NotePage(page_id), &name)?;
    if !source.is_file() {
        return Err(AppError::NotFound(format!("file of attachment {id}")));
    }
    let owner = AttachmentOwner::NotePage(page_id);
    let dir = owner_dir(conn, owner)?;
    let target = free_name(conn, &dir, &name)?;
    fs::copy(source, &target)?;
    let sha256 = sha256_file(&target)?;
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&name)
        .to_string();
    insert(conn, owner, &file_name, &target, &sha256)
}

/// Whether a page's text shows or names the attachment (`file:<id>`). A deleted page counts
/// until it is purged: it can still be restored with its images.
fn shown_by_a_page(conn: &Connection, id: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM note_pages WHERE instr(body, 'file:' || ?1) > 0)",
        [id],
        |r| r.get(0),
    )?)
}

/// The images taken out of a page while it was open (`candidates`), once its text is saved:
/// deletes those that are this page's and that no page shows any more (a deleted page until
/// it is purged) (one may have
/// been cut and pasted in another page). Returns the deleted ids.
pub fn prune_page_images(
    conn: &Connection,
    page_id: &str,
    candidates: &[String],
) -> AppResult<Vec<String>> {
    let mut gone = Vec::new();
    for id in candidates {
        let Ok((owner, _)) = get_page_image(conn, id) else {
            continue;
        };
        if owner != page_id || shown_by_a_page(conn, id)? {
            continue;
        }
        delete_page_image(conn, id)?;
        gone.push(id.clone());
    }
    Ok(gone)
}

/// A live attachment by its id, whoever owns it; `None` when there is none.
pub fn info(conn: &Connection, id: &str) -> AppResult<Option<AttachmentInfo>> {
    let row = conn
        .query_row(
            "SELECT file_name, stored_path, mime_type, size, remote FROM attachments \
             WHERE id = ?1 AND deleted_at IS NULL",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((file_name, path, mime_type, size, remote)) = row else {
        return Ok(None);
    };
    let linked = crate::sync::store::is_linked(conn)?;
    let exists = Path::new(&path).is_file();
    Ok(Some(AttachmentInfo {
        id: id.to_string(),
        file_name,
        remote: remote_view(id, FileState::parse(&remote), exists, linked),
        exists,
        path,
        mime_type,
        size: u32::try_from(size).unwrap_or(u32::MAX),
    }))
}

/// One live attachment row, whoever owns it.
struct Listed {
    id: String,
    owner_id: String,
    file_name: String,
    path: String,
    mime_type: String,
    size: u32,
    added_at: String,
    exists: bool,
    remote: AttachmentRemote,
}

/// The live attachments whose `owner_column` (`task_id` or `note_page_id`) is `owner_id`,
/// oldest first.
fn list_owned(conn: &Connection, owner_column: &str, owner_id: &str) -> AppResult<Vec<Listed>> {
    let linked = crate::sync::store::is_linked(conn)?;
    let mut stmt = conn.prepare(&format!(
        "SELECT id, {owner_column}, file_name, stored_path, mime_type, size, created_at, remote \
         FROM attachments WHERE {owner_column} = ?1 AND deleted_at IS NULL \
         ORDER BY created_at, id"
    ))?;
    let rows = stmt.query_map([owner_id], |r| {
        let id: String = r.get(0)?;
        let path: String = r.get(3)?;
        let exists = Path::new(&path).is_file();
        let state = FileState::parse(&r.get::<_, String>(7)?);
        Ok(Listed {
            remote: remote_view(&id, state, exists, linked),
            id,
            owner_id: r.get(1)?,
            file_name: r.get(2)?,
            exists,
            path,
            mime_type: r.get(4)?,
            size: u32::try_from(r.get::<_, i64>(5)?).unwrap_or(u32::MAX),
            added_at: r.get(6)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The task's attachments, oldest first.
pub fn list(conn: &Connection, task_id: &str) -> AppResult<Vec<Attachment>> {
    Ok(list_owned(conn, "task_id", task_id)?
        .into_iter()
        .map(|a| Attachment {
            id: a.id,
            task_id: a.owner_id,
            file_name: a.file_name,
            path: a.path,
            is_image: a.mime_type.starts_with("image/"),
            mime_type: a.mime_type,
            size: a.size,
            added_at: a.added_at,
            exists: a.exists,
            remote: a.remote,
        })
        .collect())
}

/// The images of a notebook page, oldest first.
pub fn list_for_page(conn: &Connection, page_id: &str) -> AppResult<Vec<NoteAttachment>> {
    Ok(list_owned(conn, "note_page_id", page_id)?
        .into_iter()
        .map(|a| NoteAttachment {
            id: a.id,
            note_page_id: a.owner_id,
            file_name: a.file_name,
            path: a.path,
            is_image: a.mime_type.starts_with("image/"),
            mime_type: a.mime_type,
            size: a.size,
            added_at: a.added_at,
            exists: a.exists,
            remote: a.remote,
        })
        .collect())
}

/// A live attachment of a task: (task id, stored path). A page's image is not one
/// ([`get_page_image`]).
pub fn get(conn: &Connection, id: &str) -> AppResult<(String, String)> {
    conn.query_row(
        "SELECT task_id, stored_path FROM attachments \
         WHERE id = ?1 AND deleted_at IS NULL AND task_id IS NOT NULL",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("attachment {id}")))
}

/// A live image of a notebook page: (page id, stored path).
pub fn get_page_image(conn: &Connection, id: &str) -> AppResult<(String, String)> {
    conn.query_row(
        "SELECT note_page_id, stored_path FROM attachments \
         WHERE id = ?1 AND deleted_at IS NULL AND note_page_id IS NOT NULL",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("note attachment {id}")))
}

/// The stored path of a live attachment, a task's or a page's.
fn stored_path(conn: &Connection, id: &str) -> AppResult<String> {
    get(conn, id)
        .or_else(|_| get_page_image(conn, id))
        .map(|(_, path)| path)
        .map_err(|_| AppError::NotFound(format!("attachment {id}")))
}

/// Removes an attachment and its copy (the original file is never touched). Returns its task.
/// A copy another live attachment still points at stays (rows made before paths were kept
/// apart, see `free_name`).
pub fn delete(conn: &Connection, id: &str) -> AppResult<String> {
    let (task_id, path) = get(conn, id)?;
    remove_row(conn, id, &path)?;
    Ok(task_id)
}

/// Removes an image of a notebook page and its copy. Returns its page.
pub fn delete_page_image(conn: &Connection, id: &str) -> AppResult<String> {
    let (page_id, path) = get_page_image(conn, id)?;
    remove_row(conn, id, &path)?;
    Ok(page_id)
}

fn remove_row(conn: &Connection, id: &str, path: &str) -> AppResult<()> {
    let in_use = path_in_use(conn, Path::new(path), Some(id))?;
    remove_copy(id, Path::new(path), !in_use)?;
    conn.execute(
        "UPDATE attachments SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1",
        params![id, now_utc()],
    )?;
    Ok(())
}

/// The file of an attachment that is gone (deleted on another device, tombstoned by the sync,
/// purged): its stored path and the hash of its content (`None` when it never had one).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FreedFile {
    pub id: String,
    pub path: String,
    pub sha256: Option<String>,
}

/// A [`FreedFile`] to clean up: its partial download always, its copy only when `copy` (no
/// live attachment points at the path).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Removal {
    pub file: FreedFile,
    pub copy: bool,
}

/// What to remove of the files of attachments that are gone (needs the database): a copy once
/// no live attachment points at it any more (the rule of [`delete`]), the attachment's partial
/// download always (it is its own). Relative paths are never touched.
pub fn removals(conn: &Connection, gone: Vec<FreedFile>) -> AppResult<Vec<Removal>> {
    let mut out = Vec::with_capacity(gone.len());
    for file in gone {
        let path = Path::new(&file.path);
        if !path.is_absolute() {
            continue;
        }
        let copy = !path_in_use(conn, path, None)?;
        out.push(Removal { file, copy });
    }
    Ok(out)
}

/// Removes what [`removals`] chose, without the database (files are hashed: run it outside
/// the database lock). A copy goes only while it is still the attachment's file: one edited
/// in place here (another hash), or whose hash was never known, is kept, as the user's own
/// file. Returns how many copies were removed; errors are logged (ids only), never returned.
pub fn remove_freed(removals: &[Removal]) -> usize {
    let mut removed = 0;
    for Removal { file, copy } in removals {
        let path = Path::new(&file.path);
        let with_copy = *copy
            && match is_its_file(path, file.sha256.as_deref()) {
                Ok(true) => true,
                Ok(false) => {
                    if path.is_file() {
                        log::info!(
                            "attachments: the copy of {} is not its file any more: kept",
                            file.id
                        );
                    }
                    false
                }
                Err(e) => {
                    log::warn!("attachments: cannot check the copy of {}: {e}", file.id);
                    false
                }
            };
        match remove_copy(&file.id, path, with_copy) {
            Ok(true) => removed += 1,
            Ok(false) => {}
            Err(e) => log::warn!("attachments: cannot remove the file of {}: {e}", file.id),
        }
    }
    removed
}

/// Whether the file at `path` is still the content of `sha256` (never without a hash: what
/// the file is cannot be told).
fn is_its_file(path: &Path, sha256: Option<&str>) -> std::io::Result<bool> {
    let Some(expected) = sha256 else {
        return Ok(false);
    };
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => Ok(sha256_file(path)? == expected),
        Ok(_) => Ok(false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// [`removals`] then [`remove_freed`] at once (tests). Returns how many copies were removed.
#[cfg(test)]
pub fn remove_unused_files(conn: &Connection, gone: Vec<FreedFile>) -> AppResult<usize> {
    Ok(remove_freed(&removals(conn, gone)?))
}

/// Where the sync's file job downloads an attachment's file before checking it: a hidden
/// `.<id>.part` in the folder of its stored path (same volume: the final move is atomic).
/// Never another attachment's file: a name ending in `.part` (`rapport.pdf.part`) is not it,
/// only a file named after this very id would be. An id that is not a plain token (pulled
/// from another device) is replaced by its hash, so that it never leaves the folder.
pub fn partial_path(stored: &Path, id: &str) -> PathBuf {
    let plain = !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    let token = if plain {
        id.to_string()
    } else {
        sha256_bytes(id.as_bytes())
    };
    stored.with_file_name(format!(".{token}.part"))
}

/// Removes an attachment's partial download, and its copy when `with_copy`; whether the copy
/// was there.
fn remove_copy(id: &str, path: &Path, with_copy: bool) -> AppResult<bool> {
    let gone = |p: &Path| -> AppResult<bool> {
        match fs::remove_file(p) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e.into()),
        }
    };
    gone(&partial_path(path, id))?;
    if with_copy {
        gone(path)
    } else {
        Ok(false)
    }
}

/// An image attachment as a `data:` URL for its preview; `None` for other files, missing or
/// too large ones.
pub fn preview(conn: &Connection, id: &str) -> AppResult<Option<String>> {
    let path = stored_path(conn, id)?;
    let mime = mime_of(&path);
    if !mime.starts_with("image/") || mime == "image/heic" {
        return Ok(None);
    }
    let Ok(meta) = fs::metadata(&path) else {
        return Ok(None);
    };
    if meta.len() > PREVIEW_MAX_BYTES {
        return Ok(None);
    }
    let bytes = fs::read(&path)?;
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(Some(format!("data:{mime};base64,{data}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open_in_memory, settings, test_support};

    fn setup() -> (Connection, tempfile::TempDir, String) {
        let conn = open_in_memory().expect("db");
        let dir = tempfile::tempdir().expect("tempdir");
        settings::set_workspace_root(&conn, &dir.path().join("Taido").to_string_lossy())
            .expect("root");
        let p = test_support::subject(&conn, "Summit Events");
        let task = test_support::task(&conn, "Export PDF", Some(&p), None);
        (conn, dir, task)
    }

    #[test]
    fn files_are_copied_into_the_tasks_folder() {
        let (conn, dir, task) = setup();
        let original = dir.path().join("maquette.png");
        fs::write(&original, b"png").expect("write");
        add_files(
            &conn,
            AttachmentOwner::Task(&task),
            &[original.to_string_lossy().into_owned()],
        )
        .expect("add");
        add_files(
            &conn,
            AttachmentOwner::Task(&task),
            &[original.to_string_lossy().into_owned()],
        )
        .expect("again");
        let list = list(&conn, &task).expect("list");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].file_name, "maquette.png");
        assert_eq!(list[1].file_name, "maquette (2).png");
        assert!(list[0].is_image && list[0].exists);
        assert_eq!(list[0].size, 3);
        let folder = Path::new(&list[0].path).parent().expect("parent");
        assert!(folder.starts_with(
            dir.path()
                .join("Taido")
                .join(FOLDER_NAME)
                .join("Summit Events")
        ));
        assert!(folder
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("Export PDF (")));
        // Removing it removes the copy, never the original.
        let id = list[0].id.clone();
        assert_eq!(delete(&conn, &id).expect("delete"), task);
        assert!(!Path::new(&list[0].path).exists());
        assert!(original.exists());
        assert_eq!(super::list(&conn, &task).expect("list").len(), 1);
    }

    #[test]
    fn pasted_data_and_previews() {
        let (conn, _dir, task) = setup();
        add_data(
            &conn,
            AttachmentOwner::Task(&task),
            "capture.png",
            "iVBORw0KGgo=",
        )
        .expect("paste");
        let a = &list(&conn, &task).expect("list")[0];
        let url = preview(&conn, &a.id).expect("preview").expect("an image");
        assert!(url.starts_with("data:image/png;base64,iVBORw0KGgo"));
        assert!(add_data(&conn, AttachmentOwner::Task(&task), "x.png", "%%%").is_err());
        assert!(add_files(
            &conn,
            AttachmentOwner::Task(&task),
            &["/nope/file.txt".into()]
        )
        .is_err());
    }

    /// A row as the sync writes it for a pulled attachment: a path, no file.
    fn pulled_row(conn: &Connection, id: &str, task: &str, name: &str) -> PathBuf {
        let path = pulled_path(conn, AttachmentOwner::Task(task), name).expect("pulled path");
        conn.execute(
            "INSERT INTO attachments (id, task_id, file_name, stored_path, mime_type, size, \
             created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'image/png', 3, ?5, ?5)",
            params![id, task, name, path.to_string_lossy(), now_utc()],
        )
        .expect("insert");
        path
    }

    #[test]
    fn a_local_copy_never_takes_the_path_of_a_pulled_attachment() {
        let (conn, dir, task) = setup();
        let pulled = pulled_row(&conn, "pulled", &task, "maquette.png");
        assert!(!pulled.exists());
        let original = dir.path().join("maquette.png");
        fs::write(&original, b"png").expect("write");
        add_files(
            &conn,
            AttachmentOwner::Task(&task),
            &[original.to_string_lossy().into_owned()],
        )
        .expect("add");
        add_data(
            &conn,
            AttachmentOwner::Task(&task),
            "maquette.png",
            "iVBORw0KGgo=",
        )
        .expect("paste");
        let list = list(&conn, &task).expect("list");
        let names: Vec<&str> = list.iter().map(|a| a.file_name.as_str()).collect();
        assert_eq!(
            names,
            ["maquette.png", "maquette (2).png", "maquette (3).png"]
        );
        assert!(!list[0].exists, "the pulled one still has no file");
        assert_eq!(list[0].path, pulled.to_string_lossy());
        let local = PathBuf::from(&list[1].path);
        assert_ne!(local, pulled);
        // Deleting the pulled attachment leaves the local copy alone.
        delete(&conn, "pulled").expect("delete");
        assert!(local.is_file());
        // The same holds the other way: a name taken on disk or by a row is skipped,
        // ignoring ASCII case like the Mac's disk.
        let again =
            pulled_path(&conn, AttachmentOwner::Task(&task), "MAQUETTE (2).png").expect("path");
        assert!(
            again.ends_with("MAQUETTE (2) (2).png"),
            "{}",
            again.display()
        );
        let again =
            pulled_path(&conn, AttachmentOwner::Task(&task), "maquette (4).png").expect("path");
        assert!(again.ends_with("maquette (4).png"));
        // Not a plain file name: no way out of the folder.
        let odd = pulled_path(&conn, AttachmentOwner::Task(&task), "..").expect("path");
        assert_eq!(odd.parent(), local.parent());
        assert!(odd.ends_with("file"));
    }

    #[test]
    fn deleting_keeps_a_file_another_attachment_still_points_at() {
        let (conn, dir, task) = setup();
        let original = dir.path().join("devis.pdf");
        fs::write(&original, b"pdf").expect("write");
        add_files(
            &conn,
            AttachmentOwner::Task(&task),
            &[original.to_string_lossy().into_owned()],
        )
        .expect("add");
        let local = list(&conn, &task).expect("list").remove(0);
        // A row from before paths were kept apart: same path as the local copy.
        conn.execute(
            "INSERT INTO attachments (id, task_id, file_name, stored_path, mime_type, size, \
             created_at, updated_at) VALUES ('twin', ?1, 'devis.pdf', ?2, \
             'application/pdf', 3, ?3, ?3)",
            params![task, local.path, now_utc()],
        )
        .expect("insert");
        delete(&conn, "twin").expect("delete twin");
        assert!(
            Path::new(&local.path).is_file(),
            "still used by the local row"
        );
        delete(&conn, &local.id).expect("delete local");
        assert!(
            !Path::new(&local.path).exists(),
            "last user gone: the copy goes"
        );
        assert!(original.exists());
    }

    #[test]
    fn added_files_record_their_hash() {
        let (conn, dir, task) = setup();
        let original = dir.path().join("devis.pdf");
        fs::write(&original, b"%PDF devis").expect("write");
        add_files(
            &conn,
            AttachmentOwner::Task(&task),
            &[original.to_string_lossy().into_owned()],
        )
        .expect("add");
        add_data(
            &conn,
            AttachmentOwner::Task(&task),
            "capture.png",
            "iVBORw0KGgo=",
        )
        .expect("paste");
        let hashes: Vec<(String, String)> = {
            let mut stmt = conn
                .prepare("SELECT sha256, remote FROM attachments ORDER BY created_at, id")
                .expect("prepare");
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .expect("query");
            rows.collect::<Result<_, _>>().expect("rows")
        };
        let png = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgo=")
            .expect("png");
        assert_eq!(
            hashes,
            [
                (sha256_bytes(b"%PDF devis"), "local".to_string()),
                (sha256_bytes(&png), "local".to_string())
            ]
        );
        assert_eq!(
            sha256_bytes(b"test"),
            "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
        );
        assert_eq!(
            sha256_file(&original).expect("hash"),
            sha256_bytes(b"%PDF devis")
        );
    }

    #[test]
    fn the_tile_indicator_follows_the_file_and_the_account() {
        let (conn, dir, task) = setup();
        let original = dir.path().join("a.txt");
        fs::write(&original, b"a").expect("write");
        add_files(
            &conn,
            AttachmentOwner::Task(&task),
            &[original.to_string_lossy().into_owned()],
        )
        .expect("add");
        let id = list(&conn, &task).expect("list")[0].id.clone();
        let view = |conn: &Connection| list(conn, &task).expect("list")[0].remote;
        let set = |conn: &Connection, state: FileState| {
            set_state(conn, &id, state).expect("state");
        };
        // Without an account: nothing to say, whatever the state (as before file sync).
        for state in [
            FileState::Local,
            FileState::Missing,
            FileState::Sent,
            FileState::FileTooLarge,
        ] {
            set(&conn, state);
            assert_eq!(view(&conn), AttachmentRemote::None, "{state:?}");
        }

        crate::db::settings::write(&conn, crate::sync::store::TOKEN, &"token").expect("link");
        set(&conn, FileState::Sent);
        assert_eq!(view(&conn), AttachmentRemote::None);
        set(&conn, FileState::Missing);
        assert_eq!(
            view(&conn),
            AttachmentRemote::ToDownload,
            "a copy here that is not the attachment's file"
        );
        set(&conn, FileState::Local);
        assert_eq!(view(&conn), AttachmentRemote::LocalOnly, "not sent yet");
        {
            let _sending = begin_transfer(&id, Transfer::Upload);
            assert_eq!(view(&conn), AttachmentRemote::Uploading);
        }
        assert_eq!(view(&conn), AttachmentRemote::LocalOnly);
        set(&conn, FileState::FileTooLarge);
        assert_eq!(view(&conn), AttachmentRemote::TooLarge);
        set(&conn, FileState::QuotaExceeded);
        assert_eq!(view(&conn), AttachmentRemote::QuotaFull);

        // No file here: to download (the file job fetches it).
        let path = list(&conn, &task).expect("list")[0].path.clone();
        fs::remove_file(&path).expect("remove");
        set(&conn, FileState::Missing);
        assert_eq!(view(&conn), AttachmentRemote::ToDownload);
        {
            let _fetching = begin_transfer(&id, Transfer::Download);
            assert_eq!(view(&conn), AttachmentRemote::Downloading);
        }
        set(&conn, FileState::Sent);
        assert_eq!(view(&conn), AttachmentRemote::ToDownload);
        crate::db::settings::remove(&conn, crate::sync::store::TOKEN).expect("unlink");
        assert_eq!(
            view(&conn),
            AttachmentRemote::None,
            "without an account: « fichier introuvable » as before"
        );
    }

    #[test]
    fn a_file_state_is_recorded_only_for_its_hash_and_sent_means_shared() {
        let (conn, dir, task) = setup();
        let original = dir.path().join("a.txt");
        fs::write(&original, b"a").expect("write");
        add_files(
            &conn,
            AttachmentOwner::Task(&task),
            &[original.to_string_lossy().into_owned()],
        )
        .expect("add");
        let id = list(&conn, &task).expect("list")[0].id.clone();
        let read = |conn: &Connection| -> (String, bool) {
            conn.query_row(
                "SELECT remote, shared FROM attachments WHERE id = ?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("row")
        };
        assert_eq!(
            read(&conn),
            ("local".into(), false),
            "added here: not shared"
        );
        let other = sha256_bytes(b"another content");
        assert!(!set_file_state(&conn, &id, Some(&other), FileState::Sent).expect("state"));
        assert_eq!(read(&conn), ("local".into(), false));
        let own = sha256_bytes(b"a");
        assert!(set_file_state(&conn, &id, Some(&own), FileState::Missing).expect("state"));
        assert_eq!(read(&conn), ("missing".into(), false));
        assert!(set_file_state(&conn, &id, Some(&own), FileState::Sent).expect("state"));
        assert_eq!(read(&conn), ("sent".into(), true));
        assert!(set_file_state(&conn, &id, Some(&own), FileState::Local).expect("state"));
        assert_eq!(read(&conn), ("local".into(), true), "once shared, always");
    }

    #[test]
    fn a_partial_download_is_named_after_its_attachment_only() {
        let stored = Path::new("/x/Pièces jointes/P/T (abc)/rapport.pdf");
        assert_eq!(
            partial_path(stored, "0192f0a1-7c2b-7d3e-9f00-112233445566"),
            Path::new("/x/Pièces jointes/P/T (abc)/.0192f0a1-7c2b-7d3e-9f00-112233445566.part")
        );
        // An id from another device that is not a plain token never leaves the folder.
        let odd = partial_path(stored, "../../etc/passwd");
        assert_eq!(odd.parent(), stored.parent());
        assert_eq!(
            odd.file_name().and_then(|n| n.to_str()),
            Some(format!(".{}.part", sha256_bytes(b"../../etc/passwd")).as_str())
        );
    }

    /// A page's images: listed apart from the tasks', previewed by the same function,
    /// removed with their copy.
    #[test]
    fn page_images_list_preview_and_delete() {
        use crate::model::{CreateNotePageInput, NoteKind};
        let (conn, _dir, task) = setup();
        let subject_id: String = conn
            .query_row("SELECT subject_id FROM tasks WHERE id = ?1", [&task], |r| {
                r.get(0)
            })
            .expect("subject");
        let page = crate::db::notes::create_page(
            &conn,
            &CreateNotePageInput {
                subject_id,
                group_id: None,
                title: "Maquettes".into(),
                body: String::new(),
                kind: NoteKind::Page,
                source_task_id: None,
            },
        )
        .expect("page")
        .id;
        add_data(
            &conn,
            AttachmentOwner::Task(&task),
            "tache.png",
            "iVBORw0KGgo=",
        )
        .expect("task");
        let id = add_data(
            &conn,
            AttachmentOwner::NotePage(&page),
            "capture.png",
            "iVBORw0KGgo=",
        )
        .expect("image");
        let images = list_for_page(&conn, &page).expect("list");
        assert_eq!(images.len(), 1);
        assert_eq!(
            (images[0].id.as_str(), images[0].note_page_id.as_str()),
            (id.as_str(), page.as_str())
        );
        assert!(images[0].is_image && images[0].exists);
        assert_eq!(list(&conn, &task).expect("task list").len(), 1);
        // `get` stays the task's; the page image has its own.
        assert!(get(&conn, &id).is_err());
        assert_eq!(get_page_image(&conn, &id).expect("get").0, page);
        // The preview serves both owners.
        let data = preview(&conn, &id).expect("preview").expect("an image");
        assert!(data.starts_with("data:image/png;base64,"), "{data}");
        let task_image = list(&conn, &task).expect("list").remove(0);
        assert!(preview(&conn, &task_image.id).expect("task").is_some());
        assert!(preview(&conn, "nope").is_err());
        // Deleting removes the row's life and the copy; a task's attachment is not a page's.
        assert!(delete_page_image(&conn, &task_image.id).is_err());
        assert_eq!(delete_page_image(&conn, &id).expect("delete"), page);
        assert!(!Path::new(&images[0].path).exists());
        assert!(list_for_page(&conn, &page).expect("list").is_empty());
        assert!(preview(&conn, &id).is_err());
    }

    /// A page of the task's project, with `body`.
    fn page_with(conn: &Connection, task: &str, title: &str, body: &str) -> String {
        use crate::model::{CreateNotePageInput, NoteKind};
        let subject_id: String = conn
            .query_row("SELECT subject_id FROM tasks WHERE id = ?1", [task], |r| {
                r.get(0)
            })
            .expect("subject");
        crate::db::notes::create_page(
            conn,
            &CreateNotePageInput {
                subject_id,
                group_id: None,
                title: title.into(),
                body: body.into(),
                kind: NoteKind::Page,
                source_task_id: None,
            },
        )
        .expect("page")
        .id
    }

    fn set_body(conn: &Connection, page: &str, body: &str) {
        conn.execute(
            "UPDATE note_pages SET body = ?2 WHERE id = ?1",
            params![page, body],
        )
        .expect("body");
    }

    #[test]
    fn an_image_pasted_in_another_page_becomes_its_own_copy() {
        let (conn, _dir, task) = setup();
        let a = page_with(&conn, &task, "A", "");
        let b = page_with(&conn, &task, "B", "");
        let x = add_data(
            &conn,
            AttachmentOwner::NotePage(&a),
            "plan.png",
            "iVBORw0KGgo=",
        )
        .expect("image");
        let copy = copy_to_page(&conn, &x, &b).expect("copy");
        assert_ne!(copy, x);
        let (owner, path) = get_page_image(&conn, &copy).expect("copy row");
        assert_eq!(owner, b);
        let (_, original) = get_page_image(&conn, &x).expect("original");
        assert_ne!(path, original);
        assert_eq!(
            fs::read(&path).expect("copy"),
            fs::read(&original).expect("orig")
        );
        let listed = list_for_page(&conn, &b).expect("list");
        // Same project folder: the copy gets a free name.
        assert_eq!(listed[0].file_name, "plan (2).png");
        // A task's file that is not an image is not a page's.
        let pdf =
            add_data(&conn, AttachmentOwner::Task(&task), "devis.pdf", "JVBERi0=").expect("task");
        assert!(matches!(
            copy_to_page(&conn, &pdf, &b),
            Err(AppError::Invalid(_))
        ));
        // A file not on this device cannot be copied (the page keeps the original id).
        fs::remove_file(&original).expect("rm");
        assert!(matches!(
            copy_to_page(&conn, &x, &b),
            Err(AppError::NotFound(_))
        ));
        assert!(matches!(
            copy_to_page(&conn, "0192f0a1-7c2b-7d3e-9f00-0123456789ab", &b),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn prune_deletes_only_the_pages_images_no_live_page_shows() {
        let (conn, _dir, task) = setup();
        let a = page_with(&conn, &task, "A", "");
        let b = page_with(&conn, &task, "B", "");
        let x = add_data(
            &conn,
            AttachmentOwner::NotePage(&a),
            "x.png",
            "iVBORw0KGgo=",
        )
        .expect("x");
        let y = add_data(
            &conn,
            AttachmentOwner::NotePage(&b),
            "y.png",
            "iVBORw0KGgo=",
        )
        .expect("y");
        // Cut from A, pasted in B (no copy made): A's close keeps the file B shows.
        set_body(&conn, &b, &format!("![[file:{x}|50%]]"));
        assert!(prune_page_images(&conn, &a, std::slice::from_ref(&x))
            .expect("prune")
            .is_empty());
        assert!(get_page_image(&conn, &x).is_ok());
        // A shows it again: kept.
        set_body(&conn, &b, "");
        set_body(&conn, &a, &format!("Voir ![[file:{x}]]"));
        assert!(prune_page_images(&conn, &a, std::slice::from_ref(&x))
            .expect("prune")
            .is_empty());
        // Shown nowhere: deleted. Another page's image is never deleted from here.
        set_body(&conn, &a, "");
        let gone =
            prune_page_images(&conn, &a, &[x.clone(), y.clone(), "nope".into()]).expect("prune");
        assert_eq!(gone, vec![x.clone()]);
        assert!(get_page_image(&conn, &x).is_err());
        assert!(get_page_image(&conn, &y).is_ok());
        // A deleted page can still be restored: it keeps its images until it is purged.
        let z = add_data(
            &conn,
            AttachmentOwner::NotePage(&a),
            "z.png",
            "iVBORw0KGgo=",
        )
        .expect("z");
        set_body(&conn, &b, &format!("![[file:{z}]]"));
        conn.execute(
            "UPDATE note_pages SET deleted_at = '2026-10-14T00:00:00Z' WHERE id = ?1",
            [&b],
        )
        .expect("delete");
        assert!(prune_page_images(&conn, &a, std::slice::from_ref(&z))
            .expect("prune")
            .is_empty());
        conn.execute("DELETE FROM note_pages WHERE id = ?1", [&b])
            .expect("purge");
        assert_eq!(
            prune_page_images(&conn, &a, std::slice::from_ref(&z)).expect("prune"),
            vec![z]
        );
    }

    #[test]
    fn info_reads_an_attachment_whoever_owns_it() {
        let (conn, _dir, task) = setup();
        let a = page_with(&conn, &task, "A", "");
        let x = add_data(
            &conn,
            AttachmentOwner::NotePage(&a),
            "plan.png",
            "iVBORw0KGgo=",
        )
        .expect("x");
        let t = add_data(&conn, AttachmentOwner::Task(&task), "photo.HEIC", "AAAA").expect("t");
        let read = info(&conn, &x).expect("info").expect("some");
        assert_eq!(
            (read.file_name.as_str(), read.mime_type.as_str()),
            ("plan.png", "image/png")
        );
        assert!(read.exists);
        let heic = info(&conn, &t).expect("info").expect("some");
        assert_eq!(heic.mime_type, "image/heic");
        assert!(info(&conn, "0192f0a1-7c2b-7d3e-9f00-0123456789ab")
            .expect("info")
            .is_none());
        delete_page_image(&conn, &x).expect("delete");
        assert!(info(&conn, &x).expect("info").is_none());
    }

    #[test]
    fn a_page_takes_only_images() {
        use crate::model::{CreateNotePageInput, NoteKind};
        let (conn, dir, task) = setup();
        let subject_id: String = conn
            .query_row("SELECT subject_id FROM tasks WHERE id = ?1", [&task], |r| {
                r.get(0)
            })
            .expect("subject");
        let page = crate::db::notes::create_page(
            &conn,
            &CreateNotePageInput {
                subject_id,
                group_id: None,
                title: "Maquettes".into(),
                body: String::new(),
                kind: NoteKind::Page,
                source_task_id: None,
            },
        )
        .expect("page")
        .id;
        let pasted = add_data(
            &conn,
            AttachmentOwner::NotePage(&page),
            "devis.pdf",
            "JVBERi0=",
        );
        assert!(matches!(pasted, Err(AppError::Invalid(_))), "{pasted:?}");
        let text = dir.path().join("notes.txt");
        fs::write(&text, "x").expect("write");
        let photo = dir.path().join("photo.HEIC");
        fs::write(&photo, "x").expect("write");
        let dropped = add_files(
            &conn,
            AttachmentOwner::NotePage(&page),
            &[
                photo.to_string_lossy().into_owned(),
                text.to_string_lossy().into_owned(),
            ],
        );
        assert!(matches!(dropped, Err(AppError::Invalid(_))), "{dropped:?}");
        // Refused before anything is copied or added.
        assert!(list_for_page(&conn, &page).expect("list").is_empty());
        // A task still takes any file; a page takes an image (HEIC too: shown by name).
        add_data(&conn, AttachmentOwner::Task(&task), "devis.pdf", "JVBERi0=").expect("task");
        add_files(
            &conn,
            AttachmentOwner::NotePage(&page),
            &[photo.to_string_lossy().into_owned()],
        )
        .expect("image");
        // The same image formats as the UI (`PAGE_IMAGE_MIMES`).
        for name in ["scan.TIFF", "photo.avif", "vieux.bmp", "photo.heif"] {
            add_data(
                &conn,
                AttachmentOwner::NotePage(&page),
                name,
                "iVBORw0KGgo=",
            )
            .expect(name);
        }
        assert!(add_data(&conn, AttachmentOwner::NotePage(&page), "icone.ico", "AA==").is_err());
        assert_eq!(list_for_page(&conn, &page).expect("list").len(), 5);
    }

    #[test]
    fn deleting_keeps_a_file_named_like_its_partial_download() {
        let (conn, dir, task) = setup();
        for name in ["rapport.pdf.part", "rapport.pdf"] {
            let original = dir.path().join(name);
            fs::write(&original, name.as_bytes()).expect("write");
            add_files(
                &conn,
                AttachmentOwner::Task(&task),
                &[original.to_string_lossy().into_owned()],
            )
            .expect("add");
        }
        let list = list(&conn, &task).expect("list");
        let (other, report) = (&list[0], &list[1]);
        assert_eq!(report.file_name, "rapport.pdf");
        let partial = partial_path(Path::new(&report.path), &report.id);
        fs::write(&partial, b"debut").expect("partial");
        delete(&conn, &report.id).expect("delete");
        assert!(!Path::new(&report.path).exists());
        assert!(!partial.exists(), "its own partial download goes");
        assert_eq!(
            fs::read(&other.path).expect("the other attachment"),
            b"rapport.pdf.part"
        );
        // The same through the sync's cleanup of deleted attachments.
        remove_unused_files(
            &conn,
            vec![FreedFile {
                id: report.id.clone(),
                path: report.path.clone(),
                sha256: Some(sha256_bytes(b"rapport.pdf")),
            }],
        )
        .expect("cleanup");
        assert!(Path::new(&other.path).is_file());
    }

    /// A pulled deletion or the purge removes a copy only while it is the attachment's file:
    /// one edited in place here, or whose hash was never known, stays as the user's own file.
    #[test]
    fn a_freed_copy_is_removed_only_while_it_is_its_file() {
        let (conn, dir, _) = setup();
        let folder = dir.path().join("copies");
        fs::create_dir_all(&folder).expect("folder");
        let file = |name: &str, bytes: &[u8]| {
            let path = folder.join(name);
            fs::write(&path, bytes).expect("write");
            fs::write(partial_path(&path, name), b"debut").expect("partial");
            path
        };
        let same = file("same", b"original");
        let edited = file("edited", b"original, then edited here");
        let unhashed = file("unhashed", b"made before file sync");
        let freed = |id: &str, path: &Path, sha256: Option<String>| FreedFile {
            id: id.into(),
            path: path.to_string_lossy().into_owned(),
            sha256,
        };
        let removed = remove_unused_files(
            &conn,
            vec![
                freed("same", &same, Some(sha256_bytes(b"original"))),
                freed("edited", &edited, Some(sha256_bytes(b"original"))),
                freed("unhashed", &unhashed, None),
                freed("gone", &folder.join("gone"), Some(sha256_bytes(b"x"))),
            ],
        )
        .expect("cleanup");
        assert_eq!(removed, 1);
        assert!(!same.exists());
        assert_eq!(
            fs::read(&edited).expect("edited copy"),
            b"original, then edited here"
        );
        assert_eq!(
            fs::read(&unhashed).expect("unhashed copy"),
            b"made before file sync"
        );
        for (id, path) in [
            ("same", &same),
            ("edited", &edited),
            ("unhashed", &unhashed),
        ] {
            assert!(!partial_path(path, id).exists(), "{id}: its partial goes");
        }
    }

    #[test]
    fn a_renamed_task_keeps_its_folder() {
        let (conn, dir, task) = setup();
        let original = dir.path().join("a.txt");
        fs::write(&original, b"a").expect("write");
        add_files(
            &conn,
            AttachmentOwner::Task(&task),
            &[original.to_string_lossy().into_owned()],
        )
        .expect("add");
        let before = folder_of(&conn, &task).expect("folder");
        conn.execute("UPDATE tasks SET title = 'Autre' WHERE id = ?1", [&task])
            .expect("rename");
        assert_eq!(folder_of(&conn, &task).expect("folder"), before);
        assert_eq!(mime_of("Mail.EML"), "message/rfc822");
    }
    #[test]
    fn a_note_pages_images_go_to_the_projects_notes_folder() {
        let (conn, dir, task) = setup();
        let subject_id = tasks::load(&conn, &task)
            .expect("task")
            .subject_id
            .expect("project");
        let page = crate::db::notes::create_page(
            &conn,
            &crate::model::CreateNotePageInput {
                subject_id,
                group_id: None,
                title: "Page".into(),
                body: String::new(),
                kind: crate::model::NoteKind::Page,
                source_task_id: None,
            },
        )
        .expect("page");
        let owner = AttachmentOwner::NotePage(&page.id);
        add_data(&conn, owner, "capture.png", "iVBORw0KGgo=").expect("paste");
        add_data(&conn, owner, "capture.png", "iVBORw0KGgo=").expect("again");
        let stored: Vec<String> = conn
            .prepare(
                "SELECT stored_path FROM attachments WHERE note_page_id = ?1 \
                 AND task_id IS NULL ORDER BY created_at, id",
            )
            .expect("prepare")
            .query_map([&page.id], |r| r.get(0))
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("rows");
        let notes = dir
            .path()
            .join("Taido")
            .join(FOLDER_NAME)
            .join("Summit Events")
            .join(NOTES_FOLDER_NAME);
        assert_eq!(stored.len(), 2);
        assert_eq!(Path::new(&stored[0]), notes.join("capture.png"));
        assert_eq!(Path::new(&stored[1]), notes.join("capture (2).png"));
        assert!(Path::new(&stored[0]).is_file());
        // They are not a task's attachments, and a missing page is refused.
        assert!(list(&conn, &task).expect("list").is_empty());
        assert!(add_data(
            &conn,
            AttachmentOwner::NotePage("nope"),
            "a.png",
            "iVBORw0KGgo="
        )
        .is_err());
        // Purging the project removes the images' files too.
        let subject_id: String = conn
            .query_row("SELECT subject_id FROM note_pages", [], |r| r.get(0))
            .expect("subject");
        crate::db::subjects::delete(&conn, &subject_id).expect("delete");
        crate::db::trash::purge(&conn, chrono::Utc::now() + chrono::Duration::days(2))
            .expect("purge");
        assert!(!Path::new(&stored[0]).exists());
        assert!(!Path::new(&stored[1]).exists());
    }

    #[test]
    fn attachment_of_50_mb_is_accepted_locally() {
        let (conn, dir, task) = setup();
        // A sparse file: 50 MB declared, nothing allocated.
        let big = dir.path().join("big.bin");
        fs::File::create(&big)
            .expect("create")
            .set_len(50 * 1024 * 1024)
            .expect("len");
        add_files(
            &conn,
            AttachmentOwner::Task(&task),
            &[big.to_string_lossy().into_owned()],
        )
        .expect("no local size limit");
        assert_eq!(list(&conn, &task).expect("list")[0].size, 50 * 1024 * 1024);
    }
}
