//! HTTP client of the sync server (docs/SYNC.md § 2.2, § 3.6): reqwest 0.13 with rustls, one
//! `Client` with a 10 s connect timeout and a 60 s total timeout (longer for the attachment
//! files, V2.7 bis). Only this module talks to the network. Tokens, passwords, codes and
//! e-mail addresses are never logged.

use std::time::Duration;

use reqwest::StatusCode;
use serde::de::DeserializeOwned;
use serde::Serialize;
use sync_proto::{
    AccountResponse, ErrorBody, ErrorCode, FileStatus, ForgotRequest, LoginRequest, LoginResponse,
    ResetRequest, SignupRequest, SyncRequest, SyncResponse, PROTOCOL_VERSION,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(60);
const LOGOUT_TIMEOUT: Duration = Duration::from_secs(5);
/// `GET /api/account` is a small read done after each sync: it gives up sooner.
const ACCOUNT_TIMEOUT: Duration = Duration::from_secs(10);
/// `GET /api/files/{id}/status`: a small read.
const FILE_STATUS_TIMEOUT: Duration = Duration::from_secs(15);
/// One chunk of at most 8 MiB (`MAX_CHUNK_BYTES`): 5 minutes leave room for a slow upload.
const CHUNK_TIMEOUT: Duration = Duration::from_secs(300);
/// One whole file (100 MB by default): an interrupted download resumes at the next run.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(1800);
/// A download that receives nothing for this long stops (as a network error): a stalled
/// connection never keeps « Télécharger » waiting for the whole `DOWNLOAD_TIMEOUT`.
const BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// Why a request failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientError {
    /// Network error or timeout: the server could not be reached.
    Offline(String),
    /// HTTP error status, with the server's error code when the body was an `ErrorBody`.
    Status {
        status: u16,
        code: Option<ErrorCode>,
    },
    /// A success status whose body is not the expected JSON (an HTML page from a proxy, a
    /// truncated body…).
    BadBody(String),
    /// The request could not even be built.
    Internal(String),
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::Offline(e) => write!(f, "server unreachable: {e}"),
            ClientError::Status { status, code } => write!(f, "HTTP {status} ({code:?})"),
            ClientError::BadBody(e) => write!(f, "unreadable response: {e}"),
            ClientError::Internal(e) => write!(f, "client error: {e}"),
        }
    }
}

/// One HTTP client for the whole app; the base URL is given per call (it lives in the
/// settings).
#[derive(Debug, Clone)]
pub struct SyncClient {
    /// A client that cannot be built (TLS set-up) fails every call instead of the app start.
    http: Result<reqwest::Client, String>,
    /// Longest wait for the next bytes of a downloaded file (`BODY_IDLE_TIMEOUT`).
    idle: Duration,
}

impl Default for SyncClient {
    fn default() -> Self {
        Self::new()
    }
}

