//! The binary: `serve` prints `LISTENING <addr>`, `accounts`, `devices`, `revoke`,
//! `reset-epoch`, `healthcheck` exit codes, static files with `TAIDO_SYNC_STATIC_DIR`, the
//! refusal of a legacy database, and logs without addresses, passwords nor tokens.

mod common;

use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, Command, Stdio};

use common::{get, post_json, request};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const BIN: &str = env!("CARGO_BIN_EXE_taido-sync-server");
const EMAIL: &str = "user@example.com";
const PASSWORD: &str = "un mot de passe solide";

fn command(data_dir: &Path, bind: &str) -> Command {
    let mut cmd = Command::new(BIN);
    cmd.env("TAIDO_SYNC_DATA_DIR", data_dir)
        .env("TAIDO_SYNC_BIND", bind)
        .env_remove("TAIDO_SYNC_STATIC_DIR")
        .env_remove("TAIDO_MAX_FILE_BYTES")
        .env_remove("TAIDO_ACCOUNT_QUOTA_BYTES")
        .env_remove("TAIDO_MIN_FREE_BYTES")
        .env_remove("TAIDO_SMTP_HOST")
        .env_remove("TAIDO_PUBLIC_URL")
        .env_remove("TAIDO_SIGNUPS")
        .env("RUST_LOG", "warn");
    cmd
}

fn run(data_dir: &Path, args: &[&str]) -> (bool, String, String) {
    let out = command(data_dir, "127.0.0.1:0")
        .args(args)
        .output()
        .expect("run");
    (
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
    )
}

async fn signup(base_url: &str, email: &str, device_name: &str) -> Value {
    let reply = post_json(
        base_url,
        "/api/signup",
        None,
        &json!({"protocol": 3, "email": email, "password": PASSWORD,
            "device_name": device_name}),
    )
    .await;
    assert_eq!(
        reply.status,
        200,
        "{}",
        String::from_utf8_lossy(&reply.body)
    );
    reply.json()
}

/// A running `serve` process; killed on drop.
struct Served {
    child: Child,
    base_url: String,
    addr: String,
}

impl Drop for Served {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn serve(data_dir: &Path, static_dir: Option<&Path>) -> Served {
    serve_with(data_dir, static_dir, &[], Stdio::null())
}

/// `serve` with extra environment variables and the given destination for its log.
fn serve_with(
    data_dir: &Path,
    static_dir: Option<&Path>,
    env: &[(&str, &str)],
    stderr: Stdio,
) -> Served {
    let mut cmd = command(data_dir, "127.0.0.1:0");
    if let Some(dir) = static_dir {
        cmd.env("TAIDO_SYNC_STATIC_DIR", dir);
    }
    cmd.envs(env.iter().copied());
    let mut child = cmd
        .arg("serve")
        .stdout(Stdio::piped())
        .stderr(stderr)
        .spawn()
        .expect("spawn serve");
    let stdout = child.stdout.take().expect("stdout");
    let mut line = String::new();
    BufReader::new(stdout)
        .read_line(&mut line)
        .expect("read line");
    let addr = line
        .trim()
        .strip_prefix("LISTENING ")
        .unwrap_or_else(|| panic!("unexpected first line {line:?}"))
        .to_string();
    Served {
        child,
        base_url: format!("http://{addr}"),
        addr,
    }
}

#[tokio::test]
async fn serve_signup_devices_revoke_and_healthcheck() {
    let dir = tempfile::tempdir().expect("tmp");
    let served = serve(dir.path(), None);

    let health = command(dir.path(), &served.addr)
        .arg("healthcheck")
        .output()
        .expect("healthcheck");
    assert!(health.status.success(), "healthcheck against a live server");
    assert!(health.stdout.is_empty());

    let body = signup(&served.base_url, EMAIL, "Mac").await;
    let token = body["token"].as_str().expect("token").to_string();
    let device_id = body["device_id"].as_str().expect("device").to_string();
    signup(&served.base_url, "other@example.com", "PC").await;

    let (ok, listing, _) = run(dir.path(), &["devices"]);
    assert!(ok);
    assert!(
        listing.contains(&device_id) && listing.contains("Mac") && listing.contains("PC"),
        "{listing}"
    );
    assert!(!listing.contains(&token), "the token is never printed");
    let (ok, listing, _) = run(dir.path(), &["devices", "User@Example.com"]);
    assert!(ok);
    assert!(listing.contains(&device_id), "{listing}");
    assert!(!listing.contains("PC"), "only that account: {listing}");

    let (ok, _, _) = run(dir.path(), &["revoke", &device_id]);
    assert!(ok);
    let r = post_json(
        &served.base_url,
        "/api/sync",
        Some(&token),
        &json!({"protocol": 3, "cursor": 0, "changes": []}),
    )
    .await;
    assert_eq!(r.status, 401);
    let (ok, _, _) = run(dir.path(), &["revoke", &device_id]);
    assert!(!ok, "already revoked");

    let (ok, out, _) = run(dir.path(), &["reset-epoch"]);
    assert!(ok);
    assert!(out.starts_with("new server epoch: "));

    let (ok, _, _) = run(dir.path(), &["set-password"]);
    assert!(!ok, "set-password is gone");

    drop(served);
}

/// Every regular file under `dir`, with its content.
fn files_under(dir: &Path) -> Vec<Vec<u8>> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir).expect("read dir").flatten() {
        let path = entry.path();
        if path.is_dir() {
            found.extend(files_under(&path));
        } else {
            found.push(std::fs::read(&path).expect("read file"));
        }
    }
    found
}

