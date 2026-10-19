//! The sync engine (docs/SYNC.md § 2.6–2.7, § 3.4–3.5): link, unlink and one run. It knows
//! the database, the documents folder, the HTTP client and a [`SyncHooks`]; never an
//! `AppHandle` (the Tauri layer, `sync::service`, adds events, timers and terminals). The
//! database mutex is never held across an `await`.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{params, Connection};
use sync_proto::{
    Change, ChangeKey, Entity, ErrorCode, SyncRequest, SyncResponse, Versioned, EPOCH_STAMP,
    MAX_PUSH_BYTES, MAX_PUSH_CHANGES, PROTOCOL_VERSION,
};

use crate::db::{attachments, now_utc, workspace};
use crate::error::{AppError, AppResult};
use crate::sync::client::{ClientError, SyncClient};
use crate::sync::model::{AccountInfo, SyncErrorKind};
use crate::sync::{apply, rows, store};

/// Requests of one run, at most (§ 2.7).
const MAX_REQUESTS: usize = 1000;
/// What the engine needs from the app around it.
pub trait SyncHooks: Send + Sync {
    /// Called before an apply, without the DB lock: close the terminals of these tasks
    /// (the Tauri layer calls `TerminalService::close_task` for each).
    fn close_tasks(&self, task_ids: &[String]);
}

/// What one run did (logs and tests).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunReport {
    pub requests: usize,
    pub pushed: usize,
    pub accepted: usize,
    pub rejected: usize,
    pub applied: usize,
    pub parked: usize,
    pub corrected: usize,
    pub closed_task_ids: Vec<String>,
    pub epoch_reset: bool,
}

/// Why a run failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncError {
    /// No account linked: nothing was done.
    NotLinked,
    /// The server could not be reached (network error, timeout).
    Offline(String),
    /// 401: the token was revoked; the user links again.
    Unauthorized,
    /// The server speaks another protocol version.
    UnsupportedProtocol,
    /// Any other HTTP error, an HTML page or unreadable JSON.
    Server(String),
    /// Local failure (database…).
    Internal(String),
    /// The device was unlinked or linked again during the run: the run stopped without
    /// writing anything for the old link.
    Superseded,
}

impl SyncError {
    /// The kind stored in `sync_last_error`; `None` for offline (kept in memory) and unlinked.
    pub fn kind(&self) -> Option<SyncErrorKind> {
        match self {
            SyncError::NotLinked | SyncError::Offline(_) | SyncError::Superseded => None,
            SyncError::Unauthorized => Some(SyncErrorKind::Unauthorized),
            SyncError::UnsupportedProtocol => Some(SyncErrorKind::UnsupportedProtocol),
            SyncError::Server(_) => Some(SyncErrorKind::Server),
            SyncError::Internal(_) => Some(SyncErrorKind::Internal),
        }
    }
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncError::NotLinked => f.write_str("not linked"),
            SyncError::Offline(e) => write!(f, "offline: {e}"),
            SyncError::Unauthorized => f.write_str("unauthorized"),
            SyncError::UnsupportedProtocol => f.write_str("unsupported protocol"),
            SyncError::Server(e) => write!(f, "server error: {e}"),
            SyncError::Internal(e) => write!(f, "internal error: {e}"),
            SyncError::Superseded => f.write_str("the link changed during the run"),
        }
    }
}

impl From<AppError> for SyncError {
    fn from(e: AppError) -> Self {
        SyncError::Internal(e.to_string())
    }
}

impl From<rusqlite::Error> for SyncError {
    fn from(e: rusqlite::Error) -> Self {
        SyncError::Internal(e.to_string())
    }
}

