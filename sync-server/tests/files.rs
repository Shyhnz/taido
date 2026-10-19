//! Attachment files: chunked upload resumed from the
//! status route, SHA-256 check, per-file limit and account quota, download with `Range` and
//! security headers, one account never reads another's file, deletion through the sync. A real
//! server on 127.0.0.1:<random port> (`start_for_tests`); small limits are set with
//! `TestServer::set_file_limits` so that no test writes 100 MB.

mod common;

use std::path::Path;

use common::{post_json, request, request_with_headers, Reply};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sync_proto::MAX_CHUNK_BYTES;
use taido_sync_server::{start_for_tests, TestServer};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

const PASSWORD: &str = "un mot de passe solide";
const AT: &str = "2026-10-10T09:00:00.000Z";
const LATER: &str = "2026-10-10T10:00:00.000Z";
const EARLIER: &str = "2026-10-10T08:00:00.000Z";

/// One logged-in device of an account.
struct Client {
    base: String,
    token: String,
    account_id: String,
}

async fn account(server: &TestServer, email: &str) -> Client {
    let account_id = server.create_account(email, PASSWORD).expect("account");
    let r = post_json(
        &server.base_url,
        "/api/login",
        None,
        &json!({"protocol": 3, "email": email, "password": PASSWORD, "device_name": "Mac"}),
    )
    .await;
    assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
    Client {
        base: server.base_url.clone(),
        token: r.json()["token"].as_str().expect("token").to_string(),
        account_id,
    }
}

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `len` bytes that differ with `seed`.
fn content(len: usize, seed: u8) -> Vec<u8> {
    (0..len)
        .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
        .collect()
}

fn attachment(id: &str, at: &str, name: &str, size: usize, deleted_at: Option<&str>) -> Value {
    json!({
        "entity": "attachment", "id": id, "updated_at": at, "device_id": "",
        "data": {"task_id": "t1", "file_name": name, "mime_type": "application/pdf",
                 "size": size, "created_at": AT, "deleted_at": deleted_at}
    })
}

fn tombstone(id: &str, at: &str) -> Value {
    json!({"entity": "attachment", "id": id, "updated_at": at, "device_id": "", "data": null})
}

/// `(received, size, complete)` of a 200 status answer.
fn status_of(r: &Reply) -> (u64, u64, bool) {
    assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
    let v = r.json();
    assert_eq!(v["protocol"], json!(3));
    (
        v["received"].as_u64().expect("received"),
        v["size"].as_u64().expect("size"),
        v["complete"].as_bool().expect("complete"),
    )
}

fn assert_error(r: &Reply, status: u16, code: &str) {
    assert_eq!(
        (r.status, r.error().as_str()),
        (status, code),
        "{}",
        String::from_utf8_lossy(&r.body)
    );
}

impl Client {
    async fn sync(&self, changes: Vec<Value>) -> Value {
        let r = post_json(
            &self.base,
            "/api/sync",
            Some(&self.token),
            &json!({"protocol": 3, "cursor": 0, "changes": changes}),
        )
        .await;
        assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
        r.json()
    }

    async fn put(&self, id: &str, offset: usize, size: usize, sha256: &str, body: &[u8]) -> Reply {
        request(
            &self.base,
            "PUT",
            &format!("/api/files/{id}?offset={offset}&size={size}&sha256={sha256}"),
            Some(&self.token),
            body,
        )
        .await
    }

    async fn status(&self, id: &str) -> Reply {
        request(
            &self.base,
            "GET",
            &format!("/api/files/{id}/status"),
            Some(&self.token),
            b"",
        )
        .await
    }

    async fn download(&self, id: &str, range: Option<&str>) -> Reply {
        let headers: Vec<(&str, &str)> = range.map(|r| ("Range", r)).into_iter().collect();
        request_with_headers(
            &self.base,
            "GET",
            &format!("/api/files/{id}"),
            Some(&self.token),
            &headers,
            b"",
        )
        .await
    }

    /// Uploads `data` in chunks of `chunk` bytes; returns the last status.
    async fn upload(&self, id: &str, data: &[u8], chunk: usize) -> (u64, u64, bool) {
        let hash = sha(data);
        let mut offset = 0;
        loop {
            let end = (offset + chunk).min(data.len());
            let r = self
                .put(id, offset, data.len(), &hash, &data[offset..end])
                .await;
            offset = end;
            if offset == data.len() {
                return status_of(&r);
            }
            status_of(&r);
        }
    }

    /// Sends the head of a chunk upload and only `sent` bytes of its body, then hangs up.
    async fn cut_upload(&self, id: &str, offset: usize, size: usize, hash: &str, chunk: &[u8]) {
        let host = self.base.trim_start_matches("http://");
        let mut stream = TcpStream::connect(host).await.expect("connect");
        let head = format!(
            "PUT /api/files/{id}?offset={offset}&size={size}&sha256={hash} HTTP/1.1\r\n\
             Host: {host}\r\nAuthorization: Bearer {}\r\nContent-Length: {}\r\n\r\n",
            self.token,
            chunk.len()
        );
        stream.write_all(head.as_bytes()).await.expect("head");
        stream
            .write_all(&chunk[..chunk.len() / 2])
            .await
            .expect("half");
        stream.flush().await.expect("flush");
        drop(stream);
    }
}

