//! The tools of the app's MCP server. Claude only adds to Todo: tasks, subtasks, note text.
//! It never deletes, completes, renames nor moves. Everything defaults to the **current task**:
//! the task of the open Claude terminal that calls (`X-Terminal-Id`).

use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use super::ToolResult;
use crate::db::{notes, sections, subjects, subtasks, tasks, terminals};
use crate::error::{AppError, AppResult};
use crate::model::{
    AddSubtaskInput, CreateNotePageInput, CreateTaskInput, NoteKind, NoteLinkKind, TaskDetail,
    UpdateNotePageInput, UpdateTaskInput,
};
use crate::views::rows::{self, Filter, TaskFacts};

/// Tool names, in `tools/list` order (also the `permissions.allow` rules, `claude/mod.rs`).
pub const TOOL_NAMES: [&str; 9] = [
    "list_projects",
    "list_tasks",
    "create_task",
    "create_subtask",
    "add_to_note",
    "list_note_pages",
    "read_note_page",
    "create_note_page",
    "add_to_note_page",
];
const MAX_TITLE_CHARS: usize = 500;
const MAX_TEXT_CHARS: usize = 10_000;

/// A tool's result, and the tasks it changed (to refresh the UI and poke the sync).
#[derive(Debug)]
pub struct Outcome {
    pub result: ToolResult,
    pub changed: Vec<String>,
    /// The project notebooks changed (pages added to): the UI refreshes them.
    pub notes: bool,
}

/// `tools/list` entries.
pub fn definitions() -> Value {
    let task_id = json!({
        "type": "string",
        "description": "Task id from list_tasks. Default: the current task."
    });
    // MCP `ToolAnnotations` (2025-11-25): the list tools only read; the others only add
    // (`destructiveHint: false`); everything stays inside Todo (closed world).
    let project_id = json!({
        "type": "string",
        "description": "Project id from list_projects. Default: the current task's project."
    });
    let reads = json!({ "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false });
    let adds = json!({ "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false });
    json!([
        {
            "name": "list_projects",
            "description": "Lists Taido's projects (sub-projects name their parent) with their \
                sections, and tells which task is the current one. Use it to find the id of a \
                project or section the user names.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
            "annotations": reads
        },
        {
            "name": "list_tasks",
            "description": "Lists the open tasks of a project and of its sub-projects (each \
                task names its project), with their open subtasks. Default: the current task's \
                project. Use it to find the id of a task the user names.",
            "annotations": reads,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project_id": {
                        "type": "string",
                        "description": "Project id from list_projects."
                    },
                    "inbox": {
                        "type": "boolean",
                        "description": "true: the tasks without a project (« Sans projet »)."
                    }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "create_task",
            "description": "Creates a task in Taido. Default place: next to the current task \
                (same project and section).",
            "annotations": adds,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": format!("One line, at most {MAX_TITLE_CHARS} characters.")
                    },
                    "note": {
                        "type": "string",
                        "description": "Text of the task's note."
                    },
                    "project_id": {
                        "type": "string",
                        "description": "Project id from list_projects (no section)."
                    },
                    "section_id": {
                        "type": "string",
                        "description": "Section id from list_projects; the task goes in its \
                            project."
                    },
                    "inbox": {
                        "type": "boolean",
                        "description": "true: no project (« Sans projet »)."
                    },
                    "due_date": {
                        "type": "string",
                        "description": "Due date, YYYY-MM-DD (local)."
                    }
                },
                "required": ["title"],
                "additionalProperties": false
            }
        },
        {
            "name": "create_subtask",
            "description": "Adds a subtask (a checklist item, itself a small task) at the end \
                of a task's subtasks. Default: the current task. Subtasks have no subtasks: \
                under a subtask, it goes to its parent task.",
            "annotations": adds,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": format!("One line, at most {MAX_TITLE_CHARS} characters.")
                    },
                    "task_id": task_id
                },
                "required": ["title"],
                "additionalProperties": false
            }
        },
        {
            "name": "add_to_note",
            "description": "Appends text to a task's note, as a new paragraph. This is how to \
                comment on a task or note something in it. Default: the current task.",
            "annotations": adds,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": format!("At most {MAX_TEXT_CHARS} characters.")
                    },
                    "task_id": task_id
                },
                "required": ["text"],
                "additionalProperties": false
            }
        },
        {
            "name": "list_note_pages",
            "description": "Lists the pages of a project's notebook (the project's notes: \
                access, decisions, links…) with their group and the start of their text, and \
                the project's groups. Default: the current task's project. Use it to find \
                the id of a page before reading it or adding to it.",
            "annotations": reads,
            "inputSchema": {
                "type": "object",
                "properties": { "project_id": project_id },
                "additionalProperties": false
            }
        },
        {
            "name": "read_note_page",
            "description": "Reads a notebook page: its title and its text. Links to other \
                pages and tasks read as [[Title]]. Works for a page of any project, by id.",
            "annotations": reads,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Page id from list_note_pages." }
                },
                "required": ["id"],
                "additionalProperties": false
            }
        },
        {
            "name": "create_note_page",
            "description": "Creates a page in a project's notebook, at the end of its group \
                (or outside any group). Default project: the current task's project.",
            "annotations": adds,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": format!(
                            "One line, at most {} bytes (an accented letter counts 2).",
                            notes::MAX_NOTE_TITLE_BYTES
                        )
                    },
                    "body": {
                        "type": "string",
                        "description": "Text of the page, in Markdown."
                    },
                    "group": {
                        "type": "string",
                        "description": "Name or id of one of the project's groups (see \
                            list_note_pages). Default: no group."
                    },
                    "project_id": project_id
                },
                "required": ["title"],
                "additionalProperties": false
            }
        },
        {
            "name": "add_to_note_page",
            "description": "Appends text to a notebook page, as a new paragraph.",
            "annotations": adds,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Page id from list_note_pages." },
                    "text": {
                        "type": "string",
                        "description": format!("At most {MAX_TEXT_CHARS} characters.")
                    }
                },
                "required": ["id", "text"],
                "additionalProperties": false
            }
        }
    ])
}