impl From<ClientError> for SyncError {
    fn from(e: ClientError) -> Self {
        match e {
            ClientError::Offline(e) => SyncError::Offline(e),
            ClientError::Status { status: 401, .. } => SyncError::Unauthorized,
            ClientError::Status {
                code: Some(ErrorCode::UnsupportedProtocol),
                ..
            } => SyncError::UnsupportedProtocol,
            ClientError::Status { status, code } => {
                SyncError::Server(format!("HTTP {status} ({code:?})"))
            }
            ClientError::BadBody(e) => SyncError::Server(e),
            ClientError::Internal(e) => SyncError::Internal(e),
        }
    }
}

fn lock(db: &Mutex<Connection>) -> Result<MutexGuard<'_, Connection>, SyncError> {
    db.lock()
        .map_err(|e| SyncError::Internal(format!("database lock poisoned: {e}")))
}

// ---------------------------------------------------------------------------
// Link and unlink (§ 3.5)
// ---------------------------------------------------------------------------

/// Trims, drops trailing `/`, and accepts `https://host[…]`, or `http://127.0.0.1[:port]` /
/// `http://localhost[:port]` (tests). Else `invalid`.
pub fn normalize_url(raw: &str) -> AppResult<String> {
    let url = raw.trim().trim_end_matches('/').to_string();
    let invalid = || AppError::Invalid(format!("bad server address: {url}"));
    let parsed = reqwest::Url::parse(&url).map_err(|_| invalid())?;
    let host = parsed.host_str().unwrap_or_default();
    let ok = match parsed.scheme() {
        "https" => !host.is_empty(),
        "http" => {
            (host == "127.0.0.1" || host == "localhost")
                && (parsed.path().is_empty() || parsed.path() == "/")
                && parsed.query().is_none()
        }
        _ => false,
    };
    if ok && parsed.username().is_empty() && parsed.password().is_none() {
        Ok(url)
    } else {
        Err(invalid())
    }
}

/// How this device joins an account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Join {
    /// Creates the account (`POST /api/signup`).
    Signup,
    /// An existing account (`POST /api/login`).
    Login,
}

/// The error the UI translates for a failed account request (signup, login, forgotten
/// password, reset).
pub fn account_error(e: ClientError) -> AppError {
    match e {
        ClientError::Offline(e) => AppError::SyncOffline(e),
        ClientError::Internal(e) => AppError::Internal(e),
        ClientError::Status {
            code: Some(code),
            status,
        } => match code {
            ErrorCode::Unauthorized => AppError::SyncAuth,
            ErrorCode::RateLimited => AppError::SyncRateLimited,
            ErrorCode::EmailTaken => AppError::SyncEmailTaken,
            ErrorCode::WeakPassword => AppError::SyncWeakPassword,
            ErrorCode::BadEmail => AppError::SyncBadEmail,
            ErrorCode::InvalidCode => AppError::SyncInvalidCode,
            ErrorCode::MailUnavailable => AppError::SyncMailUnavailable,
            ErrorCode::SignupsClosed => AppError::SyncSignupsClosed,
            other => AppError::SyncServer(format!("HTTP {status} ({other:?})")),
        },
        // A proxy's page instead of the server's JSON error.
        ClientError::Status {
            status: 401,
            code: None,
        } => AppError::SyncAuth,
        ClientError::Status {
            status: 429,
            code: None,
        } => AppError::SyncRateLimited,
        other => AppError::SyncServer(other.to_string()),
    }
}

/// Creates the account and links this device ([`join`]).
pub async fn signup(
    db: &Arc<Mutex<Connection>>,
    client: &SyncClient,
    server_url: &str,
    email: &str,
    password: &str,
) -> AppResult<()> {
    join(db, client, server_url, email, password, Join::Signup).await
}

/// Logs in to the account and links this device ([`join`]).
pub async fn login(
    db: &Arc<Mutex<Connection>>,
    client: &SyncClient,
    server_url: &str,
    email: &str,
    password: &str,
) -> AppResult<()> {
    join(db, client, server_url, email, password, Join::Login).await
}

