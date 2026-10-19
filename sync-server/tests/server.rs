//! Integration tests: a real server on 127.0.0.1:<random port> started with
//! `start_for_tests`, a temp data dir, one account created with `TestServer::create_account`,
//! two devices.

mod common;

use common::{get, post_json, request};
use serde_json::{json, Value};
use sync_proto::{SyncResponse, MAX_PULL_CHANGES, MAX_SYNC_BODY_BYTES};
use taido_sync_server::{reset_epoch, start_for_tests, start_for_tests_at, TestServer};

const EMAIL: &str = "user@example.com";
const PASSWORD: &str = "un mot de passe solide";

/// A server on a new data dir with the account [`EMAIL`] / [`PASSWORD`].
async fn start(dir: &std::path::Path) -> TestServer {
    let server = start_for_tests(dir).await.expect("server");
    server.create_account(EMAIL, PASSWORD).expect("account");
    server
}

fn task(id: &str, at: &str, title: &str) -> Value {
    json!({
        "entity": "task", "id": id, "updated_at": at, "device_id": "",
        "data": {
            "subject_id": "p1", "section_id": null, "parent_id": null,
            "title": title, "description": "note", "due_date": "2026-10-05", "due_time": "17:00",
            "priority": 3, "completed_at": null, "position": 1.0,
            "created_at": "2026-10-01T08:00:00.000Z", "deleted_at": null
        }
    })
}

fn subject(id: &str, at: &str) -> Value {
    json!({
        "entity": "subject", "id": id, "updated_at": at, "device_id": "",
        "data": { "name": "Globex", "color": "teal", "parent_id": null, "position": 1.0,
                  "created_at": "2026-10-01T08:00:00.000Z", "deleted_at": null }
    })
}

async fn login(base: &str, name: &str) -> (String, String) {
    let reply = post_json(
        base,
        "/api/login",
        None,
        &json!({"protocol": 3, "email": EMAIL, "password": PASSWORD, "device_name": name}),
    )
    .await;
    assert_eq!(
        reply.status,
        200,
        "{}",
        String::from_utf8_lossy(&reply.body)
    );
    let body = reply.json();
    assert_eq!(body["token"].as_str().expect("token").len(), 43);
    assert_eq!(body["server_epoch"].as_str().expect("epoch").len(), 36);
    (
        body["token"].as_str().expect("token").to_string(),
        body["server_epoch"].as_str().expect("epoch").to_string(),
    )
}

async fn sync(base: &str, token: &str, cursor: u64, changes: Vec<Value>) -> SyncResponse {
    let reply = post_json(
        base,
        "/api/sync",
        Some(token),
        &json!({"protocol": 3, "cursor": cursor, "changes": changes}),
    )
    .await;
    assert_eq!(
        reply.status,
        200,
        "{}",
        String::from_utf8_lossy(&reply.body)
    );
    serde_json::from_slice(&reply.body).expect("sync response")
}