/// Runs tool `name` for the Claude terminal `terminal_id`. Refusals and failures become
/// error results (Claude reads them); nothing is written then.
pub fn run(conn: &Connection, terminal_id: Option<&str>, name: &str, args: &Value) -> Outcome {
    let current =
        match terminal_id.map(|t| terminals::claude_task_of(conn, t)) {
            Some(Ok(Some(task_id))) => task_id,
            Some(Err(e)) => return refusal(e.to_string()),
            Some(Ok(None)) | None => return refusal(
                "This Claude session does not run in a Taido task's terminal: nothing to add to.",
            ),
        };
    let done = match name {
        "list_projects" => list_projects(conn, &current),
        "list_tasks" => list_tasks(conn, &current, args),
        "create_task" => create_task(conn, &current, args),
        "create_subtask" => create_subtask(conn, &current, args),
        "add_to_note" => add_to_note(conn, &current, args),
        "list_note_pages" => list_note_pages(conn, &current, args),
        "read_note_page" => read_note_page(conn, args),
        "create_note_page" => create_note_page(conn, &current, args),
        "add_to_note_page" => add_to_note_page(conn, args),
        other => Err(AppError::Invalid(format!("unknown tool {other}"))),
    };
    done.unwrap_or_else(|e| refusal(e.to_string()))
}

fn refusal(text: impl Into<String>) -> Outcome {
    Outcome {
        result: ToolResult::error(text),
        changed: Vec::new(),
        notes: false,
    }
}

fn read_only(value: &Value) -> AppResult<Outcome> {
    let text = serde_json::to_string_pretty(value)
        .map_err(|e| AppError::Internal(format!("tool result: {e}")))?;
    Ok(Outcome {
        result: ToolResult::ok(text),
        changed: Vec::new(),
        notes: false,
    })
}

fn parse<T: for<'de> Deserialize<'de>>(args: &Value) -> AppResult<T> {
    serde_json::from_value(args.clone())
        .map_err(|e| AppError::Invalid(format!("bad arguments: {e}")))
}

/// A title on one line, single spaces, like the panel saves it (`normalizeTitle` in the UI).
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Trimmed, not empty, at most `max` characters.
fn bounded(text: &str, max: usize, what: &str) -> AppResult<String> {
    let text = text.trim();
    if text.is_empty() {
        return Err(AppError::Invalid(format!("{what} must not be empty")));
    }
    if text.chars().count() > max {
        return Err(AppError::Invalid(format!(
            "{what} is longer than {max} characters"
        )));
    }
    Ok(text.to_string())
}

