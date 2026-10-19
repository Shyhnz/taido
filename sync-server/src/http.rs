//! HTTP layer (docs/SYNC.md § 2.2 and § 4.4): API routes, body limits, static PWA files and
//! response headers, attachment files (V2.7 bis, [`crate::files`]). No CORS: the PWA is
//! same-origin and the Mac is not a browser.

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::rejection::{BytesRejection, PathRejection};
use axum::extract::{DefaultBodyLimit, Path as UrlPath, Request, State};
use axum::http::header::{
    HeaderValue, ACCEPT_RANGES, AUTHORIZATION, CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH,
    CONTENT_RANGE, CONTENT_SECURITY_POLICY, CONTENT_TYPE, RANGE, REFERRER_POLICY,
    X_CONTENT_TYPE_OPTIONS,
};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Extension, Json, Router};
use serde_json::Value;
use sync_proto::{
    AccountResponse, ErrorCode, FileStatus, ForgotRequest, HealthResponse, LoginRequest,
    LoginResponse, ResetRequest, SignupRequest, MAX_CHUNK_BYTES, MAX_LOGIN_BODY_BYTES,
    MAX_PUSH_CHANGES, MAX_SYNC_BODY_BYTES, PROTOCOL_VERSION,
};
use tokio::sync::Semaphore;
use tower_http::classify::ServerErrorsFailureClass;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing::Span;

use crate::auth::{self, LoginLimits, VERIFY_WAIT};
use crate::error::{ApiError, ApiNotFound, ServerError};
use crate::files::{self, FileStore, Stored};
use crate::gate::{self, BodyGates};
use crate::mail::{self, Mailer};
use crate::r2::{self, R2};
use crate::store::{self, Authed, Store};
use crate::sync::{self, RawSyncRequest};

/// Content Security Policy of every static response (§ 4.4). `'unsafe-inline'` styles: the
/// toast library injects a `<style>` element. `img-src blob:`: the web app shows an attached
/// raster image through `<img src="blob:…">` (V2.7 bis); `blob:` is allowed nowhere else.
pub const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; \
base-uri 'none'; frame-ancestors 'none'";

/// Longest accepted device name, in characters.
pub const MAX_DEVICE_NAME_CHARS: usize = 64;

/// Content Security Policy of a downloaded attachment: a browser that would render it anyway
/// runs it in a sandbox (no script, unique origin).
pub const FILE_CSP: &str = "sandbox";

/// Shared state of the handlers. Built with [`AppState::new`]; services that tests replace
/// (the mail sender of V2.7 task 4) are added as fields set by `with_*` builders, so that
/// `TestServer` can hold the same state and inspect them.
#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    /// Attachment files: on disk under the data directory, with their limits.
    pub files: Arc<FileStore>,
    /// Login limit, per (e-mail, client address), per client address and global.
    pub limiter: Arc<LoginLimits>,
    /// Signup limit, per client address and global (per hour).
    pub signup_limiter: Arc<LoginLimits>,
    /// One password hash or check at a time (argon2 is deliberately expensive).
    pub verify_gate: Arc<Semaphore>,
    /// Number of password checks run at login (tests and diagnostics).
    pub verifications: Arc<AtomicUsize>,
    /// Of which checks against [`auth::dummy_hash`] (unknown or malformed address).
    pub dummy_verifications: Arc<AtomicUsize>,
    /// Sends the reset codes; `None` = no e-mail configured (`/api/password/forgot` → 503).
    pub mailer: Option<Arc<dyn Mailer>>,
    /// Forgotten-password limit, per e-mail address, per client address and global (per hour).
    pub forgot_limiter: Arc<LoginLimits>,
    /// Wrong reset codes, per client address and global (per hour).
    pub reset_limiter: Arc<LoginLimits>,
    /// Address of this server in the links of the mails (`TAIDO_PUBLIC_URL`, no trailing
    /// slash). With a mailer: confirmation mails at signup; else accounts are confirmed at once.
    pub public_url: Option<String>,
    /// Confirmation-mail resends, per account and global (per hour).
    pub resend_limiter: Arc<LoginLimits>,
    /// Unknown confirmation links, per client address and global (per hour).
    pub confirm_limiter: Arc<LoginLimits>,
    /// Slots of the bodies waiting in memory (sync pushes and file chunks).
    pub body_gates: Arc<BodyGates>,
    /// Sync bodies parsed at once, server-wide ([`gate::PARSES`]).
    pub parse_gate: Arc<Semaphore>,
    /// Longest wait for a parse slot (then 429 `rate_limited`).
    pub parse_wait: Duration,
}

