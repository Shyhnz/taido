//! The file job (V2.7 bis, `sync::files`) against the fake server's file store: a chunk
//! refused for its offset (another device uploading the same file) resumes from the status;
//! a file changed before it was ever sent is hashed again, its new hash goes out, then the
//! file.

use std::fs;

use super::fake::FakeServer;
use super::*;
use crate::db::attachments::{self, sha256_bytes};
use crate::db::test_support::task;
use crate::db::workspace;
use crate::sync::files::{self, FileOptions, FilesReport};

const CHUNK: usize = 64 * 1024;

async fn linked() -> (FakeServer, Mac) {
    let server = FakeServer::start().await;
    let mac = Mac::new();
    workspace::ensure(&mac.conn(), mac.docs.path()).expect("app folder");
    mac.link(&server).await;
    mac.sync().await;
    (server, mac)
}

/// Attaches `bytes` as `name` to a new task; returns (attachment id, its stored path).
fn attach(mac: &Mac, name: &str, bytes: &[u8]) -> (String, std::path::PathBuf) {
    let original = mac.docs.path().join(name);
    fs::write(&original, bytes).expect("original");
    let conn = mac.conn();
    let t = task(&conn, "T", None, None);
    attachments::add_files(
        &conn,
        attachments::AttachmentOwner::Task(&t),
        &[original.to_string_lossy().into_owned()],
    )
    .expect("attach");
    let a = attachments::list(&conn, &t).expect("list").remove(0);
    (a.id, a.path.into())
}

async fn files(mac: &Mac) -> FilesReport {
    files::run(
        &mac.db,
        &mac.client,
        &QuietEvents,
        FileOptions { chunk_bytes: CHUNK },
    )
    .await
}

fn bytes(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i * 7 % 251) as u8).collect()
}

#[tokio::test]
async fn a_chunk_refused_for_its_offset_resumes_from_the_status() {
    let (server, mac) = linked().await;
    let content = bytes(200_000);
    let (id, _) = attach(&mac, "plan.pdf", &content);
    mac.sync().await;
    // Another device sends the first 50 000 bytes right after this Mac read the status.
    server.state().racing = Some((
        id.clone(),
        200_000,
        sha256_bytes(&content),
        content[..50_000].to_vec(),
    ));
    let report = files(&mac).await;
    assert_eq!(report.uploaded, 1);
    assert_eq!(report.sent_bytes, 150_000, "resumed after the 409");
    let s = server.state();
    let file = s.files.get(&id).expect("stored");
    assert!(file.complete);
    assert_eq!(file.bytes, content);
    assert_eq!(
        s.file_requests[..3],
        [
            format!("status {id}"),
            format!("put {id} 0 0"),
            format!("status {id}")
        ],
        "the empty first chunk got a 409, then the status was read again"
    );
    assert_eq!(s.file_requests[3], format!("put {id} 50000 {CHUNK}"));
}

/// A copy edited here before its file was ever sent (same size or not) is the only content of
/// its attachment: nothing of the old content goes; the copy is hashed again once, its new
/// hash and size go out with the next sync, then the file, and nothing more after that.
/// (Once sent, an edited copy is never sent: see files_e2e_tests.)
#[tokio::test]
async fn a_copy_edited_before_it_was_sent_goes_out_with_its_new_hash() {
    let (server, mac) = linked().await;
    let first = bytes(100_000);
    let (id, path) = attach(&mac, "notes.txt", &first);
    let (id2, path2) = attach(&mac, "journal.txt", &first);
    mac.sync().await;
    let mut edited = first.clone();
    edited[10] ^= 0xff;
    fs::write(&path, &edited).expect("edit");
    let longer = bytes(120_000);
    fs::write(&path2, &longer).expect("grow");

    let report = files(&mac).await;
    assert_eq!((report.uploaded, report.sent_bytes), (0, 0));
    for (id, content) in [(&id, &edited), (&id2, &longer)] {
        assert_eq!(
            mac.text(&format!(
                "SELECT remote || '|' || size || '|' || sha256 FROM attachments \
                 WHERE id = '{id}'"
            )),
            Some(format!("local|{}|{}", content.len(), sha256_bytes(content))),
            "the new content is the attachment's"
        );
        assert!(mac.outbox_has("attachment", id), "pushed by the next sync");
    }
    assert_eq!(fs::read(&path).expect("edited copy"), edited, "untouched");
    assert_eq!(fs::read(&path2).expect("grown copy"), longer, "untouched");

    mac.sync().await;
    let report = files(&mac).await;
    assert_eq!(
        (report.uploaded, report.sent_bytes),
        (2, (edited.len() + longer.len()) as u64)
    );
    for (id, content) in [(&id, &edited), (&id2, &longer)] {
        let s = server.state();
        let file = s.files.get(id.as_str()).expect("stored");
        assert!(file.complete);
        assert_eq!(&file.bytes, content);
    }
    mac.sync().await;
    assert_eq!(files(&mac).await, FilesReport::default(), "once");
}

/// A pulled hash that differs from the local one: the copy here is not that file any more
/// (a file's content never changes once sent): the attachment is `missing` and its real file
/// will be fetched next to the copy.
#[tokio::test]
async fn a_pulled_hash_that_differs_marks_the_attachment_missing() {
    let (server, mac) = linked().await;
    let first = bytes(1_000);
    let (id, path) = attach(&mac, "plan.txt", &first);
    mac.sync().await;
    mac.conn()
        .execute(
            "UPDATE attachments SET remote = 'sent' WHERE id = ?1",
            [&id],
        )
        .expect("as if sent");
    let Some(mut change) = server.get(sync_proto::Entity::Attachment, &id) else {
        panic!("attachment pushed");
    };
    let other = "a".repeat(64);
    if let Change::Attachment(Versioned { data: Some(d), .. }) = &mut change {
        d.sha256 = Some(other.clone());
    }
    change.set_device_id("");
    if let Change::Attachment(v) = &mut change {
        v.updated_at = "2099-01-01T00:00:00.000Z".into();
    }
    server.put(change);
    mac.sync().await;
    assert_eq!(
        mac.text(&format!(
            "SELECT remote || '|' || sha256 FROM attachments WHERE id = '{id}'"
        )),
        Some(format!("missing|{other}"))
    );
    assert_eq!(fs::read(&path).expect("copy"), first, "never touched");
}

/// What a transfer learnt is recorded only while the link it started with is still there: an
/// unlink during an upload leaves the attachment as it was.
#[tokio::test]
async fn an_unlink_during_a_transfer_records_nothing() {
    let (server, mac) = linked().await;
    let (id, _) = attach(&mac, "devis.pdf", &bytes(30_000));
    mac.sync().await;
    let db = std::sync::Arc::clone(&mac.db);
    server.state().during_files = Some(Box::new(move || {
        db.lock()
            .expect("db")
            .execute("DELETE FROM settings WHERE key = 'sync_token'", [])
            .expect("unlink");
    }));
    files(&mac).await;
    assert!(
        server.state().files.get(&id).is_some_and(|f| f.complete),
        "the transfer itself went through"
    );
    assert_eq!(
        mac.text(&format!("SELECT remote FROM attachments WHERE id = '{id}'"))
            .as_deref(),
        Some("local"),
        "nothing recorded for the old link"
    );
}
