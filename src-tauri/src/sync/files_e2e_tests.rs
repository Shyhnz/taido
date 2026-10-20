//! Attachment files between two Macs through the real sync server: same hash on both sides, resumed upload and download
//! after a cut, deletion everywhere without touching another file of the same name, limits
//! of the server, nothing sent without an account. Same harness as `e2e_tests`: temp
//! databases and folders, the server in process on 127.0.0.1; each Mac's app folder is in its
//! temp documents folder (never the real home).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use sync_proto::FileStatus;

use super::e2e_tests::{converge, Device, Hooks, NoEvents, Server, EMAIL, PASSWORD};
use crate::db::attachments::{self, sha256_bytes, AttachmentOwner};
use crate::db::{notes, tasks, trash, workspace};
use crate::error::ErrorKind;
use crate::model::{AttachmentRemote, CreateNotePageInput, NoteKind};
use crate::sync::client::SyncClient;
use crate::sync::engine;
use crate::sync::files::{self, FileOptions, FilesReport};
use crate::sync::model::AccountInput;
use crate::sync::service::SyncService;
use crate::sync::store;

/// Small chunks: a few hundred kilobytes make several of them.
const CHUNK: usize = 64 * 1024;

/// Deterministic bytes that differ with `seed`.
fn content(len: usize, seed: u8) -> Vec<u8> {
    let mut x = u32::from(seed).wrapping_mul(2_654_435_761) | 1;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            (x & 0xff) as u8
        })
        .collect()
}

/// The device's app folder, in its temp documents folder.
fn ready(device: &Device) {
    workspace::ensure(&device.conn(), device.docs.path()).expect("app folder");
}

/// Attaches a new file named `name` to `task`; returns the attachment's id.
fn attach(device: &Device, task: &str, name: &str, bytes: &[u8]) -> String {
    let dir = device
        .docs
        .path()
        .join("originals")
        .join(content_dir(bytes));
    fs::create_dir_all(&dir).expect("originals");
    let original = dir.join(name);
    fs::write(&original, bytes).expect("original");
    let conn = device.conn();
    attachments::add_files(
        &conn,
        attachments::AttachmentOwner::Task(task),
        &[original.to_string_lossy().into_owned()],
    )
    .expect("attach");
    conn.query_row(
        "SELECT id FROM attachments WHERE task_id = ?1 ORDER BY created_at DESC, id DESC \
         LIMIT 1",
        [task],
        |r| r.get(0),
    )
    .expect("attachment id")
}

/// One folder per content, so that two originals of the same name can coexist.
fn content_dir(bytes: &[u8]) -> String {
    sha256_bytes(bytes)[..12].to_string()
}

fn state(device: &Device, id: &str) -> String {
    device
        .text("SELECT remote FROM attachments WHERE id = ?1", id)
        .expect("attachment state")
}

fn stored(device: &Device, id: &str) -> PathBuf {
    PathBuf::from(
        device
            .text("SELECT stored_path FROM attachments WHERE id = ?1", id)
            .expect("stored path"),
    )
}

/// The tile's indicator of an attachment of `task`.
fn view(device: &Device, task: &str, id: &str) -> AttachmentRemote {
    attachments::list(&device.conn(), task)
        .expect("list")
        .into_iter()
        .find(|a| a.id == id)
        .expect("attachment listed")
        .remote
}

async fn files(device: &Device) -> FilesReport {
    files::run(
        &device.db,
        &device.client,
        &NoEvents,
        FileOptions { chunk_bytes: CHUNK },
    )
    .await
}

fn token(device: &Device) -> String {
    store::link(&device.conn())
        .expect("link")
        .expect("linked")
        .token
}

/// What the server holds of an attachment's file; `None` when it refuses (404).
fn server_status(server: &Server, id: &str) -> Option<FileStatus> {
    let state = server.running.as_ref().expect("server running").state();
    state
        .files
        .status(&state.store, &server.account_id, id)
        .ok()
}

/// Where the server keeps the complete file of an attachment.
fn server_file(server: &Server, id: &str) -> PathBuf {
    let state = server.running.as_ref().expect("server running").state();
    state.files.file_path(&server.account_id, id)
}

/// Where the file job downloads an attachment before checking it.
fn part_of(path: &Path, id: &str) -> PathBuf {
    attachments::partial_path(path, id)
}

#[tokio::test]
async fn a_file_added_on_a_mac_reaches_the_other_with_the_same_hash() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    ready(&a);
    ready(&b);
    let p = a.project("Globex", None);
    let t = a.task("Facturer", Some(&p), None);
    let bytes = content(200_000, 7);
    let sha = sha256_bytes(&bytes);
    let id = attach(&a, &t, "devis.pdf", &bytes);
    assert_eq!(
        a.text("SELECT sha256 FROM attachments WHERE id = ?1", &id),
        Some(sha.clone()),
        "hashed when added"
    );
    assert_eq!(view(&a, &t, &id), AttachmentRemote::None, "no account yet");

    a.link(&server).await;
    // The row is not on the server yet: its file waits.
    assert_eq!(files(&a).await.sent_bytes, 0);
    assert_eq!(state(&a, &id), "local");
    assert_eq!(view(&a, &t, &id), AttachmentRemote::LocalOnly);
    a.sync().await;
    let sent = files(&a).await;
    assert_eq!((sent.uploaded, sent.sent_bytes), (1, 200_000));
    assert_eq!(state(&a, &id), "sent");
    assert_eq!(view(&a, &t, &id), AttachmentRemote::None);
    let on_server = server_status(&server, &id).expect("status");
    assert!(on_server.complete);
    assert_eq!(
        fs::read(server_file(&server, &id)).expect("server copy"),
        bytes
    );

    b.link(&server).await;
    b.sync().await;
    assert_eq!(state(&b, &id), "missing");
    assert_eq!(view(&b, &t, &id), AttachmentRemote::ToDownload);
    assert_eq!(
        b.text("SELECT sha256 FROM attachments WHERE id = ?1", &id),
        Some(sha.clone()),
        "the pulled hash is kept"
    );
    let got = files(&b).await;
    assert_eq!((got.downloaded, got.received_bytes), (1, 200_000));
    let on_b = stored(&b, &id);
    assert!(on_b.starts_with(b.docs.path()), "{}", on_b.display());
    assert_eq!(fs::read(&on_b).expect("file on B"), bytes);
    assert!(!part_of(&on_b, &id).exists());
    assert_eq!(state(&b, &id), "sent");
    assert_eq!(view(&b, &t, &id), AttachmentRemote::None);
    converge(&a, &b).await;

    // Nothing left to move.
    assert_eq!(files(&a).await, FilesReport::default());
    assert_eq!(files(&b).await, FilesReport::default());
}