/// Signs up or logs in, then links this device: forgets what a previous link learnt from its
/// server (cursor, epoch, known versions, parked rows: a V1 server, another account), stores
/// the link (cursor 0), re-enqueues every row without an outbox entry (§ 2.6) and has the
/// file job check every attachment file with the new server (V2.7 bis); finally reads the
/// account (best effort). Errors: `invalid` (address, or [`ALREADY_LINKED`]: see
/// [`check_can_join`]), then [`account_error`].
async fn join(
    db: &Arc<Mutex<Connection>>,
    client: &SyncClient,
    server_url: &str,
    email: &str,
    password: &str,
    how: Join,
) -> AppResult<()> {
    let url = normalize_url(server_url)?;
    let email = email.trim();
    // Name of this device on the server, in the user's language.
    let device = {
        let conn = db.lock()?;
        check_can_join(&conn, email, how)?;
        crate::i18n::device_name(crate::i18n::current_language(&conn))
    };
    let login = match how {
        Join::Signup => client.signup(&url, email, password, device).await,
        Join::Login => client.login(&url, email, password, device).await,
    }
    .map_err(account_error)?;
    {
        let conn = db.lock()?;
        let tx = conn.unchecked_transaction()?;
        store::forget_server_state(&tx)?;
        store::save_link(
            &tx,
            &store::Link {
                server_url: url,
                token: login.token,
                device_id: login.device_id,
                server_epoch: login.server_epoch,
            },
        )?;
        re_enqueue(&tx)?;
        attachments::recheck_after_link(&tx)?;
        tx.commit()?;
    }
    refresh_account(db, client).await;
    Ok(())
}

/// Message of the `invalid` refusal of a signup or login while linked (the UI matches it).
pub const ALREADY_LINKED: &str = "already linked to an account: log out first";

/// Linked: no signup, and a login only to the cached account (a re-login after a refused
/// token), compared trimmed and lowercased. Logging in to another account would merge this
/// Mac's rows into it.
fn check_can_join(conn: &Connection, email: &str, how: Join) -> AppResult<()> {
    if !store::is_linked(conn)? {
        return Ok(());
    }
    let same_account = how == Join::Login
        && store::account(conn)?
            .is_some_and(|account| account.email.trim().to_lowercase() == email.to_lowercase());
    if same_account {
        Ok(())
    } else {
        Err(AppError::Invalid(ALREADY_LINKED.into()))
    }
}

/// Asks the server to e-mail a reset code (`POST /api/password/forgot`, answered the same
/// whether the address has an account or not).
pub async fn forgot_password(client: &SyncClient, server_url: &str, email: &str) -> AppResult<()> {
    let url = normalize_url(server_url)?;
    client
        .forgot_password(&url, email.trim())
        .await
        .map_err(account_error)
}

/// Sets a new password from the e-mailed code; every device of the account is logged out
/// (this one logs in again with [`login`]).
pub async fn reset_password(
    client: &SyncClient,
    server_url: &str,
    email: &str,
    code: &str,
    password: &str,
) -> AppResult<()> {
    let url = normalize_url(server_url)?;
    client
        .reset_password(&url, email.trim(), code.trim(), password)
        .await
        .map_err(account_error)
}

/// Asks the server to mail a new confirmation link to the linked account's address.
pub async fn resend_confirmation(
    db: &Arc<Mutex<Connection>>,
    client: &SyncClient,
) -> AppResult<()> {
    let link = {
        let conn = db.lock().map_err(AppError::from)?;
        store::link(&conn)?
    }
    .ok_or(AppError::SyncAuth)?;
    client
        .resend_confirmation(&link.server_url, &link.token)
        .await
        .map_err(account_error)
}