#[tokio::test(flavor = "multi_thread")]
async fn legacy_r2_settings_are_ignored() {
    let dir = tempfile::tempdir().expect("tmp");
    let log_path = dir.path().join("server.log");
    let log = std::fs::File::create(&log_path).expect("log");
    let served = serve_with(
        dir.path(),
        None,
        &[
            ("TAIDO_R2_ENDPOINT", "http://127.0.0.1:9"),
            ("TAIDO_R2_BUCKET", "bucket"),
            ("TAIDO_R2_ACCESS_KEY_ID", "key-id"),
            ("TAIDO_R2_SECRET_ACCESS_KEY", "secret"),
            ("TAIDO_MIN_FREE_BYTES", "0"),
        ],
        Stdio::from(log),
    );
    let token = signup(&served.base_url, EMAIL, "Mac").await["token"]
        .as_str()
        .expect("token")
        .to_string();
    let data: Vec<u8> = (0..3_000u32).map(|i| (i * 31 % 251) as u8).collect();
    let hash: String = Sha256::digest(&data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let synced = post_json(
        &served.base_url,
        "/api/sync",
        Some(&token),
        &json!({"protocol": 3, "cursor": 0, "changes": [{
            "entity": "attachment", "id": "a1", "updated_at": "2026-10-10T09:00:00.000Z",
            "device_id": "",
            "data": {"task_id": "t1", "file_name": "devis.pdf", "mime_type": "application/pdf",
                     "size": data.len(), "created_at": "2026-10-10T09:00:00.000Z",
                     "deleted_at": null}}]}),
    )
    .await;
    assert_eq!(
        synced.status,
        200,
        "{}",
        String::from_utf8_lossy(&synced.body)
    );

    let put = request(
        &served.base_url,
        "PUT",
        &format!("/api/files/a1?offset=0&size={}&sha256={hash}", data.len()),
        Some(&token),
        &data,
    )
    .await;
    assert_eq!(put.status, 200, "{}", String::from_utf8_lossy(&put.body));
    assert_eq!(put.json()["complete"], json!(true));

    // The file sits on the server's disk, under `<data dir>/files`.
    assert_eq!(files_under(&dir.path().join("files")), vec![data.clone()]);
    let got = request(&served.base_url, "GET", "/api/files/a1", Some(&token), b"").await;
    assert_eq!(got.status, 200);
    assert_eq!(got.body, data);

    drop(served);
    let log = std::fs::read_to_string(&log_path).expect("read log");
    assert_eq!(
        log.matches("Cloudflare R2 is no longer supported").count(),
        1,
        "{log}"
    );
    assert!(!log.contains("secret"), "the keys are never logged: {log}");
}

#[tokio::test]
async fn accounts_lists_the_accounts_and_set_plan_is_gone() {
    let dir = tempfile::tempdir().expect("tmp");
    let served = serve(dir.path(), None);
    signup(&served.base_url, EMAIL, "Mac").await;
    signup(&served.base_url, "other@example.com", "PC").await;

    let (ok, listing, _) = run(dir.path(), &["accounts"]);
    assert!(ok);
    assert!(listing.starts_with("email\tcreated\tdevices"), "{listing}");
    let user = listing
        .lines()
        .find(|l| l.starts_with(EMAIL))
        .unwrap_or_else(|| panic!("{listing}"));
    let fields: Vec<&str> = user.split('\t').collect();
    assert_eq!(fields.len(), 3, "{user}");
    assert_eq!(fields[2], "1", "one live device: {user}");
    assert!(listing.contains("other@example.com"));

    let (ok, _, _) = run(dir.path(), &["set-plan", EMAIL, "pro"]);
    assert!(!ok, "set-plan is gone");
    drop(served);
}

#[test]
fn a_legacy_database_is_refused() {
    let dir = tempfile::tempdir().expect("tmp");
    {
        let conn = rusqlite::Connection::open(dir.path().join("sync.sqlite3")).expect("db");
        conn.execute_batch(include_str!("../migrations/0001_init.sql"))
            .expect("legacy schema");
        conn.execute_batch(
            "PRAGMA user_version = 1;
             INSERT INTO meta (key, value) VALUES ('password_hash', '$argon2id$x');",
        )
        .expect("legacy data");
    }
    let out = command(dir.path(), "127.0.0.1:0")
        .arg("serve")
        .output()
        .expect("serve");
    assert!(!out.status.success());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("legacy"), "{stderr}");
    assert!(stderr.contains("new, empty data directory"), "{stderr}");
}

