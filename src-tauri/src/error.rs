//! Application error type, serialized to the UI as `{ kind, message }`.
//!
//! **Contract with the UI** (bug #12): every command error carries a stable `kind`, the only
//! field the UI translates into French; `message` is an English detail for the console and
//! the logs, never shown as is. The kinds are:
//!
//! | `kind`      | Meaning                                                              |
//! | ----------- | -------------------------------------------------------------------- |
//! | `not_found` | The item (task, project, section, subtask, folder…) no longer exists, |
//! |             | or is deleted (soft delete), or the path to open does not exist.     |
//! | `invalid`   | The input was refused (empty name, relative path, bad date…).        |
//! | `no_folder` | A terminal needs a working folder and the task has none:  |
//! |             | the UI asks for one (`pick_folder` then `set_task_folder`).          |
//! | `folder_missing` | The task's working folder does not exist on disk any more.      |
//! | `claude_missing` | The `claude` binary cannot be found.                 |
//! | `codex_missing` | The `codex` binary cannot be found. |
//! | `internal`  | Anything else: database, migration, I/O, opener, poisoned lock, PTY. |
//! | `sync_auth` | Account (login, signup…): wrong e-mail address or password.          |
//! | `sync_rate_limited` | Account: too many attempts, try again in a few minutes.      |
//! | `sync_email_taken` | Signup: an account already uses this address.                 |
//! | `sync_weak_password` | Signup, reset: the password has fewer than 10 characters.   |
//! | `sync_bad_email` | Signup, forgotten password: the address is not `x@y.z`.         |
//! | `sync_invalid_code` | Reset: the e-mailed code is wrong, expired or used up.       |
//! | `sync_mail_unavailable` | Forgotten password: the server cannot send e-mails.      |
//! | `sync_signups_closed` | Signup: the server does not accept new accounts.           |
//! | `sync_offline` | Account: the sync server cannot be reached.                       |
//! | `sync_server` | Account: the sync server answered with an unexpected error.        |
//! | `file_not_here` | « Télécharger »: the attachment's file is not on this Mac and there |
//! |             | is no account to fetch it from.                                      |
//! | `file_not_on_server` | « Télécharger »: the server does not have the file (yet).   |
//! | `downloads_denied` | « Télécharger »: macOS refused access to the Downloads folder  |
//! |             | (Réglages Système › Confidentialité et sécurité › Fichiers et dossiers). |
//! | `disk_full` | « Télécharger »: no space left on this Mac for the file.              |
//! | `file_write_failed` | « Télécharger »: the file could not be written on this Mac.   |
//!
//! New variants must map to one of these kinds, or add a kind here and in the UI.

use serde::Serialize;
use specta::Type;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid input: {0}")]
    Invalid(String),
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("migration error: {0}")]
    Migration(#[from] rusqlite_migration::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("no working folder for task {0}")]
    NoFolder(String),
    #[error("working folder missing: {0}")]
    FolderMissing(String),
    #[error("claude binary not found")]
    ClaudeMissing,
    #[error("codex binary not found")]
    CodexMissing,
    #[error("internal error: {0}")]
    Internal(String),
    #[error("sync server refused the e-mail address or the password")]
    SyncAuth,
    #[error("too many attempts on the sync server")]
    SyncRateLimited,
    #[error("an account already uses this e-mail address")]
    SyncEmailTaken,
    #[error("the password is too short")]
    SyncWeakPassword,
    #[error("malformed e-mail address")]
    SyncBadEmail,
    #[error("wrong or expired reset code")]
    SyncInvalidCode,
    #[error("the sync server cannot send e-mails")]
    SyncMailUnavailable,
    #[error("the sync server does not accept new accounts")]
    SyncSignupsClosed,
    #[error("sync server unreachable: {0}")]
    SyncOffline(String),
    #[error("sync server error: {0}")]
    SyncServer(String),
    #[error("the file of attachment {0} is not on this Mac and there is no account")]
    FileNotHere(String),
    #[error("the server does not have the file of attachment {0}")]
    FileNotOnServer(String),
    #[error("access to the downloads folder refused: {0}")]
    DownloadsDenied(String),
    #[error("no space left on this Mac: {0}")]
    DiskFull(String),
    #[error("cannot write the file on this Mac: {0}")]
    FileWriteFailed(String),
    /// Dictation: macOS refused the microphone (Réglages Système › Confidentialité).
    #[error("microphone access refused")]
    MicDenied,
    /// Dictation cannot run: no model, no microphone, or not macOS.
    #[error("dictation unavailable: {0}")]
    VoiceUnavailable(String),
}

pub type AppResult<T> = Result<T, AppError>;

/// Error shape seen by the UI.
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    pub kind: ErrorKind,
    pub message: String,
}