impl SyncClient {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(TOTAL_TIMEOUT)
            .user_agent(concat!("Taido/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| {
                log::error!("sync: cannot build the HTTP client: {e}");
                e.to_string()
            });
        Self {
            http,
            idle: BODY_IDLE_TIMEOUT,
        }
    }

    /// Tests: a shorter wait for the next bytes of a download.
    #[cfg(test)]
    pub fn with_idle_timeout(mut self, idle: Duration) -> Self {
        self.idle = idle;
        self
    }

    fn http(&self) -> Result<&reqwest::Client, ClientError> {
        self.http
            .as_ref()
            .map_err(|e| ClientError::Internal(e.clone()))
    }

    /// `POST /api/signup`: creates the account and logs this device in.
    pub async fn signup(
        &self,
        base_url: &str,
        email: &str,
        password: &str,
        device_name: &str,
    ) -> Result<LoginResponse, ClientError> {
        let body = SignupRequest {
            protocol: PROTOCOL_VERSION,
            email: email.to_string(),
            password: password.to_string(),
            device_name: device_name.to_string(),
        };
        self.post_json(base_url, "/api/signup", None, &body).await
    }

    /// `POST /api/login`.
    pub async fn login(
        &self,
        base_url: &str,
        email: &str,
        password: &str,
        device_name: &str,
    ) -> Result<LoginResponse, ClientError> {
        let body = LoginRequest {
            protocol: PROTOCOL_VERSION,
            email: email.to_string(),
            password: password.to_string(),
            device_name: device_name.to_string(),
        };
        self.post_json(base_url, "/api/login", None, &body).await
    }

    /// `POST /api/password/forgot` (204, account or not).
    pub async fn forgot_password(&self, base_url: &str, email: &str) -> Result<(), ClientError> {
        let body = ForgotRequest {
            protocol: PROTOCOL_VERSION,
            email: email.to_string(),
        };
        self.post_empty(base_url, "/api/password/forgot", &body)
            .await
    }

    /// `POST /api/password/reset` (204).
    pub async fn reset_password(
        &self,
        base_url: &str,
        email: &str,
        code: &str,
        password: &str,
    ) -> Result<(), ClientError> {
        let body = ResetRequest {
            protocol: PROTOCOL_VERSION,
            email: email.to_string(),
            code: code.to_string(),
            password: password.to_string(),
        };
        self.post_empty(base_url, "/api/password/reset", &body)
            .await
    }

    /// `GET /api/account`: the address of the token's account.
    pub async fn account(
        &self,
        base_url: &str,
        token: &str,
    ) -> Result<AccountResponse, ClientError> {
        let response = self
            .http()?
            .get(format!("{base_url}/api/account"))
            .bearer_auth(token)
            .timeout(ACCOUNT_TIMEOUT)
            .send()
            .await
            .map_err(network_error)?;
        if !response.status().is_success() {
            return Err(status_error(response).await);
        }
        let bytes = response.bytes().await.map_err(network_error)?;
        serde_json::from_slice(&bytes).map_err(|e| ClientError::BadBody(e.to_string()))
    }

    /// `POST /api/email/resend` (204): a new confirmation link by mail.
    pub async fn resend_confirmation(
        &self,
        base_url: &str,
        token: &str,
    ) -> Result<(), ClientError> {
        let response = self
            .send_json(
                base_url,
                "/api/email/resend",
                Some(token),
                &serde_json::json!({}),
            )
            .await?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(status_error(response).await)
        }
    }

    /// `POST /api/logout` (best effort, 5 s).
    pub async fn logout(&self, base_url: &str, token: &str) -> Result<(), ClientError> {
        let response = self
            .http()?
            .post(format!("{base_url}/api/logout"))
            .bearer_auth(token)
            .timeout(LOGOUT_TIMEOUT)
            .send()
            .await
            .map_err(network_error)?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(status_error(response).await)
        }
    }

    /// `POST /api/sync`.
    pub async fn sync(
        &self,
        base_url: &str,
        token: &str,
        request: &SyncRequest,
    ) -> Result<SyncResponse, ClientError> {
        let value: serde_json::Value = self
            .post_json(base_url, "/api/sync", Some(token), request)
            .await?;
        parse_sync_response(value)
    }

    /// A POST whose success has no body (204).
    async fn post_empty<B: Serialize>(
        &self,
        base_url: &str,
        path: &str,
        body: &B,
    ) -> Result<(), ClientError> {
        let response = self.send_json(base_url, path, None, body).await?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(status_error(response).await)
        }
    }

    async fn send_json<B: Serialize>(
        &self,
        base_url: &str,
        path: &str,
        token: Option<&str>,
        body: &B,
    ) -> Result<reqwest::Response, ClientError> {
        let bytes = serde_json::to_vec(body).map_err(|e| ClientError::Internal(e.to_string()))?;
        let mut request = self
            .http()?
            .post(format!("{base_url}{path}"))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(bytes);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        request.send().await.map_err(network_error)
    }

    async fn post_json<B: Serialize, T: DeserializeOwned>(
        &self,
        base_url: &str,
        path: &str,
        token: Option<&str>,
        body: &B,
    ) -> Result<T, ClientError> {
        let response = self.send_json(base_url, path, token, body).await?;
        if !response.status().is_success() {
            return Err(status_error(response).await);
        }
        let bytes = response.bytes().await.map_err(network_error)?;
        serde_json::from_slice(&bytes).map_err(|e| ClientError::BadBody(e.to_string()))
    }
}

/// Reads a sync response tolerantly: pulled rows of an entity this build does not know (one
/// added by a later version) are skipped and logged, the rest is read as usual. The server
/// already holds such rows back from a client that did not declare them (docs/SYNC.md § 0.1);
/// this keeps a later addition from ever making a whole response unreadable here.
pub(crate) fn parse_sync_response(
    mut value: serde_json::Value,
) -> Result<SyncResponse, ClientError> {
    if let Some(changes) = value
        .get_mut("changes")
        .and_then(serde_json::Value::as_array_mut)
    {
        let mut unknown: Vec<String> = Vec::new();
        changes.retain(
            |change| match change.get("entity").and_then(serde_json::Value::as_str) {
                Some(name) if sync_proto::Entity::parse(name).is_none() => {
                    if !unknown.iter().any(|known| known == name) {
                        unknown.push(name.chars().take(64).collect());
                    }
                    false
                }
                _ => true,
            },
        );
        if !unknown.is_empty() {
            log::info!(
                "sync: skipped pulled rows of entities this version does not know: {}",
                unknown.join(", ")
            );
        }
    }
    serde_json::from_value(value).map_err(|e| ClientError::BadBody(e.to_string()))
}

/// The body of a file download, read chunk by chunk (`GET /api/files/{id}`).
pub struct FileBody {
    response: reqwest::Response,
    start: u64,
    idle: Duration,
}

impl FileBody {
    /// Offset of the first byte of the body: the asked one for a `206`, 0 for a `200` (the
    /// server sent the whole file).
    pub fn start(&self) -> u64 {
        self.start
    }