fn current_ref(d: &TaskDetail) -> Value {
    json!({
        "id": d.id,
        "title": d.title,
        "project": d.subject.as_ref().map(|s| json!({ "id": s.id, "name": s.name })),
        "section": d.section.as_ref().map(|s| json!({ "id": s.id, "name": s.name })),
        "parent_task": d.parent.as_ref().map(|p| json!({ "id": p.id, "title": p.title })),
    })
}

fn list_projects(conn: &Connection, current: &str) -> AppResult<Outcome> {
    let detail = tasks::detail(conn, current)?;
    let all = subjects::list(conn)?;
    let group_name = |id: &Option<String>| {
        id.as_ref()
            .and_then(|g| all.iter().find(|s| &s.id == g))
            .map(|g| g.name.clone())
    };
    // Groups hold no tasks (Taido V2.2 bis): only their name is given, on each project.
    let projects: Vec<Value> = all
        .iter()
        .filter(|s| !s.is_group)
        .map(|s| {
            json!({
                "id": s.id,
                "name": s.name,
                "group": group_name(&s.parent_id),
                "sections": s.sections.iter()
                    .map(|sec| json!({ "id": sec.id, "name": sec.name }))
                    .collect::<Vec<_>>(),
            })
        })
        .collect();
    read_only(&json!({
        "current_task": current_ref(&detail),
        "projects": projects,
        "inbox": "Tasks without a project (« Sans projet »): pass inbox=true.",
    }))
}

#[derive(Deserialize)]
struct ListTasksArgs {
    project_id: Option<String>,
    #[serde(default)]
    inbox: bool,
}

/// Open tasks of « Sans projet », or of a project **and its sub-projects** (product decision,
/// 2026-10-05: listing « Globex » must find a task of « Globex › Hooli »), each naming its project.
fn list_tasks(conn: &Connection, current: &str, args: &Value) -> AppResult<Outcome> {
    let a: ListTasksArgs = parse(args)?;
    let subject_id = if a.inbox {
        None
    } else {
        match a.project_id {
            Some(id) => Some(id),
            None => tasks::detail(conn, current)?.subject.map(|s| s.id),
        }
    };
    let Some(id) = subject_id else {
        let tasks: Vec<Value> = rows::load(conn, Filter::Inbox { completed: false })?
            .iter()
            .map(|t| task_entry(t, None, None))
            .collect();
        return read_only(&json!({ "project": null, "tasks": tasks }));
    };
    let subject = subjects::get(conn, &id)?;
    let mut ids = vec![id.clone()];
    ids.extend(subjects::child_ids(conn, &id)?);
    let mut tasks = Vec::new();
    for sid in &ids {
        let label = subjects::label(conn, sid)?;
        let sections = sections::list_for_subject(conn, sid)?;
        for t in rows::load(
            conn,
            Filter::Subject {
                id: sid,
                completed: false,
            },
        )? {
            let section = sections
                .iter()
                .find(|s| Some(&s.id) == t.section_id.as_ref())
                .map(|s| s.name.as_str());
            tasks.push(task_entry(&t, Some(&label), section));
        }
    }
    let project = json!({ "id": subject.id, "name": subjects::label(conn, &id)? });
    read_only(&json!({ "project": project, "tasks": tasks }))
}

fn task_entry(t: &TaskFacts, project: Option<&str>, section: Option<&str>) -> Value {
    json!({
        "id": t.id,
        "title": t.title,
        "project": project,
        "section": section,
        "due_date": t.due_date,
        "subtasks": t.children.iter()
            .filter(|c| c.completed_at.is_none())
            .map(|c| json!({ "id": c.id, "title": c.title }))
            .collect::<Vec<_>>(),
    })
}

#[derive(Deserialize)]
struct CreateTaskArgs {
    title: String,
    note: Option<String>,
    project_id: Option<String>,
    section_id: Option<String>,
    #[serde(default)]
    inbox: bool,
    due_date: Option<String>,
}

