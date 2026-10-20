//! Address confirmation: mail at signup, page with one
//! button, form that confirms, resend, password reset confirms too.

mod common;

use std::time::Duration;

use common::{get, post_json, request};
use serde_json::json;
use taido_sync_server::mail::{self, verify_subject, welcome_subject, MailLang};
use taido_sync_server::{
    start_for_tests, start_for_tests_with_lang, store, TestServer, TEST_PUBLIC_URL,
};

const EMAIL: &str = "camille@example.com";
const PASSWORD: &str = "un mot de passe solide";
const WAIT: Duration = Duration::from_secs(5);

async fn signup(server: &TestServer) -> String {
    let r = post_json(
        &server.base_url,
        "/api/signup",
        None,
        &json!({"protocol": 3, "email": EMAIL, "password": PASSWORD, "device_name": "Mac"}),
    )
    .await;
    assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
    r.json()["token"].as_str().expect("token").to_string()
}

async fn verified(server: &TestServer, token: &str) -> bool {
    let r = request(&server.base_url, "GET", "/api/account", Some(token), b"").await;
    assert_eq!(r.status, 200);
    r.json()["email_verified"]
        .as_bool()
        .expect("email_verified")
}

/// The confirmation token of the `nth` mail (from 1) sent to [`EMAIL`].
async fn link_token(server: &TestServer, nth: usize) -> String {
    link_token_in(server, nth, MailLang::En).await
}

async fn link_token_in(server: &TestServer, nth: usize, lang: MailLang) -> String {
    let mails = server.mailer().wait_for_mails_to(EMAIL, nth, WAIT).await;
    let (subject, text) = mails.get(nth - 1).expect("mail").clone();
    assert_eq!(subject, verify_subject(lang));
    assert!(
        text.contains(&format!("{TEST_PUBLIC_URL}/confirmer?t=")),
        "{text}"
    );
    mail::confirm_token_in(&text).expect("token in the mail")
}

fn html(reply: &common::Reply) -> String {
    String::from_utf8_lossy(&reply.body).into_owned()
}

#[tokio::test]
async fn signup_sends_a_link_that_confirms_after_a_click() {
    confirm_flow(
        MailLang::En,
        [
            "Confirm my address",
            "Address confirmed",
            "open ",
            "This link no longer works",
        ],
    )
    .await;
}

#[tokio::test]
async fn confirmation_pages_and_mails_follow_mail_lang_fr() {
    confirm_flow(
        MailLang::Fr,
        [
            "Confirmer mon adresse",
            "Adresse confirmée",
            "ouvre ",
            "Ce lien ne marche plus",
        ],
    )
    .await;
}

/// `texts`: the button of the page, the page once confirmed, the verb of the welcome mail's
/// first step, the page of a used link.
async fn confirm_flow(lang: MailLang, texts: [&str; 4]) {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests_with_lang(dir.path(), lang)
        .await
        .expect("server");
    let token = signup(&server).await;
    assert!(!verified(&server, &token).await);
    let link = link_token_in(&server, 1, lang).await;

    // Opening the link only shows a page (mail scanners open links on their own).
    let page = get(&server.base_url, &format!("/confirmer?t={link}")).await;
    assert_eq!(page.status, 200);
    assert!(page.headers["content-type"].starts_with("text/html"));
    assert!(page.headers.contains_key("content-security-policy"));
    let body = html(&page);
    assert!(body.contains(texts[0]) && body.contains(&link));
    assert!(!verified(&server, &token).await);

    let done = request(
        &server.base_url,
        "POST",
        "/confirmer",
        None,
        format!("t={link}").as_bytes(),
    )
    .await;
    assert_eq!(done.status, 200);
    assert!(html(&done).contains(texts[1]));
    assert!(verified(&server, &token).await);

    // Then the welcome mail, once.
    let mails = server.mailer().wait_for_mails_to(EMAIL, 2, WAIT).await;
    assert_eq!(mails[1].0, welcome_subject(lang));
    assert!(mails[1].1.contains(&format!(
        "{}{}",
        texts[2],
        TEST_PUBLIC_URL.trim_start_matches("http://")
    )));

    // Used once.
    let again = request(
        &server.base_url,
        "POST",
        "/confirmer",
        None,
        format!("t={link}").as_bytes(),
    )
    .await;
    assert_eq!(again.status, 400);
    assert!(html(&again).contains(texts[3]));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(server.mailer().mails_to(EMAIL).len(), 2, "one welcome mail");
}

