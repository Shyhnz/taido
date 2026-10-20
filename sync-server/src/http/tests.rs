//! Router tests with `tower::ServiceExt::oneshot` (no socket).

use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sync_proto::{
    AccountResponse, ErrorBody, ErrorCode, LoginResponse, SyncResponse, MAX_PUSH_CHANGES,
    MAX_SYNC_BODY_BYTES,
};
use tokio::sync::Semaphore;
use tower::ServiceExt;

use super::{router, AppState, CSP};
use crate::auth;
use crate::files::{FileLimits, FileStore};
use crate::gate::BodyGates;
use crate::mail::MemoryMailer;
use crate::store::{self, Store};
use crate::Signups;

const EMAIL: &str = "user@example.com";
const PASSWORD: &str = "correct horse battery";

/// A state on `store`. These router tests never upload: the file directory is never created.
fn new_state(store: Store) -> AppState {
    let unused = std::env::temp_dir().join("taido-router-tests-no-files");
    AppState::new(store, FileStore::new(unused, FileLimits::default()))
}

/// A state with one account, [`EMAIL`] / [`PASSWORD`].
fn state_with_account() -> AppState {
    let store = Store::in_memory().expect("store");
    {
        let conn = store.lock().expect("lock");
        let hash = auth::hash_password(PASSWORD).expect("hash");
        store::create_account(&conn, EMAIL, &hash)
            .expect("create")
            .expect("new");
    }
    new_state(store)
}

fn app(state: &AppState) -> Router {
    router(state.clone(), None)
}

async fn send(
    app: &Router,
    request: Request<Body>,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let response = app.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let headers = response.headers().clone();
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes()
        .to_vec();
    (status, headers, body)
}

fn post_json(uri: &str, token: Option<&str>, body: impl Into<Body>) -> Request<Body> {
    let mut builder = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    builder.body(body.into()).expect("request")
}

fn get(uri: &str) -> Request<Body> {
    Request::builder()
        .uri(uri)
        .body(Body::empty())
        .expect("request")
}

fn error_code(body: &[u8]) -> ErrorCode {
    serde_json::from_slice::<ErrorBody>(body)
        .expect("error body")
        .error
}

fn login_body(password: &str) -> String {
    login_body_for(EMAIL, password)
}

fn login_body_for(email: &str, password: &str) -> String {
    json!({"protocol": 3, "email": email, "password": password, "device_name": "Mac"}).to_string()
}

fn signup_body(email: &str, password: &str) -> String {
    json!({"protocol": 3, "email": email, "password": password, "device_name": "Mac"}).to_string()
}

/// `request` as sent by nginx for the client address `ip` (`X-Real-IP`).
fn from_ip(ip: &str, mut request: Request<Body>) -> Request<Body> {
    request
        .headers_mut()
        .insert("x-real-ip", ip.parse().expect("header"));
    request
}

fn get_with_token(uri: &str, token: &str) -> Request<Body> {
    Request::builder()
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .expect("request")
}

async fn login(app: &Router) -> LoginResponse {
    let (status, _, body) = send(app, post_json("/api/login", None, login_body(PASSWORD))).await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    serde_json::from_slice(&body).expect("login response")
}

#[tokio::test]
async fn health_answers_ok_with_security_headers() {
    let state = state_with_account();
    let (status, headers, body) = send(&app(&state), get("/api/health")).await;
    assert_eq!(status, StatusCode::OK);
    let body: Value = serde_json::from_slice(&body).expect("json");
    assert_eq!(body, json!({"ok": true, "protocol": 3}));
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert_eq!(headers["referrer-policy"], "no-referrer");
    assert!(
        headers.get("access-control-allow-origin").is_none(),
        "no CORS"
    );
}

#[tokio::test]
async fn login_returns_token_device_and_epoch() {
    let state = state_with_account();
    let app = app(&state);
    let login = login(&app).await;
    assert_eq!(login.protocol, 3);
    assert_eq!(login.token.len(), 43);
    let conn = state.store.lock().expect("lock");
    assert_eq!(
        login.server_epoch,
        store::server_epoch(&conn).expect("epoch")
    );
    let devices = store::list_devices(&conn, None).expect("devices");
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].id, login.device_id);
    // Only the hash is stored.
    let stored: String = conn
        .query_row("SELECT token_hash FROM devices", [], |r| r.get(0))
        .expect("hash");
    assert_eq!(stored, auth::hash_token(&login.token));
}

#[tokio::test]
async fn login_errors() {
    let state = state_with_account();
    let app = app(&state);
    let (status, _, body) = send(
        &app,
        post_json("/api/login", None, login_body("wrong password!")),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(error_code(&body), ErrorCode::Unauthorized);

    let (status, _, body) = send(&app, post_json("/api/login", None, "{not json")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), ErrorCode::BadRequest);

    let v1 = json!({"protocol": 1, "email": EMAIL, "password": PASSWORD, "device_name": "Mac"})
        .to_string();
    let (status, _, body) = send(&app, post_json("/api/login", None, v1)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), ErrorCode::UnsupportedProtocol);

    for name in ["", "   ", &"x".repeat(65)] {
        let req = json!({"protocol": 3, "email": EMAIL, "password": PASSWORD, "device_name": name})
            .to_string();
        let (status, _, body) = send(&app, post_json("/api/login", None, req)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "name {name:?}");
        assert_eq!(error_code(&body), ErrorCode::BadRequest);
    }
    let ok_name =
        json!({"protocol": 3, "email": EMAIL, "password": PASSWORD, "device_name": "Téléphone"});
    let (status, _, _) = send(&app, post_json("/api/login", None, ok_name.to_string())).await;
    assert_eq!(status, StatusCode::OK);

    // Body above 4 KiB → 413 with a JSON body.
    let big =
        json!({"protocol": 3, "email": EMAIL, "password": "x".repeat(5000), "device_name": "Mac"});
    let (status, _, body) = send(&app, post_json("/api/login", None, big.to_string())).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(error_code(&body), ErrorCode::PayloadTooLarge);
}

