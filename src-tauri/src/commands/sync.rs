//! Sync and account commands. Thin: they
//! delegate to the sync service, which emits `sync-changed`. Every command is `async`
//! (bug #4): a link or a sync waits on the network.

use tauri::State;

use crate::app_state::AppState;
use crate::error::AppResult;
use crate::sync::model::{AccountInfo, AccountInput, ForgotInput, ResetInput};
use crate::sync::SyncStatus;

/// State of the sync with the server.
#[tauri::command]
#[specta::specta]
pub async fn sync_status(state: State<'_, AppState>) -> AppResult<SyncStatus> {
    state.sync.status()
}

/// Syncs now and resolves once done (waits for a sync already running). Never throws for
/// a failed sync: the failure is in the returned status. Unlinked: returns the status.
#[tauri::command]
#[specta::specta]
pub async fn sync_now(state: State<'_, AppState>) -> AppResult<SyncStatus> {
    Ok(state.sync.run().await)
}

/// Creates an account on the server and links this Mac, then starts the first sync in the
/// background (every row goes out). `invalid` (bad address), `sync_email_taken`,
/// `sync_weak_password`, `sync_bad_email`, `sync_rate_limited`, `sync_offline`, `sync_server`.
#[tauri::command]
#[specta::specta]
pub async fn sync_signup(state: State<'_, AppState>, input: AccountInput) -> AppResult<SyncStatus> {
    state.sync.signup(&input).await
}

/// Logs in to an account and links this Mac, then starts the first sync in the background.
/// `invalid` (bad address), `sync_auth` (wrong e-mail or password), `sync_rate_limited`,
/// `sync_offline`, `sync_server`.
#[tauri::command]
#[specta::specta]
pub async fn sync_login(state: State<'_, AppState>, input: AccountInput) -> AppResult<SyncStatus> {
    state.sync.login(&input).await
}

/// Asks the server to e-mail a 6-digit reset code. Succeeds whether the address has an
/// account or not. `invalid`, `sync_bad_email`, `sync_rate_limited`, `sync_mail_unavailable`,
/// `sync_offline`, `sync_server`.
#[tauri::command]
#[specta::specta]
pub async fn sync_forgot_password(state: State<'_, AppState>, input: ForgotInput) -> AppResult<()> {
    state.sync.forgot_password(&input).await
}

/// Sets a new password from the e-mailed code; every device of the account is logged out (the
/// UI then calls `sync_login`). `invalid`, `sync_invalid_code`, `sync_weak_password`,
/// `sync_rate_limited`, `sync_offline`, `sync_server`.
#[tauri::command]
#[specta::specta]
pub async fn sync_reset_password(state: State<'_, AppState>, input: ResetInput) -> AppResult<()> {
    state.sync.reset_password(&input).await
}

/// Mails a new address-confirmation link to the linked account. `sync_auth` (unlinked or
/// token refused), `sync_rate_limited`, `sync_mail_unavailable`, `sync_offline`, `sync_server`.
#[tauri::command]
#[specta::specta]
pub async fn sync_resend_confirmation(state: State<'_, AppState>) -> AppResult<()> {
    state.sync.resend_confirmation().await
}

/// The linked account (e-mail) as last read from the server; `null` when unlinked.
#[tauri::command]
#[specta::specta]
pub async fn sync_account(state: State<'_, AppState>) -> AppResult<Option<AccountInfo>> {
    state.sync.account()
}

/// Unlinks (revokes the token on the server when reachable); local data is kept.
#[tauri::command]
#[specta::specta]
pub async fn sync_unlink(state: State<'_, AppState>) -> AppResult<SyncStatus> {
    state.sync.unlink().await
}

/// Automatic sync interval: 1, 5, 15, 30 or 60 minutes, else `invalid`.
#[tauri::command]
#[specta::specta]
pub async fn sync_set_interval(state: State<'_, AppState>, minutes: u32) -> AppResult<SyncStatus> {
    state.sync.set_interval(minutes)
}