#[tokio::test]
async fn wrong_or_missing_links_are_refused() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    let token = signup(&server).await;
    for body in ["t=nope", "", "t=<script>", "x=1"] {
        let r = request(
            &server.base_url,
            "POST",
            "/confirmer",
            None,
            body.as_bytes(),
        )
        .await;
        assert_eq!(r.status, 400, "{body}");
    }
    let page = get(&server.base_url, "/confirmer").await;
    assert_eq!(page.status, 400);
    let page = get(&server.base_url, "/confirmer?t=%3Cb%3E").await;
    assert_eq!(page.status, 400);
    assert!(!verified(&server, &token).await);
}

#[tokio::test]
async fn an_expired_link_does_not_confirm() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    let token = signup(&server).await;
    let link = link_token(&server, 1).await;
    {
        let conn = server.state().store.lock().expect("lock");
        conn.execute(
            "UPDATE email_verifications SET expires_at = '2000-01-01T00:00:00.000Z'",
            [],
        )
        .expect("expire");
    }
    let r = request(
        &server.base_url,
        "POST",
        "/confirmer",
        None,
        format!("t={link}").as_bytes(),
    )
    .await;
    assert_eq!(r.status, 400);
    assert!(!verified(&server, &token).await);
}

#[tokio::test]
async fn resend_sends_a_new_link_and_is_limited() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    let token = signup(&server).await;
    let first = link_token(&server, 1).await;
    let r = request(
        &server.base_url,
        "POST",
        "/api/email/resend",
        Some(&token),
        b"",
    )
    .await;
    assert_eq!(r.status, 204);
    let second = link_token(&server, 2).await;
    assert_ne!(first, second);

    // The old link no longer works, the new one does.
    let old = request(
        &server.base_url,
        "POST",
        "/confirmer",
        None,
        format!("t={first}").as_bytes(),
    )
    .await;
    assert_eq!(old.status, 400);

    // 3 resends an hour.
    for _ in 0..2 {
        let r = request(
            &server.base_url,
            "POST",
            "/api/email/resend",
            Some(&token),
            b"",
        )
        .await;
        assert_eq!(r.status, 204);
    }
    let r = request(
        &server.base_url,
        "POST",
        "/api/email/resend",
        Some(&token),
        b"",
    )
    .await;
    assert_eq!(r.status, 429);
    assert_eq!(r.error(), "rate_limited");

    let last = link_token(&server, 4).await;
    let ok = request(
        &server.base_url,
        "POST",
        "/confirmer",
        None,
        format!("t={last}").as_bytes(),
    )
    .await;
    assert_eq!(ok.status, 200);
    assert!(verified(&server, &token).await);

    // Confirmed: a resend sends nothing (4 links, then the welcome mail).
    let before = server
        .mailer()
        .wait_for_mails_to(EMAIL, 5, WAIT)
        .await
        .len();
    let r = request(
        &server.base_url,
        "POST",
        "/api/email/resend",
        Some(&token),
        b"",
    )
    .await;
    assert_eq!(r.status, 204);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(server.mailer().mails_to(EMAIL).len(), before);

    let r = request(&server.base_url, "POST", "/api/email/resend", None, b"").await;
    assert_eq!(r.status, 401);
}

#[tokio::test]
async fn a_password_reset_by_mail_confirms_the_address() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    let token = signup(&server).await;
    link_token(&server, 1).await;
    let r = post_json(
        &server.base_url,
        "/api/password/forgot",
        None,
        &json!({"protocol": 3, "email": EMAIL}),
    )
    .await;
    assert_eq!(r.status, 204);
    let code = server.wait_for_code(EMAIL, 2, WAIT).await.expect("code");
    let r = post_json(
        &server.base_url,
        "/api/password/reset",
        None,
        &json!({"protocol": 3, "email": EMAIL, "code": code,
            "password": "un autre mot de passe"}),
    )
    .await;
    assert_eq!(r.status, 204);
    let r = post_json(
        &server.base_url,
        "/api/login",
        None,
        &json!({"protocol": 3, "email": EMAIL, "password": "un autre mot de passe",
            "device_name": "Mac"}),
    )
    .await;
    let token2 = r.json()["token"].as_str().expect("token").to_string();
    assert!(verified(&server, &token2).await);
    drop(token);
}

#[tokio::test]
async fn accounts_created_by_the_operator_are_confirmed() {
    let dir = tempfile::tempdir().expect("tmp");
    let server = start_for_tests(dir.path()).await.expect("server");
    let id = server.create_account(EMAIL, PASSWORD).expect("account");
    let conn = server.state().store.lock().expect("lock");
    let account = store::account_by_id(&conn, &id)
        .expect("read")
        .expect("account");
    assert!(account.email_verified);
    drop(conn);
    assert!(server.mailer().mails_to(EMAIL).is_empty());
}
