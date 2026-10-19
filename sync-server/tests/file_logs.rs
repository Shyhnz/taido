//! Attachment files write neither the file name nor the content in the logs, a file that
//! cannot be deleted is logged (by ids, no path) without failing the sync, and a refused upload
//! (507) is a warning, not an error. Its own test binary:
//! it installs the process-wide tracing subscriber (all levels, every thread, blocking tasks
//! included).

mod common;

use std::io::Write;
use std::sync::{Arc, Mutex};

use common::{post_json, request, request_with_headers};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use taido_sync_server::start_for_tests;

const EMAIL: &str = "user@example.com";
const PASSWORD: &str = "un mot de passe solide";
const FILE_NAME: &str = "nom-secret-QX7 Été.pdf";
const MARKER: &str = "CONTENU-SECRET-QX7";
const AT: &str = "2026-10-10T09:00:00.000Z";
const LATER: &str = "2026-10-10T10:00:00.000Z";

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().expect("log buffer").extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn attachment(id: &str, at: &str, size: usize, deleted_at: Option<&str>) -> Value {
    json!({
        "entity": "attachment", "id": id, "updated_at": at, "device_id": "",
        "data": {"task_id": "t1", "file_name": FILE_NAME, "mime_type": "application/pdf",
                 "size": size, "created_at": AT, "deleted_at": deleted_at}
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_file_name_nor_content_in_the_logs() {
    let logs = Captured::default();
    let writer = logs.clone();
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .without_time()
        .with_writer(move || writer.clone())
        .init();

    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    let account_id = server.create_account(EMAIL, PASSWORD).expect("account");
    let base = server.base_url.clone();
    let r = post_json(
        &base,
        "/api/login",
        None,
        &json!({"protocol": 3, "email": EMAIL, "password": PASSWORD, "device_name": "Mac"}),
    )
    .await;
    let token = r.json()["token"].as_str().expect("token").to_string();
    let sync = |changes: Vec<Value>| {
        let base = base.clone();
        let token = token.clone();
        async move {
            let r = post_json(
                &base,
                "/api/sync",
                Some(&token),
                &json!({"protocol": 3, "cursor": 0, "changes": changes}),
            )
            .await;
            assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
            r.json()
        }
    };

    let data = MARKER.repeat(100).into_bytes();
    let len = data.len();
    let hash = sha(&data);
    sync(vec![
        attachment("a1", AT, len, None),
        attachment("a2", AT, len, None),
    ])
    .await;
    let put = |id: &'static str, offset: usize, hash: String, body: Vec<u8>| {
        let base = base.clone();
        let token = token.clone();
        async move {
            request(
                &base,
                "PUT",
                &format!("/api/files/{id}?offset={offset}&size={len}&sha256={hash}"),
                Some(&token),
                &body,
            )
            .await
        }
    };
    // Upload in two chunks, download whole and by range.
    assert_eq!(
        put("a1", 0, hash.clone(), data[..800].to_vec())
            .await
            .status,
        200
    );
    assert_eq!(
        put("a1", 800, hash.clone(), data[800..].to_vec())
            .await
            .status,
        200
    );
    let r = request(&base, "GET", "/api/files/a1", Some(&token), b"").await;
    assert_eq!(r.body, data);
    let r = request_with_headers(
        &base,
        "GET",
        "/api/files/a1",
        Some(&token),
        &[("Range", "bytes=0-99")],
        b"",
    )
    .await;
    assert_eq!(r.status, 206);
    // A wrong hash.
    let r = put("a2", 0, sha(b"other"), data.clone()).await;
    assert_eq!(r.status, 400);

    // a1's stored file cannot be deleted (a directory took its place): the sync still works.
    let stored = server.state().files.file_path(&account_id, "a1");
    std::fs::remove_file(&stored).expect("remove");
    std::fs::create_dir_all(stored.join("blocker")).expect("blocker");
    let r = sync(vec![attachment("a1", LATER, len, Some(LATER))]).await;
    assert_eq!(r["accepted"], json!(1));

    // A disk nearly full refuses a new upload with 507: a warning, never an error.
    sync(vec![attachment("a3", AT, len, None)]).await;
    server.set_free_space(1_000_000, Some(0));
    let r = put("a3", 0, hash.clone(), Vec::new()).await;
    assert_eq!(r.status, 507);

    let text = String::from_utf8(logs.0.lock().expect("logs").clone()).expect("utf-8");
    let refused: Vec<&str> = text.lines().filter(|l| l.contains("507")).collect();
    assert!(
        refused.iter().any(|l| l.contains("WARN")),
        "a 507 is a warning:\n{text}"
    );
    assert!(
        !refused.iter().any(|l| l.contains("ERROR")),
        "a 507 is never an error:\n{text}"
    );
    assert!(text.contains("file refused"), "{text}");
    assert!(
        text.contains("file complete"),
        "uploads are logged:\n{text}"
    );
    assert!(text.contains("hash mismatch"), "{text}");
    assert!(
        text.contains("attached file not deleted"),
        "the failed deletion is logged:\n{text}"
    );
    let stored_name = stored
        .file_name()
        .expect("name")
        .to_string_lossy()
        .to_string();
    let data_dir = dir.path().to_string_lossy().to_string();
    for secret in [
        FILE_NAME,
        "nom-secret",
        MARKER,
        stored_name.as_str(),
        data_dir.as_str(),
    ] {
        assert!(!text.contains(secret), "{secret:?} in the logs:\n{text}");
    }
}
