//! The app's MCP server for the Claude sessions it launches (2026-10-05): Claude adds
//! tasks, subtasks and note text to Todo. Served by the hook server (`POST /mcp`, same port and
//! token) and handed to Claude with `--mcp-config` (`claude-mcp.json`).
//!
//! Transport: MCP Streamable HTTP, **legacy era** (`initialize` handshake, protocol
//! 2025-11-25), stateless: no `Mcp-Session-Id`, one JSON body per request, `GET` → 405.
//! Claude Code 2.1.289 first probes the 2026-07-28 era with `server/discover`; our 400
//! "method not found" makes it fall back to `initialize` (spike of 2026-10-05,
//! `fixtures/mcp/`).

pub mod tools;

use std::sync::Arc;

use serde_json::{json, Value};

/// Server name in `claude-mcp.json`: Claude sees the tools as `mcp__taido__<tool>`.
pub const SERVER_NAME: &str = "taido";

/// What a tool call gives back to Claude: text, and `is_error` when the tool refused.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolResult {
    pub text: String,
    pub is_error: bool,
}

impl ToolResult {
    pub fn ok(text: impl Into<String>) -> Self {
        ToolResult {
            text: text.into(),
            is_error: false,
        }
    }

    pub fn error(text: impl Into<String>) -> Self {
        ToolResult {
            text: text.into(),
            is_error: true,
        }
    }
}

/// Runs one tool for the Claude session of a terminal: (`X-Terminal-Id`, tool name,
/// arguments). Blocking (SQLite): the server calls it off its async workers.
pub type ToolRunner = Arc<dyn Fn(Option<&str>, &str, &Value) -> ToolResult + Send + Sync>;

/// Legacy protocol versions served (the client's is echoed); any other gets [`LATEST`].
const PROTOCOL_VERSIONS: &[&str] = &["2025-03-26", "2025-06-18", "2025-11-25"];
const LATEST: &str = "2025-11-25";
const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

/// Shown to the model by Claude Code ("MCP Server Instructions").
const INSTRUCTIONS: &str = "Taido is the to-do app that opened this Claude Code session. The \
    session belongs to one Taido task, the current task (its title, project and note may be in \
    your context). Use these tools when the user asks you to add something to Taido: a task \
    (create_task), a subtask (create_subtask), or a comment or a note on a task (add_to_note: \
    comments go into the task's note). Without other indication, everything targets the \
    current task and its project; call list_projects or list_tasks first only when the user \
    names another project, section or task. These tools only add: to delete, complete, rename \
    or move something, tell the user to do it in Taido. Each project also has a notebook of \
    pages (access, decisions, links…): list_note_pages, read_note_page, create_note_page, \
    add_to_note_page. When the user says things like \"put that in the project notes\", use \
    create_note_page or add_to_note_page.";

/// HTTP answer to one POSTed message.
#[derive(Debug, PartialEq)]
pub enum Reply {
    /// 200 with this JSON-RPC response.
    Ok(Value),
    /// 202 without body: a notification, or a response from the client.
    Accepted,
    /// 400 with this JSON-RPC error: unreadable message, or unknown method (`server/discover`).
    BadRequest(Value),
}

/// A list of tools and what the model is told about them.
pub struct Toolset {
    pub definitions: fn() -> Value,
    pub instructions: &'static str,
}

/// The tools of a task's terminal (`POST /mcp`).
pub const TASK_TOOLS: Toolset = Toolset {
    definitions: tools::definitions,
    instructions: INSTRUCTIONS,
};

/// The read-only tools of a question to a project (`POST /mcp/ask`, `crate::ask`).
pub const ASK_TOOLS: Toolset = Toolset {
    definitions: crate::ask::tools::definitions,
    instructions: crate::ask::tools::INSTRUCTIONS,
};

/// Handles one POSTed JSON-RPC message for the task tools; `call` runs a tool (name, arguments).
pub fn handle(body: &[u8], call: impl FnOnce(&str, &Value) -> ToolResult) -> Reply {
    handle_with(&TASK_TOOLS, body, call)
}

/// Handles one POSTed JSON-RPC message for `set`.
pub fn handle_with(
    set: &Toolset,
    body: &[u8],
    call: impl FnOnce(&str, &Value) -> ToolResult,
) -> Reply {
    let Ok(msg) = serde_json::from_slice::<Value>(body) else {
        return Reply::BadRequest(error(Value::Null, PARSE_ERROR, "parse error"));
    };
    // JSON-RPC batches left MCP in 2025-06-18.
    let Some(obj) = msg.as_object() else {
        return Reply::BadRequest(error(Value::Null, INVALID_REQUEST, "expected one message"));
    };
    let (Some(method), Some(id)) = (obj.get("method").and_then(Value::as_str), obj.get("id"))
    else {
        // A notification, or a response (we never send requests): nothing to answer.
        return Reply::Accepted;
    };
    let id = id.clone();
    let params = obj.get("params").cloned().unwrap_or(Value::Null);
    match method {
        "initialize" => Reply::Ok(result(id, initialize(&params, set.instructions))),
        "ping" => Reply::Ok(result(id, json!({}))),
        "tools/list" => Reply::Ok(result(id, json!({ "tools": (set.definitions)() }))),
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Reply::Ok(error(id, INVALID_PARAMS, "tools/call needs a tool name"));
            };
            let args = match params.get("arguments") {
                Some(a) if !a.is_null() => a.clone(),
                _ => json!({}),
            };
            let r = call(name, &args);
            Reply::Ok(result(
                id,
                json!({ "content": [{ "type": "text", "text": r.text }], "isError": r.is_error }),
            ))
        }
        other => Reply::BadRequest(error(
            id,
            METHOD_NOT_FOUND,
            &format!("method not found: {other}"),
        )),
    }
}

fn initialize(params: &Value, instructions: &str) -> Value {
    let asked = params.get("protocolVersion").and_then(Value::as_str);
    let version = asked
        .filter(|v| PROTOCOL_VERSIONS.contains(v))
        .unwrap_or(LATEST);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
        "instructions": instructions,
    })
}

fn result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// A real message of Claude Code captured in the spike (`fixtures/mcp/`).
#[cfg(test)]
pub fn test_fixture(name: &str) -> String {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/mcp/");
    std::fs::read_to_string(format!("{path}{name}")).expect("fixture")
}

#[cfg(test)]
mod tests;