#[test]
fn a_malformed_file_limit_stops_the_server() {
    let dir = tempfile::tempdir().expect("tmp");
    for (key, value) in [
        ("TAIDO_MAX_FILE_BYTES", "100 Mo"),
        ("TAIDO_ACCOUNT_QUOTA_BYTES", "-1"),
        ("TAIDO_MIN_FREE_BYTES", "2 Go"),
    ] {
        let out = command(dir.path(), "127.0.0.1:0")
            .env(key, value)
            .arg("serve")
            .output()
            .expect("serve");
        assert!(!out.status.success(), "{key}");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(stderr.contains(key), "{stderr}");
        assert!(!String::from_utf8_lossy(&out.stdout).contains("LISTENING"));
    }
}

#[test]
fn an_invalid_signups_value_stops_the_server() {
    let dir = tempfile::tempdir().expect("tmp");
    let out = command(dir.path(), "127.0.0.1:0")
        .env("TAIDO_SIGNUPS", "maybe")
        .arg("serve")
        .output()
        .expect("serve");
    assert!(!out.status.success());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("TAIDO_SIGNUPS"), "{stderr}");
    assert!(!String::from_utf8_lossy(&out.stdout).contains("LISTENING"));
}

#[tokio::test]
async fn logs_never_contain_addresses_passwords_nor_tokens() {
    let dir = tempfile::tempdir().expect("tmp");
    let mut child = command(dir.path(), "127.0.0.1:0")
        .env("RUST_LOG", "trace")
        .arg("serve")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn");
    // Drain stderr while the server runs (a full pipe would block it).
    let mut stderr = child.stderr.take().expect("stderr");
    let reader = std::thread::spawn(move || {
        let mut logs = String::new();
        let _ = stderr.read_to_string(&mut logs);
        logs
    });
    let mut line = String::new();
    BufReader::new(child.stdout.take().expect("stdout"))
        .read_line(&mut line)
        .expect("line");
    let base = format!(
        "http://{}",
        line.trim().strip_prefix("LISTENING ").expect("address")
    );

    let email = "Secret.Person@Example.com";
    let token = signup(&base, email, "Mac").await["token"]
        .as_str()
        .expect("token")
        .to_string();
    let taken = post_json(
        &base,
        "/api/signup",
        None,
        &json!({"protocol": 3, "email": email, "password": PASSWORD, "device_name": "Mac"}),
    )
    .await;
    assert_eq!(taken.status, 409);
    for (address, password) in [
        (email, "wrong password!"),
        ("unknown@example.com", PASSWORD),
    ] {
        let r = post_json(
            &base,
            "/api/login",
            None,
            &json!({"protocol": 3, "email": address, "password": password,
                "device_name": "Mac"}),
        )
        .await;
        assert_eq!(r.status, 401);
    }
    let ok = post_json(
        &base,
        "/api/login",
        None,
        &json!({"protocol": 3, "email": email, "password": PASSWORD, "device_name": "Mac"}),
    )
    .await;
    assert_eq!(ok.status, 200);
    let account = request(&base, "GET", "/api/account", Some(&token), b"").await;
    assert_eq!(account.status, 200);

    let _ = child.kill();
    let _ = child.wait();
    let logs = reader.join().expect("logs");
    assert!(logs.contains("account created"), "trace logs were captured");
    for secret in [
        "secret.person",
        "Secret.Person",
        "unknown@example.com",
        PASSWORD,
        "wrong password!",
        token.as_str(),
    ] {
        assert!(!logs.contains(secret), "{secret:?} found in the logs");
    }
}

