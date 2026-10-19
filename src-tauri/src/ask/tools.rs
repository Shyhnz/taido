//! The MCP tools of a question (`POST /mcp/ask`, header `X-Ask-Id`): read only, limited to
//! the project of the question ([`Scope`]). Each call also says what the agent is doing
//! ([`AskStep`]), titles resolved.

use rusqlite::{params_from_iter, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::db::questions;
use crate::error::{AppError, AppResult};
use crate::mcp::ToolResult;

use super::{search, AskStep, Scope};

/// Tool names (allowed without a question in Claude's `--allowedTools`).
pub const TOOL_NAMES: &[&str] = &[
    "search_project",
    "search_conversations",
    "read_note_page",
    "read_task",
    "read_conversation",
];

/// Title, note, completion, due date and creation of a task.
type TaskRow = (String, String, Option<String>, Option<String>, String);

/// Characters of a conversation given by `read_conversation` (its last exchanges).
const CONVERSATION_MAX_CHARS: usize = 12_000;
/// Characters of one exchange in it.
const EXCHANGE_MAX_CHARS: usize = 2_000;

pub const INSTRUCTIONS: &str = "Taido is the user's to-do app. These tools read one project \
    of it, the one the user asks about: its notebook pages, completed tasks and past \
    conversations with Claude or Codex. They only read. Search first (search_project, \
    search_conversations), then read the results you need in full.";

pub fn definitions() -> Value {
    let query = json!({
        "type": "object",
        "properties": { "query": { "type": "string", "description": "Keywords (accents and case ignored); an item matches when it holds one of them." } },
        "required": ["query"]
    });
    let id = |what: &str| {
        json!({
            "type": "object",
            "properties": { "id": { "type": "string", "description": what } },
            "required": ["id"]
        })
    };
    json!([
        {
            "name": "search_project",
            "description": "Search the project's notebook pages and completed tasks (title and note). Returns up to 20 hits: kind (page or task), id, title, date, excerpt.",
            "inputSchema": query,
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "search_conversations",
            "description": "Search the past conversations of the project: what the user and Claude or Codex said in the sessions of its tasks, and the questions already asked about the project. Returns up to 20 hits (kind conversation): id, title, date, excerpt.",
            "inputSchema": query,
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "read_note_page",
            "description": "Read a notebook page of the project in full (Markdown).",
            "inputSchema": id("Page id (from search_project)."),
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "read_task",
            "description": "Read a task of the project: title, state, dates, note, subtasks.",
            "inputSchema": id("Task id (from search_project)."),
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "read_conversation",
            "description": "Read a past conversation (its last exchanges) or a question already asked.",
            "inputSchema": id("Conversation id (from search_conversations)."),
            "annotations": { "readOnlyHint": true }
        }
    ])
}

#[derive(Deserialize)]
struct QueryArgs {
    query: String,
}

#[derive(Deserialize)]
struct IdArgs {
    id: String,
}

fn parse<T: for<'de> Deserialize<'de>>(args: &Value) -> AppResult<T> {
    serde_json::from_value(args.clone()).map_err(|e| AppError::Invalid(format!("arguments: {e}")))
}

fn pretty(value: &Value) -> AppResult<String> {
    serde_json::to_string_pretty(value).map_err(|e| AppError::Internal(format!("tool: {e}")))
}

fn in_scope(scope: &Scope) -> String {
    vec!["?"; scope.subjects.len()].join(", ")
}

fn with_id(id: &str, scope: &Scope) -> Vec<String> {
    let mut v = vec![id.to_string()];
    v.extend(scope.subjects.iter().cloned());
    v
}

/// Runs tool `name` for a question on `scope`: its result, and what it shows the user.
pub fn run(
    conn: &Connection,
    scope: &Scope,
    name: &str,
    args: &Value,
) -> (ToolResult, Option<AskStep>) {
    match run_inner(conn, scope, name, args) {
        Ok((text, step)) => (ToolResult::ok(text), step),
        Err(e) => (ToolResult::error(e.to_string()), None),
    }
}

fn run_inner(
    conn: &Connection,
    scope: &Scope,
    name: &str,
    args: &Value,
) -> AppResult<(String, Option<AskStep>)> {
    match name {
        "search_project" => {
            let a: QueryArgs = parse(args)?;
            let hits = search::search_project(conn, scope, &a.query)?;
            Ok((
                pretty(&json!({ "project": scope.name, "hits": hits }))?,
                Some(AskStep::SearchNotes { query: a.query }),
            ))
        }
        "search_conversations" => {
            let a: QueryArgs = parse(args)?;
            let hits = search::search_conversations(conn, scope, &a.query)?;
            Ok((
                pretty(&json!({ "project": scope.name, "hits": hits }))?,
                Some(AskStep::SearchConversations { query: a.query }),
            ))
        }
        "read_note_page" => {
            let a: IdArgs = parse(args)?;
            let page: Option<(String, String, String)> = conn
                .query_row(
                    &format!(
                        "SELECT title, body, updated_at FROM note_pages WHERE id = ?1 \
                         AND deleted_at IS NULL AND subject_id IN ({})",
                        in_scope(scope)
                    ),
                    params_from_iter(with_id(&a.id, scope)),
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            let Some((title, body, at)) = page else {
                return Err(AppError::NotFound(format!(
                    "no page {} in this project",
                    a.id
                )));
            };
            let text = format!(
                "{title}\n(page {}, changed {at})\n\n{}",
                a.id,
                crate::mcp::tools::render_for_claude(conn, &body)?
            );
            Ok((text, Some(AskStep::ReadPage { title })))
        }
        "read_task" => {
            let a: IdArgs = parse(args)?;
            let task: Option<TaskRow> = conn
                .query_row(
                    &format!(
                        "SELECT title, description, completed_at, due_date, created_at \
                         FROM tasks WHERE id = ?1 AND deleted_at IS NULL \
                         AND subject_id IN ({})",
                        in_scope(scope)
                    ),
                    params_from_iter(with_id(&a.id, scope)),
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
                .optional()?;
            let Some((title, note, completed_at, due, created_at)) = task else {
                return Err(AppError::NotFound(format!(
                    "no task {} in this project",
                    a.id
                )));
            };
            let mut stmt = conn.prepare(
                "SELECT title, completed_at IS NOT NULL FROM tasks \
                 WHERE parent_id = ?1 AND deleted_at IS NULL ORDER BY position",
            )?;
            let children: Vec<Value> = stmt
                .query_map([&a.id], |r| {
                    Ok(json!({ "title": r.get::<_, String>(0)?, "done": r.get::<_, bool>(1)? }))
                })?
                .collect::<Result<_, _>>()?;
            let text = pretty(&json!({
                "id": a.id,
                "title": title,
                "completed_at": completed_at,
                "due_date": due,
                "created_at": created_at,
                "note": crate::mcp::tools::render_for_claude(conn, &note)?,
                "subtasks": children,
            }))?;
            Ok((text, Some(AskStep::ReadTask { title })))
        }
        "read_conversation" => {
            let a: IdArgs = parse(args)?;
            if let Some((title, exchanges)) = search::session_exchanges(conn, scope, &a.id)? {
                // The last exchanges first fill the budget, then shown in order.
                let mut kept = Vec::new();
                let mut used = 0;
                for e in exchanges.iter().rev() {
                    let text: String = e.text.trim().chars().take(EXCHANGE_MAX_CHARS).collect();
                    let line = format!("[{}] {} : {text}", e.at, e.who);
                    used += line.chars().count();
                    if used > CONVERSATION_MAX_CHARS && !kept.is_empty() {
                        break;
                    }
                    kept.push(line);
                }
                kept.reverse();
                let text = format!(
                    "Conversation de la tâche « {title} » ({} échanges, les derniers ci-dessous)\n\n{}",
                    exchanges.len(),
                    kept.join("\n\n")
                );
                return Ok((text, Some(AskStep::ReadConversation { title })));
            }
            if let Ok(subject) = questions::subject_of(conn, &a.id) {
                if scope.subjects.contains(&subject) {
                    let q = questions::get(conn, &a.id)?;
                    let text = format!(
                        "Question posée le {} : {}\nRéponse : {}",
                        q.asked_at, q.question, q.answer
                    );
                    return Ok((text, Some(AskStep::ReadConversation { title: q.question })));
                }
            }
            Err(AppError::NotFound(format!(
                "no conversation {} in this project",
                a.id
            )))
        }
        other => Err(AppError::Invalid(format!("unknown tool {other}"))),
    }
}