/// Reads the linked account (`GET /api/account`) and caches it in the settings. Best effort:
/// a failure is logged and the cached value kept.
pub async fn refresh_account(db: &Arc<Mutex<Connection>>, client: &SyncClient) {
    let link = match db
        .lock()
        .map_err(AppError::from)
        .and_then(|c| store::link(&c))
    {
        Ok(Some(link)) => link,
        Ok(None) => return,
        Err(e) => {
            log::warn!("sync: cannot read the link: {e}");
            return;
        }
    };
    let account = match client.account(&link.server_url, &link.token).await {
        Ok(account) => AccountInfo {
            email: account.email,
            email_verified: account.email_verified,
        },
        Err(e) => {
            log::info!("sync: cannot read the account: {e}");
            return;
        }
    };
    let saved = db.lock().map_err(AppError::from).and_then(|conn| {
        // Never cache the account of an old link on a new one.
        if store::link(&conn)?.is_some_and(|current| current.token == link.token) {
            store::set_account(&conn, &account)?;
        }
        Ok(())
    });
    if let Err(e) = saved {
        log::warn!("sync: cannot save the account: {e}");
    }
}

/// Revokes the token on the server when reachable (5 s, errors ignored), then forgets the
/// link. The URL, the outbox, the known versions and the parked rows are kept.
pub async fn unlink(db: &Arc<Mutex<Connection>>, client: &SyncClient) -> AppResult<()> {
    let link = {
        let conn = db.lock()?;
        store::link(&conn)?
    };
    if let Some(link) = link {
        if let Err(e) = client.logout(&link.server_url, &link.token).await {
            log::info!("sync: logout failed, unlinking anyway: {e}");
        }
    }
    let conn = db.lock()?;
    store::clear_link(&conn)
}

/// Every row (live or soft-deleted) without an outbox entry is enqueued with its known
/// version, or [`EPOCH_STAMP`] when none is known. Existing entries are kept as they are:
/// they hold real edits (§ 2.6).
pub fn re_enqueue(conn: &Connection) -> AppResult<usize> {
    conn.execute("UPDATE sync_guard SET seq = seq + 1 WHERE id = 1", [])?;
    let seq = store::seq(conn)?;
    let mut n = 0;
    // A device that never set a shared setting has no row for it: nothing is sent.
    // An `attachments` row is an `attachment` when a task owns it, a `note_attachment` when
    // a notebook page does.
    for (table, key, entity, filter) in [
        ("subjects", "id", "subject", "1"),
        ("sections", "id", "section", "1"),
        ("tasks", "id", "task", "1"),
        ("synced_settings", "key", "setting", "1"),
        ("board_columns", "id", "board_column", "1"),
        ("time_segments", "id", "time_segment", "1"),
        ("task_relations", "id", "relation", "1"),
        ("attachments", "id", "attachment", "t.task_id IS NOT NULL"),
        ("note_groups", "id", "note_group", "1"),
        ("note_pages", "id", "note_page", "1"),
        (
            "attachments",
            "id",
            "note_attachment",
            "t.note_page_id IS NOT NULL",
        ),
    ] {
        n += conn.execute(
            &format!(
                "INSERT INTO sync_outbox (entity, id, seq, changed_at, purged) \
                 SELECT ?1, t.{key}, ?2, COALESCE(k.stamp, ?3), 0 FROM {table} t \
                 LEFT JOIN sync_known k ON k.entity = ?1 AND k.id = t.{key} WHERE {filter} \
                 ON CONFLICT (entity, id) DO NOTHING"
            ),
            params![entity, seq, EPOCH_STAMP],
        )?;
    }
    Ok(n)
}

// ---------------------------------------------------------------------------
// One run (§ 2.7, § 3.4)
// ---------------------------------------------------------------------------

/// Wire names of the entities this build reads: declared in every sync request, so that the
/// server sends nothing an older build could not read (docs/SYNC.md § 0.1).
fn known_entities() -> Vec<String> {
    Entity::ALL.iter().map(|e| e.as_str().to_string()).collect()
}

/// One outbox entry sent in a request.
struct SentEntry {
    key: ChangeKey,
    seq: i64,
    stamp: String,
    tombstone: bool,
}