#[tokio::test]
async fn two_devices_converge() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start(dir.path()).await;
    let base = server.base_url.clone();
    assert_eq!(
        get(&base, "/api/health").await.json(),
        json!({"ok": true, "protocol": 3})
    );

    let (mac, epoch) = login(&base, "Mac").await;
    let (phone, epoch2) = login(&base, "Téléphone").await;
    assert_eq!(epoch, epoch2);

    let pushed = sync(
        &base,
        &mac,
        0,
        vec![
            subject("p1", "2026-10-04T09:00:00.000Z"),
            task("t1", "2026-10-04T09:00:01.000Z", "Mac"),
        ],
    )
    .await;
    assert_eq!(pushed.accepted, 2);
    assert_eq!(pushed.server_epoch, epoch);

    let pulled = sync(&base, &phone, 0, vec![]).await;
    assert_eq!(pulled.changes.len(), 2);
    let phone_cursor = pulled.cursor;

    // Conflict: the phone edits with an older stamp → refused, the server row comes back.
    let refused = sync(
        &base,
        &phone,
        phone_cursor,
        vec![task("t1", "2026-10-04T08:00:00.000Z", "old")],
    )
    .await;
    assert_eq!(refused.accepted, 0);
    assert_eq!(refused.changes.len(), 1);
    assert_eq!(
        serde_json::to_value(&refused.changes[0]).expect("v")["data"]["title"],
        "Mac"
    );

    // Newer edit from the phone wins; the Mac pulls it.
    let won = sync(
        &base,
        &phone,
        phone_cursor,
        vec![task("t1", "2026-10-04T10:00:00.000Z", "Phone")],
    )
    .await;
    assert_eq!(won.accepted, 1);
    let mac_pull = sync(&base, &mac, pushed.cursor, vec![]).await;
    assert_eq!(mac_pull.changes.len(), 1);
    assert_eq!(
        serde_json::to_value(&mac_pull.changes[0]).expect("v")["data"]["title"],
        "Phone"
    );

    // Idempotent re-push of the same change.
    let again = sync(
        &base,
        &phone,
        won.cursor,
        vec![task("t1", "2026-10-04T10:00:00.000Z", "Phone")],
    )
    .await;
    assert_eq!(again.accepted, 1);
    assert!(again.changes.is_empty());

    // Tombstone finality.
    let tomb = json!({"entity": "task", "id": "t1", "updated_at": "2026-10-04T10:00:01.000Z",
        "device_id": "", "data": null});
    let deleted = sync(&base, &mac, mac_pull.cursor, vec![tomb]).await;
    assert_eq!(deleted.accepted, 1);
    let revive = sync(
        &base,
        &phone,
        again.cursor,
        vec![task("t1", "2026-10-05T00:00:00.000Z", "back")],
    )
    .await;
    assert_eq!(revive.accepted, 0);
    assert_eq!(revive.changes.len(), 1);
    assert!(revive.changes[0].is_tombstone());
}

#[tokio::test]
async fn invalid_change_is_rejected_and_others_stored() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start(dir.path()).await;
    let (token, _) = login(&server.base_url, "Mac").await;
    let mut bad = task("bad", "2026-10-04T09:00:00.000Z", "x");
    bad["data"]["due_time"] = json!("25:99");
    let r = sync(
        &server.base_url,
        &token,
        0,
        vec![
            task("a", "2026-10-04T09:00:00.000Z", "a"),
            bad,
            task("b", "2026-10-04T09:00:01.000Z", "b"),
        ],
    )
    .await;
    assert_eq!(r.accepted, 2);
    assert_eq!(r.rejected.len(), 1);
    assert_eq!(r.rejected[0].id, "bad");
}

#[tokio::test]
async fn large_pull_comes_in_two_pages() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start(dir.path()).await;
    let base = server.base_url.clone();
    let (mac, _) = login(&base, "Mac").await;
    let (phone, _) = login(&base, "Téléphone").await;
    for chunk in 0..5 {
        let changes = (0..500)
            .map(|i| task(&format!("t{chunk}-{i}"), "2026-10-04T09:00:00.000Z", "x"))
            .collect();
        sync(&base, &mac, 0, changes).await;
    }
    let first = sync(&base, &phone, 0, vec![]).await;
    assert_eq!(first.changes.len(), MAX_PULL_CHANGES);
    assert!(first.has_more);
    let second = sync(&base, &phone, first.cursor, vec![]).await;
    assert_eq!(second.changes.len(), 500);
    assert!(!second.has_more);
    assert_eq!(second.cursor, 2500);
}

