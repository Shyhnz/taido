//! A fake sync server for the engine tests: axum on `127.0.0.1:0`, the algorithm of
//! docs/SYNC.md § 2.4 in memory (conflict rule of `sync_proto`), plus knobs to script
//! failures. Never the network beyond localhost. a minimal file store (status and
//! chunks, in memory) for the file job's tests.

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use sync_proto::{
    incoming_wins, Change, ChangeKey, Entity, ErrorBody, ErrorCode, FileStatus, LoginRequest,
    LoginResponse, SyncRequest, SyncResponse, Versioned, PROTOCOL_VERSION,
};

pub const PASSWORD: &str = "correct horse battery";
/// Any address: the fake server checks only the password.
pub const EMAIL: &str = "user@example.com";

/// The input of `sync_login` for this fake server (it checks only the password).
pub fn account(base_url: &str) -> crate::sync::model::AccountInput {
    crate::sync::model::AccountInput {
        server_url: base_url.to_string(),
        email: EMAIL.into(),
        password: PASSWORD.into(),
    }
}

/// One scripted answer of `/api/sync`, used once, before the real algorithm.
#[derive(Clone)]
pub enum Scripted {
    /// Status + JSON error code.
    Error(u16, ErrorCode),
    /// Status + raw body with a content type (an HTML page from a proxy).
    Raw(u16, &'static str, &'static str),
}

pub struct Record {
    pub rev: u64,
    pub change: Change,
}

pub type Hook = Box<dyn Fn() + Send>;

pub struct FakeState {
    pub epoch: String,
    pub records: BTreeMap<ChangeKey, Record>,
    pub max_rev: u64,
    pub devices: usize,
    pub page_size: usize,
    /// Requests of `/api/sync` with more changes are answered 413.
    pub max_changes: Option<usize>,
    /// Pushed changes with these ids are rejected.
    pub reject_ids: HashSet<String>,
    pub script: VecDeque<Scripted>,
    /// Requests received by `/api/sync`, in order.
    pub requests: Vec<SyncRequest>,
    /// Responses sent by `/api/sync`, in order.
    pub responses: Vec<SyncResponse>,
    /// Called while a sync request is being answered (to edit the client in flight).
    pub during_sync: Option<Hook>,
    pub logouts: usize,
    /// Attachment files by attachment id.
    pub files: BTreeMap<String, FakeFile>,
    /// Another device's upload of a file: `(id, size, sha256, bytes)` appended right after
    /// this file's next status is answered (once).
    pub racing: Option<(String, u64, String, Vec<u8>)>,
    /// File requests, in order: `status <id>`, `put <id> <offset> <len>`.
    pub file_requests: Vec<String>,
    /// Called (once) while a file status is being answered (to edit the client in flight).
    pub during_files: Option<Hook>,
}

/// One file of the fake store: what an upload declared and the bytes received.
pub struct FakeFile {
    pub size: u64,
    pub sha256: String,
    pub bytes: Vec<u8>,
    pub complete: bool,
}