/// One sync run. Records the outcome in the settings (`sync_last_success_at`,
/// `sync_last_error`; offline is not recorded) and creates the missing project folders when
/// rows were applied or corrected. (The service uses [`run_once_report`].)
#[cfg(test)]
pub async fn run_once(
    db: &Arc<Mutex<Connection>>,
    documents: &Path,
    client: &SyncClient,
    hooks: &dyn SyncHooks,
) -> Result<RunReport, SyncError> {
    let (report, result) = run_once_report(db, documents, client, hooks).await;
    result.map(|()| report)
}

/// [`run_once`], with the report of what was done even when the run failed: chunks applied
/// before the failure are committed, and the UI must show them.
pub async fn run_once_report(
    db: &Arc<Mutex<Connection>>,
    documents: &Path,
    client: &SyncClient,
    hooks: &dyn SyncHooks,
) -> (RunReport, Result<(), SyncError>) {
    let mut report = RunReport::default();
    let result = run_and_record(db, documents, client, hooks, &mut report).await;
    (report, result)
}

/// Whether `link` is still the stored link (an unlink or a new link replaces its token).
fn still_linked(conn: &Connection, link: &store::Link) -> Result<bool, SyncError> {
    Ok(store::link(conn)?.is_some_and(|current| current.token == link.token))
}

async fn run_and_record(
    db: &Arc<Mutex<Connection>>,
    documents: &Path,
    client: &SyncClient,
    hooks: &dyn SyncHooks,
    report: &mut RunReport,
) -> Result<(), SyncError> {
    let link = {
        let conn = lock(db)?;
        store::link(&conn)?
    };
    let mut result = match &link {
        Some(link) => run_chunks(db, client, hooks, link, report).await,
        None => Err(SyncError::NotLinked),
    };
    let conn = lock(db)?;
    if let Some(link) = &link {
        // Never record the outcome of a run of an old link on the new one.
        if result.as_ref().err() != Some(&SyncError::Superseded) && !still_linked(&conn, link)? {
            result = Err(SyncError::Superseded);
        }
    }
    if report.applied + report.corrected > 0 {
        match workspace::ensure(&conn, documents) {
            Ok(0) => {}
            Ok(n) => log::info!("sync: created the folders of {n} projects"),
            Err(e) => log::warn!("sync: preparing the project folders failed: {e}"),
        }
    }
    match &result {
        Ok(()) => {
            store::record_success(&conn, &now_utc())?;
            log::info!(
                "sync: {} requests, {} pushed, {} accepted, {} rejected, {} applied, {} parked, \
                 {} corrected",
                report.requests,
                report.pushed,
                report.accepted,
                report.rejected,
                report.applied,
                report.parked,
                report.corrected
            );
        }
        Err(SyncError::Superseded) => {
            log::info!("sync: the link changed during the run, stopped");
        }
        Err(e) => {
            if let Some(kind) = e.kind() {
                store::record_error(&conn, kind)?;
            }
            if *e != SyncError::NotLinked {
                log::warn!("sync failed: {e}");
            }
        }
    }
    result
}