/// Stable error kinds the UI translates (see the module documentation).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    NotFound,
    Invalid,
    NoFolder,
    FolderMissing,
    ClaudeMissing,
    CodexMissing,
    Internal,
    SyncAuth,
    SyncRateLimited,
    SyncEmailTaken,
    SyncWeakPassword,
    SyncBadEmail,
    SyncInvalidCode,
    SyncMailUnavailable,
    SyncSignupsClosed,
    SyncOffline,
    SyncServer,
    FileNotHere,
    FileNotOnServer,
    DownloadsDenied,
    DiskFull,
    FileWriteFailed,
    MicDenied,
    VoiceUnavailable,
}

impl AppError {
    pub fn kind(&self) -> ErrorKind {
        match self {
            AppError::NotFound(_) => ErrorKind::NotFound,
            AppError::Invalid(_) => ErrorKind::Invalid,
            AppError::NoFolder(_) => ErrorKind::NoFolder,
            AppError::FolderMissing(_) => ErrorKind::FolderMissing,
            AppError::ClaudeMissing => ErrorKind::ClaudeMissing,
            AppError::CodexMissing => ErrorKind::CodexMissing,
            AppError::SyncAuth => ErrorKind::SyncAuth,
            AppError::SyncRateLimited => ErrorKind::SyncRateLimited,
            AppError::SyncEmailTaken => ErrorKind::SyncEmailTaken,
            AppError::SyncWeakPassword => ErrorKind::SyncWeakPassword,
            AppError::SyncBadEmail => ErrorKind::SyncBadEmail,
            AppError::SyncInvalidCode => ErrorKind::SyncInvalidCode,
            AppError::SyncMailUnavailable => ErrorKind::SyncMailUnavailable,
            AppError::SyncSignupsClosed => ErrorKind::SyncSignupsClosed,
            AppError::SyncOffline(_) => ErrorKind::SyncOffline,
            AppError::SyncServer(_) => ErrorKind::SyncServer,
            AppError::FileNotHere(_) => ErrorKind::FileNotHere,
            AppError::FileNotOnServer(_) => ErrorKind::FileNotOnServer,
            AppError::DownloadsDenied(_) => ErrorKind::DownloadsDenied,
            AppError::DiskFull(_) => ErrorKind::DiskFull,
            AppError::FileWriteFailed(_) => ErrorKind::FileWriteFailed,
            AppError::MicDenied => ErrorKind::MicDenied,
            AppError::VoiceUnavailable(_) => ErrorKind::VoiceUnavailable,
            _ => ErrorKind::Internal,
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        ErrorPayload {
            kind: self.kind(),
            message: self.to_string(),
        }
        .serialize(serializer)
    }
}

impl Type for AppError {
    fn definition(types: &mut specta::Types) -> specta::datatype::DataType {
        ErrorPayload::definition(types)
    }
}

impl From<tauri_plugin_opener::Error> for AppError {
    fn from(e: tauri_plugin_opener::Error) -> Self {
        AppError::Internal(format!("opener: {e}"))
    }
}

impl<T> From<std::sync::PoisonError<T>> for AppError {
    fn from(e: std::sync::PoisonError<T>) -> Self {
        AppError::Internal(format!("lock poisoned: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_error_serializes_a_stable_kind() {
        let cases: Vec<(AppError, &str)> = vec![
            (AppError::NotFound("task x".into()), "not_found"),
            (AppError::Invalid("empty".into()), "invalid"),
            (AppError::NoFolder("t".into()), "no_folder"),
            (AppError::FolderMissing("/x".into()), "folder_missing"),
            (AppError::ClaudeMissing, "claude_missing"),
            (AppError::CodexMissing, "codex_missing"),
            (AppError::Db(rusqlite::Error::InvalidQuery), "internal"),
            (AppError::Io(std::io::Error::other("disk")), "internal"),
            (AppError::Internal("boom".into()), "internal"),
            (AppError::SyncAuth, "sync_auth"),
            (AppError::SyncRateLimited, "sync_rate_limited"),
            (AppError::SyncEmailTaken, "sync_email_taken"),
            (AppError::SyncWeakPassword, "sync_weak_password"),
            (AppError::SyncBadEmail, "sync_bad_email"),
            (AppError::SyncInvalidCode, "sync_invalid_code"),
            (AppError::SyncMailUnavailable, "sync_mail_unavailable"),
            (AppError::SyncSignupsClosed, "sync_signups_closed"),
            (AppError::SyncOffline("timeout".into()), "sync_offline"),
            (AppError::SyncServer("HTTP 500".into()), "sync_server"),
            (AppError::FileNotHere("att".into()), "file_not_here"),
            (
                AppError::FileNotOnServer("att".into()),
                "file_not_on_server",
            ),
            (
                AppError::DownloadsDenied("EPERM".into()),
                "downloads_denied",
            ),
            (AppError::DiskFull("ENOSPC".into()), "disk_full"),
            (AppError::FileWriteFailed("EIO".into()), "file_write_failed"),
        ];
        for (error, kind) in cases {
            let json = serde_json::to_value(&error).expect("serialize");
            assert_eq!(json["kind"], kind, "{error:?}");
            assert_eq!(json["message"], error.to_string());
        }
    }
}