/// Names of the entries of the account's file directory (none when it does not exist).
fn stored_names(dir: &Path, account_id: &str) -> Vec<String> {
    let mut names: Vec<String> = match std::fs::read_dir(dir.join("files").join(account_id)) {
        Ok(entries) => entries
            .map(|e| e.expect("entry").file_name().to_string_lossy().to_string())
            .collect(),
        Err(_) => Vec::new(),
    };
    names.sort();
    names
}

fn files_rows(server: &TestServer) -> i64 {
    let conn = server.state().store.lock().expect("lock");
    conn.query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0))
        .expect("count")
}

#[tokio::test]
async fn upload_in_three_chunks_resumes_after_a_cut_and_a_restart() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    let mut a = account(&server, "user@example.com").await;
    let data = content(30_000, 1);
    let hash = sha(&data);
    let len = data.len();
    a.sync(vec![attachment("a1", AT, "photo.jpg", len, None)])
        .await;
    assert_eq!(status_of(&a.status("a1").await), (0, 30_000, false));

    let r = a.put("a1", 0, len, &hash, &data[..10_000]).await;
    assert_eq!(status_of(&r), (10_000, 30_000, false));
    let r = a.put("a1", 10_000, len, &hash, &data[10_000..20_000]).await;
    assert_eq!(status_of(&r), (20_000, 30_000, false));

    // The connection drops in the middle of the third chunk: none of it is kept.
    a.cut_upload("a1", 20_000, len, &hash, &data[20_000..])
        .await;
    assert_eq!(status_of(&a.status("a1").await), (20_000, 30_000, false));

    // The server restarts: the bytes received survive.
    server.stop().await;
    let server = start_for_tests(dir.path()).await.expect("restart");
    a.base = server.base_url.clone();
    assert_eq!(status_of(&a.status("a1").await), (20_000, 30_000, false));

    // Resume from the status.
    let r = a.put("a1", 20_000, len, &hash, &data[20_000..]).await;
    assert_eq!(status_of(&r), (30_000, 30_000, true));
    assert_eq!(status_of(&a.status("a1").await), (30_000, 30_000, true));
    let r = a.download("a1", None).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, data);
    assert_eq!(sha(&r.body), hash);
    // Stored under a name derived from the account and the attachment, no partial file left.
    let stored = server.state().files.file_path(&a.account_id, "a1");
    assert_eq!(
        stored_names(dir.path(), &a.account_id),
        [stored
            .file_name()
            .expect("name")
            .to_string_lossy()
            .to_string()]
    );
    assert_eq!(std::fs::read(stored).expect("stored"), data);
}

#[tokio::test]
async fn a_chunk_at_the_wrong_offset_is_409() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    let a = account(&server, "user@example.com").await;
    let data = content(3_000, 2);
    let hash = sha(&data);
    a.sync(vec![attachment("a1", AT, "doc.pdf", 3_000, None)])
        .await;
    assert_eq!(
        status_of(&a.put("a1", 0, 3_000, &hash, &data[..1_000]).await),
        (1_000, 3_000, false)
    );
    // The same chunk again (a retry after a lost answer), or one too far.
    assert_error(
        &a.put("a1", 0, 3_000, &hash, &data[..1_000]).await,
        409,
        "chunk_offset",
    );
    assert_error(
        &a.put("a1", 2_000, 3_000, &hash, &data[2_000..]).await,
        409,
        "chunk_offset",
    );
    assert_eq!(status_of(&a.status("a1").await), (1_000, 3_000, false));

    // Once complete, the last chunk again is a 409 and an empty chunk at the end is a no-op.
    assert_eq!(
        status_of(&a.put("a1", 1_000, 3_000, &hash, &data[1_000..]).await),
        (3_000, 3_000, true)
    );
    assert_error(
        &a.put("a1", 1_000, 3_000, &hash, &data[1_000..]).await,
        409,
        "chunk_offset",
    );
    assert_eq!(
        status_of(&a.put("a1", 3_000, 3_000, &hash, b"").await),
        (3_000, 3_000, true)
    );
}

#[tokio::test]
async fn a_file_above_the_limit_is_413() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    server.set_file_limits(1_000, 1_000_000);
    let a = account(&server, "user@example.com").await;
    a.sync(vec![attachment("big", AT, "film.mov", 1_001, None)])
        .await;
    let data = content(1_001, 3);
    assert_error(
        &a.put("big", 0, 1_001, &sha(&data), &data[..10]).await,
        413,
        "file_too_large",
    );
    assert_eq!(status_of(&a.status("big").await), (0, 1_001, false));
    assert!(stored_names(dir.path(), &a.account_id).is_empty());
    assert_eq!(files_rows(&server), 0);
    // Exactly at the limit is fine.
    a.sync(vec![attachment("ok", AT, "film.mov", 1_000, None)])
        .await;
    assert_eq!(
        a.upload("ok", &content(1_000, 3), 400).await,
        (1_000, 1_000, true)
    );
}