#[tokio::test]
async fn note_attachment_file_uploads_and_downloads() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    ready(&a);
    ready(&b);
    let p = a.project("Globex", None);
    let page = notes::create_page(
        &a.conn(),
        &CreateNotePageInput {
            subject_id: p.clone(),
            group_id: None,
            title: "Maquettes".into(),
            body: String::new(),
            kind: NoteKind::Page,
            source_task_id: None,
        },
    )
    .expect("page")
    .id;
    let bytes = content(150_000, 11);
    let sha = sha256_bytes(&bytes);
    let original = a.docs.path().join("maquette.png");
    fs::write(&original, &bytes).expect("original");
    attachments::add_files(
        &a.conn(),
        AttachmentOwner::NotePage(&page),
        &[original.to_string_lossy().into_owned()],
    )
    .expect("image");
    let id = a
        .text("SELECT id FROM attachments WHERE note_page_id = ?1", &page)
        .expect("image id");

    a.link(&server).await;
    a.sync().await;
    let sent = files(&a).await;
    assert_eq!((sent.uploaded, sent.sent_bytes), (1, 150_000));
    assert_eq!(state(&a, &id), "sent");
    assert!(server_status(&server, &id).expect("status").complete);
    assert_eq!(
        fs::read(server_file(&server, &id)).expect("server copy"),
        bytes
    );

    b.link(&server).await;
    b.sync().await;
    assert_eq!(state(&b, &id), "missing");
    let got = files(&b).await;
    assert_eq!((got.downloaded, got.received_bytes), (1, 150_000));
    let on_b = stored(&b, &id);
    assert!(
        on_b.starts_with(b.docs.path()) && on_b.parent().is_some_and(|d| d.ends_with("Notes")),
        "{}",
        on_b.display()
    );
    assert_eq!(fs::read(&on_b).expect("file on B"), bytes);
    assert_eq!(
        b.text("SELECT sha256 FROM attachments WHERE id = ?1", &id),
        Some(sha)
    );
    assert_eq!(state(&b, &id), "sent");
    converge(&a, &b).await;
    assert_eq!(files(&a).await, FilesReport::default());
    assert_eq!(files(&b).await, FilesReport::default());

    // The page is purged on B: the server forgets the file, A loses its copy.
    b.conn()
        .execute("DELETE FROM note_pages WHERE id = ?1", [&page])
        .expect("purge on B");
    converge(&a, &b).await;
    assert!(server_status(&server, &id).is_none());
    assert!(!a.exists("attachments", &id));
}

/// Counts what the file job tells the UI.
#[derive(Default)]
struct CountingEvents {
    tasks: std::sync::atomic::AtomicUsize,
    notes: std::sync::atomic::AtomicUsize,
}