/// Where a new task goes: `inbox`, else the given section (its project), else the given
/// project (no section), else next to the current task (its project and section).
fn place(
    conn: &Connection,
    current: &str,
    a: &CreateTaskArgs,
) -> AppResult<(Option<String>, Option<String>)> {
    if a.inbox {
        if a.project_id.is_some() || a.section_id.is_some() {
            return Err(AppError::Invalid(
                "inbox=true cannot be combined with project_id or section_id".into(),
            ));
        }
        return Ok((None, None));
    }
    if let Some(section_id) = &a.section_id {
        let section = sections::get(conn, section_id)?;
        if let Some(p) = &a.project_id {
            if *p != section.subject_id {
                return Err(AppError::Invalid(format!(
                    "section {section_id} is not in project {p}"
                )));
            }
        }
        return Ok((Some(section.subject_id), Some(section_id.clone())));
    }
    if let Some(p) = &a.project_id {
        return Ok((Some(p.clone()), None));
    }
    let d = tasks::detail(conn, current)?;
    Ok((d.subject.map(|s| s.id), d.section.map(|s| s.id)))
}

/// « Perso › Maison », « Perso » or « Sans projet ».
fn place_label(conn: &Connection, d: &TaskDetail) -> AppResult<String> {
    let project = match &d.subject {
        Some(s) => subjects::label(conn, &s.id)?,
        None => return Ok("« Sans projet »".into()),
    };
    Ok(match &d.section {
        Some(sec) => format!("{project} › {}", sec.name),
        None => project,
    })
}

fn create_task(conn: &Connection, current: &str, args: &Value) -> AppResult<Outcome> {
    let a: CreateTaskArgs = parse(args)?;
    let title = bounded(&one_line(&a.title), MAX_TITLE_CHARS, "title")?;
    let note = match a.note.as_deref().filter(|n| !n.trim().is_empty()) {
        Some(n) => Some(bounded(n, MAX_TEXT_CHARS, "note")?),
        None => None,
    };
    let (subject_id, section_id) = place(conn, current, &a)?;
    let notes = note.as_deref().is_some_and(links_a_page);
    let d = tasks::create(
        conn,
        &CreateTaskInput {
            title,
            description: note,
            subject_id,
            section_id,
            due_date: a.due_date,
            due_time: None,
        },
    )?;
    let text = format!(
        "Created the task \"{}\" (id {}) in {}.",
        d.title,
        d.id,
        place_label(conn, &d)?
    );
    Ok(Outcome {
        result: ToolResult::ok(text),
        changed: vec![d.id],
        notes,
    })
}

/// A task note that links a page changes that page's « Mentionné dans ».
fn links_a_page(note: &str) -> bool {
    note.contains("[[page:")
}

#[derive(Deserialize)]
struct CreateSubtaskArgs {
    title: String,
    task_id: Option<String>,
}

fn create_subtask(conn: &Connection, current: &str, args: &Value) -> AppResult<Outcome> {
    let a: CreateSubtaskArgs = parse(args)?;
    let title = bounded(&one_line(&a.title), MAX_TITLE_CHARS, "title")?;
    let target = tasks::detail(conn, a.task_id.as_deref().unwrap_or(current))?;
    // One level only: under a subtask, the new one goes to its parent.
    let (parent_id, parent_title) = match target.parent {
        Some(p) => (p.id, p.title),
        None => (target.id, target.title),
    };
    let sub = subtasks::add(
        conn,
        &AddSubtaskInput {
            task_id: parent_id.clone(),
            text: title,
        },
    )?;
    let text = format!(
        "Added the subtask \"{}\" (id {}) to the task \"{parent_title}\".",
        sub.text, sub.id
    );
    Ok(Outcome {
        result: ToolResult::ok(text),
        changed: vec![parent_id, sub.id],
        notes: false,
    })
}

#[derive(Deserialize)]
struct AddToNoteArgs {
    text: String,
    task_id: Option<String>,
}

/// The note without its trailing blanks, an empty line, then `text`.
fn append_paragraph(note: &str, text: &str) -> String {
    let note = note.trim_end();
    if note.is_empty() {
        text.to_string()
    } else {
        format!("{note}\n\n{text}")
    }
}

fn add_to_note(conn: &Connection, current: &str, args: &Value) -> AppResult<Outcome> {
    let a: AddToNoteArgs = parse(args)?;
    let text = bounded(&a.text, MAX_TEXT_CHARS, "text")?;
    let t = tasks::detail(conn, a.task_id.as_deref().unwrap_or(current))?;
    tasks::update(
        conn,
        &UpdateTaskInput {
            id: t.id.clone(),
            title: None,
            description: Some(append_paragraph(&t.description, &text)),
        },
    )?;
    let mut changed = vec![t.id.clone()];
    // A subtask's note shows in its parent's panel too.
    changed.extend(t.parent.map(|p| p.id));
    Ok(Outcome {
        result: ToolResult::ok(format!("Added to the note of the task \"{}\".", t.title)),
        changed,
        notes: links_a_page(&text),
    })
}