#[tokio::test]
async fn a_chunk_body_above_8_mib_is_413_and_8_mib_is_accepted() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    let a = account(&server, "user@example.com").await;
    let size = MAX_CHUNK_BYTES + 5;
    a.sync(vec![attachment("a1", AT, "gros.bin", size, None)])
        .await;
    let data = content(size, 4);
    let hash = sha(&data);
    let r = request(
        &a.base,
        "PUT",
        &format!("/api/files/a1?offset=0&size={size}&sha256={hash}"),
        Some(&a.token),
        &vec![0u8; MAX_CHUNK_BYTES + 1],
    )
    .await;
    assert_error(&r, 413, "payload_too_large");
    assert_eq!(status_of(&a.status("a1").await), (0, size as u64, false));
    assert_eq!(
        status_of(&a.put("a1", 0, size, &hash, &data[..MAX_CHUNK_BYTES]).await),
        (MAX_CHUNK_BYTES as u64, size as u64, false)
    );
    assert_eq!(
        status_of(
            &a.put("a1", MAX_CHUNK_BYTES, size, &hash, &data[MAX_CHUNK_BYTES..])
                .await
        ),
        (size as u64, size as u64, true)
    );
}

#[tokio::test]
async fn any_account_gets_server_file_limit() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    let a = account(&server, "user@example.com").await;
    // A brand-new account takes 6 MiB: there is no 5 MiB plan limit any more.
    let size = 6 * 1024 * 1024;
    a.sync(vec![attachment("a1", AT, "gros.bin", size, None)])
        .await;
    let data = content(size, 1);
    assert_eq!(
        status_of(&a.put("a1", 0, size, &sha(&data), &data).await),
        (size as u64, size as u64, true)
    );
}

#[tokio::test]
async fn the_quota_counts_complete_and_started_files() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    server.set_file_limits(10_000, 3_000);
    let a = account(&server, "user@example.com").await;
    a.sync(vec![
        attachment("a1", AT, "1.pdf", 2_000, None),
        attachment("a2", AT, "2.pdf", 1_000, None),
        attachment("a3", AT, "3.pdf", 1, None),
        attachment("a4", AT, "4.pdf", 100, None),
    ])
    .await;
    assert_eq!(
        a.upload("a1", &content(2_000, 5), 1_000).await,
        (2_000, 2_000, true)
    );
    // 2 000 + 1 000 = the quota: accepted, even before all its bytes are in.
    let a2 = content(1_000, 6);
    assert_eq!(
        status_of(&a.put("a2", 0, 1_000, &sha(&a2), &a2[..10]).await),
        (10, 1_000, false)
    );
    let one = content(1, 7);
    assert_error(
        &a.put("a3", 0, 1, &sha(&one), &one).await,
        507,
        "quota_exceeded",
    );
    // Restarting a2 smaller frees room (its old size is not counted twice).
    let a2 = content(900, 8);
    assert_eq!(
        status_of(&a.put("a2", 0, 900, &sha(&a2), &a2[..10]).await),
        (10, 900, false)
    );
    let hundred = content(100, 9);
    assert_eq!(
        status_of(&a.put("a4", 0, 100, &sha(&hundred), &hundred).await),
        (100, 100, true)
    );
    assert_error(
        &a.put("a3", 0, 1, &sha(&one), &one).await,
        507,
        "quota_exceeded",
    );
    // Deleting a1 frees its 2 000 bytes.
    a.sync(vec![attachment("a1", LATER, "1.pdf", 2_000, Some(LATER))])
        .await;
    assert_eq!(
        status_of(&a.put("a3", 0, 1, &sha(&one), &one).await),
        (1, 1, true)
    );
}

#[tokio::test]
async fn a_wrong_hash_is_400_and_nothing_is_kept() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    let a = account(&server, "user@example.com").await;
    let data = content(5_000, 10);
    let wrong = sha(b"something else");
    a.sync(vec![attachment("a1", AT, "doc.pdf", 5_000, None)])
        .await;
    assert_eq!(
        status_of(&a.put("a1", 0, 5_000, &wrong, &data[..2_500]).await),
        (2_500, 5_000, false)
    );
    assert_error(
        &a.put("a1", 2_500, 5_000, &wrong, &data[2_500..]).await,
        400,
        "hash_mismatch",
    );
    assert_eq!(status_of(&a.status("a1").await), (0, 5_000, false));
    assert_error(&a.download("a1", None).await, 404, "not_found");
    assert!(stored_names(dir.path(), &a.account_id).is_empty());
    assert_eq!(files_rows(&server), 0);
    // The right hash then works.
    assert_eq!(a.upload("a1", &data, 2_500).await, (5_000, 5_000, true));
}

#[tokio::test]
async fn a_new_hash_or_size_starts_again_from_zero() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    let a = account(&server, "user@example.com").await;
    let first = content(300, 11);
    let second = content(300, 12);
    a.sync(vec![attachment("a1", AT, "doc.pdf", 300, None)])
        .await;
    assert_eq!(
        status_of(&a.put("a1", 0, 300, &sha(&first), &first[..100]).await),
        (100, 300, false)
    );
    // Another content: the upload in progress is dropped, the client must start at 0.
    assert_error(
        &a.put("a1", 100, 300, &sha(&second), &second[100..200])
            .await,
        409,
        "chunk_offset",
    );
    assert_eq!(status_of(&a.status("a1").await), (0, 300, false));
    assert_eq!(a.upload("a1", &second, 120).await, (300, 300, true));
    assert_eq!(a.download("a1", None).await.body, second);
    // A complete file is replaced the same way.
    assert_eq!(a.upload("a1", &first, 300).await, (300, 300, true));
    assert_eq!(a.download("a1", None).await.body, first);
}

