//! Local server receiving Claude Code's HTTP hooks.
//!
//! axum on `127.0.0.1`, random port, three routes: `POST /hooks`, `POST /mcp` (the app's MCP
//! server, `crate::mcp`) and `POST /mcp/ask` (the read-only tools of a question to a project,
//! `crate::ask`), body limited to 1 MiB.
//! A random 32-byte token per app launch, compared in constant time (401 otherwise). Payloads
//! are handed to a recorder with the `X-Terminal-Id` header and the event name.
//!
//! The recorder (`session_service`) logs every event to `hook_events`, decodes
//! it ([`payload`]) and routes it to the state machine. Every request, `PermissionRequest`
//! included, still gets `200 {}` at once: holding permission requests is not built.

pub mod payload;

use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::header::ORIGIN;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::mcp::{self, ToolRunner};

const BODY_LIMIT: usize = 1024 * 1024;

/// Receives every authenticated event: terminal id (header), event name, raw payload.
pub type Recorder = Arc<dyn Fn(Option<&str>, &str, &str) + Send + Sync>;

#[derive(Clone)]
struct Shared {
    token: Arc<str>,
    recorder: Recorder,
    tools: ToolRunner,
    /// Tools of a question: (`X-Ask-Id`, tool name, arguments).
    ask_tools: ToolRunner,
}

/// A bound, not yet serving, hook server: the port is known before Claude is launched.
pub struct HookServer {
    listener: TcpListener,
    pub port: u16,
    pub token: String,
}

/// 32 random bytes as hex (two v4 UUIDs: 244 random bits from the OS generator).
pub fn new_token() -> String {
    let a = uuid::Uuid::new_v4();
    let b = uuid::Uuid::new_v4();
    a.as_bytes()
        .iter()
        .chain(b.as_bytes())
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

impl HookServer {
    /// Binds `127.0.0.1:0`.
    pub fn bind() -> std::io::Result<Self> {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        Ok(HookServer {
            listener,
            port,
            token: new_token(),
        })
    }

    /// Serves forever; must run inside a Tokio runtime.
    pub async fn serve(
        self,
        recorder: Recorder,
        tools: ToolRunner,
        ask_tools: ToolRunner,
    ) -> std::io::Result<()> {
        let listener = tokio::net::TcpListener::from_std(self.listener)?;
        let shared = Shared {
            token: self.token.into(),
            recorder,
            tools,
            ask_tools,
        };
        // Other methods on `/mcp` (Claude Code's `GET` for an SSE stream) get axum's 405.
        let app = Router::new()
            .route("/hooks", post(receive))
            .route("/mcp", post(receive_mcp))
            .route(crate::ask::MCP_ROUTE, post(receive_ask_mcp))
            .layer(DefaultBodyLimit::max(BODY_LIMIT))
            .with_state(shared);
        axum::serve(listener, app).await
    }
}

/// Byte comparison whose duration does not depend on where the inputs differ.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get("x-app-token")
        .map(|v| constant_time_eq(v.as_bytes(), token.as_bytes()))
        .unwrap_or(false)
}

fn terminal_header(headers: &HeaderMap) -> Option<String> {
    header(headers, "x-terminal-id")
}

fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

/// An MCP `initialize` request: the agent of the terminal is up.
fn is_initialize(body: &[u8]) -> bool {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v.get("method")?.as_str().map(|m| m == "initialize"))
        .unwrap_or(false)
}