impl crate::sync::service::SyncEvents for CountingEvents {
    fn status_changed(&self, _status: &crate::sync::model::SyncStatus) {}
    fn data_changed(&self, _conn: &rusqlite::Connection) {}
    fn attachments_changed(&self, _conn: &rusqlite::Connection, _task_ids: &[String]) {
        self.tasks.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    fn notes_changed(&self, _conn: &rusqlite::Connection) {
        self.notes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// A page image changing state tells the notebook (`DataScope::Notes`), not a task's panel.
#[tokio::test]
async fn a_page_image_state_change_tells_the_notebook() {
    use std::sync::atomic::Ordering::SeqCst;
    let server = Server::start().await;
    let a = Device::new();
    ready(&a);
    let p = a.project("Globex", None);
    let page = notes::create_page(
        &a.conn(),
        &CreateNotePageInput {
            subject_id: p,
            group_id: None,
            title: "Maquettes".into(),
            body: String::new(),
            kind: NoteKind::Page,
            source_task_id: None,
        },
    )
    .expect("page")
    .id;
    attachments::add_data(
        &a.conn(),
        AttachmentOwner::NotePage(&page),
        "capture.png",
        "iVBORw0KGgo=",
    )
    .expect("image");
    a.link(&server).await;
    a.sync().await;
    let events = CountingEvents::default();
    let report = files::run(
        &a.db,
        &a.client,
        &events,
        FileOptions { chunk_bytes: CHUNK },
    )
    .await;
    assert_eq!(report.uploaded, 1);
    assert!(events.notes.load(SeqCst) >= 1);
    assert_eq!(events.tasks.load(SeqCst), 0);
}

#[tokio::test]
async fn an_upload_cut_midway_resumes_from_what_the_server_has() {
    let mut server = Server::start().await;
    let a = Device::new();
    ready(&a);
    let t = a.task("Maquette", None, None);
    let bytes = content(300_000, 3);
    let sha = sha256_bytes(&bytes);
    let id = attach(&a, &t, "maquette.png", &bytes);
    a.link(&server).await;
    a.sync().await;

    // The server is gone: the file waits for the next run, nothing is lost.
    server.stop().await;
    let r = files(&a).await;
    assert_eq!((r.uploaded, r.deferred), (0, 1));
    assert_eq!(state(&a, &id), "local");
    server.restart().await;

    // A previous run was cut after its first chunk: the server holds 64 KiB of it.
    let tok = token(&a);
    a.client
        .put_file_chunk(&server.url, &tok, &id, 0, 300_000, &sha, Vec::new())
        .await
        .expect("open");
    let status = a
        .client
        .put_file_chunk(
            &server.url,
            &tok,
            &id,
            0,
            300_000,
            &sha,
            bytes[..CHUNK].to_vec(),
        )
        .await
        .expect("first chunk");
    assert_eq!(status.received, CHUNK as u64);

    let r = files(&a).await;
    assert_eq!(r.uploaded, 1);
    assert_eq!(
        r.sent_bytes,
        (300_000 - CHUNK) as u64,
        "resumed, not restarted"
    );
    assert_eq!(state(&a, &id), "sent");
    assert_eq!(
        fs::read(server_file(&server, &id)).expect("server copy"),
        bytes
    );
}

#[tokio::test]
async fn a_download_cut_midway_resumes_and_a_wrong_one_is_never_kept() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    ready(&a);
    ready(&b);
    let t = a.task("Photos", None, None);
    let first = content(300_000, 11);
    let second = content(150_000, 12);
    let id = attach(&a, &t, "photo.jpg", &first);
    let id2 = attach(&a, &t, "plan.pdf", &second);
    a.link(&server).await;
    a.sync().await;
    assert_eq!(files(&a).await.uploaded, 2);
    b.link(&server).await;
    b.sync().await;

    // B was cut after 100 000 bytes of the first file; the second one got garbage.
    let dest = stored(&b, &id);
    fs::create_dir_all(dest.parent().expect("folder")).expect("folder");
    fs::write(part_of(&dest, &id), &first[..100_000]).expect("partial");
    let dest2 = stored(&b, &id2);
    fs::write(part_of(&dest2, &id2), content(100_000, 99)).expect("wrong partial");

    let r = files(&b).await;
    assert_eq!(r.downloaded, 1);
    assert_eq!(r.deferred, 1);
    assert_eq!(
        r.received_bytes,
        200_000 + 50_000,
        "resumed from the partial files"
    );
    assert_eq!(fs::read(&dest).expect("first file"), first);
    assert!(!part_of(&dest, &id).exists());
    assert_eq!(state(&b, &id), "sent");
    // The wrong one failed its hash check: nothing kept, fetched again next time.
    assert!(!dest2.exists());
    assert!(!part_of(&dest2, &id2).exists());
    assert_eq!(state(&b, &id2), "missing");
    let r = files(&b).await;
    assert_eq!((r.downloaded, r.received_bytes), (1, 150_000));
    assert_eq!(fs::read(&dest2).expect("second file"), second);
}

#[tokio::test]
async fn deleting_an_attachment_frees_the_server_and_the_other_mac_only_for_it() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    ready(&a);
    ready(&b);
    let t1 = a.task("Devis client A", None, None);
    let t2 = a.task("Devis client B", None, None);
    let gone = attach(&a, &t1, "devis.pdf", &content(70_000, 1));
    let kept_bytes = content(80_000, 2);
    let kept = attach(&a, &t2, "devis.pdf", &kept_bytes);
    a.link(&server).await;
    a.sync().await;
    assert_eq!(files(&a).await.uploaded, 2);
    b.link(&server).await;
    b.sync().await;
    assert_eq!(files(&b).await.downloaded, 2);
    let (gone_on_b, kept_on_b) = (stored(&b, &gone), stored(&b, &kept));
    assert!(gone_on_b.is_file() && kept_on_b.is_file());
    assert_eq!(
        gone_on_b.file_name(),
        kept_on_b.file_name(),
        "same name, two tasks"
    );

    attachments::delete(&a.conn(), &gone).expect("delete on A");
    a.sync().await;
    assert!(
        server_status(&server, &gone).is_none(),
        "refused once deleted"
    );
    assert!(
        !server_file(&server, &gone).exists(),
        "the server's copy is gone"
    );
    assert!(server_file(&server, &kept).is_file(), "the other one stays");

    b.sync().await;
    assert!(!gone_on_b.exists(), "B's copy is gone");
    assert_eq!(fs::read(&kept_on_b).expect("kept on B"), kept_bytes);
    assert!(attachments::list(&b.conn(), &t1).expect("list").is_empty());

    // A partial download of a deleted attachment goes too.
    let draft = attach(&a, &t1, "brouillon.txt", &content(30_000, 3));
    a.sync().await;
    files(&a).await;
    b.sync().await;
    let draft_on_b = stored(&b, &draft);
    fs::create_dir_all(draft_on_b.parent().expect("folder")).expect("folder");
    fs::write(part_of(&draft_on_b, &draft), b"debut").expect("partial");
    attachments::delete(&a.conn(), &draft).expect("delete the draft");
    a.sync().await;
    b.sync().await;
    assert!(!part_of(&draft_on_b, &draft).exists());
    converge(&a, &b).await;
}

#[tokio::test]
async fn too_large_and_a_full_account_are_shown_and_tasks_still_sync() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    ready(&a);
    ready(&b);
    let running = server.running.as_ref().expect("server");
    running.set_file_limits(100_000, 2_147_483_648);
    let t = a.task("Vidéos", None, None);
    let big = attach(&a, &t, "film.mov", &content(150_000, 5));
    a.link(&server).await;
    a.sync().await;
    let r = files(&a).await;
    assert_eq!((r.refused, r.sent_bytes), (1, 0), "refused before any byte");
    assert_eq!(state(&a, &big), "file_too_large");
    assert_eq!(view(&a, &t, &big), AttachmentRemote::TooLarge);

    // Tasks keep syncing.
    let after = a.task("Monter la vidéo", None, None);
    a.sync().await;
    b.link(&server).await;
    b.sync().await;
    assert_eq!(b.title(&after).as_deref(), Some("Monter la vidéo"));

    // Larger files allowed, a small account: the big one goes (tried again), the next one
    // does not fit.
    running.set_file_limits(1_000_000, 200_000);
    let next = attach(&a, &t, "rush.mov", &content(100_000, 6));
    a.sync().await;
    let r = files(&a).await;
    assert_eq!((r.uploaded, r.refused), (1, 1));
    assert_eq!(state(&a, &big), "sent");
    assert_eq!(state(&a, &next), "quota_exceeded");
    assert_eq!(view(&a, &t, &next), AttachmentRemote::QuotaFull);
    a.retitle(&after, "Monter la vidéo (v2)");
    a.sync().await;
    b.sync().await;
    assert_eq!(b.title(&after).as_deref(), Some("Monter la vidéo (v2)"));

    // Deleting the big one frees the account: the other one goes at the next run.
    attachments::delete(&a.conn(), &big).expect("delete");
    a.sync().await;
    let r = files(&a).await;
    assert_eq!(r.uploaded, 1);
    assert_eq!(state(&a, &next), "sent");
    assert_eq!(view(&a, &t, &next), AttachmentRemote::None);
}

/// A file the server refuses is answered by the empty first chunk: its copy is never read for
/// it (an unreadable copy is still refused, not left for later), at any run.
// Unix only: makes the copy unreadable with permission bits.
#[cfg(unix)]
#[tokio::test]
async fn a_refused_file_is_never_read() {
    use std::os::unix::fs::PermissionsExt;
    let server = Server::start().await;
    let a = Device::new();
    ready(&a);
    let running = server.running.as_ref().expect("server");
    running.set_file_limits(10_000, 2_147_483_648);
    let t = a.task("Vidéos", None, None);
    let big = attach(&a, &t, "film.mov", &content(50_000, 8));
    a.link(&server).await;
    a.sync().await;
    let copy = stored(&a, &big);
    fs::set_permissions(&copy, fs::Permissions::from_mode(0o000)).expect("unreadable");
    for _ in 0..2 {
        let r = files(&a).await;
        assert_eq!((r.refused, r.deferred, r.sent_bytes), (1, 0, 0));
        assert_eq!(state(&a, &big), "file_too_large");
    }
    fs::set_permissions(&copy, fs::Permissions::from_mode(0o644)).expect("readable");
}

