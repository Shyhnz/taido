//! Taido sync server (docs/SYNC.md § 4, V2.7 accounts): accounts signed up by e-mail, a durable
//! log of the latest version of every synced row of each account, the attachment files (V2.7
//! bis, [`files`]), and the static PWA. The binary (`src/main.rs`) is a thin CLI over this
//! library; tests of the Mac core and of the phone start it with [`start_for_tests`], create
//! accounts with [`TestServer::create_account`] and lower the file limits with
//! [`TestServer::set_file_limits`].

pub mod auth;
pub mod error;
pub mod files;
pub mod gate;
pub mod healthcheck;
pub mod http;
pub mod mail;
pub mod mail_template;
pub mod store;
pub mod sync;

use std::future::Future;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

pub use error::{ApiError, ServerError};
pub use files::{FileLimits, FileStore};
pub use http::{router, AppState};

/// Default bind address outside Docker.
pub const DEFAULT_BIND: &str = "127.0.0.1:3020";
/// Default data directory.
pub const DEFAULT_DATA_DIR: &str = "./data";

/// Environment variable that opens or closes account creation.
pub const ENV_SIGNUPS: &str = "TAIDO_SIGNUPS";

/// Whether `POST /api/signup` creates accounts (`TAIDO_SIGNUPS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Signups {
    /// Anyone can create an account (the default).
    #[default]
    Open,
    /// Account creation is refused; login, password reset and sync are unaffected.
    Closed,
}

impl Signups {
    /// Reads [`ENV_SIGNUPS`].
    pub fn from_env() -> Result<Signups, ServerError> {
        Self::from_os_value(std::env::var_os(ENV_SIGNUPS))
    }

    /// Like [`Signups::from_env_value`], for a raw environment value: one that is not valid
    /// UTF-8 is refused (never read as open).
    pub fn from_os_value(value: Option<std::ffi::OsString>) -> Result<Signups, ServerError> {
        match value {
            None => Self::from_env_value(None),
            Some(value) => match value.to_str() {
                Some(text) => Self::from_env_value(Some(text)),
                None => Err(ServerError::Invalid(format!(
                    "{ENV_SIGNUPS} must be \"open\" or \"closed\""
                ))),
            },
        }
    }

    /// Unset or blank = open; else `open` or `closed`, in any case. Anything else is refused.
    pub fn from_env_value(value: Option<&str>) -> Result<Signups, ServerError> {
        let value = value.map(str::trim).unwrap_or_default();
        if value.is_empty() || value.eq_ignore_ascii_case("open") {
            Ok(Signups::Open)
        } else if value.eq_ignore_ascii_case("closed") {
            Ok(Signups::Closed)
        } else {
            Err(ServerError::Invalid(format!(
                "{ENV_SIGNUPS} must be \"open\" or \"closed\""
            )))
        }
    }
}

/// Runtime configuration (environment, § 4.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// `TAIDO_SYNC_BIND`.
    pub bind: String,
    /// `TAIDO_SYNC_DATA_DIR`.
    pub data_dir: PathBuf,
    /// `TAIDO_SYNC_STATIC_DIR`; `None` = no static files.
    pub static_dir: Option<PathBuf>,
}