#[tokio::test]
async fn an_account_never_reads_another_accounts_file() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    let a = account(&server, "user@example.com").await;
    let b = account(&server, "other@example.com").await;
    let x = content(2_000, 13);
    let y = content(1_500, 14);
    // The same attachment id in both accounts.
    a.sync(vec![
        attachment("same-id", AT, "photo.jpg", 2_000, None),
        attachment("a-only", AT, "photo.jpg", 2_000, None),
    ])
    .await;
    b.sync(vec![attachment("same-id", AT, "photo.jpg", 1_500, None)])
        .await;
    assert_eq!(a.upload("same-id", &x, 2_000).await, (2_000, 2_000, true));

    assert_eq!(status_of(&b.status("same-id").await), (0, 1_500, false));
    assert_error(&b.download("same-id", None).await, 404, "not_found");
    assert_error(
        &b.put("same-id", 2_000, 2_000, &sha(&x), b"").await,
        409,
        "chunk_offset",
    );
    assert_eq!(b.upload("same-id", &y, 700).await, (1_500, 1_500, true));
    assert_eq!(a.download("same-id", None).await.body, x);
    assert_eq!(b.download("same-id", None).await.body, y);

    // An attachment of A only does not exist for B.
    assert_error(&b.status("a-only").await, 404, "not_found");
    assert_error(&b.download("a-only", None).await, 404, "not_found");
    assert_error(
        &b.put("a-only", 0, 2_000, &sha(&x), &x[..10]).await,
        404,
        "not_found",
    );
    assert_ne!(
        server.state().files.file_path(&a.account_id, "same-id"),
        server.state().files.file_path(&b.account_id, "same-id")
    );
}

#[tokio::test]
async fn unknown_deleted_or_non_attachment_ids_are_404() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    let a = account(&server, "user@example.com").await;
    a.sync(vec![
        attachment("gone", AT, "doc.pdf", 10, Some(AT)),
        tombstone("buried", AT),
        json!({"entity": "task", "id": "t1", "updated_at": AT, "device_id": "",
               "data": {"subject_id": null, "section_id": null, "parent_id": null,
                        "title": "x", "description": "", "due_date": null, "due_time": null,
                        "priority": 1, "completed_at": null, "position": 1.0,
                        "created_at": AT, "deleted_at": null}}),
    ])
    .await;
    let data = content(10, 15);
    for id in ["nope", "gone", "buried", "t1"] {
        assert_error(&a.status(id).await, 404, "not_found");
        assert_error(&a.download(id, None).await, 404, "not_found");
        assert_error(
            &a.put(id, 0, 10, &sha(&data), &data).await,
            404,
            "not_found",
        );
    }
    assert!(stored_names(dir.path(), &a.account_id).is_empty());
}

#[tokio::test]
async fn deleting_an_attachment_removes_its_file_only() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    let a = account(&server, "user@example.com").await;
    let b = account(&server, "other@example.com").await;
    let one = content(1_000, 16);
    let two = content(1_200, 17);
    let three = content(900, 18);
    a.sync(vec![
        attachment("a1", AT, "photo.jpg", 1_000, None),
        attachment("a2", AT, "photo.jpg", 1_200, None),
        attachment("a3", AT, "photo.jpg", 900, None),
    ])
    .await;
    b.sync(vec![attachment("a1", AT, "photo.jpg", 1_000, None)])
        .await;
    assert_eq!(a.upload("a1", &one, 1_000).await, (1_000, 1_000, true));
    assert_eq!(a.upload("a2", &two, 1_200).await, (1_200, 1_200, true));
    assert_eq!(
        status_of(&a.put("a3", 0, 900, &sha(&three), &three[..300]).await),
        (300, 900, false)
    );
    assert_eq!(b.upload("a1", &one, 1_000).await, (1_000, 1_000, true));
    assert_eq!(stored_names(dir.path(), &a.account_id).len(), 3);

    // An older deletion loses: nothing is removed.
    let r = a
        .sync(vec![attachment(
            "a2",
            EARLIER,
            "photo.jpg",
            1_200,
            Some(EARLIER),
        )])
        .await;
    assert_eq!(r["accepted"], json!(0));
    assert_eq!(a.download("a2", None).await.body, two);

    // Soft delete of a1, tombstone of a3 (upload in progress).
    let r = a
        .sync(vec![
            attachment("a1", LATER, "photo.jpg", 1_000, Some(LATER)),
            tombstone("a3", LATER),
        ])
        .await;
    assert_eq!(r["accepted"], json!(2));
    for id in ["a1", "a3"] {
        assert_error(&a.status(id).await, 404, "not_found");
        assert_error(&a.download(id, None).await, 404, "not_found");
    }
    let a2_name = server
        .state()
        .files
        .file_path(&a.account_id, "a2")
        .file_name()
        .expect("name")
        .to_string_lossy()
        .to_string();
    assert_eq!(stored_names(dir.path(), &a.account_id), [a2_name]);
    assert_eq!(a.download("a2", None).await.body, two);
    // The other account's attachment with the same id keeps its file.
    assert_eq!(b.download("a1", None).await.body, one);
    assert_eq!(files_rows(&server), 2);
}

fn note_attachment(id: &str, at: &str, size: usize, deleted_at: Option<&str>) -> Value {
    json!({
        "entity": "note_attachment", "id": id, "updated_at": at, "device_id": "",
        "data": {"note_page_id": "p1", "file_name": "capture.png", "mime_type": "image/png",
                 "size": size, "created_at": AT, "deleted_at": deleted_at}
    })
}