#[tokio::test]
async fn without_an_account_nothing_is_sent() {
    let server = Server::start().await;
    let a = Device::new();
    ready(&a);
    let t = a.task("Hors ligne", None, None);
    let id = attach(&a, &t, "notes.txt", b"rien ne part");
    assert_eq!(files(&a).await, FilesReport::default());
    assert_eq!(state(&a, &id), "local");
    assert_eq!(
        view(&a, &t, &id),
        AttachmentRemote::None,
        "as before file sync"
    );

    // Linked once, then unlinked: a new file stays here too.
    a.link(&server).await;
    a.sync().await;
    assert_eq!(files(&a).await.uploaded, 1);
    engine::unlink(&a.db, &a.client).await.expect("unlink");
    let later = attach(&a, &t, "plus.txt", b"toujours rien");
    a.conn()
        .execute("DELETE FROM sync_outbox", [])
        .expect("as if pushed");
    assert_eq!(files(&a).await, FilesReport::default());
    assert_eq!(state(&a, &later), "local");
    assert!(server_status(&server, &later).is_none());
    assert_eq!(view(&a, &t, &later), AttachmentRemote::None);
    assert_eq!(view(&a, &t, &id), AttachmentRemote::None);
}

#[tokio::test]
async fn a_restored_attachment_is_sent_again_from_the_mac_that_has_it() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    ready(&a);
    ready(&b);
    let t = a.task("Contrat", None, None);
    let bytes = content(90_000, 21);
    let id = attach(&a, &t, "contrat.pdf", &bytes);
    a.link(&server).await;
    a.sync().await;
    files(&a).await;
    b.link(&server).await;
    b.sync().await;

    // B deletes it (the server frees the file), then it is restored before A syncs.
    attachments::delete(&b.conn(), &id).expect("delete on B");
    b.sync().await;
    assert!(!server_file(&server, &id).exists());
    b.conn()
        .execute(
            "UPDATE attachments SET deleted_at = NULL WHERE id = ?1",
            [&id],
        )
        .expect("restore on B");
    b.sync().await;
    assert_eq!(server_status(&server, &id).map(|s| s.received), Some(0));

    // A still has the file and thought it sent: it sends it again.
    a.sync().await;
    let r = files(&a).await;
    assert_eq!((r.uploaded, r.sent_bytes), (1, 90_000));
    assert_eq!(
        fs::read(server_file(&server, &id)).expect("server copy"),
        bytes
    );
    assert_eq!(state(&a, &id), "sent");

    // Deleted then restored once A has seen the deletion: no device has the file any more.
    attachments::delete(&b.conn(), &id).expect("delete again");
    b.sync().await;
    a.sync().await;
    assert!(!stored(&a, &id).exists(), "A's copy went with the deletion");
    b.conn()
        .execute(
            "UPDATE attachments SET deleted_at = NULL WHERE id = ?1",
            [&id],
        )
        .expect("restore again");
    b.sync().await;
    a.sync().await;
    let r = files(&a).await;
    assert_eq!((r.uploaded, r.downloaded), (0, 0));
    assert_eq!(state(&a, &id), "missing");
    assert_eq!(view(&a, &t, &id), AttachmentRemote::ToDownload);
}

#[tokio::test]
async fn deleting_a_task_frees_its_files_once_purged() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    ready(&a);
    ready(&b);
    let t = a.task("Ancien projet", None, None);
    let id = attach(&a, &t, "archive.zip", &content(60_000, 31));
    let notes = attach(&a, &t, "notes.txt", &content(5_000, 32));
    a.link(&server).await;
    a.sync().await;
    files(&a).await;
    b.link(&server).await;
    b.sync().await;
    files(&b).await;
    let (on_a, on_b) = (stored(&a, &id), stored(&b, &id));
    assert!(on_a.is_file() && on_b.is_file());

    // In the trash, the task can come back with its files.
    tasks::delete(&a.conn(), &t).expect("delete task");
    a.sync().await;
    b.sync().await;
    assert!(server_file(&server, &id).is_file());
    assert!(on_b.is_file());

    // Purged a day later: its attachments' tombstones free every copy, except one edited in
    // place here meanwhile (no longer the attachment's file: the user's own).
    let (notes_on_a, notes_on_b) = (stored(&a, &notes), stored(&b, &notes));
    fs::write(&notes_on_a, b"notes reprises sur A").expect("edit on A");
    let later = chrono::Utc::now() + chrono::Duration::hours(25);
    trash::purge(&a.conn(), later).expect("purge");
    assert!(!on_a.exists(), "A's copy goes with the purge");
    assert_eq!(
        fs::read(&notes_on_a).expect("edited copy kept"),
        b"notes reprises sur A"
    );
    a.sync().await;
    assert!(
        !server_file(&server, &id).exists(),
        "the server's copy is gone"
    );
    assert!(server_status(&server, &id).is_none());
    b.sync().await;
    assert!(!on_b.exists(), "B's copy is gone");
    assert!(!notes_on_b.exists(), "B's unchanged copy of the notes too");
    converge(&a, &b).await;
}

#[tokio::test]
async fn a_mac_linked_to_another_account_sends_its_files_again() {
    let first = Server::start().await;
    let a = Device::new();
    ready(&a);
    let t = a.task("Facture", None, None);
    let bytes = content(40_000, 41);
    let id = attach(&a, &t, "facture.pdf", &bytes);
    a.link(&first).await;
    a.sync().await;
    assert_eq!(files(&a).await.uploaded, 1);
    engine::unlink(&a.db, &a.client).await.expect("unlink");

    let second = Server::start().await;
    engine::login(&a.db, &a.client, &second.url, EMAIL, PASSWORD)
        .await
        .expect("link to the other server");
    assert_eq!(state(&a, &id), "local", "checked again with the new server");
    a.sync().await;
    let r = files(&a).await;
    assert_eq!((r.uploaded, r.sent_bytes), (1, 40_000));
    assert_eq!(
        fs::read(server_file(&second, &id)).expect("copy on the new server"),
        bytes
    );
}

