//! `taido-sync-server` CLI (docs/SYNC.md § 4.1). Configuration through the environment:
//! `TAIDO_SYNC_BIND`, `TAIDO_SYNC_DATA_DIR`, `TAIDO_SYNC_STATIC_DIR`, `RUST_LOG`, and for the
//! forgotten-password e-mails `TAIDO_SMTP_HOST`, `TAIDO_SMTP_PORT`, `TAIDO_SMTP_USER`,
//! `TAIDO_SMTP_PASSWORD`, `TAIDO_MAIL_FROM`, `TAIDO_PUBLIC_URL`, and for the attachment files
//! `TAIDO_MAX_FILE_BYTES`, `TAIDO_ACCOUNT_QUOTA_BYTES` (the files are stored under the data
//! directory; the old `TAIDO_R2_*` settings are ignored with a warning), and `TAIDO_SIGNUPS`
//! (`open`, the default, or `closed`) for the account creation, and `TAIDO_MAIL_LANG` (`en`,
//! the default, or `fr`) for the language of the mails and of the confirmation pages.

use std::io::Write;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use taido_sync_server::mail::MailConfig;
use taido_sync_server::{
    auth, healthcheck, store, Config, FileLimits, MailLang, ServerError, Signups,
};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(
    name = "taido-sync-server",
    version,
    about = "Taido sync server (accounts by e-mail)"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Serve the API (and the PWA when TAIDO_SYNC_STATIC_DIR is set). Default.
    Serve,
    /// List the accounts: e-mail, creation, live devices.
    Accounts,
    /// List the devices, of every account or of one.
    Devices {
        /// Only the devices of this account.
        email: Option<String>,
    },
    /// Revoke one device.
    Revoke {
        /// Device id, as listed by `devices`.
        device_id: String,
    },
    /// Give the database a new epoch (run after restoring a backup).
    ResetEpoch,
    /// Exit 0 when the server answers GET /api/health within 3 s, else 1.
    Healthcheck,
}

fn init_logging() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .init();
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    let config = Config::from_env();
    let command = cli.command.unwrap_or(Command::Serve);
    if matches!(command, Command::Healthcheck) {
        // No logging: the output of a Docker health check should stay quiet.
        return if healthcheck::check(&config.bind).await {
            ExitCode::SUCCESS
        } else {
            ExitCode::FAILURE
        };
    }
    init_logging();
    let result = match command {
        Command::Serve => serve(&config).await,
        Command::Accounts => accounts(&config),
        Command::Devices { email } => devices(&config, email.as_deref()),
        Command::Revoke { device_id } => revoke(&config, &device_id),
        Command::ResetEpoch => taido_sync_server::reset_epoch(&config.data_dir).map(|epoch| {
            println!("new server epoch: {epoch}");
        }),
        Command::Healthcheck => Ok(()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err}");
            ExitCode::FAILURE
        }
    }
}

async fn serve(config: &Config) -> Result<(), ServerError> {
    let mail = MailConfig::from_env()?;
    match &mail {
        Some(mail) => tracing::info!(host = %mail.host, port = mail.port, "e-mail sending on"),
        None => tracing::warn!("TAIDO_SMTP_HOST is not set: no e-mail, password reset off"),
    }
    let limits = FileLimits::from_env()?;
    tracing::info!(
        max_file_bytes = limits.max_file_bytes,
        account_quota_bytes = limits.account_quota_bytes,
        min_free_bytes = limits.min_free_bytes,
        records_quota_bytes = limits.records_quota_bytes,
        "storage limits"
    );
    if std::env::vars_os().any(|(name, _)| name.to_string_lossy().starts_with("TAIDO_R2_")) {
        tracing::warn!("Cloudflare R2 is no longer supported: files are stored on disk");
    }
    let signups = Signups::from_env()?;
    tracing::info!(
        "signups {}",
        match signups {
            Signups::Open => "open",
            Signups::Closed => "closed",
        }
    );
    let mail_lang = MailLang::from_env()?;
    tracing::info!(lang = mail_lang.code(), "mail language");
    let server =
        taido_sync_server::bind_with(config, mail.as_ref(), limits, signups, mail_lang).await?;
    let addr = server.local_addr()?;
    {
        let mut out = std::io::stdout().lock();
        writeln!(out, "LISTENING {addr}")?;
        out.flush()?;
    }
    tracing::info!(%addr, data_dir = %config.data_dir.display(),
        static_dir = ?config.static_dir, "serving");
    server.run(shutdown_signal()).await?;
    tracing::info!("stopped");
    Ok(())
}

/// Resolves on Ctrl-C or SIGTERM.
async fn shutdown_signal() {
    let ctrl_c = async {
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}

fn accounts(config: &Config) -> Result<(), ServerError> {
    let conn = store::open_connection(&config.data_dir)?;
    println!("email\tcreated\tdevices");
    for a in store::list_accounts(&conn)? {
        println!("{}\t{}\t{}", a.email, a.created_at, a.live_devices);
    }
    Ok(())
}

fn devices(config: &Config, email: Option<&str>) -> Result<(), ServerError> {
    let email = email
        .map(|e| {
            auth::normalize_email(e)
                .ok_or_else(|| ServerError::Invalid("malformed e-mail address".into()))
        })
        .transpose()?;
    let conn = store::open_connection(&config.data_dir)?;
    let devices = store::list_devices(&conn, email.as_deref())?;
    println!("id\temail\tname\tcreated\tlast seen\trevoked");
    for d in devices {
        println!(
            "{}\t{}\t{}\t{}\t{}\t{}",
            d.id,
            d.email,
            d.name,
            d.created_at,
            d.last_seen_at.as_deref().unwrap_or("-"),
            d.revoked_at.as_deref().unwrap_or("-"),
        );
    }
    Ok(())
}

fn revoke(config: &Config, device_id: &str) -> Result<(), ServerError> {
    let conn = store::open_connection(&config.data_dir)?;
    if store::revoke_device(&conn, device_id)? {
        println!("device {device_id} revoked");
        Ok(())
    } else {
        Err(ServerError::Invalid(format!(
            "no live device with id {device_id}"
        )))
    }
}
