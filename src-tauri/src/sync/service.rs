//! The sync worker (docs/SYNC.md § 3.2, § 3.6): one task, one run at a time. When linked: a
//! run at start, then every `interval_minutes`; `poke` schedules a run 10 s after a local
//! change when something is pending; `run_now` waits for a running sync, then runs one. After
//! the first successful run of the session, the 24 h purge runs and the service pokes itself
//! so the resulting tombstones go out. After each successful run, the file job
//! (`sync::files`, V2.7 bis) sends and fetches attachment files in the background, outside the
//! run lock, one job at a time. Events go through [`SyncEvents`] (the Tauri layer emits
//! `sync-changed`, `data-changed` and `counts-changed`).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::Connection;
use tokio::sync::Notify;
use tokio::time::Instant;

use crate::db::{attachments, trash};
use crate::error::{AppError, AppResult};
use crate::sync::client::SyncClient;
use crate::sync::engine::{self, SyncError, SyncHooks};
use crate::sync::files::{self, FileOptions};
use crate::sync::model::{AccountInfo, AccountInput, ForgotInput, ResetInput, SyncStatus};
use crate::sync::store;

/// Delay between a local change and the sync it triggers.
pub const POKE_DELAY: Duration = Duration::from_secs(10);

/// What the service tells the app around it.
pub trait SyncEvents: Send + Sync {
    /// The status changed (start or end of a run, link, unlink, interval, pending count).
    fn status_changed(&self, status: &SyncStatus);
    /// Rows were applied, corrected or purged: the UI refreshes (called with the lock held).
    fn data_changed(&self, conn: &Connection);
    /// The file of an attachment of these tasks was sent, fetched, or started or stopped
    /// moving: their panels refresh the indicator (called with the lock held).
    fn attachments_changed(&self, _conn: &Connection, _task_ids: &[String]) {}
    /// The file of a notebook page's image was sent, fetched, or started or stopped moving:
    /// the notebook refreshes (called with the lock held).
    fn notes_changed(&self, _conn: &Connection) {}
}

#[derive(Debug, Default)]
struct Inner {
    running: bool,
    /// The last run could not reach the server.
    offline: bool,
    /// The purge of this session ran (after the first successful run).
    purged: bool,
    /// A run asked by a local change.
    poke_at: Option<Instant>,
    /// The next periodic run (`None` when unlinked).
    next_run: Option<Instant>,
    /// The file job is running.
    files_running: bool,
    /// A run succeeded while the file job was running: it goes once more.
    files_again: bool,
}

pub struct SyncService {
    db: Arc<Mutex<Connection>>,
    home: PathBuf,
    client: SyncClient,
    hooks: Arc<dyn SyncHooks>,
    events: Arc<dyn SyncEvents>,
    poke_delay: Duration,
    inner: Mutex<Inner>,
    wake: Notify,
    run_lock: tokio::sync::Mutex<()>,
}

impl SyncService {
    pub fn new(
        db: Arc<Mutex<Connection>>,
        home: PathBuf,
        client: SyncClient,
        hooks: Arc<dyn SyncHooks>,
        events: Arc<dyn SyncEvents>,
    ) -> Arc<Self> {
        Self::with_poke_delay(db, home, client, hooks, events, POKE_DELAY)
    }