impl Config {
    /// Reads `TAIDO_SYNC_BIND`, `TAIDO_SYNC_DATA_DIR` and `TAIDO_SYNC_STATIC_DIR`.
    pub fn from_env() -> Config {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Config {
        let non_empty = |key: &str| lookup(key).filter(|v| !v.trim().is_empty());
        Config {
            bind: non_empty("TAIDO_SYNC_BIND").unwrap_or_else(|| DEFAULT_BIND.to_string()),
            data_dir: non_empty("TAIDO_SYNC_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(DEFAULT_DATA_DIR)),
            static_dir: non_empty("TAIDO_SYNC_STATIC_DIR").map(PathBuf::from),
        }
    }
}

/// A bound, not yet running server.
pub struct BoundServer {
    listener: TcpListener,
    app: axum::Router,
}

impl BoundServer {
    pub fn local_addr(&self) -> Result<SocketAddr, ServerError> {
        Ok(self.listener.local_addr()?)
    }

    /// Serves until `shutdown` resolves, then finishes the requests in progress.
    pub async fn run<F>(self, shutdown: F) -> Result<(), ServerError>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        axum::serve(self.listener, self.app)
            .with_graceful_shutdown(shutdown)
            .await?;
        Ok(())
    }
}

/// Opens the database and binds the listener, without e-mail and with the default file limits
/// (see [`bind_with`]).
pub async fn bind(config: &Config) -> Result<BoundServer, ServerError> {
    bind_with(config, None, FileLimits::default(), Signups::Open).await
}

/// Opens the database and binds the listener; e-mails go through SMTP when `mail` is set,
/// else `/api/password/forgot` answers 503 `mail_unavailable`. Attachment files are kept in
/// `<data_dir>/files` within `limits`; `/api/signup` follows `signups`. Must run inside Tokio.
pub async fn bind_with(
    config: &Config,
    mail: Option<&mail::MailConfig>,
    limits: FileLimits,
    signups: Signups,
) -> Result<BoundServer, ServerError> {
    let files = FileStore::in_data_dir(&config.data_dir, limits);
    let mut state =
        AppState::new(store::Store::open(&config.data_dir)?, files).with_signups(signups);
    if let Some(mail) = mail {
        state = state.with_mailer(Arc::new(mail::SmtpMailer::new(mail)?));
        if let Some(url) = &mail.public_url {
            state = state.with_public_url(url.clone());
        }
    }
    bind_state(config, state).await
}

/// Binds the listener for an application state already built.
pub async fn bind_state(config: &Config, state: AppState) -> Result<BoundServer, ServerError> {
    let app = router(state, config.static_dir.as_deref());
    let listener = TcpListener::bind(&config.bind).await?;
    Ok(BoundServer { listener, app })
}

fn valid_email(email: &str) -> Result<String, ServerError> {
    auth::normalize_email(email)
        .ok_or_else(|| ServerError::Invalid("malformed e-mail address".into()))
}

/// Creates an account (address normalised, password of at least
/// [`auth::MIN_PASSWORD_CHARS`] characters); returns its id. Fails when the address is
/// malformed or taken. The password is hashed before the store is locked.
pub fn create_account(
    store: &store::Store,
    email: &str,
    password: &str,
) -> Result<String, ServerError> {
    let email = valid_email(email)?;
    auth::check_new_password(password)?;
    let hash = auth::hash_password(password)?;
    let conn = store.lock()?;
    let id = store::create_account(&conn, &email, &hash)?
        .ok_or_else(|| ServerError::Invalid("an account already uses this address".into()))?;
    // Created by the operator: nothing to confirm.
    store::mark_email_verified(&conn, &id)?;
    Ok(id)
}

/// Sets the password of the account with this address and revokes its devices. Returns the
/// number of devices revoked.
pub fn set_account_password(
    store: &store::Store,
    email: &str,
    password: &str,
) -> Result<usize, ServerError> {
    let email = valid_email(email)?;
    auth::check_new_password(password)?;
    let hash = auth::hash_password(password)?;
    let conn = store.lock()?;
    let credentials = store::account_by_email(&conn, &email)?
        .ok_or_else(|| ServerError::Invalid("no account with this address".into()))?;
    store::set_password_hash(&conn, &credentials.id, &hash)
}

/// Renews the server epoch (after restoring a backup); returns the new epoch.
pub fn reset_epoch(data_dir: &Path) -> Result<String, ServerError> {
    let conn = store::open_connection(data_dir)?;
    store::reset_epoch(&conn)
}

/// Public address of a [`TestServer`] in its mails (the links are read, never opened).
pub const TEST_PUBLIC_URL: &str = "http://taido.test";

/// A server running on `127.0.0.1:<random port>` for tests; stops when dropped.
pub struct TestServer {
    /// `http://127.0.0.1:<port>`, no trailing slash.
    pub base_url: String,
    /// The handlers' state (its store is the server's connection).
    state: AppState,
    /// Receives the e-mails (reset codes) instead of an SMTP server.
    mailer: Arc<mail::MemoryMailer>,
    shutdown: Option<oneshot::Sender<()>>,
    handle: Option<JoinHandle<()>>,
}

impl TestServer {
    /// The handlers' state, e.g. to inspect the services a test injected.
    pub fn state(&self) -> &AppState {
        &self.state
    }

    /// The e-mails the server « sent » (reset codes): nothing leaves the process.
    pub fn mailer(&self) -> &mail::MemoryMailer {
        &self.mailer
    }

    /// The reset code of the `nth` e-mail (from 1) sent to `email` (as stored: trimmed,
    /// lowercase), waiting at most `timeout` for it (the mail is sent after the 204).
    pub async fn wait_for_code(
        &self,
        email: &str,
        nth: usize,
        timeout: Duration,
    ) -> Option<String> {
        let mails = self.mailer.wait_for_mails_to(email, nth, timeout).await;
        mails
            .get(nth.checked_sub(1)?)
            .and_then(|(_, text)| mail::code_in(text))
    }

    /// Creates an account (as `POST /api/signup` would, without a device); returns its id.
    pub fn create_account(&self, email: &str, password: &str) -> Result<String, ServerError> {
        create_account(&self.state.store, email, password)
    }

    /// Changes the password of an account and revokes its devices; returns how many.
    pub fn set_password(&self, email: &str, password: &str) -> Result<usize, ServerError> {
        set_account_password(&self.state.store, email, password)
    }