#[tokio::test]
async fn file_upload_allowed_for_live_note_attachment() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    let a = account(&server, "user@example.com").await;
    let data = content(3_000, 21);
    let r = a.sync(vec![note_attachment("img", AT, 3_000, None)]).await;
    assert_eq!(r["accepted"], json!(1));
    assert_eq!(status_of(&a.status("img").await), (0, 3_000, false));
    assert_eq!(a.upload("img", &data, 1_000).await, (3_000, 3_000, true));
    let got = a.download("img", None).await;
    assert_eq!(got.status, 200);
    assert_eq!(got.body, data);

    // Its page image deleted (soft): the file goes, like an attachment's.
    let r = a
        .sync(vec![note_attachment("img", LATER, 3_000, Some(LATER))])
        .await;
    assert_eq!(r["accepted"], json!(1));
    assert_error(&a.status("img").await, 404, "not_found");
    assert_error(&a.download("img", None).await, 404, "not_found");
    assert!(stored_names(dir.path(), &a.account_id).is_empty());
    assert_eq!(files_rows(&server), 0);

    // A tombstone too.
    a.sync(vec![note_attachment("img2", AT, 10, None)]).await;
    let small = content(10, 22);
    assert_eq!(a.upload("img2", &small, 10).await, (10, 10, true));
    a.sync(vec![
        json!({"entity": "note_attachment", "id": "img2", "updated_at": LATER,
        "device_id": "", "data": null}),
    ])
    .await;
    assert_error(&a.status("img2").await, 404, "not_found");
    assert!(stored_names(dir.path(), &a.account_id).is_empty());
}

#[tokio::test]
async fn single_ranges_are_served() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    let a = account(&server, "user@example.com").await;
    let data = content(1_000, 19);
    a.sync(vec![attachment("a1", AT, "doc.pdf", 1_000, None)])
        .await;
    a.upload("a1", &data, 1_000).await;

    let r = a.download("a1", Some("bytes=10-19")).await;
    assert_eq!(r.status, 206);
    assert_eq!(r.headers["content-range"], "bytes 10-19/1000");
    assert_eq!(r.headers["content-length"], "10");
    assert_eq!(r.body, &data[10..20]);
    assert_eq!(r.headers["content-type"], "application/octet-stream");
    assert_eq!(r.headers["content-security-policy"], "sandbox");

    let r = a.download("a1", Some("bytes=990-")).await;
    assert_eq!(r.status, 206);
    assert_eq!(r.body, &data[990..]);
    let r = a.download("a1", Some("bytes=-5")).await;
    assert_eq!(r.status, 206);
    assert_eq!(r.body, &data[995..]);

    let r = a.download("a1", Some("bytes=1000-")).await;
    assert_eq!(r.status, 416);
    assert_eq!(r.headers["content-range"], "bytes */1000");

    // Several ranges: the whole file.
    let r = a.download("a1", Some("bytes=0-1,4-5")).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, data);
}

#[tokio::test]
async fn downloads_are_never_rendered_by_a_browser() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    let a = account(&server, "user@example.com").await;
    let html = b"<script>alert(document.cookie)</script>".to_vec();
    let mut row = attachment("a1", AT, "Été \"rapport\" 2026.html", html.len(), None);
    row["data"]["mime_type"] = json!("text/html");
    a.sync(vec![row]).await;
    a.upload("a1", &html, 100).await;

    let r = a.download("a1", None).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, html);
    assert_eq!(r.headers["content-type"], "application/octet-stream");
    assert_eq!(
        r.headers["content-disposition"],
        "attachment; filename=\"_t_ _rapport_ 2026.html\"; \
         filename*=UTF-8''%C3%89t%C3%A9%20%22rapport%22%202026.html"
    );
    assert_eq!(r.headers["x-content-type-options"], "nosniff");
    assert_eq!(r.headers["content-security-policy"], "sandbox");
    assert_eq!(r.headers["cache-control"], "private, no-store");
    assert_eq!(r.headers["accept-ranges"], "bytes");
    assert_eq!(r.headers["content-length"], html.len().to_string());

    // The status route is ordinary API JSON.
    let r = a.status("a1").await;
    assert_eq!(r.headers["content-type"], "application/json");
    assert_eq!(r.headers["cache-control"], "no-store");
}

#[tokio::test]
async fn an_empty_file_completes_with_one_empty_chunk() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    let a = account(&server, "user@example.com").await;
    a.sync(vec![attachment("a1", AT, "vide.txt", 0, None)])
        .await;
    assert_eq!(
        status_of(&a.put("a1", 0, 0, &sha(b""), b"").await),
        (0, 0, true)
    );
    let r = a.download("a1", None).await;
    assert_eq!(r.status, 200);
    assert!(r.body.is_empty());
    assert_eq!(r.headers["content-length"], "0");
}

