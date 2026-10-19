//! « Demander au projet » commands. The question runs
//! in the background (`crate::ask::run`); its steps and answer come as `AskUpdated` events.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, State};
use tauri_specta::Event;

use crate::app_state::AppState;
use crate::ask::{self, run::Launch, AskEntry, AskOverview, AskUpdate};
use crate::commands::data::{notify, TASK_SCOPES};
use crate::commands::terminals::blocking;
use crate::db::{notes, questions, settings, tasks};
use crate::error::{AppError, AppResult};
use crate::events::{AskUpdated, DataScope};
use crate::model::{Agent, CreateNotePageInput, CreateTaskInput, NoteKind, NotePage};

/// Characters of a page or task title made from a question.
const TITLE_CHARS: usize = 120;

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AskInput {
    pub subject_id: String,
    /// The panel's thread, for a follow-up question; `None` for the first one.
    pub thread_id: Option<String>,
    pub question: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AskStarted {
    pub ask_id: String,
    pub thread_id: String,
}

/// The default agent when it is installed, else the other one; `None` when neither is.
fn pick(default: Agent, installed: &[Agent]) -> Option<Agent> {
    if installed.contains(&default) {
        return Some(default);
    }
    installed.first().copied()
}

/// What the panel shows on opening: folder, agent, questions already asked.
#[tauri::command]
#[specta::specta]
pub async fn ask_overview(app: AppHandle, subject_id: String) -> AppResult<AskOverview> {
    blocking(&app, move |state| {
        let installed = state.terminals.installed_agents(&state.db)?;
        let conn = state.db.lock()?;
        let scope = ask::scope(&conn, &subject_id)?;
        Ok(AskOverview {
            has_folder: scope.root.is_some(),
            agent: pick(settings::get(&conn)?.default_agent, &installed),
            threads: questions::threads(&conn, &subject_id)?,
        })
    })
    .await
}

/// The questions of a thread (one already asked, reopened read only).
#[tauri::command]
#[specta::specta]
pub async fn ask_thread(state: State<'_, AppState>, thread_id: String) -> AppResult<Vec<AskEntry>> {
    questions::thread(&*state.db.lock()?, &thread_id)
}

/// Asks the project a question. Refused without an agent
/// (`claude_missing` / `codex_missing`), or while another question about it runs.
#[tauri::command]
#[specta::specta]
pub async fn ask_project(app: AppHandle, input: AskInput) -> AppResult<AskStarted> {
    let emit_app = app.clone();
    blocking(&app, move |state| {
        let question = input.question.trim().to_string();
        if question.is_empty() {
            return Err(AppError::Invalid("empty question".into()));
        }
        if question.chars().count() > ask::QUESTION_MAX_CHARS {
            return Err(AppError::Invalid("question too long".into()));
        }
        let installed = state.terminals.installed_agents(&state.db)?;
        let env_vars = state.terminals.env().vars.clone();
        let (scope, history, agent, program) = {
            let conn = state.db.lock()?;
            let scope = ask::scope(&conn, &input.subject_id)?;
            let history = match &input.thread_id {
                Some(t) => questions::thread(&conn, t)?,
                None => Vec::new(),
            };
            let default = settings::get(&conn)?.default_agent;
            let agent = pick(default, &installed).ok_or(match default {
                Agent::Claude => AppError::ClaudeMissing,
                Agent::Codex => AppError::CodexMissing,
            })?;
            let program = state.terminals.agent_binary(&conn, &env_vars, agent)?;
            (scope, history, agent, program)
        };
        if state.asks.busy(&scope.subject_id) {
            return Err(AppError::Invalid(
                "a question about this project is already running".into(),
            ));
        }
        let ask_id = crate::db::new_id();
        let thread_id = input.thread_id.clone().unwrap_or_else(crate::db::new_id);
        let mut env = env_vars;
        env.insert(
            "TAIDO_HOOK_TOKEN".into(),
            state.terminals.hook_token().to_string(),
        );
        env.insert(ask::ASK_ID_VAR.into(), ask_id.clone());
        let data_dir = state.terminals.data_dir().to_path_buf();
        let cwd = match &scope.root {
            Some(root) => root.clone(),
            None => {
                let empty = data_dir.join("ask-empty");
                std::fs::create_dir_all(&empty)?;
                empty
            }
        };
        let system = ask::system_prompt(&scope);
        let args = match agent {
            Agent::Claude => ask::claude_args(&system, &data_dir.join(ask::MCP_FILE)),
            Agent::Codex => ask::codex_args(
                &system,
                state.terminals.hook_port(),
                &cwd,
                &data_dir.join(ask::SCHEMA_FILE),
            ),
        };
        let launch = Launch {
            ask_id: ask_id.clone(),
            thread_id: thread_id.clone(),
            input: ask::user_message(&history, &question),
            question,
            agent,
            program,
            args,
            env,
            cwd,
            scope: Arc::new(scope),
            timeout: ask::run::TIMEOUT,
        };
        let id = ask_id.clone();
        let emit: ask::run::Emit = Arc::new(move |update: AskUpdate| {
            let event = AskUpdated {
                ask_id: id.clone(),
                update,
            };
            if let Err(e) = event.emit(&emit_app) {
                log::warn!("cannot emit ask_updated: {e}");
            }
        });
        state.asks.start(launch, state.db.clone(), emit)?;
        Ok(AskStarted { ask_id, thread_id })
    })
    .await
}

/// Stops a running question (nothing is stored).
#[tauri::command]
#[specta::specta]
pub async fn ask_stop(state: State<'_, AppState>, ask_id: String) -> AppResult<()> {
    state.asks.stop(&ask_id);
    Ok(())
}

/// A title from a question: one line, [`TITLE_CHARS`] at most.
fn title_of(question: &str) -> String {
    let line = question.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut t: String = line.chars().take(TITLE_CHARS).collect();
    let mut cut = t.chars().count() < line.chars().count();
    let ellipsis = '…'.len_utf8();
    while t.len() + if cut { ellipsis } else { 0 } > notes::MAX_NOTE_TITLE_BYTES {
        t.pop();
        cut = true;
    }
    if cut {
        t.push('…');
    }
    t
}

/// « Ranger dans une note »: a new page of the project's notebook with the answer and its
/// sources.
#[tauri::command]
#[specta::specta]
pub async fn ask_save_note(
    app: AppHandle,
    state: State<'_, AppState>,
    question_id: String,
) -> AppResult<NotePage> {
    let conn = state.db.lock()?;
    let entry = questions::get(&conn, &question_id)?;
    let page = notes::create_page(
        &conn,
        &CreateNotePageInput {
            subject_id: questions::subject_of(&conn, &question_id)?,
            group_id: None,
            title: title_of(&entry.question),
            body: ask::as_markdown(&entry),
            kind: NoteKind::Page,
            source_task_id: None,
        },
    )?;
    notify(&app, &conn, &[DataScope::Notes], None);
    Ok(page)
}

/// « En faire une tâche »: a task of the project, the answer and its sources as its note.
/// Returns its id.
#[tauri::command]
#[specta::specta]
pub async fn ask_make_task(
    app: AppHandle,
    state: State<'_, AppState>,
    question_id: String,
) -> AppResult<String> {
    let conn = state.db.lock()?;
    let entry = questions::get(&conn, &question_id)?;
    let task = tasks::create(
        &conn,
        &CreateTaskInput {
            title: title_of(&entry.question),
            description: Some(ask::as_markdown(&entry)),
            subject_id: Some(questions::subject_of(&conn, &question_id)?),
            section_id: None,
            due_date: None,
            due_time: None,
        },
    )?;
    notify(&app, &conn, TASK_SCOPES, Some(vec![task.id.clone()]));
    Ok(task.id)
}

/// The absolute path of a file source, checked inside the project's folder (to open it with
/// `open_path`). `not_found` when it is not there any more.
#[tauri::command]
#[specta::specta]
pub async fn ask_file_path(
    state: State<'_, AppState>,
    subject_id: String,
    path: String,
) -> AppResult<String> {
    let scope = ask::scope(&*state.db.lock()?, &subject_id)?;
    let root = scope
        .root
        .ok_or_else(|| AppError::NotFound("project folder".into()))?;
    let (relative, _) = ask::verify::read_inside(&root, &path)
        .ok_or_else(|| AppError::NotFound(format!("file {path}")))?;
    Ok(root
        .canonicalize()?
        .join(relative)
        .to_string_lossy()
        .into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_prefers_the_default_agent() {
        assert_eq!(
            pick(Agent::Codex, &[Agent::Claude, Agent::Codex]),
            Some(Agent::Codex)
        );
        assert_eq!(pick(Agent::Codex, &[Agent::Claude]), Some(Agent::Claude));
        assert_eq!(pick(Agent::Claude, &[]), None);
    }

    #[test]
    fn titles_from_questions() {
        assert_eq!(
            title_of("  C'était quoi\n le prix ? "),
            "C'était quoi le prix ?"
        );
        let long = "é".repeat(300);
        let t = title_of(&long);
        assert!(t.ends_with('…'));
        assert!(t.len() <= notes::MAX_NOTE_TITLE_BYTES);
    }
}

/// « Demander au projet » in a terminal: the project's Claude Code (the running one, else a
/// new one). Refused without Claude (`claude_missing`).
#[tauri::command]
#[specta::specta]
pub async fn open_ask_terminal(
    app: AppHandle,
    subject_id: String,
    cols: u16,
    rows: u16,
) -> AppResult<crate::model::TerminalInfo> {
    let notify_app = app.clone();
    blocking(&app, move |state| {
        let info = state
            .terminals
            .open_ask(&state.db, &state.asks, &subject_id, cols, rows)?;
        notify(
            &notify_app,
            &*state.db.lock()?,
            &[DataScope::Terminals],
            None,
        );
        Ok(info)
    })
    .await
}