/// One MCP message of a question to a project (`crate::ask`): same checks as `/mcp`.
async fn receive_ask_mcp(
    State(shared): State<Shared>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if headers.contains_key(ORIGIN) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !authorized(&headers, &shared.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let ask_id = header(&headers, "x-ask-id");
    let tools = shared.ask_tools.clone();
    let reply = tokio::task::spawn_blocking(move || {
        mcp::handle_with(&mcp::ASK_TOOLS, &body, |name, args| {
            tools(ask_id.as_deref(), name, args)
        })
    })
    .await;
    mcp_response(reply)
}

fn mcp_response(reply: Result<mcp::Reply, tokio::task::JoinError>) -> Response {
    match reply {
        Ok(mcp::Reply::Ok(v)) => (StatusCode::OK, Json(v)).into_response(),
        Ok(mcp::Reply::Accepted) => StatusCode::ACCEPTED.into_response(),
        Ok(mcp::Reply::BadRequest(v)) => (StatusCode::BAD_REQUEST, Json(v)).into_response(),
        Err(e) => {
            log::warn!("MCP handler failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// One MCP message (`crate::mcp`). A browser page always sends `Origin`, Claude Code never
/// does: refusing it blocks DNS rebinding (MCP transport rules), before the token check.
async fn receive_mcp(State(shared): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
    if headers.contains_key(ORIGIN) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !authorized(&headers, &shared.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let terminal_id = terminal_header(&headers);
    if terminal_id.is_some() && is_initialize(&body) {
        let recorder = shared.recorder.clone();
        let terminal = terminal_id.clone();
        let recorded = tokio::task::spawn_blocking(move || {
            recorder(terminal.as_deref(), payload::AGENT_READY, "{}");
        })
        .await;
        if let Err(e) = recorded {
            log::warn!("agent ready recorder failed: {e}");
        }
    }
    let tools = shared.tools.clone();
    // Tools touch SQLite: off the async workers.
    let reply = tokio::task::spawn_blocking(move || {
        mcp::handle(&body, |name, args| {
            tools(terminal_id.as_deref(), name, args)
        })
    })
    .await;
    mcp_response(reply)
}

async fn receive(
    State(shared): State<Shared>,
    headers: HeaderMap,
    body: Bytes,
) -> (StatusCode, Json<Value>) {
    if !authorized(&headers, &shared.token) {
        return (StatusCode::UNAUTHORIZED, Json(json!({})));
    }
    let terminal_id = terminal_header(&headers);
    let payload = String::from_utf8_lossy(&body).into_owned();
    // Tolerant decoding: anything that is not a JSON object with `hook_event_name` is still
    // recorded, as "unknown".
    let event = serde_json::from_str::<Value>(&payload)
        .ok()
        .and_then(|v| v.get("hook_event_name")?.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string());
    let recorder = shared.recorder.clone();
    // The recorder touches SQLite: off the async workers.
    let recorded = tokio::task::spawn_blocking(move || {
        recorder(terminal_id.as_deref(), &event, &payload);
    })
    .await;
    if let Err(e) = recorded {
        log::warn!("hook recorder failed: {e}");
    }
    (StatusCode::OK, Json(json!({})))
}

/// Minimal HTTP/1.1 request for tests; returns the status line and the body.
#[cfg(test)]
pub fn test_request(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> (String, String) {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    req.push_str(body);
    stream.write_all(req.as_bytes()).expect("write");
    let mut resp = String::new();
    stream.read_to_string(&mut resp).expect("read");
    let status = resp.lines().next().unwrap_or_default().to_string();
    let body = resp
        .split("\r\n\r\n")
        .nth(1)
        .unwrap_or_default()
        .to_string();
    (status, body)
}

/// `POST /hooks` for tests.
#[cfg(test)]
pub fn test_post(port: u16, headers: &[(&str, &str)], body: &str) -> (String, String) {
    test_request(port, "POST", "/hooks", headers, body)
}

/// Serves `server` on its own runtime thread (tests); its MCP tools refuse everything.
#[cfg(test)]
pub fn test_serve(server: HookServer, recorder: Recorder) {
    let tools: ToolRunner = Arc::new(|_, _, _| mcp::ToolResult::error("no tools in this test"));
    test_serve_with_tools(server, recorder, tools);
}

/// Serves `server` with these MCP tools on its own runtime thread (tests).
#[cfg(test)]
pub fn test_serve_with_tools(server: HookServer, recorder: Recorder, tools: ToolRunner) {
    let ask: ToolRunner = Arc::new(|_, _, _| mcp::ToolResult::error("no ask tools in this test"));
    test_serve_all(server, recorder, tools, ask);
}

/// Serves `server` with these task and question tools on its own runtime thread (tests).
#[cfg(test)]
pub fn test_serve_all(server: HookServer, recorder: Recorder, tools: ToolRunner, ask: ToolRunner) {
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .expect("runtime");
        let _ = rt.block_on(server.serve(recorder, tools, ask));
    });
}

/// A real hook payload captured (`fixtures/hooks/`).
#[cfg(test)]
pub fn test_fixture(name: &str) -> String {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/hooks/");
    std::fs::read_to_string(format!("{path}{name}")).expect("fixture")
}

#[cfg(test)]
mod tests;