/// Waits (up to 10 s) until the attachment's file state is `expected`.
async fn wait_for_state(device: &Device, id: &str, expected: &str) {
    for _ in 0..200 {
        if state(device, id) == expected {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("{id} never became {expected}: {}", state(device, id));
}

/// The service runs the file job after its successful runs, in the background: a new file
/// goes out; an older attachment is hashed, its hash goes out with the sync the job asks for,
/// then its file with the job after it.
#[tokio::test]
async fn the_sync_service_moves_the_files_after_its_runs() {
    let server = Server::start().await;
    let a = Device::new();
    ready(&a);
    let t = a.task("Service", None, None);
    let bytes = content(150_000, 51);
    let id = attach(&a, &t, "rapport.pdf", &bytes);
    let service = SyncService::with_poke_delay(
        Arc::clone(&a.db),
        a.docs.path().to_path_buf(),
        SyncClient::new(),
        Arc::new(Hooks::default()),
        Arc::new(NoEvents),
        Duration::from_millis(50),
    );
    tokio::spawn(Arc::clone(&service).worker());
    service
        .login(&AccountInput {
            server_url: server.url.clone(),
            email: EMAIL.into(),
            password: PASSWORD.into(),
        })
        .await
        .expect("link");
    wait_for_state(&a, &id, "sent").await;
    assert_eq!(
        fs::read(server_file(&server, &id)).expect("server copy"),
        bytes
    );

    let older = a.docs.path().join("ancien.txt");
    fs::write(&older, b"made before file sync").expect("older file");
    {
        let conn = a.conn();
        conn.execute(
            "INSERT INTO attachments (id, task_id, file_name, stored_path, mime_type, size, \
             created_at, updated_at) VALUES ('older', ?1, 'ancien.txt', ?2, 'text/plain', 19, \
             'c', 'c')",
            rusqlite::params![t, older.to_string_lossy()],
        )
        .expect("older attachment");
        service.poke(&conn);
    }
    wait_for_state(&a, "older", "sent").await;
    assert_eq!(
        fs::read(server_file(&server, "older")).expect("server copy"),
        b"made before file sync"
    );
    assert_eq!(
        a.text("SELECT sha256 FROM attachments WHERE id = ?1", "older"),
        Some(sha256_bytes(b"made before file sync"))
    );
}

/// The service's purge (after its first successful run) removes the purged attachments' files
/// once the database lock is released, and keeps a copy edited in place.
#[tokio::test]
async fn the_sync_service_purge_keeps_a_copy_edited_here() {
    let server = Server::start().await;
    let a = Device::new();
    ready(&a);
    let t = a.task("Ancien", None, None);
    let photo = attach(&a, &t, "photo.jpg", &content(20_000, 61));
    let notes = attach(&a, &t, "notes.txt", &content(5_000, 62));
    let (photo_path, notes_path) = (stored(&a, &photo), stored(&a, &notes));
    fs::write(&notes_path, b"notes reprises ici").expect("edit in place");
    tasks::delete(&a.conn(), &t).expect("delete task");
    a.conn()
        .execute(
            "UPDATE tasks SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1",
            [&t],
        )
        .expect("deleted long ago");
    let service = SyncService::with_poke_delay(
        Arc::clone(&a.db),
        a.docs.path().to_path_buf(),
        SyncClient::new(),
        Arc::new(Hooks::default()),
        Arc::new(NoEvents),
        Duration::from_millis(50),
    );
    tokio::spawn(Arc::clone(&service).worker());
    service
        .login(&AccountInput {
            server_url: server.url.clone(),
            email: EMAIL.into(),
            password: PASSWORD.into(),
        })
        .await
        .expect("link");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while photo_path.exists() {
        assert!(tokio::time::Instant::now() < deadline, "never purged");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        a.text(
            "SELECT CAST(COUNT(*) AS TEXT) FROM attachments WHERE task_id = ?1",
            &t
        ),
        Some("0".into())
    );
    assert_eq!(
        fs::read(&notes_path).expect("edited copy kept"),
        b"notes reprises ici"
    );
}

/// A partial download never takes another attachment's name: a file literally named
/// `rapport.pdf.part` survives the download and the deletion of `rapport.pdf`.
#[tokio::test]
async fn a_file_named_like_a_partial_download_is_never_touched() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    ready(&a);
    ready(&b);
    let t = a.task("Rapport", None, None);
    let named_part = content(50_000, 61);
    let report_bytes = content(80_000, 62);
    let other = attach(&a, &t, "rapport.pdf.part", &named_part);
    let report = attach(&a, &t, "rapport.pdf", &report_bytes);
    a.link(&server).await;
    a.sync().await;
    assert_eq!(files(&a).await.uploaded, 2);
    b.link(&server).await;
    b.sync().await;
    let r = files(&b).await;
    assert_eq!((r.downloaded, r.received_bytes), (2, 130_000));
    let (other_on_b, report_on_b) = (stored(&b, &other), stored(&b, &report));
    assert_eq!(fs::read(&other_on_b).expect("other"), named_part);
    assert_eq!(fs::read(&report_on_b).expect("report"), report_bytes);
    assert_eq!(other_on_b.parent(), report_on_b.parent());

    attachments::delete(&a.conn(), &report).expect("delete on A");
    assert_eq!(
        fs::read(stored(&a, &other)).expect("other on A"),
        named_part
    );
    a.sync().await;
    b.sync().await;
    assert!(!report_on_b.exists());
    assert_eq!(fs::read(&other_on_b).expect("other on B"), named_part);
}

/// A file already where an attachment is to be downloaded: kept when it is that very file
/// (nothing fetched; the server is asked whether it has it before the file counts as sent),
/// else never overwritten (the download takes a free name next to it).
#[tokio::test]
async fn a_file_already_in_place_is_kept_or_never_overwritten() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    ready(&a);
    ready(&b);
    let t = a.task("Chantier", None, None);
    let photo_bytes = content(40_000, 71);
    let devis_bytes = content(30_000, 72);
    let photo = attach(&a, &t, "photo.jpg", &photo_bytes);
    let devis = attach(&a, &t, "devis.pdf", &devis_bytes);
    a.link(&server).await;
    a.sync().await;
    files(&a).await;
    b.link(&server).await;
    b.sync().await;
    let (photo_on_b, devis_on_b) = (stored(&b, &photo), stored(&b, &devis));
    fs::create_dir_all(photo_on_b.parent().expect("folder")).expect("folder");
    fs::write(&photo_on_b, &photo_bytes).expect("same file put there");
    fs::write(&devis_on_b, b"mon propre devis").expect("another file put there");

    let r = files(&b).await;
    assert_eq!(r.downloaded, 2);
    assert_eq!(r.received_bytes, 30_000, "the photo was not fetched");
    assert_eq!(stored(&b, &photo), photo_on_b);
    assert_eq!(
        state(&b, &photo),
        "local",
        "not « sent » before the server says so"
    );
    let r = files(&b).await;
    assert_eq!((r.uploaded, r.sent_bytes), (1, 0), "the server had it");
    assert_eq!(state(&b, &photo), "sent");
    assert_eq!(
        fs::read(&devis_on_b).expect("own file"),
        b"mon propre devis"
    );
    let moved = stored(&b, &devis);
    assert_ne!(moved, devis_on_b);
    assert_eq!(moved.parent(), devis_on_b.parent());
    assert_eq!(
        moved.file_name().and_then(|n| n.to_str()),
        Some("devis (2).pdf")
    );
    assert_eq!(fs::read(&moved).expect("downloaded"), devis_bytes);
    assert_eq!(state(&b, &devis), "sent");
}

