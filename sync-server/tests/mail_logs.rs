//! The forgotten-password flow writes neither the code nor the address in the logs. Its own
//! test binary: it installs the process-wide tracing subscriber (all levels, every thread,
//! blocking tasks included).

mod common;

use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::post_json;
use serde_json::json;
use taido_sync_server::start_for_tests;

const EMAIL: &str = "user.secret@example.com";
const PASSWORD: &str = "un mot de passe solide";
const NEW_PASSWORD: &str = "un nouveau mot de passe";

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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_code_nor_address_in_the_logs() {
    let logs = Captured::default();
    let writer = logs.clone();
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        // No timestamps: their microseconds could look like a code.
        .without_time()
        .with_writer(move || writer.clone())
        .init();

    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    server.create_account(EMAIL, PASSWORD).expect("account");
    let base = server.base_url.clone();

    let r = post_json(
        &base,
        "/api/password/forgot",
        None,
        &json!({"protocol": 3, "email": EMAIL}),
    )
    .await;
    assert_eq!(r.status, 204);
    let code = server
        .wait_for_code(EMAIL, 1, Duration::from_secs(5))
        .await
        .expect("code mailed");
    let wrong = format!(
        "{:06}",
        (code.parse::<u32>().expect("digits") + 1) % 1_000_000
    );
    let r = post_json(
        &base,
        "/api/password/reset",
        None,
        &json!({"protocol": 3, "email": EMAIL, "code": wrong, "password": NEW_PASSWORD}),
    )
    .await;
    assert_eq!(r.status, 400);
    let r = post_json(
        &base,
        "/api/password/reset",
        None,
        &json!({"protocol": 3, "email": EMAIL, "code": code, "password": NEW_PASSWORD}),
    )
    .await;
    assert_eq!(r.status, 204);

    // A failed send is logged, still without the address.
    server.mailer().set_failing(true);
    let r = post_json(
        &base,
        "/api/password/forgot",
        None,
        &json!({"protocol": 3, "email": EMAIL}),
    )
    .await;
    assert_eq!(r.status, 204);
    let read = || String::from_utf8(logs.0.lock().expect("logs").clone()).expect("utf-8");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !read().contains("not sent") && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let text = read();
    assert!(
        text.contains("password reset"),
        "the flow is logged:\n{text}"
    );
    assert!(
        text.contains("not sent"),
        "the failed send is logged:\n{text}"
    );
    // Both forgot requests logged the same line, nothing that tells the address exists.
    assert_eq!(
        text.matches("password reset requested").count(),
        2,
        "{text}"
    );
    for secret in [EMAIL, "user.secret", &code, &wrong, NEW_PASSWORD] {
        assert!(!text.contains(secret), "{secret:?} in the logs:\n{text}");
    }
}