    pub fn with_poke_delay(
        db: Arc<Mutex<Connection>>,
        home: PathBuf,
        client: SyncClient,
        hooks: Arc<dyn SyncHooks>,
        events: Arc<dyn SyncEvents>,
        poke_delay: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            db,
            home,
            client,
            hooks,
            events,
            poke_delay,
            inner: Mutex::new(Inner::default()),
            wake: Notify::new(),
            run_lock: tokio::sync::Mutex::new(()),
        })
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        // The state is a few flags: a poisoned lock keeps its last values.
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn db(&self) -> AppResult<MutexGuard<'_, Connection>> {
        Ok(self.db.lock()?)
    }

    /// The worker: runs at start when linked, then on the timer and on pokes. Never returns.
    pub async fn worker(self: Arc<Self>) {
        let linked = self
            .db()
            .and_then(|conn| store::is_linked(&conn))
            .unwrap_or(false);
        if linked {
            self.inner().next_run = Some(Instant::now());
        }
        loop {
            let deadline = {
                let inner = self.inner();
                match (inner.poke_at, inner.next_run) {
                    (Some(a), Some(b)) => Some(a.min(b)),
                    (a, b) => a.or(b),
                }
            };
            match deadline {
                Some(at) => {
                    tokio::select! {
                        () = tokio::time::sleep_until(at) => {}
                        () = self.wake.notified() => continue,
                    }
                }
                None => {
                    self.wake.notified().await;
                    continue;
                }
            }
            {
                let now = Instant::now();
                let mut inner = self.inner();
                if inner.poke_at.is_some_and(|at| at <= now) {
                    inner.poke_at = None;
                }
                if inner.next_run.is_some_and(|at| at <= now) {
                    inner.next_run = None;
                }
            }
            self.run().await;
        }
    }

    /// Current status.
    pub fn status(&self) -> AppResult<SyncStatus> {
        let conn = self.db()?;
        self.status_on(&conn)
    }

    fn status_on(&self, conn: &Connection) -> AppResult<SyncStatus> {
        let (running, offline) = {
            let inner = self.inner();
            (inner.running, inner.offline)
        };
        store::status(conn, running, offline)
    }

    fn emit_status(&self) {
        match self.status() {
            Ok(status) => self.events.status_changed(&status),
            Err(e) => log::warn!("sync: cannot read the status: {e}"),
        }
    }

    /// Runs one sync now (after the running one, if any) and returns the final status.
    /// Unlinked: returns the status at once. A successful run starts the file job in the
    /// background (never waited for here).
    pub async fn run(self: &Arc<Self>) -> SyncStatus {
        let succeeded = {
            let _single = self.run_lock.lock().await;
            self.run_locked().await
        };
        // Outside the run lock: a slow `GET /api/account` never holds the next run back.
        if succeeded {
            engine::refresh_account(&self.db, &self.client).await;
            self.start_files();
        }
        let status = self.status().unwrap_or_else(|e| {
            log::warn!("sync: cannot read the status: {e}");
            fallback_status()
        });
        self.events.status_changed(&status);
        status
    }

    /// One run under the run lock; whether it succeeded.
    async fn run_locked(&self) -> bool {
        let linked = self
            .db()
            .and_then(|conn| store::is_linked(&conn))
            .unwrap_or(false);
        if !linked {
            return false;
        }
        self.inner().running = true;
        self.emit_status();
        let (report, result) =
            engine::run_once_report(&self.db, &self.home, &self.client, self.hooks.as_ref()).await;
        {
            let mut inner = self.inner();
            inner.running = false;
            inner.offline = matches!(result, Err(SyncError::Offline(_)));
        }
        let changed = report.applied + report.corrected > 0;
        if result.is_ok() {
            let files = self.after_success(changed);
            if !files.is_empty() {
                // Hashed before removal (an edited copy stays): off the lock and the workers.
                match tokio::task::spawn_blocking(move || attachments::remove_freed(&files)).await {
                    Ok(n) => log::info!("purge: removed {n} files of purged attachments"),
                    Err(e) => log::warn!("purge: cannot remove the purged files: {e}"),
                }
            }
        } else if changed {
            // Chunks applied before the failure are committed: the UI shows them.
            self.refresh_data();
        }
        self.rearm();
        result.is_ok()
    }

    /// Starts the file job in the background, or asks the running one to go once more.
    fn start_files(self: &Arc<Self>) {
        {
            let mut inner = self.inner();
            if inner.files_running {
                inner.files_again = true;
                return;
            }
            inner.files_running = true;
        }
        let this = Arc::clone(self);
        tokio::spawn(async move { this.files_loop().await });
    }

    /// File job runs until no successful sync asked for another one. Hashes made for older
    /// attachments go out with a sync 10 s later (poke), then their files with its job.
    async fn files_loop(&self) {
        let mut running = FilesRunning {
            service: self,
            armed: true,
        };
        loop {
            let report = files::run(
                &self.db,
                &self.client,
                self.events.as_ref(),
                FileOptions::default(),
            )
            .await;
            if report.hashed > 0 {
                match self.db() {
                    Ok(conn) => self.poke(&conn),
                    Err(e) => log::warn!("sync: {e}"),
                }
            }
            let mut inner = self.inner();
            if !std::mem::take(&mut inner.files_again) {
                inner.files_running = false;
                running.armed = false;
                return;
            }
        }
    }

    /// Refreshes the UI after applied rows, then purges once per session (§ 3.2). Returns the
    /// files of the purged attachments, for the caller to remove once the lock is released.
    fn after_success(&self, changed: bool) -> Vec<attachments::Removal> {
        let conn = match self.db() {
            Ok(conn) => conn,
            Err(e) => {
                log::warn!("sync: {e}");
                return Vec::new();
            }
        };
        let purge = !std::mem::replace(&mut self.inner().purged, true);
        let mut purged = false;
        let mut files = Vec::new();
        if purge {
            match trash::purge_rows(&conn, chrono::Utc::now()) {
                Ok((p, freed)) => {
                    log::info!(
                        "purged {} deleted subjects, {} deleted tasks and {} deleted note pages",
                        p.subjects,
                        p.tasks,
                        p.pages
                    );
                    purged = p.subjects + p.tasks + p.pages > 0;
                    files = freed;
                }
                Err(e) => log::warn!("purge of deleted rows failed: {e}"),
            }
        }
        if changed || purged {
            self.events.data_changed(&conn);
        }
        if purged {
            self.poke(&conn);
        }
        files
    }

    /// Tells the UI that rows changed.
    fn refresh_data(&self) {
        match self.db() {
            Ok(conn) => self.events.data_changed(&conn),
            Err(e) => log::warn!("sync: {e}"),
        }
    }

    /// Next periodic run in `interval_minutes` when linked, none otherwise.
    fn rearm(&self) {
        let next = self.db().and_then(|conn| {
            Ok(if store::is_linked(&conn)? {
                let minutes = store::interval_minutes(&conn)?;
                Some(Instant::now() + Duration::from_secs(u64::from(minutes) * 60))
            } else {
                None
            })
        });
        match next {
            Ok(next) => self.inner().next_run = next,
            Err(e) => log::warn!("sync: cannot arm the timer: {e}"),
        }
        self.wake.notify_one();
    }

    /// A local change: when linked and something is pending, a run in 10 s (debounced). An
    /// apply records nothing, so this never loops. Called with the lock held.
    pub fn poke(&self, conn: &Connection) {
        let pending = match (store::is_linked(conn), store::pending(conn)) {
            (Ok(true), Ok(n)) => n,
            (Ok(false), _) => return,
            (Err(e), _) | (_, Err(e)) => {
                log::warn!("sync: {e}");
                return;
            }
        };
        if pending > 0 {
            self.inner().poke_at = Some(Instant::now() + self.poke_delay);
            self.wake.notify_one();
        }
        match self.status_on(conn) {
            Ok(status) => self.events.status_changed(&status),
            Err(e) => log::warn!("sync: cannot read the status: {e}"),
        }
    }

    /// Creates the account and links this device (§ 3.5), then starts a run in the background.
    pub async fn signup(&self, input: &AccountInput) -> AppResult<SyncStatus> {
        engine::signup(
            &self.db,
            &self.client,
            &input.server_url,
            &input.email,
            &input.password,
        )
        .await?;
        self.linked()
    }

    /// Logs in to the account and links this device (§ 3.5), then starts a run in the
    /// background.
    pub async fn login(&self, input: &AccountInput) -> AppResult<SyncStatus> {
        engine::login(
            &self.db,
            &self.client,
            &input.server_url,
            &input.email,
            &input.password,
        )
        .await?;
        self.linked()
    }

    /// After a link: the first run starts now; returns the status.
    fn linked(&self) -> AppResult<SyncStatus> {
        {
            let mut inner = self.inner();
            inner.offline = false;
            inner.next_run = Some(Instant::now());
        }
        self.wake.notify_one();
        self.emit_status();
        self.status()
    }

    /// E-mails a reset code (same answer whether the address has an account or not).
    pub async fn forgot_password(&self, input: &ForgotInput) -> AppResult<()> {
        engine::forgot_password(&self.client, &input.server_url, &input.email).await
    }

    /// Sets a new password from the e-mailed code (every device of the account is logged out).
    pub async fn reset_password(&self, input: &ResetInput) -> AppResult<()> {
        engine::reset_password(
            &self.client,
            &input.server_url,
            &input.email,
            &input.code,
            &input.password,
        )
        .await
    }

    /// Mails a new address-confirmation link to the linked account.
    pub async fn resend_confirmation(&self) -> AppResult<()> {
        engine::resend_confirmation(&self.db, &self.client).await
    }

    /// The linked account as last read from the server; `None` when unlinked.
    pub fn account(&self) -> AppResult<Option<AccountInfo>> {
        store::account(&*self.db()?)
    }

    /// Unlinks (§ 3.5); local data is kept.
    pub async fn unlink(&self) -> AppResult<SyncStatus> {
        engine::unlink(&self.db, &self.client).await?;
        {
            let mut inner = self.inner();
            inner.offline = false;
            inner.next_run = None;
            inner.poke_at = None;
        }
        self.wake.notify_one();
        self.emit_status();
        self.status()
    }

    /// « Télécharger » (Mac): a copy of an attachment's file in `downloads`, fetched from the
    /// server first when it is not on this Mac yet (`files::save_copy`). Returns the copy.
    pub async fn download_attachment(&self, id: &str, downloads: &Path) -> AppResult<PathBuf> {
        files::save_copy(&self.db, &self.client, self.events.as_ref(), id, downloads).await
    }

    /// Sets the automatic interval (1, 5, 15, 30 or 60 minutes) and re-arms the timer.
    pub fn set_interval(&self, minutes: u32) -> AppResult<SyncStatus> {
        if !store::INTERVALS.contains(&minutes) {
            return Err(AppError::Invalid(format!(
                "sync interval must be 1, 5, 15, 30 or 60 minutes: {minutes}"
            )));
        }
        store::set_interval_minutes(&*self.db()?, minutes)?;
        self.rearm();
        self.emit_status();
        self.status()
    }
}