#[test]
fn healthcheck_fails_without_a_server() {
    let dir = tempfile::tempdir().expect("tmp");
    // A port that was free a moment ago: nothing listens on it.
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .expect("port")
        .port();
    let out = command(dir.path(), &format!("127.0.0.1:{port}"))
        .arg("healthcheck")
        .output()
        .expect("healthcheck");
    assert_eq!(out.status.code(), Some(1));
    let bad = command(dir.path(), "not an address")
        .arg("healthcheck")
        .output()
        .expect("healthcheck");
    assert_eq!(bad.status.code(), Some(1));
}

#[tokio::test]
async fn serves_the_pwa() {
    let data = tempfile::tempdir().expect("data");
    let public = tempfile::tempdir().expect("public");
    std::fs::create_dir_all(public.path().join("assets")).expect("assets");
    std::fs::write(
        public.path().join("index.html"),
        "<!doctype html><title>Todo</title>",
    )
    .expect("index");
    std::fs::write(public.path().join("assets/app-1.js"), "1").expect("js");
    let served = serve(data.path(), Some(public.path()));

    let r = get(&served.base_url, "/assets/x.js").await;
    assert_eq!(r.status, 404);
    let r = get(&served.base_url, "/assets/app-1.js").await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.headers["cache-control"],
        "public, max-age=31536000, immutable"
    );
    let r = get(&served.base_url, "/projets/inbox").await;
    assert_eq!(r.status, 200);
    assert!(String::from_utf8_lossy(&r.body).starts_with("<!doctype html>"));
    assert_eq!(r.headers["cache-control"], "no-cache");
    assert!(r.headers["content-security-policy"].contains("default-src 'self'"));
    assert_eq!(r.headers["x-content-type-options"], "nosniff");
    let r = get(&served.base_url, "/api/health").await;
    assert_eq!(r.status, 200);
}