#[tokio::test]
async fn malformed_requests_are_400_and_anonymous_ones_401() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    let a = account(&server, "user@example.com").await;
    let data = content(10, 20);
    let hash = sha(&data);
    a.sync(vec![attachment("a1", AT, "doc.pdf", 10, None)])
        .await;

    for query in [
        "offset=0&size=10".to_string(),
        format!("offset=0&sha256={hash}"),
        format!("size=10&sha256={hash}"),
        format!("offset=x&size=10&sha256={hash}"),
        format!("offset=0&size=-1&sha256={hash}"),
        format!("offset=0&size=10&sha256={}", hash.to_uppercase()),
        format!("offset=0&size=10&sha256={}", &hash[..63]),
        format!("offset=0&offset=0&size=10&sha256={hash}"),
    ] {
        let r = request(
            &a.base,
            "PUT",
            &format!("/api/files/a1?{query}"),
            Some(&a.token),
            &data,
        )
        .await;
        assert_error(&r, 400, "bad_request");
    }
    // A chunk past the declared size.
    assert_error(
        &a.put("a1", 0, 10, &hash, &content(11, 20)).await,
        400,
        "bad_request",
    );
    assert_eq!(status_of(&a.status("a1").await), (0, 10, false));

    for (method, path) in [
        (
            "PUT",
            format!("/api/files/a1?offset=0&size=10&sha256={hash}"),
        ),
        ("GET", "/api/files/a1".to_string()),
        ("GET", "/api/files/a1/status".to_string()),
    ] {
        let r = request(&a.base, method, &path, None, b"").await;
        assert_error(&r, 401, "unauthorized");
        let r = request(&a.base, method, &path, Some("unknown-token"), b"").await;
        assert_error(&r, 401, "unauthorized");
    }
}

/// An attachment row that names its file's hash.
fn hashed(id: &str, at: &str, data: &[u8]) -> Value {
    let mut row = attachment(id, at, "doc.pdf", data.len(), None);
    row["data"]["sha256"] = json!(sha(data));
    row
}

#[tokio::test]
async fn a_complete_file_gone_from_the_disk_is_received_0_and_sent_again() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    let a = account(&server, "user@example.com").await;
    let data = content(500, 30);
    a.sync(vec![hashed("a1", AT, &data)]).await;
    assert_eq!(a.upload("a1", &data, 500).await, (500, 500, true));
    std::fs::remove_file(server.state().files.file_path(&a.account_id, "a1")).expect("rm");

    // Never « complete » for a file the server cannot serve: the row is dropped.
    assert_error(&a.download("a1", None).await, 404, "not_found");
    assert_eq!(status_of(&a.status("a1").await), (0, 500, false));
    assert_eq!(files_rows(&server), 0);
    assert_eq!(a.upload("a1", &data, 200).await, (500, 500, true));
    assert_eq!(a.download("a1", None).await.body, data);
}

#[tokio::test]
async fn a_file_whose_hash_is_not_the_attachments_is_dropped() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    let a = account(&server, "user@example.com").await;
    let first = content(400, 31);
    let second = content(400, 32);
    a.sync(vec![hashed("a1", AT, &first)]).await;
    assert_eq!(a.upload("a1", &first, 400).await, (400, 400, true));
    // An upload of another content than the attachment's is refused, the file stays.
    assert_error(
        &a.put("a1", 0, 400, &sha(&second), &second).await,
        400,
        "bad_request",
    );
    assert_eq!(a.download("a1", None).await.body, first);

    // The attachment now names another content (a copy that was never sent, edited).
    a.sync(vec![hashed("a1", LATER, &second)]).await;
    assert_eq!(status_of(&a.status("a1").await), (0, 400, false));
    assert_error(&a.download("a1", None).await, 404, "not_found");
    assert!(stored_names(dir.path(), &a.account_id).is_empty());
    assert_error(
        &a.put("a1", 0, 400, &sha(&first), &first).await,
        400,
        "bad_request",
    );
    assert_eq!(a.upload("a1", &second, 150).await, (400, 400, true));
    assert_eq!(a.download("a1", None).await.body, second);
}

#[tokio::test]
async fn a_complete_file_is_replaced_only_by_a_valid_first_chunk() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    let a = account(&server, "user@example.com").await;
    let first = content(300, 33);
    let second = content(300, 34);
    // A row without a hash (an older client): any content may replace the file.
    a.sync(vec![attachment("a1", AT, "doc.pdf", 300, None)])
        .await;
    assert_eq!(a.upload("a1", &first, 300).await, (300, 300, true));
    assert_error(
        &a.put("a1", 100, 300, &sha(&second), &second[100..200])
            .await,
        409,
        "chunk_offset",
    );
    let mut too_long = second.clone();
    too_long.push(0);
    assert_error(
        &a.put("a1", 0, 300, &sha(&second), &too_long).await,
        400,
        "bad_request",
    );
    assert_eq!(status_of(&a.status("a1").await), (300, 300, true));
    assert_eq!(a.download("a1", None).await.body, first);
    assert_eq!(a.upload("a1", &second, 300).await, (300, 300, true));
    assert_eq!(a.download("a1", None).await.body, second);
}

#[tokio::test]
async fn a_late_deletion_never_removes_a_newer_upload() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    let a = account(&server, "user@example.com").await;
    let data = content(200, 35);
    a.sync(vec![attachment("a1", AT, "doc.pdf", 200, None)])
        .await;
    assert_eq!(a.upload("a1", &data, 200).await, (200, 200, true));
    // The deletion of an earlier life of a1 arrives after a new upload started: its row is
    // there, so the bytes are not the deleted ones.
    let state = server.state();
    state
        .files
        .delete_files(&state.store, &a.account_id, &["a1".to_string()]);
    assert_eq!(a.download("a1", None).await.body, data);
    // Once its row is gone, the bytes go.
    a.sync(vec![tombstone("a1", LATER)]).await;
    assert!(stored_names(dir.path(), &a.account_id).is_empty());
}

