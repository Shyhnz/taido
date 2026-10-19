use std::sync::Mutex;

use super::{test_fixture as fixture, test_post as post, *};
use super::{test_request as request, test_serve_with_tools};
use crate::mcp::{test_fixture as mcp_fixture, ToolResult, ToolRunner};

type Seen = Arc<Mutex<Vec<(Option<String>, String, String)>>>;

/// Starts a server on its own runtime thread; returns port, token and what it recorded.
fn start() -> (u16, String, Seen) {
    let server = HookServer::bind().expect("bind");
    let (port, token) = (server.port, server.token.clone());
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    let recorder: Recorder = Arc::new(move |terminal, event, payload| {
        s.lock().expect("lock").push((
            terminal.map(str::to_string),
            event.to_string(),
            payload.to_string(),
        ));
    });
    test_serve(server, recorder);
    (port, token, seen)
}

#[test]
fn records_authenticated_events_with_their_terminal() {
    let (port, token, seen) = start();
    let payload = fixture("Stop.json");
    let (status, body) = post(
        port,
        &[("X-App-Token", &token), ("X-Terminal-Id", "term-1")],
        &payload,
    );
    assert!(status.contains("200"), "{status}");
    assert_eq!(body, "{}");
    let perm = fixture("PermissionRequest-Bash.json");
    let (status, body) = post(
        port,
        &[("X-App-Token", &token), ("X-Terminal-Id", "term-1")],
        &perm,
    );
    assert!(
        status.contains("200"),
        "permissions are still answered at once"
    );
    assert_eq!(body, "{}");
    let seen = seen.lock().expect("lock");
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].0.as_deref(), Some("term-1"));
    assert_eq!(seen[0].1, "Stop");
    assert_eq!(seen[0].2, payload);
    assert_eq!(seen[1].1, "PermissionRequest");
}

#[test]
fn rejects_a_missing_or_wrong_token() {
    let (port, token, seen) = start();
    let (status, _) = post(port, &[], "{}");
    assert!(status.contains("401"), "{status}");
    let mut wrong = token.clone();
    wrong.replace_range(0..1, if token.starts_with('0') { "1" } else { "0" });
    let (status, _) = post(port, &[("X-App-Token", &wrong)], "{}");
    assert!(status.contains("401"), "{status}");
    assert!(seen.lock().expect("lock").is_empty());
}

#[test]
fn unknown_or_malformed_payloads_are_recorded_as_unknown() {
    let (port, token, seen) = start();
    let (status, _) = post(port, &[("X-App-Token", &token)], "not json");
    assert!(status.contains("200"));
    let (status, _) = post(
        port,
        &[("X-App-Token", &token)],
        r#"{"hook_event_name":"Future","x":1}"#,
    );
    assert!(status.contains("200"));
    let seen = seen.lock().expect("lock");
    assert_eq!(seen[0].0, None);
    assert_eq!(seen[0].1, "unknown");
    assert_eq!(seen[1].1, "Future");
}

#[test]
fn bodies_over_one_mebibyte_are_refused() {
    let (port, token, seen) = start();
    let big = format!(
        r#"{{"hook_event_name":"Stop","x":"{}"}}"#,
        "a".repeat(BODY_LIMIT + 1)
    );
    let (status, _) = post(port, &[("X-App-Token", &token)], &big);
    assert!(status.contains("413"), "{status}");
    assert!(seen.lock().expect("lock").is_empty());
}

#[test]
fn tokens_are_64_hex_chars_and_differ() {
    let a = new_token();
    assert_eq!(a.len(), 64);
    assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(a, new_token());
    assert!(constant_time_eq(b"abc", b"abc"));
    assert!(!constant_time_eq(b"abc", b"abd"));
    assert!(!constant_time_eq(b"abc", b"ab"));
}

type Calls = Arc<Mutex<Vec<(Option<String>, String, serde_json::Value)>>>;

/// A server whose tools record their calls and answer « done ».
fn start_mcp() -> (u16, String, Calls) {
    let server = HookServer::bind().expect("bind");
    let (port, token) = (server.port, server.token.clone());
    let calls: Calls = Arc::new(Mutex::new(Vec::new()));
    let c = calls.clone();
    let tools: ToolRunner = Arc::new(move |terminal, name, args| {
        c.lock().expect("lock").push((
            terminal.map(str::to_string),
            name.to_string(),
            args.clone(),
        ));
        ToolResult::ok("done")
    });
    let recorder: Recorder = Arc::new(|_, _, _| {});
    test_serve_with_tools(server, recorder, tools);
    (port, token, calls)
}

