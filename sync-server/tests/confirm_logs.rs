//! The address-confirmation flow writes neither the address nor the link's token in the
//! logs, even at TRACE (the token travels in the query of the page). Its own test binary: it
//! installs the process-wide tracing subscriber.

mod common;

use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{get, post_json, request};
use serde_json::json;
use taido_sync_server::{mail, start_for_tests};

const EMAIL: &str = "camille.secret@example.com";
const PASSWORD: &str = "un mot de passe solide";

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
async fn no_address_nor_token_in_the_logs() {
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
    let base = server.base_url.clone();
    let r = post_json(
        &base,
        "/api/signup",
        None,
        &json!({"protocol": 3, "email": EMAIL, "password": PASSWORD, "device_name": "Mac"}),
    )
    .await;
    assert_eq!(r.status, 200);
    let token = r.json()["token"].as_str().expect("token").to_string();
    let mails = server
        .mailer()
        .wait_for_mails_to(EMAIL, 1, Duration::from_secs(5))
        .await;
    let link = mail::confirm_token_in(&mails[0].1).expect("link");
    assert_eq!(
        get(&base, &format!("/confirmer?t={link}")).await.status,
        200
    );
    let r = request(
        &base,
        "POST",
        "/confirmer",
        None,
        format!("t={link}").as_bytes(),
    )
    .await;
    assert_eq!(r.status, 200);
    let r = request(&base, "POST", "/api/email/resend", Some(&token), b"").await;
    assert_eq!(r.status, 204);

    let text = String::from_utf8(logs.0.lock().expect("logs").clone()).expect("utf-8");
    assert!(text.contains("address confirmed"), "{text}");
    for secret in [EMAIL, "camille.secret", &link, &token] {
        assert!(!text.contains(secret), "{secret:?} in the logs:\n{text}");
    }
}