async fn run_chunks(
    db: &Arc<Mutex<Connection>>,
    client: &SyncClient,
    hooks: &dyn SyncHooks,
    link: &store::Link,
    report: &mut RunReport,
) -> Result<(), SyncError> {
    let mut last_seq = {
        let conn = lock(db)?;
        if store::declare_entities(&conn, &known_entities())? {
            log::info!("sync: this Mac reads new kinds of rows, pulling everything again");
        }
        store::seq(&conn)?
    };
    let mut epoch = link.server_epoch.clone();
    let mut sent: HashSet<ChangeKey> = HashSet::new();
    let mut limit = MAX_PUSH_CHANGES;
    for _ in 0..MAX_REQUESTS {
        let (changes, entries, more, cursor) = {
            let conn = lock(db)?;
            if !still_linked(&conn, link)? {
                return Err(SyncError::Superseded);
            }
            let (changes, entries, more) =
                build_chunk(&conn, last_seq, &sent, limit, &link.device_id)?;
            (changes, entries, more, store::cursor(&conn)?)
        };
        let request = SyncRequest {
            protocol: PROTOCOL_VERSION,
            cursor,
            changes,
            known_entities: Some(known_entities()),
        };
        report.requests += 1;
        let response = match client.sync(&link.server_url, &link.token, &request).await {
            Ok(response) => response,
            Err(ClientError::Status { status: 413, .. }) => {
                if entries.len() <= 1 {
                    return Err(SyncError::Server(
                        "a single change is larger than the server accepts".into(),
                    ));
                }
                limit = (entries.len() / 2).max(1);
                log::info!("sync: request too large, retrying with {limit} changes");
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        if response.protocol != PROTOCOL_VERSION {
            return Err(SyncError::UnsupportedProtocol);
        }
        if response.server_epoch != epoch {
            if report.epoch_reset {
                return Err(SyncError::Server("the server epoch changed twice".into()));
            }
            log::warn!("sync: the server database was reset or restored, sending everything again");
            report.epoch_reset = true;
            let conn = lock(db)?;
            if !still_linked(&conn, link)? {
                return Err(SyncError::Superseded);
            }
            let tx = conn.unchecked_transaction()?;
            store::set_epoch(&tx, &response.server_epoch)?;
            store::set_cursor(&tx, 0)?;
            re_enqueue(&tx)?;
            // The restored server may have lost files too: the file job checks them all.
            attachments::recheck_after_link(&tx)?;
            last_seq = store::seq(&tx)?;
            tx.commit()?;
            epoch = response.server_epoch;
            sent.clear();
            continue;
        }

        // Terminals of the tasks the response deletes or completes, closed without the lock.
        let to_close = {
            let conn = lock(db)?;
            let skip = skipped_keys(&conn, &entries)?;
            let applied: Vec<Change> = response
                .changes
                .iter()
                .filter(|c| !skip.contains(&c.key()))
                .cloned()
                .collect();
            apply::tasks_to_close(&conn, &applied)?
        };
        if !to_close.is_empty() {
            hooks.close_tasks(&to_close);
            report.closed_task_ids.extend(to_close);
        }

        let has_more = response.has_more;
        let freed = commit_response(db, link, response, &entries, report)?;
        if !freed.is_empty() {
            // Hashed before removal (an edited copy stays): off the lock and the async workers.
            // Never fails the run: a file left behind is only disk space (no path in the logs).
            match tokio::task::spawn_blocking(move || attachments::remove_freed(&freed)).await {
                Ok(n) => log::info!("sync: removed {n} files of deleted attachments"),
                Err(e) => log::warn!("sync: cannot remove the files of deleted attachments: {e}"),
            }
        }
        report.pushed += entries.len();
        sent.extend(entries.into_iter().map(|e| e.key));
        if !more && !has_more {
            return Ok(());
        }
    }
    Err(SyncError::Server(format!(
        "more than {MAX_REQUESTS} requests in one sync"
    )))
}

/// Applies one response and updates the outbox, the known versions and the cursor, in one
/// transaction. Nothing is written when the device was unlinked or linked again meanwhile
/// (the response belongs to the old link: its cursor and outbox state are not the new one's).
/// Returns what to remove of the files of the attachments the response deleted (V2.7 bis),
/// for the caller to remove once the lock is released.
fn commit_response(
    db: &Arc<Mutex<Connection>>,
    link: &store::Link,
    response: SyncResponse,
    entries: &[SentEntry],
    report: &mut RunReport,
) -> Result<Vec<attachments::Removal>, SyncError> {
    let conn = lock(db)?;
    if !still_linked(&conn, link)? {
        return Err(SyncError::Superseded);
    }
    let tx = conn.unchecked_transaction()?;
    let skip = skipped_keys(&tx, entries)?;
    let returned: HashSet<ChangeKey> = response.changes.iter().map(Change::key).collect();
    let rejected: HashSet<ChangeKey> = response.rejected.iter().cloned().collect();
    let outcome = apply::apply(&tx, response.changes, &skip)?;

    for entry in entries {
        let entity = entry.key.entity.as_str();
        if rejected.contains(&entry.key) {
            log::warn!(
                "sync: the server rejected {entity} {} (dropped from the outbox)",
                entry.key.id
            );
        } else if !returned.contains(&entry.key) {
            // Stored by the server: it is now this row's latest known version.
            if entry.tombstone {
                store::forget_known(&tx, entity, &entry.key.id)?;
            } else {
                store::set_known(&tx, entity, &entry.key.id, &entry.stamp)?;
            }
        }
        // Sent and unchanged since: done (a refused change got the server's version back).
        tx.execute(
            "DELETE FROM sync_outbox WHERE entity = ?1 AND id = ?2 AND seq = ?3",
            params![entity, entry.key.id, entry.seq],
        )?;
    }
    store::set_cursor(&tx, response.cursor)?;
    tx.commit()?;
    report.accepted += response.accepted as usize;
    report.rejected += response.rejected.len();
    report.applied += outcome.applied;
    report.parked = outcome.parked;
    report.corrected += outcome.corrected;
    // Chosen under the lock (which copies a live attachment still uses), removed after it.
    match attachments::removals(&conn, outcome.freed_files) {
        Ok(removals) => Ok(removals),
        Err(e) => {
            log::warn!("sync: cannot list the files of deleted attachments: {e}");
            Ok(Vec::new())
        }
    }
}

/// Keys whose pulled versions must not be applied: every outbox entry, except the entries of
/// this chunk unchanged since they were sent (§ 2.7, in-flight skip).
fn skipped_keys(conn: &Connection, entries: &[SentEntry]) -> AppResult<HashSet<ChangeKey>> {
    let unchanged: HashSet<(&ChangeKey, i64)> = entries.iter().map(|e| (&e.key, e.seq)).collect();
    let mut stmt = conn.prepare("SELECT entity, id, seq FROM sync_outbox")?;
    let rows: Vec<(String, String, i64)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    let mut skip = HashSet::new();
    for (entity, id, seq) in rows {
        let Some(entity) = Entity::parse(&entity) else {
            continue;
        };
        let key = ChangeKey { entity, id };
        if !unchanged.contains(&(&key, seq)) {
            skip.insert(key);
        }
    }
    Ok(skip)
}

/// The next chunk: outbox entries with `seq ≤ last_seq` not sent in this run, by `seq`, at
/// most `limit` changes and [`MAX_PUSH_BYTES`] of JSON (one larger change goes alone).
/// Entries that fail validation are logged and dropped. Returns the changes, their entries
/// and whether entries are left for another chunk.
fn build_chunk(
    conn: &Connection,
    last_seq: i64,
    sent: &HashSet<ChangeKey>,
    limit: usize,
    device_id: &str,
) -> Result<(Vec<Change>, Vec<SentEntry>, bool), SyncError> {
    let mut stmt = conn.prepare(
        "SELECT entity, id, seq, changed_at, purged FROM sync_outbox WHERE seq <= ?1 \
         ORDER BY seq, CASE entity WHEN 'subject' THEN 0 WHEN 'section' THEN 1 \
         WHEN 'board_column' THEN 2 WHEN 'task' THEN 3 WHEN 'note_group' THEN 4 \
         WHEN 'note_page' THEN 5 ELSE 6 END, id",
    )?;
    let queued: Vec<(String, String, i64, String, bool)> = stmt
        .query_map([last_seq], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<Result<_, _>>()?;
    let mut changes = Vec::new();
    let mut entries = Vec::new();
    let mut bytes = 0usize;
    for (entity_name, id, seq, stamp, purged) in queued {
        let Some(entity) = Entity::parse(&entity_name) else {
            conn.execute(
                "DELETE FROM sync_outbox WHERE entity = ?1 AND id = ?2",
                params![entity_name, id],
            )?;
            continue;
        };
        let key = ChangeKey {
            entity,
            id: id.clone(),
        };
        if sent.contains(&key) {
            continue;
        }
        let change = local_change(conn, entity, &id, &stamp, purged, device_id)?;
        if let Err(e) = change.validate() {
            log::warn!("sync: dropping invalid local {entity_name} {id}: {e}");
            conn.execute(
                "DELETE FROM sync_outbox WHERE entity = ?1 AND id = ?2 AND seq = ?3",
                params![entity_name, id, seq],
            )?;
            continue;
        }
        let size = serde_json::to_vec(&change)
            .map_err(|e| SyncError::Internal(e.to_string()))?
            .len();
        if changes.len() >= limit || (!changes.is_empty() && bytes + size > MAX_PUSH_BYTES) {
            return Ok((changes, entries, true));
        }
        bytes += size;
        entries.push(SentEntry {
            key,
            seq,
            stamp,
            tombstone: change.is_tombstone(),
        });
        changes.push(change);
    }
    Ok((changes, entries, false))
}

/// The wire version of an outbox entry: a tombstone when purged or gone, else the row's
/// synced columns. The conflict stamp is the entry's `changed_at`.
fn local_change(
    conn: &Connection,
    entity: Entity,
    id: &str,
    stamp: &str,
    purged: bool,
    device_id: &str,
) -> AppResult<Change> {
    fn versioned<T>(id: &str, stamp: &str, device_id: &str, data: Option<T>) -> Versioned<T> {
        Versioned {
            id: id.to_string(),
            updated_at: stamp.to_string(),
            device_id: device_id.to_string(),
            data,
        }
    }
    Ok(match entity {
        Entity::Subject => {
            let data = if purged {
                None
            } else {
                rows::subject(conn, id)?
            };
            Change::Subject(versioned(id, stamp, device_id, data))
        }
        Entity::Section => {
            let data = if purged {
                None
            } else {
                rows::section(conn, id)?
            };
            Change::Section(versioned(id, stamp, device_id, data))
        }
        Entity::Task => {
            let data = if purged { None } else { rows::task(conn, id)? };
            Change::Task(versioned(id, stamp, device_id, data))
        }
        // A purged setting gives a tombstone, refused by `validate` (settings are never
        // deleted): the entry is dropped by `build_chunk`.
        Entity::Setting => {
            let data = if purged {
                None
            } else {
                rows::setting(conn, id)?
            };
            Change::Setting(versioned(id, stamp, device_id, data))
        }
        Entity::BoardColumn => {
            let data = if purged {
                None
            } else {
                rows::board_column(conn, id)?
            };
            Change::BoardColumn(versioned(id, stamp, device_id, data))
        }
        Entity::TimeSegment => {
            let data = if purged {
                None
            } else {
                rows::time_segment(conn, id)?
            };
            Change::TimeSegment(versioned(id, stamp, device_id, data))
        }
        Entity::Relation => {
            let data = if purged {
                None
            } else {
                rows::relation(conn, id)?
            };
            Change::Relation(versioned(id, stamp, device_id, data))
        }
        Entity::Attachment => {
            let data = if purged {
                None
            } else {
                rows::attachment(conn, id)?
            };
            Change::Attachment(versioned(id, stamp, device_id, data))
        }
        Entity::NoteGroup => {
            let data = if purged {
                None
            } else {
                rows::note_group(conn, id)?
            };
            Change::NoteGroup(versioned(id, stamp, device_id, data))
        }
        Entity::NotePage => {
            let data = if purged {
                None
            } else {
                rows::note_page(conn, id)?
            };
            Change::NotePage(versioned(id, stamp, device_id, data))
        }
        Entity::NoteAttachment => {
            let data = if purged {
                None
            } else {
                rows::note_attachment(conn, id)?
            };
            Change::NoteAttachment(versioned(id, stamp, device_id, data))
        }
    })
}