#[tokio::test]
async fn signup_refused_when_closed() {
    let state = new_state(Store::in_memory().expect("store")).with_signups(Signups::Closed);
    let app = app(&state);
    // Refused before any limit or store work: even a malformed body gets the same answer,
    // and the signup limiter is not used.
    for body in [signup_body("new@example.com", PASSWORD), "{".to_string()] {
        let (status, _, body) = send(&app, post_json("/api/signup", None, body)).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(error_code(&body), ErrorCode::SignupsClosed);
    }
    let conn = state.store.lock().expect("lock");
    assert!(store::list_accounts(&conn).expect("accounts").is_empty());
}

#[tokio::test]
async fn login_still_works_when_signups_closed() {
    let state = state_with_account().with_signups(Signups::Closed);
    let app = app(&state);
    let (status, _, body) = send(&app, post_json("/api/login", None, login_body(PASSWORD))).await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
}

#[tokio::test]
async fn signups_default_open() {
    let state = new_state(Store::in_memory().expect("store"));
    assert_eq!(state.signups, Signups::Open);
    let (status, _, _) = send(
        &app(&state),
        post_json(
            "/api/signup",
            None,
            signup_body("new@example.com", PASSWORD),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn signup_then_login_by_email() {
    let state = new_state(Store::in_memory().expect("store"));
    let app = app(&state);
    let (status, _, body) = send(
        &app,
        post_json(
            "/api/signup",
            None,
            signup_body(" User@Example.com ", PASSWORD),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    let signed: LoginResponse = serde_json::from_slice(&body).expect("signup response");
    assert_eq!(signed.protocol, 3);
    assert_eq!(signed.token.len(), 43);

    // The address is stored trimmed and lowercase; any case logs in.
    let (status, _, body) = send(
        &app,
        post_json(
            "/api/login",
            None,
            login_body_for("USER@example.COM", PASSWORD),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    let logged: LoginResponse = serde_json::from_slice(&body).expect("login response");
    assert_ne!(logged.device_id, signed.device_id);
    assert_eq!(logged.server_epoch, signed.server_epoch);

    let conn = state.store.lock().expect("lock");
    let devices = store::list_devices(&conn, Some(EMAIL)).expect("devices");
    assert_eq!(devices.len(), 2);
}

#[tokio::test]
async fn without_mail_a_signup_is_confirmed_at_once() {
    // No mailer, or a mailer without public address: no link can be sent.
    for state in [
        new_state(Store::in_memory().expect("store")),
        new_state(Store::in_memory().expect("store")).with_mailer(Arc::new(MemoryMailer::new())),
    ] {
        let app = app(&state);
        let (status, _, body) = send(
            &app,
            post_json("/api/signup", None, signup_body(EMAIL, PASSWORD)),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let signed: LoginResponse = serde_json::from_slice(&body).expect("signup response");
        let (status, _, body) = send(
            &app,
            Request::get("/api/account")
                .header("authorization", format!("Bearer {}", signed.token))
                .body(Body::empty())
                .expect("request"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let account: AccountResponse = serde_json::from_slice(&body).expect("account");
        assert!(account.email_verified);
        let (status, _, body) = send(
            &app,
            Request::post("/api/email/resend")
                .header("authorization", format!("Bearer {}", signed.token))
                .body(Body::empty())
                .expect("request"),
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error_code(&body), ErrorCode::MailUnavailable);
    }
}

#[tokio::test]
async fn signup_errors() {
    let state = state_with_account();
    let app = app(&state);
    let (status, _, body) = send(
        &app,
        post_json(
            "/api/signup",
            None,
            signup_body("USER@example.com", PASSWORD),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error_code(&body), ErrorCode::EmailTaken);

    let (status, _, body) = send(
        &app,
        post_json(
            "/api/signup",
            None,
            signup_body("new@example.com", "9 chars!!"),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), ErrorCode::WeakPassword);

    for email in ["", "user", "user@example", "eli ot@example.com"] {
        let (status, _, body) = send(
            &app,
            post_json("/api/signup", None, signup_body(email, PASSWORD)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{email:?}");
        assert_eq!(error_code(&body), ErrorCode::BadEmail, "{email:?}");
    }

    let v2 = json!({"protocol": 2, "email": "new@example.com", "password": PASSWORD,
        "device_name": "Mac"});
    let (status, _, body) = send(&app, post_json("/api/signup", None, v2.to_string())).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), ErrorCode::UnsupportedProtocol);

    let no_name = json!({"protocol": 3, "email": "new@example.com", "password": PASSWORD,
        "device_name": " "});
    let (status, _, body) = send(&app, post_json("/api/signup", None, no_name.to_string())).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), ErrorCode::BadRequest);

    // Nothing was created by the refused requests.
    let conn = state.store.lock().expect("lock");
    assert_eq!(store::list_accounts(&conn).expect("accounts").len(), 1);
    assert!(store::list_devices(&conn, None)
        .expect("devices")
        .is_empty());
}

#[tokio::test]
async fn signups_are_limited_to_twenty_per_hour() {
    let state = new_state(Store::in_memory().expect("store"));
    let app = app(&state);
    for i in 0..20 {
        // Four clients, five signups each (their own limit).
        let ip = format!("198.51.100.{}", i / 5);
        let (status, _, _) = send(
            &app,
            from_ip(
                &ip,
                post_json(
                    "/api/signup",
                    None,
                    signup_body(&format!("u{i}@example.com"), PASSWORD),
                ),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "signup {i}");
    }
    let (status, _, body) = send(
        &app,
        from_ip(
            "203.0.113.50",
            post_json(
                "/api/signup",
                None,
                signup_body("u20@example.com", PASSWORD),
            ),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(error_code(&body), ErrorCode::RateLimited);
}

#[tokio::test]
async fn one_client_gets_five_signups_per_hour() {
    let state = new_state(Store::in_memory().expect("store"));
    let app = app(&state);
    let signup_from = |ip: &str, i: usize| {
        from_ip(
            ip,
            post_json(
                "/api/signup",
                None,
                signup_body(&format!("u{i}@example.com"), PASSWORD),
            ),
        )
    };
    for i in 0..5 {
        let (status, _, _) = send(&app, signup_from("203.0.113.9", i)).await;
        assert_eq!(status, StatusCode::OK, "signup {i}");
    }
    let (status, _, body) = send(&app, signup_from("203.0.113.9", 5)).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(error_code(&body), ErrorCode::RateLimited);
    let (status, _, _) = send(&app, signup_from("198.51.100.7", 6)).await;
    assert_eq!(status, StatusCode::OK, "another client can still sign up");
}

#[tokio::test]
async fn wrong_password_and_unknown_address_get_the_same_answer() {
    let state = state_with_account();
    let app = app(&state);
    let (wrong_status, _, wrong_body) = send(
        &app,
        post_json("/api/login", None, login_body("wrong password!")),
    )
    .await;
    let (unknown_status, _, unknown_body) = send(
        &app,
        post_json(
            "/api/login",
            None,
            login_body_for("nobody@example.com", PASSWORD),
        ),
    )
    .await;
    let (malformed_status, _, malformed_body) = send(
        &app,
        post_json("/api/login", None, login_body_for("nobody", PASSWORD)),
    )
    .await;
    assert_eq!(wrong_status, StatusCode::UNAUTHORIZED);
    assert_eq!(unknown_status, StatusCode::UNAUTHORIZED);
    assert_eq!(malformed_status, StatusCode::UNAUTHORIZED);
    assert_eq!(wrong_body, unknown_body);
    assert_eq!(wrong_body, malformed_body);
    // The unknown and malformed addresses were checked against the dummy hash (same work).
    assert_eq!(state.verifications.load(Ordering::SeqCst), 3);
    assert_eq!(state.dummy_verifications.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn account_shows_the_address_without_a_plan() {
    let state = state_with_account();
    let app = app(&state);
    let token = login(&app).await.token;
    let (status, headers, body) = send(&app, get_with_token("/api/account", &token)).await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    assert_eq!(headers["cache-control"], "no-store");
    let account: AccountResponse = serde_json::from_slice(&body).expect("account");
    assert_eq!(account.protocol, 3);
    assert_eq!(account.email, EMAIL);
    assert_eq!(account.created_at.len(), 24);
    let raw: serde_json::Value = serde_json::from_slice(&body).expect("json");
    assert!(raw.get("plan").is_none(), "no plan in the answer: {raw}");

    let (status, _, body) = send(&app, get("/api/account")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(error_code(&body), ErrorCode::Unauthorized);
    let (status, _, _) = send(&app, get_with_token("/api/account", "unknown")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn login_is_rate_limited_after_ten_failures() {
    let state = state_with_account();
    let app = app(&state);
    for _ in 0..10 {
        let (status, _, _) = send(
            &app,
            post_json("/api/login", None, login_body("bad password!")),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    let (status, _, body) = send(&app, post_json("/api/login", None, login_body(PASSWORD))).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(error_code(&body), ErrorCode::RateLimited);
    assert_eq!(state.verifications.load(Ordering::SeqCst), 10);
}

#[tokio::test]
async fn guesses_from_one_client_do_not_lock_the_account_out_elsewhere() {
    let state = state_with_account();
    let app = app(&state);
    for _ in 0..10 {
        let (status, _, _) = send(
            &app,
            from_ip(
                "203.0.113.9",
                post_json("/api/login", None, login_body("bad password!")),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    let (status, _, _) = send(
        &app,
        from_ip(
            "203.0.113.9",
            post_json("/api/login", None, login_body(PASSWORD)),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    let (status, _, _) = send(
        &app,
        from_ip(
            "198.51.100.7",
            post_json("/api/login", None, login_body(PASSWORD)),
        ),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the account still logs in from elsewhere"
    );
}

#[tokio::test]
async fn one_client_cannot_use_up_the_global_login_budget() {
    let state = state_with_account();
    let app = app(&state);
    // 50 failures from one client, spread over addresses (10 each).
    for i in 0..auth::MAX_LOGIN_ATTEMPTS_PER_CLIENT {
        let email = format!("u{}@example.com", i / 10);
        let (status, _, _) = send(
            &app,
            from_ip(
                "203.0.113.9",
                post_json("/api/login", None, login_body_for(&email, "bad password!")),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "attempt {i}");
    }
    let (status, _, _) = send(
        &app,
        from_ip(
            "203.0.113.9",
            post_json("/api/login", None, login_body_for("fresh@example.com", "x")),
        ),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::TOO_MANY_REQUESTS,
        "the client's own limit"
    );
    let (status, _, _) = send(
        &app,
        from_ip(
            "198.51.100.7",
            post_json("/api/login", None, login_body(PASSWORD)),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn guesses_against_one_address_do_not_lock_out_another() {
    let state = state_with_account();
    {
        let conn = state.store.lock().expect("lock");
        let hash = auth::hash_password(PASSWORD).expect("hash");
        store::create_account(&conn, "other@example.com", &hash)
            .expect("create")
            .expect("new");
    }
    let app = app(&state);
    for _ in 0..10 {
        let (status, _, _) = send(
            &app,
            post_json(
                "/api/login",
                None,
                login_body_for("Other@example.com ", "bad password!"),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    // The key is the address as stored: case and spaces do not escape the limit.
    let (status, _, _) = send(
        &app,
        post_json(
            "/api/login",
            None,
            login_body_for("other@example.com", PASSWORD),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    let (status, _, _) = send(&app, post_json("/api/login", None, login_body(PASSWORD))).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn login_waits_at_most_one_second_for_the_check_slot() {
    let state = state_with_account();
    let app = app(&state);
    let held = Arc::clone(&state.verify_gate)
        .acquire_owned()
        .await
        .expect("permit");
    let started = std::time::Instant::now();
    let (status, _, body) = send(&app, post_json("/api/login", None, login_body(PASSWORD))).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(error_code(&body), ErrorCode::RateLimited);
    assert!(started.elapsed() >= Duration::from_millis(900));
    assert_eq!(state.verifications.load(Ordering::SeqCst), 0);
    drop(held);
    // The reservation was released: a login now succeeds.
    login(&app).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn eleven_parallel_bad_logins_verify_at_most_ten() {
    let state = state_with_account();
    let app = app(&state);
    let mut handles = Vec::new();
    for _ in 0..11 {
        let app = app.clone();
        handles.push(tokio::spawn(async move {
            send(
                &app,
                post_json("/api/login", None, login_body("bad password!")),
            )
            .await
            .0
        }));
    }
    let mut statuses = Vec::new();
    for handle in handles {
        statuses.push(handle.await.expect("task"));
    }
    assert!(statuses
        .iter()
        .all(|s| *s == StatusCode::UNAUTHORIZED || *s == StatusCode::TOO_MANY_REQUESTS));
    assert!(statuses.contains(&StatusCode::TOO_MANY_REQUESTS));
    let verified = state.verifications.load(Ordering::SeqCst);
    assert!(verified <= 10, "{verified} checks");
    assert_eq!(
        statuses
            .iter()
            .filter(|s| **s == StatusCode::UNAUTHORIZED)
            .count(),
        verified
    );
}

#[tokio::test]
async fn sync_needs_a_live_token() {
    let state = state_with_account();
    let app = app(&state);
    let body = json!({"protocol": 3, "cursor": 0, "changes": []}).to_string();
    let (status, _, resp) = send(&app, post_json("/api/sync", None, body.clone())).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(error_code(&resp), ErrorCode::Unauthorized);
    let (status, _, _) = send(&app, post_json("/api/sync", Some("nope"), body.clone())).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let login = login(&app).await;
    let (status, _, resp) = send(
        &app,
        post_json("/api/sync", Some(&login.token), body.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let resp: SyncResponse = serde_json::from_slice(&resp).expect("sync response");
    assert_eq!(resp.server_epoch, login.server_epoch);

    // Logout revokes the token.
    let (status, _, _) = send(&app, post_json("/api/logout", Some(&login.token), "")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _, _) = send(&app, post_json("/api/sync", Some(&login.token), body)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _, _) = send(&app, post_json("/api/logout", Some(&login.token), "")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn sync_answers_401_without_reading_the_body() {
    let state = state_with_account();
    let app = app(&state);
    // A body that never ends: reading it would hang the request.
    for token in [None, Some("unknown-token")] {
        let (_sender, body) =
            http_body_util::channel::Channel::<axum::body::Bytes, std::convert::Infallible>::new(1);
        let request = post_json("/api/sync", token, Body::new(body));
        let (status, _, resp) = tokio::time::timeout(Duration::from_secs(5), send(&app, request))
            .await
            .expect("answered before the body was read");
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(error_code(&resp), ErrorCode::Unauthorized);
    }
}

#[tokio::test]
async fn sync_request_errors() {
    let state = state_with_account();
    let app = app(&state);
    let token = login(&app).await.token;
    let v1 = json!({"protocol": 1, "cursor": 0, "changes": []}).to_string();
    let (status, _, body) = send(&app, post_json("/api/sync", Some(&token), v1)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), ErrorCode::UnsupportedProtocol);

    let (status, _, body) = send(&app, post_json("/api/sync", Some(&token), "[1,2")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), ErrorCode::BadRequest);

    let no_cursor = json!({"protocol": 3, "changes": []}).to_string();
    let (status, _, body) = send(&app, post_json("/api/sync", Some(&token), no_cursor)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), ErrorCode::BadRequest);

    let huge = vec![b' '; MAX_SYNC_BODY_BYTES + 1];
    let (status, _, body) = send(&app, post_json("/api/sync", Some(&token), huge)).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(error_code(&body), ErrorCode::PayloadTooLarge);
}

#[tokio::test]
async fn sync_body_just_under_the_limit_is_read() {
    let state = state_with_account();
    let app = app(&state);
    let token = login(&app).await.token;
    let mut body = json!({"protocol": 3, "cursor": 0, "changes": []})
        .to_string()
        .into_bytes();
    body.resize(MAX_SYNC_BODY_BYTES, b' ');
    let (status, _, _) = send(&app, post_json("/api/sync", Some(&token), body)).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn unknown_api_routes_and_methods_answer_json() {
    let state = state_with_account();
    let app = app(&state);
    let (status, headers, body) = send(&app, get("/api/nope")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error_code(&body), ErrorCode::BadRequest);
    assert_eq!(headers["content-type"], "application/json");
    let (status, _, body) = send(&app, get("/api/sync")).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(error_code(&body), ErrorCode::BadRequest);
    // Without a static dir, every other path is a JSON 404 too.
    let (status, _, _) = send(&app, get("/index.html")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

fn static_dir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("tmp");
    let root = dir.path();
    std::fs::create_dir_all(root.join("assets")).expect("assets");
    std::fs::create_dir_all(root.join("icons")).expect("icons");
    std::fs::write(
        root.join("index.html"),
        "<!doctype html><title>Todo</title>",
    )
    .expect("index");
    std::fs::write(
        root.join("sw.js"),
        "self.addEventListener('fetch', () => {});",
    )
    .expect("sw");
    std::fs::write(root.join("manifest.webmanifest"), "{\"name\":\"Todo\"}").expect("manifest");
    std::fs::write(root.join("assets/app-abc123.js"), "console.log(1)").expect("js");
    std::fs::write(root.join("icons/icon-192.png"), [0x89, b'P', b'N', b'G']).expect("png");
    dir
}

fn static_app(state: &AppState, dir: &Path) -> Router {
    router(state.clone(), Some(dir))
}

#[test]
fn the_app_may_show_blob_images_and_nothing_else_from_blob_urls() {
    // The web app shows a raster attachment through `<img src="blob:…">` (no script
    // runs in an image); `blob:` stays out of every other directive (scripts, frames, fetches).
    let directives: Vec<&str> = CSP.split(';').map(str::trim).collect();
    assert!(directives.contains(&"img-src 'self' data: blob:"), "{CSP}");
    for directive in directives.iter().filter(|d| !d.starts_with("img-src")) {
        assert!(!directive.contains("blob:"), "{directive}");
    }
}

#[tokio::test]
async fn static_assets_are_immutable_and_missing_ones_are_404() {
    let state = state_with_account();
    let dir = static_dir();
    let app = static_app(&state, dir.path());
    let (status, headers, body) = send(&app, get("/assets/app-abc123.js")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, b"console.log(1)");
    assert_eq!(
        headers["cache-control"],
        "public, max-age=31536000, immutable"
    );
    assert_eq!(headers["content-security-policy"], CSP);
    assert_eq!(headers["x-content-type-options"], "nosniff");

    let (status, headers, body) = send(&app, get("/assets/x.js")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(!String::from_utf8_lossy(&body).contains("<!doctype"));
    assert!(headers.get("cache-control").is_none());
}

#[tokio::test]
async fn navigations_fall_back_to_index_html_without_cache() {
    let state = state_with_account();
    let dir = static_dir();
    let app = static_app(&state, dir.path());
    for path in ["/", "/index.html", "/some/deep/link", "/today"] {
        let (status, headers, body) = send(&app, get(path)).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert!(
            String::from_utf8_lossy(&body).starts_with("<!doctype html>"),
            "{path}"
        );
        assert_eq!(headers["cache-control"], "no-cache", "{path}");
        assert_eq!(headers["content-security-policy"], CSP, "{path}");
        assert_eq!(headers["referrer-policy"], "no-referrer", "{path}");
    }
}

#[tokio::test]
async fn service_worker_and_manifest_headers() {
    let state = state_with_account();
    let dir = static_dir();
    let app = static_app(&state, dir.path());
    let (status, headers, _) = send(&app, get("/sw.js")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["cache-control"], "no-cache");
    let (status, headers, _) = send(&app, get("/manifest.webmanifest")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "application/manifest+json");
    let (status, headers, _) = send(&app, get("/icons/icon-192.png")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "image/png");
    assert!(headers.get("cache-control").is_none());
}

#[tokio::test]
async fn api_wins_over_static_files() {
    let state = state_with_account();
    let dir = static_dir();
    let app = static_app(&state, dir.path());
    let (status, headers, body) = send(&app, get("/api/unknown")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error_code(&body), ErrorCode::BadRequest);
    assert!(headers.get("content-security-policy").is_none());
    let (status, _, _) = send(&app, get("/api/health")).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn path_traversal_is_not_served() {
    let state = state_with_account();
    let dir = static_dir();
    let secret = dir.path().parent().expect("parent").join("secret.txt");
    let _ = std::fs::write(&secret, "secret");
    let app = static_app(&state, dir.path());
    let (_, _, body) = send(&app, get("/../secret.txt")).await;
    assert!(!String::from_utf8_lossy(&body).contains("secret"));
    let (status, _, _) = send(&app, get("/assets/../../secret.txt")).await;
    assert_ne!(status, StatusCode::OK);
    let _ = std::fs::remove_file(secret);
}

#[tokio::test]
async fn a_setting_syncs_between_two_devices() {
    let state = state_with_account();
    let app = app(&state);
    let mac = login(&app).await;
    let phone = login(&app).await;
    assert_ne!(mac.device_id, phone.device_id);

    let push = json!({"protocol": 3, "cursor": 0, "changes": [
        {"entity": "setting", "id": sync_proto::SETTING_INBOX_POSITION,
         "updated_at": "2026-10-04T09:00:01.000Z", "device_id": "", "data": {"value": 1.5}},
        {"entity": "setting", "id": "bad key", "updated_at": "2026-10-04T09:00:01.000Z",
         "device_id": "", "data": {"value": 1}},
    ]});
    let (status, _, body) = send(
        &app,
        post_json("/api/sync", Some(&mac.token), push.to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let pushed: Value = serde_json::from_slice(&body).expect("json");
    assert_eq!(pushed["protocol"], json!(3));
    assert_eq!(pushed["accepted"], json!(1));
    assert_eq!(
        pushed["rejected"],
        json!([{"entity": "setting", "id": "bad key"}])
    );

    let pull = json!({"protocol": 3, "cursor": 0, "changes": []}).to_string();
    let (status, _, body) = send(&app, post_json("/api/sync", Some(&phone.token), pull)).await;
    assert_eq!(status, StatusCode::OK);
    let pulled: Value = serde_json::from_slice(&body).expect("json");
    assert_eq!(
        pulled["changes"],
        json!([{"entity": "setting", "id": "inbox_position",
            "updated_at": "2026-10-04T09:00:01.000Z", "device_id": mac.device_id,
            "data": {"value": 1.5}}])
    );
}

#[tokio::test]
async fn protocol_3_entities_are_stored_and_pulled() {
    let state = state_with_account();
    let app = app(&state);
    let mac = login(&app).await;
    let phone = login(&app).await;
    let at = "2026-10-10T09:00:00.000Z";
    let push = json!({"protocol": 3, "cursor": 0, "changes": [
        {"entity": "board_column", "id": "col-inbox-1", "updated_at": at, "device_id": "",
         "data": {"subject_id": null, "name": "À valider", "position": 2.0, "is_done": false,
                  "created_at": at}},
        {"entity": "time_segment", "id": "seg1", "updated_at": at, "device_id": "",
         "data": {"task_id": "t1", "source": "auto", "started_at": at, "ended_at": null,
                  "stop_reason": null, "note": "", "created_at": at, "deleted_at": null}},
        {"entity": "relation", "id": "r1", "updated_at": at, "device_id": "",
         "data": {"from_task_id": "t1", "to_task_id": "t1", "kind": "blocks",
                  "created_at": at, "deleted_at": null}},
        {"entity": "attachment", "id": "a1", "updated_at": at, "device_id": "",
         "data": {"task_id": "t1", "file_name": "a/b.pdf", "mime_type": "application/pdf",
                  "size": 1, "created_at": at, "deleted_at": null}},
    ]});
    let (status, _, body) = send(
        &app,
        post_json("/api/sync", Some(&mac.token), push.to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let pushed: Value = serde_json::from_slice(&body).expect("json");
    // The two valid rows are stored; the self relation and the path-like file name are not.
    assert_eq!(pushed["accepted"], json!(2));
    assert_eq!(
        pushed["rejected"],
        json!([{"entity": "relation", "id": "r1"}, {"entity": "attachment", "id": "a1"}])
    );
    let pull = json!({"protocol": 3, "cursor": 0, "changes": []}).to_string();
    let (_, _, body) = send(&app, post_json("/api/sync", Some(&phone.token), pull)).await;
    let pulled: Value = serde_json::from_slice(&body).expect("json");
    let entities: Vec<&str> = pulled["changes"]
        .as_array()
        .expect("changes")
        .iter()
        .filter_map(|c| c["entity"].as_str())
        .collect();
    assert_eq!(entities, ["board_column", "time_segment"]);
}

// ---------------------------------------------------------------------------
// Forgotten password
// ---------------------------------------------------------------------------

const MAIL_WAIT: Duration = Duration::from_secs(5);

/// [`state_with_account`] with a [`MemoryMailer`].
fn state_with_mailer() -> (AppState, Arc<MemoryMailer>) {
    let mailer = Arc::new(MemoryMailer::new());
    let state = state_with_account().with_mailer(mailer.clone());
    (state, mailer)
}

fn forgot_body(email: &str) -> String {
    json!({"protocol": 3, "email": email}).to_string()
}

fn reset_body(email: &str, code: &str, password: &str) -> String {
    json!({"protocol": 3, "email": email, "code": code, "password": password}).to_string()
}

async fn forgot(app: &Router, email: &str) -> StatusCode {
    send(
        app,
        post_json("/api/password/forgot", None, forgot_body(email)),
    )
    .await
    .0
}

/// Asks for a code for [`EMAIL`] and returns it (the `nth` mail sent to it, from 1).
async fn request_code(app: &Router, mailer: &MemoryMailer, nth: usize) -> String {
    assert_eq!(forgot(app, EMAIL).await, StatusCode::NO_CONTENT);
    let mails = mailer.wait_for_mails_to(EMAIL, nth, MAIL_WAIT).await;
    assert_eq!(mails.len(), nth, "mail {nth} sent");
    crate::mail::code_in(&mails[nth - 1].1).expect("code in the mail")
}

async fn reset(app: &Router, code: &str, password: &str) -> (StatusCode, Vec<u8>) {
    let (status, _, body) = send(
        app,
        post_json(
            "/api/password/reset",
            None,
            reset_body(EMAIL, code, password),
        ),
    )
    .await;
    (status, body)
}

fn wrong_code(code: &str) -> String {
    let n: u32 = code.parse().expect("digits");
    format!("{:06}", (n + 1) % 1_000_000)
}

#[tokio::test]
async fn forgot_sends_the_code_in_english_by_default() {
    let (state, mailer) = state_with_mailer();
    let app = app(&state);
    let (status, _, _) = send(
        &app,
        post_json("/api/password/forgot", None, forgot_body(EMAIL)),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let mails = mailer.wait_for_mails_to(EMAIL, 1, MAIL_WAIT).await;
    assert_eq!(mails[0].0, "Your Taido code");
    assert!(mails[0]
        .1
        .starts_with("Your code to change your password: "));
}

#[tokio::test]
async fn forgot_sends_a_six_digit_code_in_french() {
    let (mut state, mailer) = state_with_mailer();
    state.mail_lang = crate::MailLang::Fr;
    let app = app(&state);
    // The address as typed: trimmed and lowercased like at login.
    let (status, _, _) = send(
        &app,
        post_json(
            "/api/password/forgot",
            None,
            forgot_body("  User@Example.com "),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let mails = mailer.wait_for_mails_to(EMAIL, 1, MAIL_WAIT).await;
    assert_eq!(mails.len(), 1);
    let (subject, text) = &mails[0];
    assert_eq!(subject, "Ton code Taido");
    let code = crate::mail::code_in(text).expect("code");
    assert_eq!(code.len(), 6);
    assert!(code.chars().all(|c| c.is_ascii_digit()));
    assert_eq!(
        text,
        &format!(
            "Ton code pour changer de mot de passe : {code}. Il est valable 30 minutes. \
             Si tu n'as rien demandé, ignore ce message."
        )
    );
    // Stored hashed, never in clear.
    let stored: String = state
        .store
        .lock()
        .expect("lock")
        .query_row("SELECT code_hash FROM password_resets", [], |r| r.get(0))
        .expect("row");
    assert!(!stored.contains(&code));
}

#[tokio::test]
async fn forgot_for_an_unknown_address_answers_204_and_sends_nothing() {
    let (state, mailer) = state_with_mailer();
    let app = app(&state);
    let ask = |email: &str| post_json("/api/password/forgot", None, forgot_body(email));
    let (unknown_status, mut unknown_headers, unknown_body) =
        send(&app, ask("nobody@example.com")).await;
    // A known address in the same window: its mail arrives, nothing went to the other one.
    let (known_status, mut known_headers, known_body) = send(&app, ask(EMAIL)).await;
    // The same answer, byte for byte (headers too, but the date).
    assert_eq!(unknown_status, StatusCode::NO_CONTENT);
    assert_eq!(known_status, unknown_status);
    assert_eq!(known_body, unknown_body);
    unknown_headers.remove(header::DATE);
    known_headers.remove(header::DATE);
    assert_eq!(known_headers, unknown_headers);
    assert_eq!(mailer.wait_for_mails_to(EMAIL, 1, MAIL_WAIT).await.len(), 1);
    assert!(mailer.mails_to("nobody@example.com").is_empty());
    assert_eq!(mailer.sent.lock().expect("sent").len(), 1);
    let rows: i64 = state
        .store
        .lock()
        .expect("lock")
        .query_row("SELECT COUNT(*) FROM password_resets", [], |r| r.get(0))
        .expect("count");
    assert_eq!(rows, 1);
}

#[tokio::test]
async fn forgot_answers_204_even_when_the_mail_cannot_be_sent() {
    let (state, mailer) = state_with_mailer();
    mailer.set_failing(true);
    let app = app(&state);
    assert_eq!(forgot(&app, EMAIL).await, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn forgot_without_mail_configured_answers_503() {
    let state = state_with_account();
    let app = app(&state);
    let (status, _, body) = send(
        &app,
        post_json("/api/password/forgot", None, forgot_body(EMAIL)),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error_code(&body), ErrorCode::MailUnavailable);
}

#[tokio::test]
async fn forgot_request_errors() {
    let (state, mailer) = state_with_mailer();
    let app = app(&state);
    let (status, _, body) = send(
        &app,
        post_json("/api/password/forgot", None, forgot_body("not an address")),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), ErrorCode::BadEmail);
    let v2 = json!({"protocol": 2, "email": EMAIL}).to_string();
    let (status, _, body) = send(&app, post_json("/api/password/forgot", None, v2)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), ErrorCode::UnsupportedProtocol);
    let (status, _, _) = send(&app, post_json("/api/password/forgot", None, "{")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(mailer.sent.lock().expect("sent").is_empty());
}

#[tokio::test]
async fn reset_sets_the_password_and_logs_every_device_out() {
    let (state, mailer) = state_with_mailer();
    let app = app(&state);
    let mac = login(&app).await;
    let phone = login(&app).await;
    let code = request_code(&app, &mailer, 1).await;

    let (status, body) = reset(&app, &code, "un nouveau mot de passe").await;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "{}",
        String::from_utf8_lossy(&body)
    );

    for token in [&mac.token, &phone.token] {
        let (status, _, _) = send(&app, get_with_token("/api/account", token)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "device logged out");
    }
    let (status, _, _) = send(&app, post_json("/api/login", None, login_body(PASSWORD))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "old password refused");
    let (status, _, _) = send(
        &app,
        post_json("/api/login", None, login_body("un nouveau mot de passe")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "new password accepted");

    // The code is used up.
    let (status, body) = reset(&app, &code, "encore un autre mot").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), ErrorCode::InvalidCode);
    let rows: i64 = state
        .store
        .lock()
        .expect("lock")
        .query_row("SELECT COUNT(*) FROM password_resets", [], |r| r.get(0))
        .expect("count");
    assert_eq!(rows, 0);
}

#[tokio::test]
async fn the_sixth_try_fails_even_with_the_right_code() {
    let (state, mailer) = state_with_mailer();
    let app = app(&state);
    let code = request_code(&app, &mailer, 1).await;
    let bad = wrong_code(&code);
    for attempt in 1..=5 {
        let (status, body) = reset(&app, &bad, "un nouveau mot de passe").await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "attempt {attempt}");
        assert_eq!(error_code(&body), ErrorCode::InvalidCode);
    }
    let (status, body) = reset(&app, &code, "un nouveau mot de passe").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), ErrorCode::InvalidCode);
    let (status, _, _) = send(&app, post_json("/api/login", None, login_body(PASSWORD))).await;
    assert_eq!(status, StatusCode::OK, "password unchanged");
}

#[tokio::test]
async fn the_right_code_works_after_four_wrong_ones() {
    let (state, mailer) = state_with_mailer();
    let app = app(&state);
    let code = request_code(&app, &mailer, 1).await;
    for _ in 0..4 {
        let (status, _) = reset(&app, &wrong_code(&code), "un nouveau mot de passe").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    let (status, _) = reset(&app, &code, "un nouveau mot de passe").await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn a_new_code_replaces_the_old_one() {
    let (state, mailer) = state_with_mailer();
    let app = app(&state);
    let first = request_code(&app, &mailer, 1).await;
    let mut second = request_code(&app, &mailer, 2).await;
    // One chance in a million that both codes are equal: ask a third.
    if second == first {
        second = request_code(&app, &mailer, 3).await;
    }
    assert_ne!(first, second);
    let (status, body) = reset(&app, &first, "un nouveau mot de passe").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), ErrorCode::InvalidCode);
    let (status, _) = reset(&app, &second, "un nouveau mot de passe").await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn an_expired_code_is_refused() {
    let (state, mailer) = state_with_mailer();
    let app = app(&state);
    let code = request_code(&app, &mailer, 1).await;
    // Expiry is 30 minutes after the request.
    let expires_at: String = state
        .store
        .lock()
        .expect("lock")
        .query_row("SELECT expires_at FROM password_resets", [], |r| r.get(0))
        .expect("row");
    let expires = chrono::DateTime::parse_from_rfc3339(&expires_at).expect("date");
    let left = expires
        .signed_duration_since(chrono::Utc::now())
        .num_seconds();
    assert!((29 * 60..=30 * 60).contains(&left), "{left} s left");
    state
        .store
        .lock()
        .expect("lock")
        .execute(
            "UPDATE password_resets SET expires_at = '2020-01-01T00:00:00.000Z'",
            [],
        )
        .expect("expire");
    let (status, body) = reset(&app, &code, "un nouveau mot de passe").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), ErrorCode::InvalidCode);
}

#[tokio::test]
async fn reset_errors() {
    let (state, mailer) = state_with_mailer();
    let app = app(&state);
    let code = request_code(&app, &mailer, 1).await;
    // A weak password is refused before the code is tried (no attempt used).
    for _ in 0..6 {
        let (status, body) = reset(&app, &code, "court").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error_code(&body), ErrorCode::WeakPassword);
    }
    // Unknown or malformed address: the same answer as a wrong code.
    for email in ["nobody@example.com", "not an address"] {
        let (status, _, body) = send(
            &app,
            post_json(
                "/api/password/reset",
                None,
                reset_body(email, &code, "un nouveau mot de passe"),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{email}");
        assert_eq!(error_code(&body), ErrorCode::InvalidCode);
    }
    let (status, body) = reset(&app, "abcdef", "un nouveau mot de passe").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), ErrorCode::InvalidCode);
    // The code still works (one wrong attempt used out of five).
    let (status, _) = reset(&app, &code, "un nouveau mot de passe").await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn three_codes_per_address_per_hour() {
    let (state, mailer) = state_with_mailer();
    let app = app(&state);
    for _ in 0..3 {
        assert_eq!(forgot(&app, EMAIL).await, StatusCode::NO_CONTENT);
    }
    let (status, _, body) = send(
        &app,
        post_json("/api/password/forgot", None, forgot_body(EMAIL)),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(error_code(&body), ErrorCode::RateLimited);
    // Also from another client, and whatever the case of the address.
    let (status, _, _) = send(
        &app,
        from_ip(
            "203.0.113.9",
            post_json(
                "/api/password/forgot",
                None,
                forgot_body("USER@example.com"),
            ),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(mailer.wait_for_mails_to(EMAIL, 3, MAIL_WAIT).await.len(), 3);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(mailer.mails_to(EMAIL).len(), 3, "no fourth mail");
    // An unknown address is limited the same way (no difference to observe).
    for _ in 0..3 {
        assert_eq!(
            forgot(&app, "nobody@example.com").await,
            StatusCode::NO_CONTENT
        );
    }
    assert_eq!(
        forgot(&app, "nobody@example.com").await,
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn one_client_gets_ten_forgot_requests_per_hour() {
    let (state, _mailer) = state_with_mailer();
    let app = app(&state);
    let ask = |i: usize, ip: &'static str| {
        from_ip(
            ip,
            post_json(
                "/api/password/forgot",
                None,
                forgot_body(&format!("user{i}@example.com")),
            ),
        )
    };
    for i in 0..auth::MAX_FORGOTS_PER_CLIENT {
        let (status, _, _) = send(&app, ask(i, "198.51.100.1")).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "request {i}");
    }
    let (status, _, _) = send(&app, ask(99, "198.51.100.1")).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    let (status, _, _) = send(&app, ask(99, "198.51.100.2")).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "another client");
}

#[tokio::test]
async fn reset_guesses_are_limited_per_client_across_accounts() {
    let (state, _mailer) = state_with_mailer();
    let app = app(&state);
    let guess = |i: usize, ip: &'static str| {
        from_ip(
            ip,
            post_json(
                "/api/password/reset",
                None,
                reset_body(
                    &format!("user{i}@example.com"),
                    "123456",
                    "un nouveau mot de passe",
                ),
            ),
        )
    };
    for i in 0..auth::MAX_RESET_FAILURES_PER_CLIENT {
        let (status, _, body) = send(&app, guess(i, "198.51.100.1")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "guess {i}");
        assert_eq!(error_code(&body), ErrorCode::InvalidCode);
    }
    let (status, _, body) = send(&app, guess(999, "198.51.100.1")).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(error_code(&body), ErrorCode::RateLimited);
    let (status, _, _) = send(&app, guess(999, "198.51.100.2")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "another client");
}

/// A sync body pushing `n` new tasks.
fn push_of(n: usize) -> String {
    let changes: Vec<Value> = (0..n)
        .map(|i| {
            json!({
                "entity": "task", "id": format!("t{i:04}"),
                "updated_at": "2026-10-12T08:00:00.000Z", "device_id": "",
                "data": {
                    "subject_id": null, "section_id": null, "parent_id": null,
                    "title": "x", "description": "", "due_date": null, "due_time": null,
                    "priority": 1, "completed_at": null, "position": 1.0,
                    "created_at": "2026-10-01T08:00:00.000Z", "deleted_at": null
                }
            })
        })
        .collect();
    json!({"protocol": 3, "cursor": 0, "changes": changes}).to_string()
}

#[tokio::test]
async fn a_push_of_more_than_500_changes_is_refused_whole() {
    let state = state_with_account();
    let app = app(&state);
    let token = login(&app).await.token;
    let too_many = push_of(MAX_PUSH_CHANGES + 1);
    let (status, _, body) = send(&app, post_json("/api/sync", Some(&token), too_many)).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(error_code(&body), ErrorCode::PayloadTooLarge);

    let (status, _, body) = send(
        &app,
        post_json("/api/sync", Some(&token), push_of(MAX_PUSH_CHANGES)),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let response: SyncResponse = serde_json::from_slice(&body).expect("response");
    assert_eq!(response.accepted as usize, MAX_PUSH_CHANGES);
}

#[tokio::test]
async fn a_busy_account_gets_429() {
    let mut state = state_with_account();
    state.body_gates = Arc::new(BodyGates::new(0, 16, Duration::from_millis(20)));
    let app = app(&state);
    let token = login(&app).await.token;
    let (status, _, body) = send(&app, post_json("/api/sync", Some(&token), push_of(1))).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(error_code(&body), ErrorCode::RateLimited);
}

#[tokio::test]
async fn a_sync_waiting_too_long_for_a_parse_slot_gets_429() {
    let mut state = state_with_account();
    state.parse_gate = Arc::new(Semaphore::new(0));
    state.parse_wait = Duration::from_millis(20);
    let app = app(&state);
    let token = login(&app).await.token;
    let (status, _, body) = send(&app, post_json("/api/sync", Some(&token), push_of(1))).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(error_code(&body), ErrorCode::RateLimited);
}

#[tokio::test]
async fn a_sync_gives_its_parse_slot_back() {
    let mut state = state_with_account();
    state.parse_gate = Arc::new(Semaphore::new(1));
    state.parse_wait = Duration::from_millis(20);
    let app = app(&state);
    let token = login(&app).await.token;
    for round in 0..3 {
        let (status, _, _) = send(&app, post_json("/api/sync", Some(&token), push_of(1))).await;
        assert_eq!(status, StatusCode::OK, "sync {round}");
    }
    // A refused push (too many changes) gives it back too.
    let too_many = push_of(MAX_PUSH_CHANGES + 1);
    let (status, _, _) = send(&app, post_json("/api/sync", Some(&token), too_many)).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    let (status, _, _) = send(&app, post_json("/api/sync", Some(&token), push_of(1))).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn downloads_are_not_gated() {
    let mut state = state_with_account();
    state.body_gates = Arc::new(BodyGates::new(0, 0, Duration::from_millis(20)));
    let app = app(&state);
    let token = login(&app).await.token;
    // No such attachment: 404 (not 429) proves the GET went through the gate untouched.
    let (status, _, _) = send(&app, get_with_token("/api/files/nope", &token)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_full_account_gets_507_on_sync() {
    let store = Store::in_memory().expect("store");
    {
        let conn = store.lock().expect("lock");
        let hash = auth::hash_password(PASSWORD).expect("hash");
        store::create_account(&conn, EMAIL, &hash)
            .expect("create")
            .expect("new");
    }
    let unused = std::env::temp_dir().join("taido-router-tests-no-files");
    let limits = FileLimits {
        records_quota_bytes: 10,
        min_free_bytes: 0,
        ..FileLimits::default()
    };
    let state = AppState::new(store, FileStore::new(unused, limits));
    let app = app(&state);
    let token = login(&app).await.token;
    let (status, _, body) = send(&app, post_json("/api/sync", Some(&token), push_of(1))).await;
    assert_eq!(status.as_u16(), 507);
    assert_eq!(error_code(&body), ErrorCode::QuotaExceeded);
}