#[tokio::test]
async fn http_errors() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start(dir.path()).await;
    let base = server.base_url.clone();
    let (token, _) = login(&base, "Mac").await;

    let r = post_json(
        &base,
        "/api/sync",
        None,
        &json!({"protocol": 3, "cursor": 0, "changes": []}),
    )
    .await;
    assert_eq!((r.status, r.error().as_str()), (401, "unauthorized"));

    let r = post_json(
        &base,
        "/api/sync",
        Some(&token),
        &json!({"protocol": 7, "cursor": 0, "changes": []}),
    )
    .await;
    assert_eq!(
        (r.status, r.error().as_str()),
        (400, "unsupported_protocol")
    );

    let r = request(
        &base,
        "POST",
        "/api/sync",
        Some(&token),
        &vec![b' '; MAX_SYNC_BODY_BYTES + 10],
    )
    .await;
    assert_eq!((r.status, r.error().as_str()), (413, "payload_too_large"));

    let r = post_json(
        &base,
        "/api/login",
        None,
        &json!({"protocol": 3, "email": EMAIL, "password": "nope nope nope", "device_name": "Mac"}),
    )
    .await;
    assert_eq!((r.status, r.error().as_str()), (401, "unauthorized"));
    for _ in 0..9 {
        post_json(
            &base,
            "/api/login",
            None,
            &json!({"protocol": 3, "email": EMAIL, "password": "nope nope nope", "device_name": "Mac"}),
        )
        .await;
    }
    let r = post_json(
        &base,
        "/api/login",
        None,
        &json!({"protocol": 3, "email": EMAIL, "password": PASSWORD, "device_name": "Mac"}),
    )
    .await;
    assert_eq!((r.status, r.error().as_str()), (429, "rate_limited"));

    let r = get(&base, "/api/nothing").await;
    assert_eq!(r.status, 404);
}

#[tokio::test]
async fn restart_keeps_devices_and_reset_epoch_is_reported() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start(dir.path()).await;
    let base = server.base_url.clone();
    let addr = base.trim_start_matches("http://").to_string();
    let (token, epoch) = login(&base, "Mac").await;
    sync(
        &base,
        &token,
        0,
        vec![task("a", "2026-10-04T09:00:00.000Z", "a")],
    )
    .await;

    server.stop().await;
    let new_epoch = reset_epoch(dir.path()).expect("reset");
    assert_ne!(new_epoch, epoch);

    let server = start_for_tests_at(dir.path(), &addr)
        .await
        .expect("restart");
    assert_eq!(server.base_url, base);
    let r = sync(&base, &token, 1, vec![]).await;
    assert_eq!(
        r.server_epoch, new_epoch,
        "same token still valid, new epoch reported"
    );
}

#[tokio::test]
async fn test_server_password_change_revokes_the_account_devices() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start(dir.path()).await;
    let base = server.base_url.clone();
    let (token, _) = login(&base, "Mac").await;
    assert!(
        server.create_account(EMAIL, PASSWORD).is_err(),
        "address taken"
    );
    assert_eq!(
        server
            .set_password(EMAIL, "un autre mot de passe")
            .expect("set password"),
        1
    );
    let r = post_json(
        &base,
        "/api/sync",
        Some(&token),
        &json!({"protocol": 3, "cursor": 0, "changes": []}),
    )
    .await;
    assert_eq!(r.status, 401);
    let r = post_json(
        &base,
        "/api/login",
        None,
        &json!({"protocol": 3, "email": EMAIL, "password": "un autre mot de passe",
            "device_name": "Mac"}),
    )
    .await;
    assert_eq!(r.status, 200);
}

#[tokio::test]
async fn test_server_mails_reset_codes_to_memory() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start(dir.path()).await;
    let base = server.base_url.clone();
    let (token, _) = login(&base, "Mac").await;
    let r = post_json(
        &base,
        "/api/password/forgot",
        None,
        &json!({"protocol": 3, "email": EMAIL}),
    )
    .await;
    assert_eq!(r.status, 204);
    let code = server
        .wait_for_code(EMAIL, 1, std::time::Duration::from_secs(5))
        .await
        .expect("code");
    assert_eq!(server.mailer().mails_to(EMAIL).len(), 1);
    let r = post_json(
        &base,
        "/api/password/reset",
        None,
        &json!({"protocol": 3, "email": EMAIL, "code": code,
            "password": "un autre mot de passe"}),
    )
    .await;
    assert_eq!(r.status, 204);
    let r = post_json(
        &base,
        "/api/sync",
        Some(&token),
        &json!({"protocol": 3, "cursor": 0, "changes": []}),
    )
    .await;
    assert_eq!(r.status, 401, "devices logged out");
}
