//! View models of the sync exposed to the UI (docs/SYNC.md § 3.7). The doc comments are those
//! of `src/bindings.ts`: tauri-specta copies them into the generated file.

use serde::{Deserialize, Serialize};
use specta::Type;

/// `unlinked`: no account; `idle`: up to date or waiting for the next sync.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SyncState {
    Unlinked,
    Idle,
    Syncing,
    Offline,
    Error,
}

/// Why the last sync failed, when `state` is `error`. `deletions_held`: the phone found many
/// rows gone at once and waits for a confirmation before pushing their deletion (never set
/// by the Mac, docs/SYNC.md § 6.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SyncErrorKind {
    Unauthorized,
    Server,
    UnsupportedProtocol,
    Internal,
    DeletionsHeld,
}

/// View model of the sync (Réglages › Synchro, sidebar button).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub state: SyncState,
    /// Kept after `sync_unlink` to prefill the form; `null` before the first link.
    pub server_url: Option<String>,
    /// Automatic sync every N minutes: 1, 5 (default), 15, 30 or 60.
    pub interval_minutes: u32,
    /// Last successful sync, ISO 8601 UTC.
    pub last_sync_at: Option<String>,
    /// Set when `state` is `error`.
    pub error_kind: Option<SyncErrorKind>,
    /// Local changes not yet sent.
    pub pending: u32,
}

/// `sync_signup` and `sync_login`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountInput {
    /// `https://…` (or `http://127.0.0.1:…` / `http://localhost:…`); a trailing `/` is dropped.
    /// There is no built-in server: the user always types the address.
    pub server_url: String,
    pub email: String,
    /// At least 10 characters for a new account.
    pub password: String,
}

/// `sync_forgot_password`: e-mails a 6-digit code when the address has an account.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ForgotInput {
    pub server_url: String,
    pub email: String,
}

/// `sync_reset_password`: the e-mailed code and the new password (10 characters at least).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResetInput {
    pub server_url: String,
    pub email: String,
    pub code: String,
    pub password: String,
}

/// The linked account, as last read from the server (at link and after each successful sync).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub email: String,
    /// The address was confirmed (link of the signup mail). Absent from an account cached
    /// before: confirmed.
    #[serde(default = "confirmed")]
    pub email_verified: bool,
}

fn confirmed() -> bool {
    true
}