pub struct FakeServer {
    pub base_url: String,
    pub state: Arc<Mutex<FakeState>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for FakeServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl FakeServer {
    pub async fn start() -> FakeServer {
        let state = Arc::new(Mutex::new(FakeState {
            epoch: "epoch-1".into(),
            records: BTreeMap::new(),
            max_rev: 0,
            devices: 0,
            page_size: sync_proto::MAX_PULL_CHANGES,
            max_changes: None,
            reject_ids: HashSet::new(),
            script: VecDeque::new(),
            requests: Vec::new(),
            responses: Vec::new(),
            during_sync: None,
            logouts: 0,
            files: BTreeMap::new(),
            racing: None,
            file_requests: Vec::new(),
            during_files: None,
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let app = Router::new()
            .route("/api/login", post(login))
            .route("/api/logout", post(logout))
            .route("/api/account", axum::routing::get(account_info))
            .route("/api/sync", post(sync))
            .route("/api/files/{id}/status", axum::routing::get(file_status))
            .route("/api/files/{id}", axum::routing::put(put_chunk))
            .layer(DefaultBodyLimit::max(sync_proto::MAX_SYNC_BODY_BYTES))
            .with_state(Arc::clone(&state));
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        FakeServer {
            base_url: format!("http://127.0.0.1:{}", addr.port()),
            state,
            task,
        }
    }

    pub fn state(&self) -> MutexGuard<'_, FakeState> {
        self.state.lock().expect("fake state")
    }

    /// Stores a change as if another device had pushed it.
    pub fn put(&self, mut change: Change) {
        let mut s = self.state();
        if change.device_id().is_empty() {
            change.set_device_id("other-device");
        }
        s.max_rev += 1;
        let rev = s.max_rev;
        s.records.insert(change.key(), Record { rev, change });
    }

    pub fn get(&self, entity: Entity, id: &str) -> Option<Change> {
        self.state()
            .records
            .get(&ChangeKey {
                entity,
                id: id.to_string(),
            })
            .map(|r| r.change.clone())
    }
}

fn error(status: u16, code: ErrorCode) -> Response {
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let body = serde_json::to_string(&ErrorBody {
        error: code,
        message: "fake".into(),
    })
    .unwrap_or_default();
    (status, [(header::CONTENT_TYPE, "application/json")], body).into_response()
}

fn json<T: serde::Serialize>(value: &T) -> Response {
    let body = serde_json::to_string(value).unwrap_or_default();
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        body,
    )
        .into_response()
}

async fn login(State(state): State<Arc<Mutex<FakeState>>>, body: Bytes) -> Response {
    let Ok(request) = serde_json::from_slice::<LoginRequest>(&body) else {
        return error(400, ErrorCode::BadRequest);
    };
    if request.password != PASSWORD {
        return error(401, ErrorCode::Unauthorized);
    }
    let mut s = state.lock().expect("fake state");
    s.devices += 1;
    json(&LoginResponse {
        protocol: PROTOCOL_VERSION,
        token: format!("token-{}", s.devices),
        device_id: format!("device-{}", s.devices),
        server_epoch: s.epoch.clone(),
    })
}

/// The account is always [`EMAIL`].
async fn account_info() -> Response {
    json(&sync_proto::AccountResponse {
        protocol: PROTOCOL_VERSION,
        email: EMAIL.into(),
        created_at: "2026-10-01T00:00:00.000Z".into(),
        email_verified: true,
    })
}

async fn logout(State(state): State<Arc<Mutex<FakeState>>>) -> StatusCode {
    state.lock().expect("fake state").logouts += 1;
    StatusCode::NO_CONTENT
}

fn device_of(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = value.strip_prefix("Bearer token-")?;
    Some(format!("device-{token}"))
}

async fn sync(
    State(state): State<Arc<Mutex<FakeState>>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(device) = device_of(&headers) else {
        return error(401, ErrorCode::Unauthorized);
    };
    let Ok(request) = serde_json::from_slice::<SyncRequest>(&body) else {
        return error(400, ErrorCode::BadRequest);
    };
    let hook = state.lock().expect("fake state").during_sync.take();
    if let Some(hook) = &hook {
        hook();
    }
    let mut s = state.lock().expect("fake state");
    s.during_sync = hook;
    s.requests.push(request.clone());
    if let Some(scripted) = s.script.pop_front() {
        return match scripted {
            Scripted::Error(status, code) => error(status, code),
            Scripted::Raw(status, content_type, body) => (
                StatusCode::from_u16(status).unwrap_or(StatusCode::OK),
                [(header::CONTENT_TYPE, content_type)],
                body,
            )
                .into_response(),
        };
    }
    if s.max_changes.is_some_and(|max| request.changes.len() > max) {
        return error(413, ErrorCode::PayloadTooLarge);
    }
    if request.protocol != PROTOCOL_VERSION {
        return error(400, ErrorCode::UnsupportedProtocol);
    }
    let mut accepted = HashSet::new();
    let mut refused = Vec::new();
    let mut rejected = Vec::new();
    for mut change in request.changes {
        let key = change.key();
        if change.validate().is_err() || s.reject_ids.contains(change.id()) {
            rejected.push(key);
            continue;
        }
        change.set_device_id(&device);
        let wins = match s.records.get(&key) {
            None => true,
            Some(stored) => incoming_wins(change.stamp(), stored.change.stamp()),
        };
        if wins {
            s.max_rev += 1;
            let rev = s.max_rev;
            s.records.insert(key.clone(), Record { rev, change });
            refused.retain(|k| k != &key);
            accepted.insert(key);
        } else {
            refused.push(key);
        }
    }
    let cursor = if request.cursor > s.max_rev {
        0
    } else {
        request.cursor
    };
    // Like the real server: only the entities the client declared (docs/SYNC.md § 0.1).
    let known = sync_proto::known_entity_set(request.known_entities.as_deref());
    let mut above: Vec<(u64, &Change)> = s
        .records
        .iter()
        .filter(|(k, r)| r.rev > cursor && !accepted.contains(*k) && known.contains(&k.entity))
        .map(|(_, r)| (r.rev, &r.change))
        .collect();
    above.sort_by_key(|(rev, _)| *rev);
    let has_more = above.len() > s.page_size;
    above.truncate(s.page_size);
    let response_cursor = if has_more {
        above.last().map(|(rev, _)| *rev).unwrap_or(cursor)
    } else {
        s.max_rev
    };
    let mut changes: Vec<(u64, Change)> = above.into_iter().map(|(r, c)| (r, c.clone())).collect();
    for key in refused.iter().filter(|k| known.contains(&k.entity)) {
        if let Some(record) = s.records.get(key) {
            if record.rev <= cursor {
                changes.push((record.rev, record.change.clone()));
            }
        }
    }
    changes.sort_by_key(|(rev, _)| *rev);
    let response = SyncResponse {
        protocol: PROTOCOL_VERSION,
        server_epoch: s.epoch.clone(),
        cursor: response_cursor,
        changes: changes.into_iter().map(|(_, c)| c).collect(),
        has_more,
        rejected,
        accepted: u32::try_from(accepted.len()).unwrap_or(u32::MAX),
        server_time: "2026-10-04T12:00:00.000Z".into(),
    };
    s.responses.push(response.clone());
    json(&response)
}

/// Size of a live attachment or page image row, `None` when the server would answer 404.
fn live_attachment_size(s: &FakeState, id: &str) -> Option<u64> {
    [Entity::Attachment, Entity::NoteAttachment]
        .into_iter()
        .find_map(|entity| {
            let key = ChangeKey {
                entity,
                id: id.to_string(),
            };
            match &s.records.get(&key)?.change {
                Change::Attachment(Versioned { data: Some(d), .. }) if d.deleted_at.is_none() => {
                    Some(d.size)
                }
                Change::NoteAttachment(Versioned { data: Some(d), .. })
                    if d.deleted_at.is_none() =>
                {
                    Some(d.size)
                }
                _ => None,
            }
        })
}

async fn file_status(
    State(state): State<Arc<Mutex<FakeState>>>,
    Path(id): Path<String>,
) -> Response {
    let hook = state.lock().expect("fake state").during_files.take();
    if let Some(hook) = hook {
        hook();
    }
    let mut s = state.lock().expect("fake state");
    s.file_requests.push(format!("status {id}"));
    let Some(row_size) = live_attachment_size(&s, &id) else {
        return error(404, ErrorCode::NotFound);
    };
    let status = match s.files.get(&id) {
        Some(f) => FileStatus {
            protocol: PROTOCOL_VERSION,
            received: f.bytes.len() as u64,
            size: f.size,
            complete: f.complete,
        },
        None => FileStatus {
            protocol: PROTOCOL_VERSION,
            received: 0,
            size: row_size,
            complete: false,
        },
    };
    if s.racing.as_ref().is_some_and(|(racing, ..)| *racing == id) {
        if let Some((_, size, sha256, bytes)) = s.racing.take() {
            s.files.insert(
                id,
                FakeFile {
                    size,
                    sha256,
                    bytes,
                    complete: false,
                },
            );
        }
    }
    json(&status)
}

async fn put_chunk(
    State(state): State<Arc<Mutex<FakeState>>>,
    Path(id): Path<String>,
    uri: Uri,
    body: Bytes,
) -> Response {
    let query: BTreeMap<String, String> = uri
        .query()
        .unwrap_or_default()
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    let number = |key: &str| query.get(key).and_then(|v| v.parse::<u64>().ok());
    let (Some(offset), Some(size), Some(sha256)) = (
        number("offset"),
        number("size"),
        query.get("sha256").cloned(),
    ) else {
        return error(400, ErrorCode::BadRequest);
    };
    let mut s = state.lock().expect("fake state");
    s.file_requests
        .push(format!("put {id} {offset} {}", body.len()));
    if live_attachment_size(&s, &id).is_none() {
        return error(404, ErrorCode::NotFound);
    }
    let restart = s
        .files
        .get(&id)
        .is_none_or(|f| f.size != size || f.sha256 != sha256);
    if restart {
        s.files.insert(
            id.clone(),
            FakeFile {
                size,
                sha256: sha256.clone(),
                bytes: Vec::new(),
                complete: false,
            },
        );
    }
    let Some(file) = s.files.get_mut(&id) else {
        return error(500, ErrorCode::BadRequest);
    };
    if offset != file.bytes.len() as u64 {
        return error(409, ErrorCode::ChunkOffset);
    }
    file.bytes.extend_from_slice(&body);
    if file.bytes.len() as u64 == size && !file.complete {
        if crate::db::attachments::sha256_bytes(&file.bytes) != sha256 {
            s.files.remove(&id);
            return error(400, ErrorCode::HashMismatch);
        }
        file.complete = true;
    }
    let status = FileStatus {
        protocol: PROTOCOL_VERSION,
        received: file.bytes.len() as u64,
        size,
        complete: file.complete,
    };
    json(&status)
}