/// Clears `files_running` when the file job ends without saying so (a panic, a dropped
/// task): the next successful sync starts a new job instead of waiting for it forever.
struct FilesRunning<'a> {
    service: &'a SyncService,
    armed: bool,
}

impl Drop for FilesRunning<'_> {
    fn drop(&mut self) {
        if self.armed {
            let mut inner = self.service.inner();
            inner.files_running = false;
            inner.files_again = false;
        }
    }
}

/// Status when the database cannot be read (never expected).
fn fallback_status() -> SyncStatus {
    SyncStatus {
        state: crate::sync::model::SyncState::Error,
        server_url: None,
        interval_minutes: store::DEFAULT_INTERVAL,
        last_sync_at: None,
        error_kind: Some(crate::sync::model::SyncErrorKind::Internal),
        pending: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::tests::{QuietEvents, RecordingHooks};

    /// A file job that ends without saying so (a panic, a dropped task) never blocks the next
    /// one; a job that ended normally leaves the flags to its loop.
    #[test]
    fn a_file_job_that_ends_without_saying_so_frees_the_next_one() {
        let db = Arc::new(Mutex::new(crate::db::open_in_memory().expect("db")));
        let service = SyncService::new(
            db,
            std::env::temp_dir(),
            SyncClient::new(),
            Arc::new(RecordingHooks::default()),
            Arc::new(QuietEvents),
        );
        {
            let mut inner = service.inner();
            inner.files_running = true;
            inner.files_again = true;
        }
        drop(FilesRunning {
            service: &service,
            armed: true,
        });
        assert!(!service.inner().files_running);
        assert!(!service.inner().files_again);
        service.inner().files_running = true;
        drop(FilesRunning {
            service: &service,
            armed: false,
        });
        assert!(service.inner().files_running);
    }
}