// --- Notebook ---------------------------------------------------------------

/// The project an argument names, else the current task's one.
fn notebook_project(
    conn: &Connection,
    current: &str,
    project_id: Option<String>,
) -> AppResult<String> {
    let id = match project_id {
        Some(id) => id,
        None => tasks::detail(conn, current)?
            .subject
            .map(|s| s.id)
            .ok_or_else(|| {
                AppError::Invalid(
                    "the current task has no project (« Sans projet »): pass project_id".into(),
                )
            })?,
    };
    if in_trash(conn, &id)? {
        return Err(AppError::Invalid(format!(
            "the project {id} is in the trash: its notebook cannot be changed (the user can \
             restore it in Taido)"
        )));
    }
    subjects::ensure_project(conn, &id)?;
    Ok(id)
}

/// Whether `subject_id` (or its parent project) is in the trash.
fn in_trash(conn: &Connection, subject_id: &str) -> AppResult<bool> {
    Ok(conn
        .query_row(
            "SELECT s.deleted_at IS NOT NULL OR g.deleted_at IS NOT NULL FROM subjects s \
             LEFT JOIN subjects g ON g.id = s.parent_id WHERE s.id = ?1",
            [subject_id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(false))
}

/// A live page, or a refusal that tells why it cannot be reached.
fn live_page(conn: &Connection, id: &str) -> AppResult<crate::model::NotePage> {
    match notes::get_page(conn, id) {
        Err(AppError::NotFound(_)) => {
            let subject: Option<String> = conn
                .query_row(
                    "SELECT subject_id FROM note_pages WHERE id = ?1 AND deleted_at IS NULL",
                    [id],
                    |r| r.get(0),
                )
                .optional()?;
            match subject {
                Some(s) if in_trash(conn, &s)? => Err(AppError::Invalid(format!(
                    "the page {id} belongs to a project in the trash: it cannot be read or \
                     changed (the user can restore the project in Taido)"
                ))),
                _ => Err(AppError::NotFound(format!(
                    "no page {id} (deleted, or a wrong id: see list_note_pages)"
                ))),
            }
        }
        other => other,
    }
}

#[derive(Deserialize)]
struct ListNotePagesArgs {
    project_id: Option<String>,
}

fn list_note_pages(conn: &Connection, current: &str, args: &Value) -> AppResult<Outcome> {
    let a: ListNotePagesArgs = parse(args)?;
    let id = notebook_project(conn, current, a.project_id)?;
    let (groups, pages) = notes::list_for_subject(conn, &id)?;
    let group_name = |gid: &Option<String>| {
        gid.as_ref()
            .and_then(|g| groups.iter().find(|x| &x.id == g))
            .map(|g| g.name.clone())
    };
    let entries: Vec<Value> = pages
        .iter()
        .map(|p| {
            json!({
                "id": p.id,
                "title": p.title,
                "kind": p.kind.as_str(),
                "group": group_name(&p.group_id),
                "pinned": p.pinned_at.is_some(),
                "excerpt": crate::views::notes::excerpt(&p.body),
            })
        })
        .collect();
    read_only(&json!({
        "project": { "id": id, "name": subjects::label(conn, &id)? },
        "groups": groups.iter()
            .map(|g| json!({ "id": g.id, "name": g.name }))
            .collect::<Vec<_>>(),
        "pages": entries,
    }))
}

#[derive(Deserialize)]
struct ReadNotePageArgs {
    id: String,
}

/// A page body for Claude: `[[page:<id>|Old]]` becomes `[[Current title]]` (the link's own
/// copy when the target is gone), an image becomes `[image: file name]`.
pub(crate) fn render_for_claude(conn: &Connection, body: &str) -> AppResult<String> {
    let mut out = String::with_capacity(body.len());
    let mut from = 0;
    for link in notes::scan_links(body) {
        out.push_str(&body[from..link.start]);
        from = link.end;
        match link.kind {
            notes::LinkKind::Page | notes::LinkKind::Task => {
                let kind = if link.kind == notes::LinkKind::Page {
                    NoteLinkKind::Page
                } else {
                    NoteLinkKind::Task
                };
                let r = notes::resolve_link(conn, kind, link.id, link.label)?;
                out.push_str(&format!("[[{}]]", r.title));
            }
            notes::LinkKind::File => {
                let name: Option<String> = conn
                    .query_row(
                        "SELECT file_name FROM attachments WHERE id = ?1 AND deleted_at IS NULL",
                        [link.id],
                        |r| r.get(0),
                    )
                    .optional()?;
                match name {
                    Some(n) => out.push_str(&format!("[image: {n}]")),
                    None => out.push_str("[image]"),
                }
            }
        }
    }
    out.push_str(&body[from..]);
    Ok(out)
}

fn read_note_page(conn: &Connection, args: &Value) -> AppResult<Outcome> {
    let a: ReadNotePageArgs = parse(args)?;
    let page = live_page(conn, &a.id)?;
    let (groups, _) = notes::list_for_subject(conn, &page.subject_id)?;
    let place = match groups
        .iter()
        .find(|g| Some(&g.id) == page.group_id.as_ref())
    {
        Some(g) => format!("{} › {}", subjects::label(conn, &page.subject_id)?, g.name),
        None => subjects::label(conn, &page.subject_id)?,
    };
    let text = format!(
        "{}\n(page {}, in {place}, changed {})\n\n{}",
        page.title,
        page.id,
        page.updated_at,
        render_for_claude(conn, &page.body)?
    );
    Ok(Outcome {
        result: ToolResult::ok(text),
        changed: Vec::new(),
        notes: false,
    })
}

#[derive(Deserialize)]
struct CreateNotePageArgs {
    title: String,
    #[serde(default)]
    body: String,
    group: Option<String>,
    project_id: Option<String>,
}

fn create_note_page(conn: &Connection, current: &str, args: &Value) -> AppResult<Outcome> {
    let a: CreateNotePageArgs = parse(args)?;
    let title = bounded(&one_line(&a.title), MAX_TITLE_CHARS, "title")?;
    if title.len() > notes::MAX_NOTE_TITLE_BYTES {
        return Err(AppError::Invalid(format!(
            "title is longer than {} bytes (an accented letter counts 2, an emoji 4): shorten it",
            notes::MAX_NOTE_TITLE_BYTES
        )));
    }
    let subject_id = notebook_project(conn, current, a.project_id)?;
    let group = match a.group.as_deref().map(str::trim).filter(|g| !g.is_empty()) {
        Some(wanted) => {
            let (groups, _) = notes::list_for_subject(conn, &subject_id)?;
            let folded = crate::views::search::fold(wanted);
            let found = groups
                .iter()
                .find(|g| g.id == wanted)
                .or_else(|| {
                    groups
                        .iter()
                        .find(|g| crate::views::search::fold(&g.name) == folded)
                })
                .ok_or_else(|| {
                    AppError::Invalid(format!(
                        "no group \"{wanted}\" in this project (groups: {}); leave group out \
                         for a page outside any group",
                        groups
                            .iter()
                            .map(|g| g.name.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ))
                })?;
            Some(found.clone())
        }
        None => None,
    };
    let page = notes::create_page(
        conn,
        &CreateNotePageInput {
            subject_id: subject_id.clone(),
            group_id: group.as_ref().map(|g| g.id.clone()),
            title,
            body: a.body.trim_end().to_string(),
            kind: NoteKind::Page,
            source_task_id: None,
        },
    )?;
    let project = subjects::label(conn, &subject_id)?;
    let place = match group {
        Some(g) => format!("{project} › {}", g.name),
        None => project,
    };
    Ok(Outcome {
        result: ToolResult::ok(format!(
            "Created the page \"{}\" (id {}) in the notebook of {place}.",
            page.title, page.id
        )),
        changed: Vec::new(),
        notes: true,
    })
}

#[derive(Deserialize)]
struct AddToNotePageArgs {
    id: String,
    text: String,
}

fn add_to_note_page(conn: &Connection, args: &Value) -> AppResult<Outcome> {
    let a: AddToNotePageArgs = parse(args)?;
    let text = bounded(&a.text, MAX_TEXT_CHARS, "text")?;
    let page = live_page(conn, &a.id)?;
    notes::update_page(
        conn,
        &UpdateNotePageInput {
            id: page.id.clone(),
            title: None,
            body: Some(append_paragraph(&page.body, &text)),
        },
    )?;
    Ok(Outcome {
        result: ToolResult::ok(format!("Added to the page \"{}\".", page.title)),
        changed: Vec::new(),
        notes: true,
    })
}

#[cfg(test)]
mod tests;