impl AppState {
    pub fn new(store: Store, files: FileStore) -> Self {
        // Computed once per process: the first login naming an unknown address is not slower.
        auth::dummy_hash();
        AppState {
            store: Arc::new(store),
            files: Arc::new(files),
            limiter: Arc::new(LoginLimits::default()),
            signup_limiter: Arc::new(LoginLimits::new(
                auth::MAX_SIGNUPS_PER_CLIENT,
                auth::MAX_SIGNUPS,
                auth::SIGNUP_WINDOW,
            )),
            verify_gate: Arc::new(Semaphore::new(1)),
            verifications: Arc::new(AtomicUsize::new(0)),
            dummy_verifications: Arc::new(AtomicUsize::new(0)),
            mailer: None,
            forgot_limiter: Arc::new(LoginLimits::new(
                auth::MAX_FORGOTS_PER_CLIENT,
                auth::MAX_FORGOTS,
                auth::FORGOT_WINDOW,
            )),
            reset_limiter: Arc::new(LoginLimits::new(
                auth::MAX_RESET_FAILURES_PER_CLIENT,
                auth::MAX_RESET_FAILURES,
                auth::RESET_WINDOW,
            )),
            public_url: None,
            resend_limiter: Arc::new(LoginLimits::new(
                auth::MAX_RESENDS_PER_ACCOUNT,
                auth::MAX_RESENDS,
                auth::RESEND_WINDOW,
            )),
            confirm_limiter: Arc::new(LoginLimits::new(
                auth::MAX_CONFIRM_FAILURES_PER_CLIENT,
                auth::MAX_CONFIRM_FAILURES,
                auth::RESEND_WINDOW,
            )),
            body_gates: Arc::new(BodyGates::default()),
            parse_gate: Arc::new(Semaphore::new(gate::PARSES)),
            parse_wait: gate::WAIT,
        }
    }

    /// The state with this mail sender (SMTP in production, [`mail::MemoryMailer`] in tests).
    pub fn with_mailer(mut self, mailer: Arc<dyn Mailer>) -> Self {
        self.mailer = Some(mailer);
        self
    }

    /// The state with the public address used in the links of the mails.
    pub fn with_public_url(mut self, url: impl Into<String>) -> Self {
        self.public_url = Some(url.into());
        self
    }

    /// The mailer and public address when confirmation mails can be sent.
    fn confirmation_mailer(&self) -> Option<(Arc<dyn Mailer>, String)> {
        Some((self.mailer.clone()?, self.public_url.clone()?))
    }
}

/// The whole application: API, then the static PWA when `static_dir` is set.
pub fn router(state: AppState, static_dir: Option<&Path>) -> Router {
    let api = Router::new()
        .route("/api/health", get(health))
        .route(
            "/api/signup",
            post(signup).layer(DefaultBodyLimit::max(MAX_LOGIN_BODY_BYTES)),
        )
        .route(
            "/api/login",
            post(login).layer(DefaultBodyLimit::max(MAX_LOGIN_BODY_BYTES)),
        )
        .route(
            "/api/password/forgot",
            post(forgot_password).layer(DefaultBodyLimit::max(MAX_LOGIN_BODY_BYTES)),
        )
        .route(
            "/api/password/reset",
            post(reset_password).layer(DefaultBodyLimit::max(MAX_LOGIN_BODY_BYTES)),
        )
        .route("/api/logout", post(logout))
        .route("/api/account", get(account))
        .route("/api/email/resend", post(resend_confirmation))
        .route(
            mail::CONFIRM_PATH,
            get(confirm_page)
                .post(confirm_submit)
                .layer(DefaultBodyLimit::max(MAX_LOGIN_BODY_BYTES)),
        )
        .route(
            "/api/sync",
            // The token is checked before the body is read: an anonymous client never makes
            // the server buffer a 16 MiB body.
            post(sync_handler)
                .layer(DefaultBodyLimit::max(MAX_SYNC_BODY_BYTES))
                .layer(middleware::from_fn_with_state(state.clone(), require_token)),
        )
        .route(
            "/api/files/{id}",
            // The token is checked before a chunk is read (as for the sync).
            get(download_file)
                .put(upload_chunk)
                .layer(DefaultBodyLimit::max(MAX_CHUNK_BYTES))
                .layer(middleware::from_fn_with_state(state.clone(), require_token)),
        )
        .route(
            "/api/files/{id}/status",
            get(file_status).layer(middleware::from_fn_with_state(state.clone(), require_token)),
        )
        .route("/api", any(api_not_found))
        .route("/api/{*rest}", any(api_not_found))
        .method_not_allowed_fallback(method_not_allowed)
        .with_state(state);

    let app = match static_dir {
        Some(dir) => {
            let assets = ServeDir::new(dir.join("assets"));
            // SPA fallback for navigations, status 200 (`not_found_service` would force 404,
            // `fallback` keeps the status of `ServeFile`).
            let spa = ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html")));
            api.nest_service("/assets", assets).fallback_service(spa)
        }
        None => api.fallback(api_not_found),
    };
    // The span names the path only: the query of a confirmation link carries its token.
    app.layer(middleware::from_fn(response_headers)).layer(
        TraceLayer::new_for_http()
            .make_span_with(|request: &Request| {
                tracing::debug_span!("request", method = %request.method(),
                    path = %request.uri().path())
            })
            .on_failure(log_failure),
    )
}

/// A 5xx answer in the logs: `507` (a full account or a nearly full disk refuses an upload,
/// the clients try again later) is a warning, the others errors.
fn log_failure(class: ServerErrorsFailureClass, latency: Duration, span: &Span) {
    let latency_ms = latency.as_millis();
    match class {
        ServerErrorsFailureClass::StatusCode(StatusCode::INSUFFICIENT_STORAGE) => {
            tracing::warn!(parent: span, classification = %class, latency_ms, "response refused");
        }
        _ => tracing::error!(parent: span, classification = %class, latency_ms, "response failed"),
    }
}