#[tokio::test]
async fn new_uploads_keep_the_disks_free_space_floor() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    let a = account(&server, "user@example.com").await;
    let big = content(600, 36);
    let small = content(400, 37);
    a.sync(vec![
        attachment("big", AT, "a.pdf", 600, None),
        attachment("small", AT, "b.pdf", 400, None),
    ])
    .await;
    server.set_free_space(1_000, Some(1_500));
    // 1 500 free - 600 would leave less than 1 000.
    assert_error(
        &a.put("big", 0, 600, &sha(&big), b"").await,
        507,
        "quota_exceeded",
    );
    assert_eq!(files_rows(&server), 0);
    assert_eq!(
        status_of(&a.put("small", 0, 400, &sha(&small), &small[..100]).await),
        (100, 400, false)
    );
    // An upload in progress goes on even below the floor (its size was counted when it
    // started).
    server.set_free_space(1_000, Some(0));
    assert_eq!(
        status_of(&a.put("small", 100, 400, &sha(&small), &small[100..]).await),
        (400, 400, true)
    );
    server.set_free_space(1_000, Some(1_600));
    assert_eq!(a.upload("big", &big, 600).await, (600, 600, true));
}

// ---------------------------------------------------------------------------
// Files in a bucket: a fake S3 server on 127.0.0.1 stands for R2.
// ---------------------------------------------------------------------------

mod bucket {
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    use axum::body::Bytes;
    use axum::extract::{Path, RawQuery, State};
    use axum::http::{HeaderMap, Method, StatusCode};
    use axum::response::{IntoResponse, Response};
    use axum::routing::any;
    use axum::Router;
    use taido_sync_server::r2::{R2Config, R2};

    pub const BUCKET: &str = "taido-fichiers";

    /// Objects by key, and whether the next requests fail (an R2 outage).
    #[derive(Clone, Default)]
    pub struct FakeBucket {
        pub objects: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
        pub down: Arc<AtomicBool>,
    }

    impl FakeBucket {
        pub fn keys(&self) -> Vec<String> {
            self.objects.lock().expect("lock").keys().cloned().collect()
        }

        pub fn get(&self, key: &str) -> Option<Vec<u8>> {
            self.objects.lock().expect("lock").get(key).cloned()
        }

        pub fn set_down(&self, down: bool) {
            self.down.store(down, Ordering::SeqCst);
        }
    }

    /// Starts the fake on a random port; returns it and a client of it.
    pub async fn start() -> (FakeBucket, Arc<R2>) {
        let fake = FakeBucket::default();
        let app = Router::new()
            .route("/{bucket}/{*key}", any(object))
            .with_state(fake.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let r2 = R2::new(&R2Config {
            endpoint: format!("http://{addr}"),
            bucket: BUCKET.into(),
            access_key_id: "test-id".into(),
            secret_access_key: "test-secret".into(),
        })
        .expect("client");
        (fake, r2)
    }

    async fn object(
        State(fake): State<FakeBucket>,
        Path((bucket, key)): Path<(String, String)>,
        RawQuery(query): RawQuery,
        method: Method,
        headers: HeaderMap,
        body: Bytes,
    ) -> Response {
        // Every request is presigned with the key id, and goes to the configured bucket.
        let query = query.unwrap_or_default();
        if bucket != BUCKET
            || !query.contains("X-Amz-Signature=")
            || !query.contains("X-Amz-Credential=test-id")
        {
            return StatusCode::FORBIDDEN.into_response();
        }
        if fake.down.load(Ordering::SeqCst) {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "<Error><Code>InternalError</Code></Error>",
            )
                .into_response();
        }
        let mut objects = fake.objects.lock().expect("lock");
        match method {
            Method::PUT => {
                objects.insert(key, body.to_vec());
                StatusCode::OK.into_response()
            }
            Method::DELETE => {
                objects.remove(&key);
                StatusCode::NO_CONTENT.into_response()
            }
            Method::GET | Method::HEAD => {
                let Some(data) = objects.get(&key) else {
                    return StatusCode::NOT_FOUND.into_response();
                };
                let range = headers
                    .get("range")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|r| r.strip_prefix("bytes="))
                    .and_then(|r| r.split_once('-'))
                    .and_then(|(a, b)| Some((a.parse::<usize>().ok()?, b.parse::<usize>().ok()?)));
                let (status, part, content_range) = match range {
                    Some((start, _)) if start >= data.len() => {
                        return (
                            StatusCode::RANGE_NOT_SATISFIABLE,
                            [("content-range", format!("bytes */{}", data.len()))],
                        )
                            .into_response();
                    }
                    Some((start, end)) => {
                        let end = end.min(data.len() - 1);
                        (
                            StatusCode::PARTIAL_CONTENT,
                            data[start..=end].to_vec(),
                            Some(format!("bytes {start}-{end}/{}", data.len())),
                        )
                    }
                    None => (StatusCode::OK, data.clone(), None),
                };
                let mut response = Response::builder()
                    .status(status)
                    .header("content-length", part.len())
                    .header("accept-ranges", "bytes");
                if let Some(range) = content_range {
                    response = response.header("content-range", range);
                }
                let body = if method == Method::HEAD {
                    Vec::new()
                } else {
                    part
                };
                response.body(body.into()).expect("response")
            }
            _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
        }
    }
}