const TOOL_CALL: &str = r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"create_subtask","arguments":{"title":"Pain"}}}"#;

#[test]
fn mcp_requires_the_token() {
    let (port, _, calls) = start_mcp();
    let (status, _) = request(port, "POST", "/mcp", &[("X-App-Token", "wrong")], TOOL_CALL);
    assert!(status.contains("401"), "{status}");
    let (status, _) = request(port, "POST", "/mcp", &[], TOOL_CALL);
    assert!(status.contains("401"), "{status}");
    assert!(calls.lock().expect("lock").is_empty());
}

#[test]
fn mcp_refuses_browser_pages() {
    let (port, token, calls) = start_mcp();
    let (status, _) = request(
        port,
        "POST",
        "/mcp",
        &[
            ("X-App-Token", token.as_str()),
            ("Origin", "http://evil.example"),
        ],
        TOOL_CALL,
    );
    assert!(status.contains("403"), "{status}");
    assert!(calls.lock().expect("lock").is_empty());
}

#[test]
fn mcp_runs_a_tool_for_the_terminal_of_the_request() {
    let (port, token, calls) = start_mcp();
    let headers = [("X-App-Token", token.as_str()), ("X-Terminal-Id", "term-1")];
    let (status, body) = request(
        port,
        "POST",
        "/mcp",
        &headers,
        &mcp_fixture("initialize.json"),
    );
    assert!(status.contains("200"), "{status}");
    assert!(
        body.contains("\"protocolVersion\":\"2025-11-25\""),
        "{body}"
    );
    let (status, body) = request(port, "POST", "/mcp", &headers, TOOL_CALL);
    assert!(status.contains("200"), "{status}");
    let v: serde_json::Value = serde_json::from_str(&body).expect("json");
    assert_eq!(v["result"]["content"][0]["text"], "done");
    let calls = calls.lock().expect("lock");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0.as_deref(), Some("term-1"));
    assert_eq!(calls[0].1, "create_subtask");
    assert_eq!(calls[0].2["title"], "Pain");
}

#[test]
fn mcp_notifications_get_202_discover_400_and_get_405() {
    let (port, token, _) = start_mcp();
    let headers = [("X-App-Token", token.as_str())];
    let (status, _) = request(
        port,
        "POST",
        "/mcp",
        &headers,
        &mcp_fixture("notifications-initialized.json"),
    );
    assert!(status.contains("202"), "{status}");
    let (status, body) = request(
        port,
        "POST",
        "/mcp",
        &headers,
        &mcp_fixture("server-discover.json"),
    );
    assert!(status.contains("400"), "{status}");
    assert!(body.contains("-32601"), "{body}");
    // Claude Code opens an SSE stream with GET: this server has none.
    let (status, _) = request(port, "GET", "/mcp", &headers, "");
    assert!(status.contains("405"), "{status}");
}

/// `/mcp/ask` serves the question tools to the question named by `X-Ask-Id`, with the same
/// token and origin checks as `/mcp`.
#[test]
fn ask_route_serves_the_question_tools() {
    let server = HookServer::bind().expect("bind");
    let (port, token) = (server.port, server.token.clone());
    type Calls = Arc<Mutex<Vec<(Option<String>, String)>>>;
    let calls: Calls = Arc::new(Mutex::new(Vec::new()));
    let c = calls.clone();
    let ask: ToolRunner = Arc::new(move |ask_id, name, _| {
        c.lock()
            .expect("lock")
            .push((ask_id.map(str::to_string), name.to_string()));
        ToolResult::ok("hits")
    });
    let tasks: ToolRunner = Arc::new(|_, _, _| ToolResult::error("task tools"));
    super::test_serve_all(server, Arc::new(|_, _, _| {}), tasks, ask);
    let list = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
    let (status, body) = request(port, "POST", "/mcp/ask", &[("X-App-Token", &token)], list);
    assert!(status.contains("200"), "{status}");
    assert!(
        body.contains("search_conversations") && !body.contains("create_task"),
        "{body}"
    );
    let call = r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_project","arguments":{"query":"prix"}}}"#;
    let (_, body) = request(
        port,
        "POST",
        "/mcp/ask",
        &[("X-App-Token", &token), ("X-Ask-Id", "a1")],
        call,
    );
    assert!(body.contains("hits"), "{body}");
    assert_eq!(
        *calls.lock().expect("lock"),
        vec![(Some("a1".to_string()), "search_project".to_string())]
    );
    let (status, _) = request(port, "POST", "/mcp/ask", &[("X-App-Token", "wrong")], call);
    assert!(status.contains("401"), "{status}");
}