/// Headers decided from the response (§ 4.4).
async fn response_headers(request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    let mut response = next.run(request).await;
    let is_api = path == "/api" || path.starts_with("/api/");
    let status = response.status();
    let headers = response.headers_mut();
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    if is_api {
        // A download sets its own (`private, no-store`).
        headers
            .entry(CACHE_CONTROL)
            .or_insert(HeaderValue::from_static("no-store"));
        return response;
    }
    headers.insert(CONTENT_SECURITY_POLICY, HeaderValue::from_static(CSP));
    if path == "/manifest.webmanifest" && status.is_success() {
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("application/manifest+json"),
        );
    }
    let is_html = headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/html"));
    if is_html || path == "/sw.js" {
        headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    } else if path.starts_with("/assets/") && status == StatusCode::OK {
        headers.insert(
            CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    }
    response
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        protocol: PROTOCOL_VERSION,
    })
}

async fn api_not_found() -> ApiNotFound {
    ApiNotFound
}

async fn method_not_allowed() -> Response {
    let mut response = ApiError::bad_request("method not allowed").into_response();
    *response.status_mut() = StatusCode::METHOD_NOT_ALLOWED;
    response
}

/// Runs blocking work (SQLite, argon2) off the async workers.
async fn blocking<T, F>(f: F) -> Result<T, ApiError>
where
    F: FnOnce() -> Result<T, ApiError> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|_| ApiError::from(ServerError::Join))?
}

/// Parses the body as JSON with a `protocol` field equal to [`PROTOCOL_VERSION`].
fn parse_versioned<T: serde::de::DeserializeOwned>(body: &[u8]) -> Result<T, ApiError> {
    let value: Value =
        serde_json::from_slice(body).map_err(|_| ApiError::bad_request("malformed JSON"))?;
    match value.get("protocol").and_then(Value::as_u64) {
        Some(p) if p == u64::from(PROTOCOL_VERSION) => {}
        Some(_) => {
            return Err(ApiError::new(
                ErrorCode::UnsupportedProtocol,
                format!("this server speaks protocol {PROTOCOL_VERSION}"),
            ))
        }
        None => return Err(ApiError::bad_request("missing protocol")),
    }
    serde_json::from_value(value).map_err(|_| ApiError::bad_request("malformed request"))
}

fn check_device_name(name: &str) -> Result<String, ApiError> {
    let name = name.trim();
    let chars = name.chars().count();
    if chars == 0 || chars > MAX_DEVICE_NAME_CHARS || name.chars().any(char::is_control) {
        return Err(ApiError::bad_request(format!(
            "device_name must be 1 to {MAX_DEVICE_NAME_CHARS} characters"
        )));
    }
    Ok(name.to_string())
}

/// Longest client address kept by the rate limiters.
const MAX_CLIENT_CHARS: usize = 64;

/// The client address for the rate limiters: `X-Real-IP`, set by nginx from Cloudflare's
/// `CF-Connecting-IP` (it overwrites any value sent by the client; the server listens on
/// loopback behind it, § 4.5), else one shared key. A spoofed value only escapes the
/// per-client limits, never the global one.
fn client_key(headers: &HeaderMap) -> String {
    headers
        .get("x-real-ip")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty() && v.len() <= MAX_CLIENT_CHARS)
        .unwrap_or("-")
        .to_string()
}

/// Waits (at most [`VERIFY_WAIT`]) for the single password-hashing slot.
async fn hashing_permit(state: &AppState) -> Result<tokio::sync::OwnedSemaphorePermit, ApiError> {
    tokio::time::timeout(VERIFY_WAIT, Arc::clone(&state.verify_gate).acquire_owned())
        .await
        .map_err(|_| ApiError::rate_limited("a password is already being checked"))?
        .map_err(|_| ApiError::from(ServerError::Join))
}

/// Links a new device of `account_id`: its token (shown once) and the server epoch.
fn link_device(
    conn: &rusqlite::Connection,
    account_id: &str,
    device_name: &str,
) -> Result<LoginResponse, ApiError> {
    let token = auth::new_token()?;
    let device_id = store::create_device(conn, account_id, device_name, &auth::hash_token(&token))?;
    let server_epoch = store::server_epoch(conn)?;
    Ok(LoginResponse {
        protocol: PROTOCOL_VERSION,
        token,
        device_id,
        server_epoch,
    })
}

