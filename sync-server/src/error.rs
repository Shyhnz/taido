//! Errors: [`ServerError`] for the library and the CLI, [`ApiError`] for HTTP responses
//! (status + `sync_proto::ErrorBody`, docs/SYNC.md § 2.2).

use axum::extract::rejection::BytesRejection;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use sync_proto::{ErrorBody, ErrorCode};

/// Failure of a storage, crypto or I/O operation. Messages never contain passwords, tokens
/// nor record content.
#[derive(Debug, thiserror::Error)]
pub enum ServerError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("migration error: {0}")]
    Migration(#[from] rusqlite_migration::Error),
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    #[error("password hashing failed")]
    PasswordHash,
    #[error("the system random generator failed")]
    Random,
    #[error("{0}")]
    Invalid(String),
    #[error(
        "legacy database (one account, set-password): start the V2 server on a new, \
         empty data directory"
    )]
    LegacyDatabase,
    #[error("corrupt stored record {entity}/{id}")]
    CorruptRecord { entity: String, id: String },
    #[error("the database lock is poisoned")]
    Poisoned,
    #[error("a background task failed")]
    Join,
    /// A push would grow the account's synced data past its quota, or the disk is low.
    #[error("the account's synced data would exceed its quota")]
    RecordsQuota,
    /// The attachment files could not be stored or served; the text never contains a file name.
    #[error("file storage: {0}")]
    Storage(String),
    /// An e-mail could not be sent; the text never contains the address nor the content.
    #[error("e-mail not sent: {0}")]
    Mail(String),
}

/// An HTTP error: status from [`ErrorCode::http_status`], JSON [`ErrorBody`].
#[derive(Debug)]
pub struct ApiError {
    pub code: ErrorCode,
    pub message: String,
}

impl ApiError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        ApiError {
            code,
            message: message.into(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::BadRequest, message)
    }

    pub fn unauthorized() -> Self {
        Self::new(
            ErrorCode::Unauthorized,
            "missing, unknown or revoked credentials",
        )
    }

    pub fn rate_limited(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::RateLimited, message)
    }

    pub fn not_found() -> Self {
        // No `NotFound` code in the protocol: unknown API routes answer 404 with `bad_request`.
        Self::new(ErrorCode::BadRequest, "unknown API route")
    }

    /// Maps the body extractor's rejection: 413 when the body limit is exceeded, else 400.
    pub fn from_body_rejection(rejection: BytesRejection) -> Self {
        if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
            Self::new(ErrorCode::PayloadTooLarge, "request body too large")
        } else {
            Self::bad_request("unreadable request body")
        }
    }

    fn status(&self) -> StatusCode {
        StatusCode::from_u16(self.code.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
    }
}

impl From<ServerError> for ApiError {
    fn from(err: ServerError) -> Self {
        if matches!(err, ServerError::RecordsQuota) {
            return ApiError::new(
                ErrorCode::QuotaExceeded,
                "the account's synced data would exceed its quota",
            );
        }
        tracing::error!(error = %err, "internal error");
        ApiError::new(ErrorCode::Internal, "internal server error")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status();
        let body = ErrorBody {
            error: self.code,
            message: self.message,
        };
        (status, Json(body)).into_response()
    }
}

/// A 404 with a JSON error body (unknown `/api/*` route).
pub struct ApiNotFound;

impl IntoResponse for ApiNotFound {
    fn into_response(self) -> Response {
        let err = ApiError::not_found();
        let body = ErrorBody {
            error: err.code,
            message: err.message,
        };
        (StatusCode::NOT_FOUND, Json(body)).into_response()
    }
}