/// A file's content never changes once sent: a copy edited in place on one Mac (then that
/// Mac logs in again, so every file is checked again) is never sent, never re-hashed, never
/// bounced between the Macs. The other Mac keeps the original; nothing is overwritten.
#[tokio::test]
async fn a_copy_edited_on_one_mac_never_loops_between_two() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    ready(&a);
    ready(&b);
    let t = a.task("Notes", None, None);
    let original = content(50_000, 81);
    let sha = sha256_bytes(&original);
    let id = attach(&a, &t, "notes.txt", &original);
    a.link(&server).await;
    a.sync().await;
    assert_eq!(files(&a).await.uploaded, 1);
    b.link(&server).await;
    b.sync().await;
    assert_eq!(files(&b).await.downloaded, 1);

    let edited_on_a = stored(&a, &id);
    let mut edited = original.clone();
    edited.extend_from_slice(b"ajout fait sur A");
    fs::write(&edited_on_a, &edited).expect("edit in place");
    engine::unlink(&a.db, &a.client).await.expect("unlink");
    a.link(&server).await;

    let mut sent = 0;
    for _ in 0..4 {
        a.sync().await;
        b.sync().await;
        sent += files(&a).await.sent_bytes;
        sent += files(&b).await.sent_bytes;
    }
    assert_eq!(sent, 0, "nothing was sent again");
    for device in [&a, &b] {
        assert_eq!(
            device.text(
                "SELECT size || '|' || sha256 FROM attachments WHERE id = ?1",
                &id
            ),
            Some(format!("50000|{sha}")),
            "the attachment keeps its hash and size"
        );
    }
    assert_eq!(
        fs::read(server_file(&server, &id)).expect("server copy"),
        original
    );
    assert_eq!(fs::read(stored(&b, &id)).expect("B's copy"), original);
    assert_eq!(
        fs::read(&edited_on_a).expect("A's edited copy"),
        edited,
        "the edit stays on A, untouched"
    );
    let back_on_a = stored(&a, &id);
    assert_ne!(back_on_a, edited_on_a);
    assert_eq!(fs::read(&back_on_a).expect("original on A"), original);
    assert_eq!(state(&a, &id), "sent");
    converge(&a, &b).await;
}

/// A copy edited in place before its file was ever sent is the only content of the
/// attachment: hashed again, pushed with its new hash and size, then sent; the other Mac gets
/// that content.
#[tokio::test]
async fn a_copy_edited_before_it_was_sent_is_what_is_sent() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    ready(&a);
    ready(&b);
    let t = a.task("Plan", None, None);
    let original = content(40_000, 91);
    let id = attach(&a, &t, "plan.txt", &original);
    a.link(&server).await;
    a.sync().await;
    let copy = stored(&a, &id);
    let mut edited = original.clone();
    edited.extend_from_slice(b"ajout avant l'envoi");
    fs::write(&copy, &edited).expect("edit in place");

    let r = files(&a).await;
    assert_eq!(
        (r.uploaded, r.sent_bytes),
        (0, 0),
        "nothing of the old content"
    );
    assert_eq!(stored(&a, &id), copy, "the attachment keeps its place");
    assert_eq!(fs::read(&copy).expect("copy"), edited, "untouched");
    assert_eq!(state(&a, &id), "local");
    assert_eq!(
        a.text(
            "SELECT size || '|' || sha256 FROM attachments WHERE id = ?1",
            &id
        ),
        Some(format!("{}|{}", edited.len(), sha256_bytes(&edited))),
        "the new content is the attachment's"
    );
    assert_eq!(view(&a, &t, &id), AttachmentRemote::LocalOnly);

    a.sync().await;
    let r = files(&a).await;
    assert_eq!((r.uploaded, r.sent_bytes), (1, edited.len() as u64));
    assert_eq!(state(&a, &id), "sent");
    assert_eq!(
        fs::read(server_file(&server, &id)).expect("server copy"),
        edited
    );
    b.link(&server).await;
    b.sync().await;
    assert_eq!(files(&b).await.downloaded, 1);
    assert_eq!(fs::read(stored(&b, &id)).expect("on B"), edited);
    converge(&a, &b).await;
}

/// A file the user put where a pulled attachment goes is never hidden: the attachment keeps
/// pointing at it while its own file is not on the server, and the file is put next to it once
/// it has arrived.
#[tokio::test]
async fn a_file_in_the_way_keeps_its_place_until_the_attachment_arrives() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    ready(&a);
    ready(&b);
    let t = a.task("Chantier", None, None);
    let bytes = content(20_000, 92);
    let id = attach(&a, &t, "plan.pdf", &bytes);
    a.link(&server).await;
    a.sync().await;
    b.link(&server).await;
    b.sync().await;
    let in_the_way = stored(&b, &id);
    fs::create_dir_all(in_the_way.parent().expect("folder")).expect("folder");
    fs::write(&in_the_way, b"mon plan").expect("own file");

    // A has not sent it yet: nothing to fetch, nothing moved.
    let r = files(&b).await;
    assert_eq!((r.downloaded, r.deferred), (0, 1));
    assert_eq!(stored(&b, &id), in_the_way);
    assert_eq!(state(&b, &id), "missing");

    assert_eq!(files(&a).await.uploaded, 1);
    assert_eq!(files(&b).await.downloaded, 1);
    let arrived = stored(&b, &id);
    assert_ne!(arrived, in_the_way);
    assert_eq!(arrived.parent(), in_the_way.parent());
    assert_eq!(fs::read(&arrived).expect("arrived"), bytes);
    assert_eq!(fs::read(&in_the_way).expect("own file"), b"mon plan");
    assert_eq!(state(&b, &id), "sent");
}