/// `POST /api/signup`: creates the account and its first device. The address is never
/// logged.
async fn signup(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Json<LoginResponse>, ApiError> {
    let body = body.map_err(ApiError::from_body_rejection)?;
    let request: SignupRequest = parse_versioned(&body)?;
    let device_name = check_device_name(&request.device_name)?;
    let email = auth::normalize_email(&request.email)
        .ok_or_else(|| ApiError::new(ErrorCode::BadEmail, "malformed e-mail address"))?;
    if !auth::is_strong_enough(&request.password) {
        return Err(ApiError::new(
            ErrorCode::WeakPassword,
            format!(
                "the password must have at least {} characters",
                auth::MIN_PASSWORD_CHARS
            ),
        ));
    }
    // Every well-formed signup counts, accepted or not (an address already taken too).
    let now = Instant::now();
    let slot = state
        .signup_limiter
        .try_reserve(&client_key(&headers), now)
        .ok_or_else(|| ApiError::rate_limited("too many signups, try again later"))?;
    slot.fail(now);
    drop(slot);
    let permit = hashing_permit(&state).await?;

    let confirmation = state.confirmation_mailer();
    let can_confirm = confirmation.is_some();
    let store = Arc::clone(&state.store);
    let (response, pending) = blocking(move || {
        let hash = {
            let _permit = permit;
            auth::hash_password(&request.password)?
        };
        let conn = store.lock()?;
        let tx = conn.unchecked_transaction().map_err(ServerError::from)?;
        let account_id = store::create_account(&tx, &email, &hash)?.ok_or_else(|| {
            tracing::info!("signup refused: address taken");
            ApiError::new(
                ErrorCode::EmailTaken,
                "an account already uses this address",
            )
        })?;
        let response = link_device(&tx, &account_id, &device_name)?;
        // No way to mail a link: nothing to confirm.
        let pending = if can_confirm {
            Some((email.clone(), new_confirmation(&tx, &account_id)?))
        } else {
            store::mark_email_verified(&tx, &account_id)?;
            None
        };
        tx.commit().map_err(ServerError::from)?;
        tracing::info!(account_id = %account_id, device_id = %response.device_id,
            "account created");
        Ok((response, pending))
    })
    .await?;
    if let (Some((mailer, public_url)), Some((email, token))) = (confirmation, pending) {
        tokio::spawn(send_confirmation(mailer, public_url, email, token));
    }
    Ok(Json(response))
}

/// Stores a new confirmation token for the account (valid [`mail::VERIFY_LIFETIME`]) and
/// returns it.
fn new_confirmation(conn: &rusqlite::Connection, account_id: &str) -> Result<String, ServerError> {
    let token = auth::new_token()?;
    let lifetime = chrono::Duration::from_std(mail::VERIFY_LIFETIME)
        .map_err(|_| ServerError::Invalid("link lifetime out of range".into()))?;
    let expires_at =
        (chrono::Utc::now() + lifetime).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    store::put_email_verification(conn, account_id, &auth::hash_token(&token), &expires_at)?;
    Ok(token)
}

/// Sends the confirmation mail (in the background, after the answer). Logs neither the
/// address nor the link.
async fn send_confirmation(
    mailer: Arc<dyn Mailer>,
    public_url: String,
    email: String,
    token: String,
) {
    let message = mail::verify_mail(
        &email,
        &mail::confirm_link(&public_url, &token),
        Some(&public_url),
    );
    if let Err(err) = mailer.send(&email, &message).await {
        tracing::warn!(error = %err, "confirmation e-mail not sent");
    }
}

/// `POST /api/email/resend`: a new confirmation link by mail, for the token's account. 204
/// (nothing sent when the address is already confirmed); 503 `mail_unavailable` when this
/// server cannot send it; 429 beyond [`auth::MAX_RESENDS_PER_ACCOUNT`] an hour.
async fn resend_confirmation(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let hash = token_hash(&headers)?;
    let Some((mailer, public_url)) = state.confirmation_mailer() else {
        return Err(ApiError::new(
            ErrorCode::MailUnavailable,
            "this server cannot send e-mails",
        ));
    };
    let store = Arc::clone(&state.store);
    let limiter = Arc::clone(&state.resend_limiter);
    let pending = blocking(move || {
        let conn = store.lock()?;
        let authed = store::authenticate(&conn, &hash)?.ok_or_else(ApiError::unauthorized)?;
        let account =
            store::account_by_id(&conn, &authed.account_id)?.ok_or_else(ApiError::unauthorized)?;
        if account.email_verified {
            return Ok(None);
        }
        let key = format!("account:{}", account.id);
        let now = Instant::now();
        let slot = limiter
            .try_reserve_keys(&[(&key, auth::MAX_RESENDS_PER_ACCOUNT)], now)
            .ok_or_else(|| ApiError::rate_limited("too many mails, try again later"))?;
        // Every resend counts.
        slot.fail(now);
        drop(slot);
        let token = new_confirmation(&conn, &account.id)?;
        tracing::info!(account_id = %account.id, "confirmation e-mail requested");
        Ok(Some((account.email, token)))
    })
    .await?;
    if let Some((email, token)) = pending {
        tokio::spawn(send_confirmation(mailer, public_url, email, token));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// An HTML page of the confirmation flow.
fn confirm_html(status: StatusCode, title: &str, body: &str) -> Response {
    let mut response = (status, crate::mail_template::page(title, body)).into_response();
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    response
}

/// The value of `key` in a query string or a form body (`a=1&b=2`), when it only holds
/// token characters (base64url: no decoding needed).
fn token_field(pairs: &str, key: &str) -> Option<String> {
    pairs.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key
            && !v.is_empty()
            && v.len() <= 128
            && v.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        .then(|| v.to_string())
    })
}

fn link_dead_page() -> Response {
    let body = [
        crate::mail_template::paragraph(
            "Il a peut-être déjà servi, ou il a expiré (il est valable 24 heures).",
        ),
        crate::mail_template::quiet(
            "Si ton adresse n'est pas encore confirmée, ouvre Taido, va dans Réglages › Compte \
             et choisis « Renvoyer le mail ».",
        ),
    ]
    .concat();
    confirm_html(StatusCode::BAD_REQUEST, "Ce lien ne marche plus", &body)
}

/// `GET /confirmer?t=<token>`: a page with one button that confirms. The link only shows
/// the page: mail scanners open links on their own, a click is asked for.
async fn confirm_page(uri: Uri) -> Response {
    let Some(token) = uri.query().and_then(|q| token_field(q, "t")) else {
        return link_dead_page();
    };
    let body = format!(
        "{}<form method=\"post\" action=\"{}\" style=\"margin:8px 0 0;\">\
         <input type=\"hidden\" name=\"t\" value=\"{token}\">\
         <button type=\"submit\" style=\"display:block;width:100%;padding:14px 20px;border:0;\
         border-radius:10px;background:#142a78;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,\
         'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;\
         font-weight:600;cursor:pointer;\">Confirmer mon adresse</button></form>",
        crate::mail_template::paragraph("Un clic pour finir ton inscription à Taido."),
        mail::CONFIRM_PATH,
    );
    confirm_html(StatusCode::OK, "Confirme ton adresse", &body)
}

/// `POST /confirmer` (form `t=<token>`): confirms the address of the link.
async fn confirm_submit(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let token = body.ok().and_then(|b| {
        std::str::from_utf8(&b)
            .ok()
            .and_then(|f| token_field(f, "t"))
    });
    let client = format!("client:{}", client_key(&headers));
    let Some(reservation) = state.confirm_limiter.try_reserve_keys(
        &[(&client, auth::MAX_CONFIRM_FAILURES_PER_CLIENT)],
        Instant::now(),
    ) else {
        return confirm_html(
            StatusCode::TOO_MANY_REQUESTS,
            "Trop d'essais",
            &crate::mail_template::paragraph("Réessaie dans une heure."),
        );
    };
    let store = Arc::clone(&state.store);
    let outcome = tokio::task::spawn_blocking(move || -> Result<Option<String>, ServerError> {
        let Some(token) = token else { return Ok(None) };
        store::confirm_email(
            &*store.lock()?,
            &auth::hash_token(&token),
            &store::now_utc(),
        )
    })
    .await
    .map_err(|_| ServerError::Join)
    .and_then(|r| r);
    match outcome {
        Ok(Some(email)) => {
            drop(reservation);
            tracing::info!("address confirmed");
            if let Some((mailer, public_url)) = state.confirmation_mailer() {
                let message = mail::welcome_mail(&email, &public_url);
                let to = email.clone();
                tokio::spawn(async move {
                    if let Err(err) = mailer.send(&to, &message).await {
                        tracing::warn!(error = %err, "welcome e-mail not sent");
                    }
                });
            }
            let body = [
                crate::mail_template::paragraph(&format!("{email} est confirmée.")),
                crate::mail_template::quiet("Tu peux fermer cette page et revenir dans Taido."),
            ]
            .concat();
            confirm_html(StatusCode::OK, "Adresse confirmée", &body)
        }
        Ok(None) => {
            reservation.fail(Instant::now());
            tracing::info!("confirmation link refused");
            link_dead_page()
        }
        Err(err) => {
            tracing::error!(error = %err, "address confirmation failed");
            confirm_html(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Un souci est survenu",
                &crate::mail_template::paragraph("Réessaie dans quelques minutes."),
            )
        }
    }
}

/// `POST /api/login`. An unknown address and a wrong password get the same answer, after
/// the same work (a check against [`auth::dummy_hash`]).
async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Json<LoginResponse>, ApiError> {
    let body = body.map_err(ApiError::from_body_rejection)?;
    let request: LoginRequest = parse_versioned(&body)?;
    let device_name = check_device_name(&request.device_name)?;

    // Reserve a slot before checking anything expensive (§ 4.3): per (address, client), per
    // client, and global.
    let client = client_key(&headers);
    let pair = format!("pair:{}|{client}", auth::email_key(&request.email));
    let per_client = format!("client:{client}");
    let reservation = state
        .limiter
        .try_reserve_keys(
            &[
                (&pair, auth::MAX_LOGIN_ATTEMPTS),
                (&per_client, auth::MAX_LOGIN_ATTEMPTS_PER_CLIENT),
            ],
            Instant::now(),
        )
        .ok_or_else(|| ApiError::rate_limited("too many login attempts, try again later"))?;
    let permit = hashing_permit(&state).await?;

    // The permit and the reservation live in the blocking task: a client that disconnects
    // cannot free its slot early nor skip the failure record.
    let store = Arc::clone(&state.store);
    let verifications = Arc::clone(&state.verifications);
    let dummy_verifications = Arc::clone(&state.dummy_verifications);
    blocking(move || {
        let _permit = permit;
        let credentials = match auth::normalize_email(&request.email) {
            Some(email) => store::account_by_email(&*store.lock()?, &email)?,
            None => None,
        };
        let account_id = match credentials {
            Some(c) => {
                verifications.fetch_add(1, Ordering::SeqCst);
                auth::verify_password(&request.password, &c.password_hash).then_some(c.id)
            }
            None => {
                if let Some(dummy) = auth::dummy_hash() {
                    verifications.fetch_add(1, Ordering::SeqCst);
                    dummy_verifications.fetch_add(1, Ordering::SeqCst);
                    auth::verify_password(&request.password, dummy);
                }
                None
            }
        };
        let Some(account_id) = account_id else {
            reservation.fail(Instant::now());
            tracing::info!("login failed");
            return Err(ApiError::unauthorized());
        };
        drop(reservation);
        let conn = store.lock()?;
        let response = link_device(&conn, &account_id, &device_name)?;
        tracing::info!(account_id = %account_id, device_id = %response.device_id,
            "device linked");
        Ok(Json(response))
    })
    .await
}

/// `POST /api/password/forgot`: e-mails a reset code when the address has an account. Always
/// 204 once the request is well formed and within the limits, account or not, mail sent or
/// not. The answer is sent right after the checks and limits, which do not depend on the
/// address having an account; the lookup, the code and the mail happen in a background task,
/// so neither the response time nor an SMTP outage tells whether the account exists.
async fn forgot_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<StatusCode, ApiError> {
    let body = body.map_err(ApiError::from_body_rejection)?;
    let request: ForgotRequest = parse_versioned(&body)?;
    let Some(mailer) = state.mailer.clone() else {
        return Err(ApiError::new(
            ErrorCode::MailUnavailable,
            "this server cannot send e-mails",
        ));
    };
    let email = auth::normalize_email(&request.email)
        .ok_or_else(|| ApiError::new(ErrorCode::BadEmail, "malformed e-mail address"))?;
    // Every well-formed request counts, whether the address has an account or not.
    let now = Instant::now();
    let by_email = format!("email:{email}");
    let by_client = format!("client:{}", client_key(&headers));
    let slot = state
        .forgot_limiter
        .try_reserve_keys(
            &[
                (&by_email, auth::MAX_FORGOTS_PER_EMAIL),
                (&by_client, auth::MAX_FORGOTS_PER_CLIENT),
            ],
            now,
        )
        .ok_or_else(|| ApiError::rate_limited("too many code requests, try again later"))?;
    slot.fail(now);
    drop(slot);

    // Everything that depends on the account existing runs after the answer, in the
    // background: lookup, code, stored row (written before the mail, so that the code in a
    // mail is always valid), then the mail.
    let store = Arc::clone(&state.store);
    let public_url = state.public_url.clone();
    tokio::spawn(async move {
        let pending = tokio::task::spawn_blocking(move || prepare_reset_code(&store, &email))
            .await
            .map_err(|_| ServerError::Join)
            .and_then(|r| r);
        match pending {
            Ok(Some((email, code))) => {
                let message = mail::code_mail(&code, public_url.as_deref());
                if let Err(err) = mailer.send(&email, &message).await {
                    tracing::warn!(error = %err, "password reset e-mail not sent");
                }
            }
            Ok(None) => {}
            Err(err) => tracing::error!(error = %err, "password reset code not stored"),
        }
    });
    tracing::info!("password reset requested");
    Ok(StatusCode::NO_CONTENT)
}

/// Stores a new reset code for the account of `email`, if any; returns the address and the
/// code to mail. Logs nothing that would tell whether the account exists.
fn prepare_reset_code(store: &Store, email: &str) -> Result<Option<(String, String)>, ServerError> {
    let conn = store.lock()?;
    let Some(account) = store::account_by_email(&conn, email)? else {
        return Ok(None);
    };
    let code = auth::new_reset_code()?;
    let lifetime = chrono::Duration::from_std(auth::CODE_LIFETIME)
        .map_err(|_| ServerError::Invalid("code lifetime out of range".into()))?;
    let expires_at =
        (chrono::Utc::now() + lifetime).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    store::put_password_reset(
        &conn,
        &account.id,
        &auth::hash_reset_code(&account.id, &code),
        &expires_at,
    )?;
    Ok(Some((email.to_string(), code)))
}

/// `POST /api/password/reset`: sets the new password when the e-mailed code is right, and
/// logs every device of the account out. A wrong, used, expired or burnt code, an unknown or
/// malformed address: the same 400 `invalid_code`.
async fn reset_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<StatusCode, ApiError> {
    let body = body.map_err(ApiError::from_body_rejection)?;
    let request: ResetRequest = parse_versioned(&body)?;
    // Checked before the code: a too short password does not use up a try.
    if !auth::is_strong_enough(&request.password) {
        return Err(ApiError::new(
            ErrorCode::WeakPassword,
            format!(
                "the password must have at least {} characters",
                auth::MIN_PASSWORD_CHARS
            ),
        ));
    }
    let client = format!("client:{}", client_key(&headers));
    let reservation = state
        .reset_limiter
        .try_reserve_keys(
            &[(&client, auth::MAX_RESET_FAILURES_PER_CLIENT)],
            Instant::now(),
        )
        .ok_or_else(|| ApiError::rate_limited("too many wrong codes, try again later"))?;
    // Taken before the code is tried: once a code is accepted it is used up, so hashing the
    // new password must not then fail on a busy slot.
    let permit = hashing_permit(&state).await?;

    // Residual (accepted): an unknown address answers without the SQLite write of a counted
    // try, slightly sooner than a known one; the per-client limit bounds what can be learnt.
    let store = Arc::clone(&state.store);
    blocking(move || {
        let _permit = permit;
        let account_id = {
            let conn = store.lock()?;
            let account = match auth::normalize_email(&request.email) {
                Some(email) => store::account_by_email(&conn, &email)?,
                None => None,
            };
            match account {
                Some(account) => store::try_password_reset(
                    &conn,
                    &account.id,
                    &auth::hash_reset_code(&account.id, request.code.trim()),
                    &store::now_utc(),
                    auth::MAX_CODE_ATTEMPTS,
                )?
                .then_some(account.id),
                None => None,
            }
        };
        let Some(account_id) = account_id else {
            reservation.fail(Instant::now());
            tracing::info!("password reset refused");
            return Err(ApiError::new(
                ErrorCode::InvalidCode,
                "wrong or expired code",
            ));
        };
        drop(reservation);
        // The code is already used up: if hashing or saving fails now, the user asks for a
        // new code.
        let hash = auth::hash_password(&request.password)?;
        let revoked = store::reset_password_hash(&*store.lock()?, &account_id, &hash)?;
        tracing::info!(account_id = %account_id, revoked, "password reset");
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}

/// Token hash of the request's bearer token.
fn token_hash(headers: &HeaderMap) -> Result<String, ApiError> {
    let header = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(ApiError::unauthorized)?;
    let token = auth::bearer_token(header).ok_or_else(ApiError::unauthorized)?;
    Ok(auth::hash_token(token))
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Result<StatusCode, ApiError> {
    let hash = token_hash(&headers)?;
    let store = Arc::clone(&state.store);
    blocking(move || {
        let conn = store.lock()?;
        let authed = store::authenticate(&conn, &hash)?.ok_or_else(ApiError::unauthorized)?;
        store::revoke_device(&conn, &authed.device_id)?;
        tracing::info!(device_id = %authed.device_id, "device logged out");
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}

/// `GET /api/account`: the address of the token's account.
async fn account(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AccountResponse>, ApiError> {
    let hash = token_hash(&headers)?;
    let store = Arc::clone(&state.store);
    blocking(move || {
        let conn = store.lock()?;
        let authed = store::authenticate(&conn, &hash)?.ok_or_else(ApiError::unauthorized)?;
        let account =
            store::account_by_id(&conn, &authed.account_id)?.ok_or_else(ApiError::unauthorized)?;
        Ok(Json(AccountResponse {
            protocol: PROTOCOL_VERSION,
            email: account.email,
            created_at: account.created_at,
            email_verified: account.email_verified,
        }))
    })
    .await
}

/// Answers 401 before the body is read when the bearer token is missing or unknown; else the
/// handler finds the device and account in an [`Authed`] extension.
async fn require_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut request: Request,
    next: Next,
) -> Response {
    let hash = match token_hash(&headers) {
        Ok(hash) => hash,
        Err(err) => return err.into_response(),
    };
    let store = Arc::clone(&state.store);
    let known = blocking(move || {
        let conn = store.lock()?;
        store::authenticate(&conn, &hash)?.ok_or_else(ApiError::unauthorized)
    })
    .await;
    match known {
        Ok(authed) => {
            // A push or a chunk waits for its slots before its body is read; a download never
            // waits.
            let permit = if request.method() == Method::GET {
                None
            } else {
                match state.body_gates.enter(&authed.account_id).await {
                    Some(permit) => Some(permit),
                    None => {
                        tracing::warn!(account_id = %authed.account_id, "request refused: account busy");
                        return ApiError::rate_limited("too many requests of this account at once")
                            .into_response();
                    }
                }
            };
            request.extensions_mut().insert(authed);
            let response = next.run(request).await;
            drop(permit);
            response
        }
        Err(err) => err.into_response(),
    }
}

async fn sync_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let hash = token_hash(&headers)?;
    let body = body.map_err(ApiError::from_body_rejection)?;
    // A parsed tree is much larger than its body: only a few exist at once, server-wide.
    let parse_permit = match tokio::time::timeout(
        state.parse_wait,
        Arc::clone(&state.parse_gate).acquire_owned(),
    )
    .await
    {
        Ok(Ok(permit)) => permit,
        _ => {
            tracing::warn!("sync refused: parse slots busy");
            return Err(ApiError::rate_limited(
                "too many syncs are being read, try again later",
            ));
        }
    };
    let store = Arc::clone(&state.store);
    let files = Arc::clone(&state.files);
    blocking(move || {
        // Parsed before the database lock: a large body never holds up the other accounts.
        let request: RawSyncRequest = parse_versioned(&body)?;
        let body_bytes = u64::try_from(body.len()).unwrap_or(u64::MAX);
        drop(body);
        if request.changes.len() > MAX_PUSH_CHANGES {
            return Err(ApiError::new(
                ErrorCode::PayloadTooLarge,
                format!("at most {MAX_PUSH_CHANGES} changes per request"),
            ));
        }
        let limits = files.limits();
        // Only a push with changes can grow the account; checked before the database lock.
        let disk_low =
            !request.changes.is_empty() && files.below_floor(body_bytes, limits.min_free_bytes);
        let mut conn = store.lock()?;
        let authed = store::authenticate(&conn, &hash)?.ok_or_else(ApiError::unauthorized)?;
        let pushed = request.changes.len();
        let quota = sync::RecordsQuota {
            max_bytes: limits.records_quota_bytes,
            disk_low,
        };
        let outcome = sync::sync(
            &mut conn,
            &authed.account_id,
            &authed.device_id,
            request,
            quota,
        )?;
        drop(conn);
        // The parsed request lives until `sync` returns: its slot is held until then, so at
        // most `gate::PARSES` parsed trees exist at once (the database runs one sync at a time
        // anyway).
        drop(parse_permit);
        // Committed: the files of the deleted attachments go too (errors are only logged).
        files.delete_files(&store, &authed.account_id, &outcome.removed_files);
        let response = outcome.response;
        tracing::info!(device_id = %authed.device_id, pushed, accepted = response.accepted,
            rejected = response.rejected.len(), pulled = response.changes.len(),
            has_more = response.has_more, removed_files = outcome.removed_files.len(), "sync");
        Ok(Json(response).into_response())
    })
    .await
}

/// The attachment id of a `/api/files/{id}…` route; an undecodable one cannot exist.
fn attachment_id(path: Result<UrlPath<String>, PathRejection>) -> Result<String, ApiError> {
    path.map(|UrlPath(id)| id).map_err(|_| files::missing())
}

/// `GET /api/files/{id}/status`: how much of the attachment's file the server holds
/// ([`FileStatus`]), to resume an upload.
async fn file_status(
    State(state): State<AppState>,
    Extension(authed): Extension<Authed>,
    path: Result<UrlPath<String>, PathRejection>,
) -> Result<Json<FileStatus>, ApiError> {
    let id = attachment_id(path)?;
    let store = Arc::clone(&state.store);
    let files = Arc::clone(&state.files);
    blocking(move || files.status(&store, &authed.account_id, &id).map(Json)).await
}

/// `PUT /api/files/{id}?offset=…&size=…&sha256=…`: one chunk of the attachment's file (body
/// of at most [`MAX_CHUNK_BYTES`], read only once the token is known).
async fn upload_chunk(
    State(state): State<AppState>,
    Extension(authed): Extension<Authed>,
    path: Result<UrlPath<String>, PathRejection>,
    uri: Uri,
    body: Result<Bytes, BytesRejection>,
) -> Result<Json<FileStatus>, ApiError> {
    let id = attachment_id(path)?;
    let upload = files::Upload::from_query(uri.query())?;
    let body = body.map_err(ApiError::from_body_rejection)?;
    let store = Arc::clone(&state.store);
    let files = Arc::clone(&state.files);
    blocking(move || {
        files
            .put_chunk(&store, &authed.account_id, &id, &upload, &body)
            .map(Json)
    })
    .await
}

/// `GET /api/files/{id}`: the complete file, streamed, never rendered by a browser
/// (`application/octet-stream`, `attachment`, `nosniff`, `sandbox`); one `Range` is served as
/// 206 (several ranges: the whole file), an unsatisfiable one as 416.
async fn download_file(
    State(state): State<AppState>,
    Extension(authed): Extension<Authed>,
    path: Result<UrlPath<String>, PathRejection>,
    method: Method,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let id = attachment_id(path)?;
    let store = Arc::clone(&state.store);
    let files = Arc::clone(&state.files);
    let (stored, file_name) =
        blocking(move || files.download(&store, &authed.account_id, &id)).await?;
    let mut response = match stored {
        Stored::Disk(file) => serve_disk_file(&file, method, headers.get(RANGE)).await?,
        Stored::Remote { r2, key } => {
            serve_remote_file(&r2, &key, &method, headers.get(RANGE)).await?
        }
    };
    let headers = response.headers_mut();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(CONTENT_DISPOSITION, files::content_disposition(&file_name));
    headers.insert(CONTENT_SECURITY_POLICY, HeaderValue::from_static(FILE_CSP));
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    Ok(response)
}

/// A file on the disk through the file service; only the range reaches it (no conditional
/// request, no compression).
async fn serve_disk_file(
    file: &std::path::Path,
    method: Method,
    range: Option<&HeaderValue>,
) -> Result<Response, ApiError> {
    let mut builder = axum::http::Request::builder().method(method).uri("/");
    if let Some(range) = range {
        builder = builder.header(RANGE, range);
    }
    let request = builder
        .body(Body::empty())
        .map_err(|_| ServerError::Invalid("download request".into()))?;
    let served = ServeFile::new(file)
        .ignore_multi_range_requests(true)
        .try_call(request)
        .await;
    match served {
        Ok(response) if response.status() != StatusCode::NOT_FOUND => Ok(response.map(Body::new)),
        // Deleted between the lookup and the read.
        Ok(_) => Err(files::missing()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Err(files::missing()),
        Err(err) => Err(ServerError::from(err).into()),
    }
}

/// A file in the bucket, streamed through: R2's status (200, 206 or 416), its length and range
/// headers, and its body (none for `HEAD`).
async fn serve_remote_file(
    r2: &R2,
    key: &str,
    method: &Method,
    range: Option<&HeaderValue>,
) -> Result<Response, ApiError> {
    let found = match r2.read(key, method, range).await? {
        r2::Read::Found(found) => found,
        r2::Read::Missing => {
            tracing::warn!(key_len = key.len(), "complete file missing from the bucket");
            return Err(files::missing());
        }
    };
    let status = StatusCode::from_u16(found.status().as_u16())
        .map_err(|_| ServerError::Storage("R2 status".into()))?;
    let mut response = Response::builder().status(status);
    for name in [CONTENT_LENGTH, CONTENT_RANGE, ACCEPT_RANGES] {
        if let Some(value) = found
            .headers()
            .get(name.as_str())
            .and_then(|v| HeaderValue::from_bytes(v.as_bytes()).ok())
        {
            response = response.header(name, value);
        }
    }
    let body = if *method == Method::HEAD || status == StatusCode::RANGE_NOT_SATISFIABLE {
        Body::empty()
    } else {
        Body::from_stream(found.bytes_stream())
    };
    response
        .body(body)
        .map_err(|_| ServerError::Storage("download response".into()).into())
}

#[cfg(test)]
mod tests;