    /// The next bytes as they arrive, `None` at the end. Nothing for the idle timeout
    /// (60 s) is a network error (`Offline`).
    pub async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, ClientError> {
        let chunk = tokio::time::timeout(self.idle, self.response.chunk())
            .await
            .map_err(|_| ClientError::Offline(format!("nothing received for {:?}", self.idle)))?
            .map_err(network_error)?;
        Ok(chunk.map(|b| b.to_vec()))
    }
}

impl SyncClient {
    /// `<base>/api/files/<id>[/<suffix>]`, the id percent-encoded as one path segment.
    fn file_url(
        base_url: &str,
        id: &str,
        suffix: Option<&str>,
    ) -> Result<reqwest::Url, ClientError> {
        let mut url = reqwest::Url::parse(base_url)
            .map_err(|e| ClientError::Internal(format!("bad server address: {e}")))?;
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|()| ClientError::Internal("bad server address".into()))?;
            segments.pop_if_empty().extend(["api", "files", id]);
            if let Some(suffix) = suffix {
                segments.push(suffix);
            }
        }
        Ok(url)
    }

    /// `GET /api/files/{id}/status`: what the server holds of an attachment's file.
    pub async fn file_status(
        &self,
        base_url: &str,
        token: &str,
        id: &str,
    ) -> Result<FileStatus, ClientError> {
        let response = self
            .http()?
            .get(Self::file_url(base_url, id, Some("status"))?)
            .bearer_auth(token)
            .timeout(FILE_STATUS_TIMEOUT)
            .send()
            .await
            .map_err(network_error)?;
        if !response.status().is_success() {
            return Err(status_error(response).await);
        }
        let bytes = response.bytes().await.map_err(network_error)?;
        serde_json::from_slice(&bytes).map_err(|e| ClientError::BadBody(e.to_string()))
    }

    /// `PUT /api/files/{id}?offset=&size=&sha256=`: one chunk (at most `MAX_CHUNK_BYTES`) of
    /// a file of `size` bytes, appended at `offset` (the bytes the server already has).
    #[allow(clippy::too_many_arguments)]
    pub async fn put_file_chunk(
        &self,
        base_url: &str,
        token: &str,
        id: &str,
        offset: u64,
        size: u64,
        sha256: &str,
        chunk: Vec<u8>,
    ) -> Result<FileStatus, ClientError> {
        let mut url = Self::file_url(base_url, id, None)?;
        url.query_pairs_mut()
            .append_pair("offset", &offset.to_string())
            .append_pair("size", &size.to_string())
            .append_pair("sha256", sha256);
        let response = self
            .http()?
            .put(url)
            .bearer_auth(token)
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body(chunk)
            .timeout(CHUNK_TIMEOUT)
            .send()
            .await
            .map_err(network_error)?;
        if !response.status().is_success() {
            return Err(status_error(response).await);
        }
        let bytes = response.bytes().await.map_err(network_error)?;
        serde_json::from_slice(&bytes).map_err(|e| ClientError::BadBody(e.to_string()))
    }

    /// `GET /api/files/{id}`, from byte `from` (`Range: bytes=<from>-` when not 0). A `206`
    /// must start at `from` (else `BadBody`); a `200` is the whole file.
    pub async fn download_file(
        &self,
        base_url: &str,
        token: &str,
        id: &str,
        from: u64,
    ) -> Result<FileBody, ClientError> {
        let mut request = self
            .http()?
            .get(Self::file_url(base_url, id, None)?)
            .bearer_auth(token)
            .timeout(DOWNLOAD_TIMEOUT);
        if from > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={from}-"));
        }
        let response = request.send().await.map_err(network_error)?;
        let start = match response.status() {
            StatusCode::OK => 0,
            StatusCode::PARTIAL_CONTENT => {
                let start = response
                    .headers()
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(range_start);
                if start != Some(from) {
                    return Err(ClientError::BadBody(
                        "the server sent another part of the file".into(),
                    ));
                }
                from
            }
            status if status.is_success() => {
                return Err(ClientError::BadBody(format!("unexpected status {status}")));
            }
            _ => return Err(status_error(response).await),
        };
        Ok(FileBody {
            response,
            start,
            idle: self.idle,
        })
    }
}

/// First byte of a `Content-Range: bytes <first>-<last>/<total>`.
fn range_start(value: &str) -> Option<u64> {
    let range = value.trim().strip_prefix("bytes ")?;
    let (first, _) = range.split_once('-')?;
    first.trim().parse().ok()
}

fn network_error(e: reqwest::Error) -> ClientError {
    if e.is_builder() {
        ClientError::Internal(e.to_string())
    } else {
        ClientError::Offline(e.to_string())
    }
}

async fn status_error(response: reqwest::Response) -> ClientError {
    let status: StatusCode = response.status();
    let code = match response.bytes().await {
        Ok(bytes) => serde_json::from_slice::<ErrorBody>(&bytes)
            .ok()
            .map(|b| b.error),
        Err(_) => None,
    };
    ClientError::Status {
        status: status.as_u16(),
        code,
    }
}