/// A pulled deletion (and the purge) removes a copy only while it is the attachment's file:
/// one edited in place here stays, as the user's own file.
#[tokio::test]
async fn a_deletion_from_elsewhere_keeps_a_copy_edited_here() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    ready(&a);
    ready(&b);
    let t = a.task("Notes", None, None);
    let edited_id = attach(&a, &t, "notes.txt", &content(10_000, 93));
    let plain_id = attach(&a, &t, "photo.jpg", &content(12_000, 94));
    a.link(&server).await;
    a.sync().await;
    assert_eq!(files(&a).await.uploaded, 2);
    b.link(&server).await;
    b.sync().await;
    assert_eq!(files(&b).await.downloaded, 2);
    let (edited_on_b, plain_on_b) = (stored(&b, &edited_id), stored(&b, &plain_id));
    fs::write(&edited_on_b, b"mes notes a moi").expect("edit on B");

    attachments::delete(&a.conn(), &edited_id).expect("delete on A");
    attachments::delete(&a.conn(), &plain_id).expect("delete on A");
    a.sync().await;
    b.sync().await;
    assert!(attachments::list(&b.conn(), &t).expect("list").is_empty());
    assert!(!plain_on_b.exists(), "an unchanged copy goes");
    assert_eq!(
        fs::read(&edited_on_b).expect("kept"),
        b"mes notes a moi",
        "the copy edited on B stays"
    );
}

// ---------------------------------------------------------------------------
// « Télécharger » (2026-10-10): a copy in the Downloads folder, a temp folder here
// ---------------------------------------------------------------------------

async fn save(device: &Device, id: &str, downloads: &Path) -> crate::error::AppResult<PathBuf> {
    files::save_copy(&device.db, &device.client, &NoEvents, id, downloads).await
}

/// The files of a folder, by name (to see that nothing else was left there).
fn names_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .expect("read dir")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// A file here is copied under a free name: never over a file of the Downloads folder, never
/// a half copy left behind, the attachment's own copy untouched.
#[tokio::test]
async fn download_copies_a_file_here_under_a_free_name() {
    let a = Device::new();
    ready(&a);
    let t = a.task("Devis", None, None);
    let bytes = content(40_000, 101);
    let id = attach(&a, &t, "devis.pdf", &bytes);
    let downloads = tempfile::tempdir().expect("downloads");
    fs::write(downloads.path().join("devis.pdf"), b"deja la").expect("taken");

    let first = save(&a, &id, downloads.path()).await.expect("first copy");
    assert_eq!(first, downloads.path().join("devis (2).pdf"));
    assert_eq!(fs::read(&first).expect("copy"), bytes);
    let second = save(&a, &id, downloads.path()).await.expect("second copy");
    assert_eq!(second, downloads.path().join("devis (3).pdf"));
    assert_eq!(fs::read(&second).expect("copy"), bytes);
    assert_eq!(
        fs::read(downloads.path().join("devis.pdf")).expect("kept"),
        b"deja la"
    );
    assert_eq!(
        names_in(downloads.path()),
        ["devis (2).pdf", "devis (3).pdf", "devis.pdf"],
        "no partial file left"
    );
    assert_eq!(fs::read(stored(&a, &id)).expect("own copy"), bytes);
    assert!(
        !files::is_quarantined(&first),
        "a file added on this Mac is not marked as downloaded"
    );

    // Gone from this Mac and no account: said plainly, nothing written.
    fs::remove_file(stored(&a, &id)).expect("remove");
    let error = save(&a, &id, downloads.path()).await.expect_err("not here");
    assert_eq!(error.kind(), ErrorKind::FileNotHere);
    let error = save(&a, "inconnue", downloads.path())
        .await
        .expect_err("unknown");
    assert_eq!(error.kind(), ErrorKind::NotFound);
    assert_eq!(names_in(downloads.path()).len(), 3);
}

/// A file added on another device is fetched now (the job's way: checked, put at its place,
/// recorded as here), then copied; the job has nothing left to do for it.
#[tokio::test]
async fn download_fetches_a_file_from_another_device_first() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    ready(&a);
    ready(&b);
    let t = a.task("Photos", None, None);
    let bytes = content(150_000, 102);
    let id = attach(&a, &t, "photo.jpg", &bytes);
    a.link(&server).await;
    a.sync().await;
    assert_eq!(files(&a).await.uploaded, 1);
    b.link(&server).await;
    b.sync().await;
    assert_eq!(state(&b, &id), "missing");
    let downloads = tempfile::tempdir().expect("downloads");

    let copy = save(&b, &id, downloads.path()).await.expect("copy");
    assert_eq!(copy, downloads.path().join("photo.jpg"));
    assert_eq!(fs::read(&copy).expect("copy"), bytes);
    assert_eq!(fs::read(stored(&b, &id)).expect("its own copy"), bytes);
    assert_eq!(state(&b, &id), "sent");
    assert_eq!(view(&b, &t, &id), AttachmentRemote::None);
    assert_eq!(names_in(downloads.path()), ["photo.jpg"]);
    #[cfg(target_os = "macos")]
    assert!(
        files::is_quarantined(&copy),
        "a file from the server stays marked as downloaded"
    );
    assert_eq!(files(&b).await, FilesReport::default());
}

/// Not on the server yet, or the server unreachable: a clear error, nothing in the Downloads
/// folder, the attachment still waiting for its file; it works once the file is there.
#[tokio::test]
async fn download_says_why_a_file_from_elsewhere_cannot_be_had() {
    let mut server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    ready(&a);
    ready(&b);
    let t = a.task("Plans", None, None);
    let bytes = content(30_000, 103);
    let id = attach(&a, &t, "plan.pdf", &bytes);
    a.link(&server).await;
    a.sync().await;
    b.link(&server).await;
    b.sync().await;
    let downloads = tempfile::tempdir().expect("downloads");

    // A has not sent the file yet.
    let error = save(&b, &id, downloads.path()).await.expect_err("404");
    assert_eq!(error.kind(), ErrorKind::FileNotOnServer);
    assert_eq!(state(&b, &id), "missing");

    assert_eq!(files(&a).await.uploaded, 1);
    server.stop().await;
    let error = save(&b, &id, downloads.path()).await.expect_err("offline");
    assert_eq!(error.kind(), ErrorKind::SyncOffline);
    assert_eq!(state(&b, &id), "missing");
    assert!(names_in(downloads.path()).is_empty());

    server.restart().await;
    let copy = save(&b, &id, downloads.path()).await.expect("copy");
    assert_eq!(fs::read(&copy).expect("copy"), bytes);
    assert_eq!(names_in(downloads.path()), ["plan.pdf"]);
}