fn bucket_key(account_id: &str, attachment_id: &str) -> String {
    format!(
        "comptes/{account_id}/{}",
        taido_sync_server::files::storage_name(account_id, attachment_id)
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn a_complete_file_goes_to_the_bucket_under_its_account_and_leaves_the_disk() {
    let dir = tempfile::tempdir().expect("tmp");
    let (fake, r2) = bucket::start().await;
    let server = taido_sync_server::start_for_tests_with_bucket(dir.path(), r2)
        .await
        .expect("server");
    server.set_file_limits(10_000, 100_000);
    let alice = account(&server, "alice@example.com").await;
    let bob = account(&server, "bob@example.com").await;
    let data = content(3_000, 7);
    alice
        .sync(vec![attachment("a1", AT, "devis.pdf", data.len(), None)])
        .await;

    assert_eq!(alice.upload("a1", &data, 1_200).await, (3_000, 3_000, true));
    let key = bucket_key(&alice.account_id, "a1");
    assert_eq!(fake.keys(), vec![key.clone()]);
    assert_eq!(fake.get(&key).as_deref(), Some(data.as_slice()));
    // Nothing of it stays on the server's disk, and its status is still « complete ».
    assert!(stored_names(dir.path(), &alice.account_id).is_empty());
    assert_eq!(status_of(&alice.status("a1").await), (3_000, 3_000, true));

    // Read back through the server, whole and by range.
    let whole = alice.download("a1", None).await;
    assert_eq!(whole.status, 200);
    assert_eq!(whole.body, data);
    assert_eq!(
        whole.headers.get("content-disposition").map(String::as_str),
        Some("attachment; filename=\"devis.pdf\"; filename*=UTF-8''devis.pdf")
    );
    assert_eq!(
        whole
            .headers
            .get("x-content-type-options")
            .map(String::as_str),
        Some("nosniff")
    );
    let part = alice.download("a1", Some("bytes=100-199")).await;
    assert_eq!(part.status, 206);
    assert_eq!(part.body, &data[100..200]);
    assert_eq!(
        part.headers.get("content-range").map(String::as_str),
        Some("bytes 100-199/3000")
    );
    assert_eq!(
        alice.download("a1", Some("bytes=5000-6000")).await.status,
        416
    );

    // Another account never reaches it.
    assert_error(&bob.download("a1", None).await, 404, "not_found");
    assert_error(&bob.status("a1").await, 404, "not_found");

    // Deleted with its attachment.
    alice.sync(vec![tombstone("a1", LATER)]).await;
    assert!(fake.keys().is_empty());
    assert_eq!(files_rows(&server), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bucket_outage_drops_the_upload_which_starts_again() {
    let dir = tempfile::tempdir().expect("tmp");
    let (fake, r2) = bucket::start().await;
    let server = taido_sync_server::start_for_tests_with_bucket(dir.path(), r2)
        .await
        .expect("server");
    server.set_file_limits(10_000, 100_000);
    let alice = account(&server, "alice@example.com").await;
    let data = content(2_000, 3);
    alice
        .sync(vec![attachment("a1", AT, "plan.pdf", data.len(), None)])
        .await;

    fake.set_down(true);
    let r = alice.put("a1", 0, data.len(), &sha(&data), &data).await;
    assert_eq!(r.status, 500, "{}", String::from_utf8_lossy(&r.body));
    assert_eq!(status_of(&alice.status("a1").await), (0, 2_000, false));
    assert!(stored_names(dir.path(), &alice.account_id).is_empty());

    fake.set_down(false);
    assert_eq!(alice.upload("a1", &data, 2_000).await, (2_000, 2_000, true));
    assert_eq!(
        fake.get(&bucket_key(&alice.account_id, "a1")).as_deref(),
        Some(data.as_slice())
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn files_kept_on_the_disk_are_served_then_moved_to_the_bucket() {
    let dir = tempfile::tempdir().expect("tmp");
    let data = content(4_000, 9);
    let (account_id, token_base) = {
        let server = start_for_tests(dir.path()).await.expect("server");
        server.set_file_limits(10_000, 100_000);
        let alice = account(&server, "alice@example.com").await;
        alice
            .sync(vec![attachment("a1", AT, "photo.jpg", data.len(), None)])
            .await;
        assert_eq!(alice.upload("a1", &data, 4_000).await, (4_000, 4_000, true));
        assert_eq!(stored_names(dir.path(), &alice.account_id).len(), 1);
        let id = alice.account_id.clone();
        let token = alice.token.clone();
        server.stop().await;
        (id, token)
    };

    let (fake, r2) = bucket::start().await;
    let server = taido_sync_server::start_for_tests_with_bucket(dir.path(), r2)
        .await
        .expect("server");
    let alice = Client {
        base: server.base_url.clone(),
        token: token_base,
        account_id: account_id.clone(),
    };
    // Before the move: read from the disk.
    assert_eq!(alice.download("a1", None).await.body, data);

    let state = server.state().clone();
    let moved = tokio::task::spawn_blocking(move || state.files.move_to_remote(&state.store))
        .await
        .expect("join")
        .expect("moved");
    assert_eq!(moved, (1, 4_000));
    assert!(stored_names(dir.path(), &account_id).is_empty());
    assert_eq!(
        fake.get(&bucket_key(&account_id, "a1")).as_deref(),
        Some(data.as_slice())
    );
    assert_eq!(alice.download("a1", None).await.body, data);
    assert_eq!(status_of(&alice.status("a1").await), (4_000, 4_000, true));

    // A second run has nothing left to move.
    let state = server.state().clone();
    let again = tokio::task::spawn_blocking(move || state.files.move_to_remote(&state.store))
        .await
        .expect("join")
        .expect("again");
    assert_eq!(again, (0, 0));
}