    /// Changes the attachment file limits of the running server (largest file, quota of one
    /// account), e.g. to a few kilobytes so that a test never writes 100 MB. A restart goes
    /// back to the defaults of `sync_proto`. Files live under `<data_dir>/files`; see
    /// [`FileStore::file_path`] (through [`TestServer::state`]) for where one is stored.
    pub fn set_file_limits(&self, max_file_bytes: u64, account_quota_bytes: u64) {
        self.state.files.set_limits(FileLimits {
            max_file_bytes,
            account_quota_bytes,
            ..self.state.files.limits()
        });
    }

    /// The disk's free-space floor of new uploads ([`FileLimits::min_free_bytes`]) and the free
    /// space the server sees (`None`: the real disk's). A test server starts with no floor, so
    /// that no test depends on the free space of the machine that runs it.
    pub fn set_free_space(&self, min_free_bytes: u64, free_bytes: Option<u64>) {
        self.state.files.set_limits(FileLimits {
            min_free_bytes,
            ..self.state.files.limits()
        });
        self.state.files.set_free_bytes_for_tests(free_bytes);
    }

    /// Stops the server and waits (up to 5 s) until its listener is closed, so that the same
    /// port can be bound again (e.g. a test that takes the server « offline » and back).
    pub async fn stop(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(mut handle) = self.handle.take() {
            if tokio::time::timeout(std::time::Duration::from_secs(5), &mut handle)
                .await
                .is_err()
            {
                handle.abort();
                let _ = handle.await;
            }
        }
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.handle.take() {
            handle.abort();
        }
    }
}

/// Starts a server on the current Tokio runtime with its database in `data_dir` (no static
/// files), on `127.0.0.1:<random port>`. Must be called inside a Tokio runtime that keeps
/// running while the server is used. E-mails go to [`TestServer::mailer`]. No account exists on a new data dir: create them with
/// [`TestServer::create_account`]; restarting on the same data dir keeps accounts, devices and
/// attachment files (`<data_dir>/files`, default limits but no free-space floor: see
/// [`TestServer::set_file_limits`] and [`TestServer::set_free_space`]).
pub async fn start_for_tests(data_dir: &Path) -> Result<TestServer, ServerError> {
    start_for_tests_at(data_dir, "127.0.0.1:0").await
}

/// [`start_for_tests`] on a given address, e.g. the port of a stopped [`TestServer`].
pub async fn start_for_tests_at(
    data_dir: &Path,
    bind_addr: &str,
) -> Result<TestServer, ServerError> {
    start_test_server(data_dir, bind_addr).await
}

async fn start_test_server(data_dir: &Path, bind_addr: &str) -> Result<TestServer, ServerError> {
    let config = Config {
        bind: bind_addr.to_string(),
        data_dir: data_dir.to_path_buf(),
        static_dir: None,
    };
    let mailer = Arc::new(mail::MemoryMailer::new());
    let limits = FileLimits {
        min_free_bytes: 0,
        ..FileLimits::default()
    };
    let files = FileStore::in_data_dir(data_dir, limits);
    let state = AppState::new(store::Store::open(data_dir)?, files)
        .with_mailer(mailer.clone())
        .with_public_url(TEST_PUBLIC_URL);
    let server = bind_state(&config, state.clone()).await?;
    let addr = server.local_addr()?;
    let (tx, rx) = oneshot::channel::<()>();
    let handle = tokio::spawn(async move {
        let shutdown = async {
            let _ = rx.await;
        };
        if let Err(err) = server.run(shutdown).await {
            tracing::error!(error = %err, "test server stopped");
        }
    });
    Ok(TestServer {
        base_url: format!("http://{addr}"),
        state,
        mailer,
        shutdown: Some(tx),
        handle: Some(handle),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signups_value_is_case_insensitive() {
        assert_eq!(Signups::from_env_value(None).expect("unset"), Signups::Open);
        for (value, expected) in [
            ("", Signups::Open),
            ("  ", Signups::Open),
            ("open", Signups::Open),
            ("OPEN", Signups::Open),
            ("closed", Signups::Closed),
            ("Closed", Signups::Closed),
            ("CLOSED", Signups::Closed),
            (" closed ", Signups::Closed),
        ] {
            assert_eq!(
                Signups::from_env_value(Some(value)).expect(value),
                expected,
                "{value:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_signups_value_is_refused() {
        use std::os::unix::ffi::OsStringExt;
        let value = std::ffi::OsString::from_vec(vec![0x63, 0xff, 0xfe]);
        let err = Signups::from_os_value(Some(value)).expect_err("not unicode");
        assert!(err.to_string().contains("TAIDO_SIGNUPS"), "{err}");
        assert_eq!(Signups::from_os_value(None).expect("unset"), Signups::Open);
    }

    #[test]
    fn invalid_signups_value_is_refused() {
        for value in ["maybe", "false", "0", "close"] {
            let err = Signups::from_env_value(Some(value)).expect_err(value);
            assert!(err.to_string().contains("TAIDO_SIGNUPS"), "{err}");
        }
    }
}