/// An HTTP server that answers every request with `response`, then keeps the connection open
/// for `hold` (a stalled transfer). Plain threads: nothing else in the test runtime waits.
fn raw_server(response: &'static [u8], hold: Duration) -> String {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let url = format!("http://{}", listener.local_addr().expect("address"));
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else {
                return;
            };
            std::thread::spawn(move || {
                let (mut seen, mut buf) = (Vec::new(), [0u8; 4096]);
                while !seen.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => return,
                        Ok(n) => seen.extend_from_slice(&buf[..n]),
                    }
                }
                let _ = stream.write_all(response);
                let _ = stream.flush();
                std::thread::sleep(hold);
            });
        }
    });
    url
}

/// The device's link now points at `url` (same token).
fn point_at(device: &Device, url: &str) {
    let conn = device.conn();
    let mut link = store::link(&conn).expect("link").expect("linked");
    link.server_url = url.to_string();
    store::save_link(&conn, &link).expect("save link");
}

/// B has the row of a file A sent, not the file: what « Télécharger » needs to fetch.
async fn pulled_from_a(server: &Server, seed: u8) -> (Device, Device, String) {
    let (a, b) = (Device::new(), Device::new());
    ready(&a);
    ready(&b);
    let t = a.task("Plans", None, None);
    let id = attach(&a, &t, "plan.pdf", &content(30_000, seed));
    a.link(server).await;
    a.sync().await;
    assert_eq!(files(&a).await.uploaded, 1);
    b.link(server).await;
    b.sync().await;
    assert_eq!(state(&b, &id), "missing");
    (a, b, id)
}

/// Each stop says what happened: the token refused (reconnect), another error status, a
/// gateway error or a stalled transfer (unreachable), nothing written on this Mac.
#[tokio::test]
async fn download_says_why_the_server_did_not_give_the_file() {
    let server = Server::start().await;
    let (_a, b, id) = pulled_from_a(&server, 104).await;
    let downloads = tempfile::tempdir().expect("downloads");

    // The token refused: « reconnecte-toi », as the sync says.
    let link = store::link(&b.conn()).expect("link").expect("linked");
    store::save_link(
        &b.conn(),
        &store::Link {
            token: "jeton-revoque".into(),
            ..link.clone()
        },
    )
    .expect("bad token");
    let error = save(&b, &id, downloads.path()).await.expect_err("401");
    assert_eq!(error.kind(), ErrorKind::SyncAuth);
    store::save_link(&b.conn(), &link).expect("good token");

    point_at(
        &b,
        &raw_server(
            b"HTTP/1.1 500 Internal Server Error\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
            Duration::ZERO,
        ),
    );
    let error = save(&b, &id, downloads.path()).await.expect_err("500");
    assert_eq!(error.kind(), ErrorKind::SyncServer);

    point_at(
        &b,
        &raw_server(
            b"HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
            Duration::ZERO,
        ),
    );
    let error = save(&b, &id, downloads.path()).await.expect_err("503");
    assert_eq!(error.kind(), ErrorKind::SyncOffline);

    // Headers, a few bytes, then nothing: stopped after the idle timeout, not 30 minutes.
    point_at(
        &b,
        &raw_server(
            b"HTTP/1.1 200 OK\r\ncontent-length: 30000\r\n\r\nabc",
            Duration::from_secs(10),
        ),
    );
    let client = SyncClient::new().with_idle_timeout(Duration::from_millis(300));
    let started = std::time::Instant::now();
    let error = files::save_copy(&b.db, &client, &NoEvents, &id, downloads.path())
        .await
        .expect_err("stalled");
    assert_eq!(error.kind(), ErrorKind::SyncOffline);
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );

    assert_eq!(state(&b, &id), "missing");
    assert!(names_in(downloads.path()).is_empty());
}

/// Nothing can be written on this Mac: in the task's folder (`file_write_failed`), or in the
/// Downloads folder, which macOS may refuse (`downloads_denied`). A link is never followed.
#[cfg(unix)]
#[tokio::test]
async fn download_says_when_this_mac_cannot_write_the_file() {
    use std::os::unix::fs::PermissionsExt;
    let server = Server::start().await;
    let (_a, b, id) = pulled_from_a(&server, 105).await;
    let downloads = tempfile::tempdir().expect("downloads");
    let folder = stored(&b, &id).parent().expect("task folder").to_path_buf();
    fs::create_dir_all(&folder).expect("task folder");
    let read_only = fs::Permissions::from_mode(0o555);
    fs::set_permissions(&folder, read_only.clone()).expect("read-only");
    let error = save(&b, &id, downloads.path())
        .await
        .expect_err("cannot write");
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).expect("writable");
    assert_eq!(error.kind(), ErrorKind::FileWriteFailed);
    assert_eq!(state(&b, &id), "missing");

    fs::set_permissions(downloads.path(), read_only).expect("read-only");
    let error = save(&b, &id, downloads.path())
        .await
        .expect_err("downloads refused");
    fs::set_permissions(downloads.path(), fs::Permissions::from_mode(0o755)).expect("writable");
    assert_eq!(error.kind(), ErrorKind::DownloadsDenied);
    // The file did arrive in the task's folder; only the copy failed.
    assert_eq!(state(&b, &id), "sent");
    assert!(names_in(downloads.path()).is_empty());
    let copy = save(&b, &id, downloads.path()).await.expect("copy");
    assert_eq!(copy, downloads.path().join("plan.pdf"));

    // Unlinked, a link put at the attachment's place is not its file.
    let a = Device::new();
    ready(&a);
    let t = a.task("Liens", None, None);
    let own = attach(&a, &t, "notes.txt", b"mes notes");
    let place = stored(&a, &own);
    let elsewhere = a.docs.path().join("ailleurs.txt");
    fs::write(&elsewhere, b"autre chose").expect("other file");
    fs::remove_file(&place).expect("remove");
    std::os::unix::fs::symlink(&elsewhere, &place).expect("symlink");
    let error = save(&a, &own, downloads.path()).await.expect_err("a link");
    assert_eq!(error.kind(), ErrorKind::FileNotHere);
}
