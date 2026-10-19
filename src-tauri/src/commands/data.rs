//! Data commands. Thin handlers: they delegate to the services and emit
//! `DataChanged` / `CountsChanged` after every mutation.
//!
//! Every command is `async` (bug #4): Tauri runs synchronous commands on the main thread,
//! which would freeze the window while SQLite waits on the lock or `git` runs. `git` itself
//! runs on the blocking pool, once the database lock is released.

use rusqlite::Connection;
use tauri::{AppHandle, Manager, State};
use tauri_specta::Event;

use crate::app_state::AppState;
use crate::db::top_level::{self, TopItem};
use crate::db::{
    agent_sessions, attachments, board_columns, journal, notes, relations, sections, settings,
    subjects, subtasks, tasks, time_segments,
};
use crate::error::{AppError, AppResult};
use crate::events::{CountsChanged, DataChanged, DataScope};
use crate::model::*;
use crate::views;

fn today() -> chrono::NaiveDate {
    chrono::Local::now().date_naive()
}

/// Emits `DataChanged`, then `CountsChanged` with fresh counts, and pokes the sync when synced
/// rows may have changed. Emission failures are logged: the mutation itself succeeded.
pub(crate) fn notify(
    app: &AppHandle,
    conn: &Connection,
    scopes: &[DataScope],
    task_ids: Option<Vec<String>>,
) {
    let changed = DataChanged {
        scopes: scopes.to_vec(),
        task_ids,
    };
    if let Err(e) = changed.emit(app) {
        log::warn!("cannot emit data_changed: {e}");
    }
    // A local change of synced rows: the sync goes 10 s later when something is pending.
    if scopes.contains(&DataScope::Subjects)
        || scopes.contains(&DataScope::Tasks)
        || scopes.contains(&DataScope::Notes)
    {
        if let Some(state) = app.try_state::<AppState>() {
            state.sync.poke(conn);
        }
    }
    match views::counts(conn, today()) {
        Ok(counts) => {
            if let Err(e) = (CountsChanged { counts }).emit(app) {
                log::warn!("cannot emit counts_changed: {e}");
            }
        }
        Err(e) => log::warn!("cannot compute counts: {e}"),
    }
}

/// Scopes touched by a task mutation: rows, subject counters and the journal.
pub(crate) const TASK_SCOPES: &[DataScope] =
    &[DataScope::Tasks, DataScope::Subjects, DataScope::Journal];
/// Task scopes when the task's terminals may have been closed.
const TASK_SCOPES_WITH_TERMINALS: &[DataScope] = &[
    DataScope::Tasks,
    DataScope::Subjects,
    DataScope::Journal,
    DataScope::Terminals,
];

/// Deleting or restoring a task also changes the notebook: its `[[task:…]]` chips turn dead or
/// alive, and the pages its note links lose or regain it in « Mentionné dans ».
const TASK_DELETE_SCOPES: &[DataScope] = &[
    DataScope::Tasks,
    DataScope::Subjects,
    DataScope::Journal,
    DataScope::Terminals,
    DataScope::Notes,
];
const TASK_RESTORE_SCOPES: &[DataScope] = &[
    DataScope::Tasks,
    DataScope::Subjects,
    DataScope::Journal,
    DataScope::Notes,
];

/// Scopes of `update_task`: the notebook too when the title changes (link chips, « Mentionné
/// dans ») or when the note links a page, before or after (that page's « Mentionné dans »).
/// Plain note typing leaves the notebooks alone.
pub(crate) fn update_task_scopes(old_note: &str, input: &UpdateTaskInput) -> &'static [DataScope] {
    let links = |note: &str| note.contains("[[page:");
    let relinked = input
        .description
        .as_deref()
        .is_some_and(|note| links(note) || links(old_note));
    if input.title.is_some() || relinked {
        &[DataScope::Tasks, DataScope::Notes]
    } else {
        &[DataScope::Tasks]
    }
}

/// Fills `git_branch` on the blocking pool (spawns git, ~1 s at most).
async fn with_git_branch(detail: TaskDetail) -> AppResult<TaskDetail> {
    tauri::async_runtime::spawn_blocking(move || tasks::with_git_branch(detail))
        .await
        .map_err(|e| AppError::Internal(format!("git branch task failed: {e}")))
}

/// Task ids a mutation of `detail` changes: the task, its parent (a subtask shows in its
/// parent's row and panel) and its children (a child's panel shows its parent's project,
/// folder and title, and moves with it).
fn notified_ids(detail: &TaskDetail) -> Vec<String> {
    let mut ids = vec![detail.id.clone()];
    ids.extend(detail.parent.as_ref().map(|p| p.id.clone()));
    ids.extend(detail.subtasks.iter().map(|s| s.id.clone()));
    ids
}

/// Runs a task mutation, notifies with [`notified_ids`], then fills the terminals and the
/// git branch.
async fn task_mutation(
    app: &AppHandle,
    state: &State<'_, AppState>,
    scopes: &[DataScope],
    f: impl FnOnce(&Connection) -> AppResult<TaskDetail>,
) -> AppResult<TaskDetail> {
    let detail = {
        let conn = state.db.lock()?;
        let detail = f(&conn)?;
        notify(app, &conn, scopes, Some(notified_ids(&detail)));
        detail
    };
    finish_detail(state, detail).await
}

/// Terminals kept by the PTY manager and their Claude sessions, then the git branch (once
/// the lock is released).
pub(crate) async fn finish_detail(
    state: &State<'_, AppState>,
    mut detail: TaskDetail,
) -> AppResult<TaskDetail> {
    detail.terminals = state.terminals.pty.for_task(&detail.id);
    let mut session_ids: Vec<String> = detail
        .terminals
        .iter()
        .filter_map(|t| t.agent_session_id.clone())
        .collect();
    session_ids.sort();
    session_ids.dedup();
    if !session_ids.is_empty() {
        let conn = state.db.lock()?;
        detail.sessions = agent_sessions::views(&conn, &session_ids)?;
    }
    with_git_branch(detail).await
}

/// Closes the terminals of tasks that no longer exist (deleted task or project).
fn close_terminals_of_deleted_tasks(state: &State<'_, AppState>) {
    let gone: Vec<String> = match state.db.lock() {
        Ok(conn) => state
            .terminals
            .task_ids()
            .into_iter()
            .filter(|id| tasks::ensure_exists(&conn, id).is_err())
            .collect(),
        Err(e) => {
            log::warn!("cannot check deleted tasks: {e}");
            return;
        }
    };
    state.terminals.close_for_tasks(&state.db, &gone);
    // « Demander au projet » of a deleted project.
    let gone_projects: Vec<String> = match state.db.lock() {
        Ok(conn) => state
            .terminals
            .ask_terminals()
            .into_iter()
            .filter(|(_, subject)| crate::db::subjects::ensure_project(&conn, subject).is_err())
            .map(|(terminal, _)| terminal)
            .collect(),
        Err(e) => {
            log::warn!("cannot check deleted projects: {e}");
            return;
        }
    };
    for id in gone_projects {
        if let Err(e) = state.terminals.close(&state.db, &id) {
            log::warn!("cannot close terminal {id}: {e}");
        }
    }
}

// --- Subjects ---------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub async fn list_subjects(state: State<'_, AppState>) -> AppResult<Vec<Subject>> {
    let conn = state.db.lock()?;
    subjects::list(&conn)
}

#[tauri::command]
#[specta::specta]
pub async fn create_subject(
    app: AppHandle,
    state: State<'_, AppState>,
    input: CreateSubjectInput,
) -> AppResult<Subject> {
    let conn = state.db.lock()?;
    let subject = subjects::create(&conn, &input)?;
    notify(&app, &conn, &[DataScope::Subjects], None);
    Ok(subject)
}

#[tauri::command]
#[specta::specta]
pub async fn update_subject(
    app: AppHandle,
    state: State<'_, AppState>,
    input: UpdateSubjectInput,
) -> AppResult<Subject> {
    let conn = state.db.lock()?;
    let subject = subjects::update(&conn, &input)?;
    // Task rows carry the subject tag and the panel its folder.
    notify(&app, &conn, &[DataScope::Subjects, DataScope::Tasks], None);
    Ok(subject)
}

/// Soft-deletes the subject and its tasks (confirmation and the "Annuler" toast are the
/// UI's job); `restore_subject` undoes it within 24 h.
#[tauri::command]
#[specta::specta]
pub async fn delete_subject(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    {
        let conn = state.db.lock()?;
        subjects::delete(&conn, &id)?;
    }
    close_terminals_of_deleted_tasks(&state);
    let conn = state.db.lock()?;
    notify(
        &app,
        &conn,
        &[DataScope::Subjects, DataScope::Tasks, DataScope::Terminals],
        None,
    );
    Ok(())
}

/// Undoes `delete_subject`: the subject comes back with the tasks deleted with it.
#[tauri::command]
#[specta::specta]
pub async fn restore_subject(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Subject> {
    let conn = state.db.lock()?;
    let subject = subjects::restore(&conn, &id)?;
    notify(&app, &conn, &[DataScope::Subjects, DataScope::Tasks], None);
    Ok(subject)
}

/// Moves a project among its siblings. At the top level `index` counts « Sans projet »
/// (index in `top_level::order`, even when the sidebar hides it); a sub-project moves among
/// its parent's live sub-projects.
#[tauri::command]
#[specta::specta]
pub async fn reorder_subject(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ReorderInput,
) -> AppResult<()> {
    let conn = state.db.lock()?;
    subjects::reorder(&conn, &input)?;
    // Today sorts by subject order.
    notify(&app, &conn, &[DataScope::Subjects, DataScope::Tasks], None);
    Ok(())
}

/// Index of « Sans projet » among the top-level projects (`top_level::order`): the index
/// `reorder_subject` counts it at, whether the sidebar shows it or not.
#[tauri::command]
#[specta::specta]
pub async fn get_inbox_index(state: State<'_, AppState>) -> AppResult<u32> {
    let conn = state.db.lock()?;
    top_level::inbox_index(&conn)
}

/// Moves « Sans projet » to `index` among the top-level projects (index in the top-level
/// order, « Sans projet » excluded from the siblings). Its position is a synced setting.
#[tauri::command]
#[specta::specta]
pub async fn reorder_inbox(
    app: AppHandle,
    state: State<'_, AppState>,
    index: u32,
) -> AppResult<()> {
    let conn = state.db.lock()?;
    top_level::reorder(&conn, &TopItem::Inbox, index as usize)?;
    // The sidebar and « À faire » follow the top-level order.
    notify(&app, &conn, &[DataScope::Subjects, DataScope::Tasks], None);
    Ok(())
}

// --- Sections ---------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub async fn create_section(
    app: AppHandle,
    state: State<'_, AppState>,
    input: CreateSectionInput,
) -> AppResult<Section> {
    let conn = state.db.lock()?;
    let section = sections::create(&conn, &input)?;
    notify(&app, &conn, &[DataScope::Subjects, DataScope::Tasks], None);
    Ok(section)
}

#[tauri::command]
#[specta::specta]
pub async fn update_section(
    app: AppHandle,
    state: State<'_, AppState>,
    input: UpdateSectionInput,
) -> AppResult<Section> {
    let conn = state.db.lock()?;
    let section = sections::update(&conn, &input)?;
    notify(&app, &conn, &[DataScope::Subjects, DataScope::Tasks], None);
    Ok(section)
}

/// Deletes the section; its tasks go back to "Sans section".
#[tauri::command]
#[specta::specta]
pub async fn delete_section(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    let conn = state.db.lock()?;
    sections::delete(&conn, &id)?;
    notify(&app, &conn, &[DataScope::Subjects, DataScope::Tasks], None);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn reorder_section(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ReorderInput,
) -> AppResult<()> {
    let conn = state.db.lock()?;
    sections::reorder(&conn, &input)?;
    notify(&app, &conn, &[DataScope::Subjects, DataScope::Tasks], None);
    Ok(())
}

// --- Project notebook ---------------------------

/// A project's notebook: « Épinglées », pages outside any group, groups, « Résumés de tâches ».
#[tauri::command]
#[specta::specta]
pub async fn notebook(state: State<'_, AppState>, subject_id: String) -> AppResult<NotebookView> {
    let conn = state.db.lock()?;
    views::notes::notebook(&conn, &subject_id)
}

/// A page with its Markdown body.
#[tauri::command]
#[specta::specta]
pub async fn get_note_page(state: State<'_, AppState>, id: String) -> AppResult<NotePage> {
    let conn = state.db.lock()?;
    notes::get_page(&conn, &id)
}

#[tauri::command]
#[specta::specta]
pub async fn create_note_group(
    app: AppHandle,
    state: State<'_, AppState>,
    input: CreateNoteGroupInput,
) -> AppResult<NoteGroup> {
    let conn = state.db.lock()?;
    let group = notes::create_group(&conn, &input)?;
    notify(&app, &conn, &[DataScope::Notes], None);
    Ok(group)
}

#[tauri::command]
#[specta::specta]
pub async fn update_note_group(
    app: AppHandle,
    state: State<'_, AppState>,
    input: UpdateNoteGroupInput,
) -> AppResult<NoteGroup> {
    let conn = state.db.lock()?;
    let group = notes::update_group(&conn, &input)?;
    notify(&app, &conn, &[DataScope::Notes], None);
    Ok(group)
}

/// Deletes the group for good; its pages stay in the notebook, outside any group.
#[tauri::command]
#[specta::specta]
pub async fn delete_note_group(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    let conn = state.db.lock()?;
    notes::delete_group(&conn, &id)?;
    notify(&app, &conn, &[DataScope::Notes], None);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn reorder_note_group(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ReorderInput,
) -> AppResult<()> {
    let conn = state.db.lock()?;
    notes::reorder_group(&conn, &input)?;
    notify(&app, &conn, &[DataScope::Notes], None);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn create_note_page(
    app: AppHandle,
    state: State<'_, AppState>,
    input: CreateNotePageInput,
) -> AppResult<NotePage> {
    let conn = state.db.lock()?;
    let page = notes::create_page(&conn, &input)?;
    notify(&app, &conn, &[DataScope::Notes], None);
    Ok(page)
}

/// Saves the title and/or the Markdown body (a page over 256 KiB is refused as `invalid`).
#[tauri::command]
#[specta::specta]
pub async fn update_note_page(
    app: AppHandle,
    state: State<'_, AppState>,
    input: UpdateNotePageInput,
) -> AppResult<NotePage> {
    let conn = state.db.lock()?;
    let page = notes::update_page(&conn, &input)?;
    notify(&app, &conn, &[DataScope::Notes], None);
    Ok(page)
}

/// Pins a page, or puts it in a group (unpinned) at an index.
#[tauri::command]
#[specta::specta]
pub async fn move_note_page(
    app: AppHandle,
    state: State<'_, AppState>,
    input: MoveNotePageInput,
) -> AppResult<NotePage> {
    let conn = state.db.lock()?;
    let page = notes::move_page(&conn, &input)?;
    notify(&app, &conn, &[DataScope::Notes], None);
    Ok(page)
}

/// Pins a page, or unpins it: it goes back to its group, at its place.
#[tauri::command]
#[specta::specta]
pub async fn pin_note_page(
    app: AppHandle,
    state: State<'_, AppState>,
    input: PinNotePageInput,
) -> AppResult<NotePage> {
    let conn = state.db.lock()?;
    let page = notes::set_pinned(&conn, &input.id, input.pinned)?;
    notify(&app, &conn, &[DataScope::Notes], None);
    Ok(page)
}

/// « Dupliquer »: a copy titled « … (copie) », right after the page in its list.
#[tauri::command]
#[specta::specta]
pub async fn duplicate_note_page(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<NotePage> {
    let conn = state.db.lock()?;
    let page = notes::duplicate_page(&conn, &id)?;
    notify(&app, &conn, &[DataScope::Notes], None);
    Ok(page)
}

/// Soft delete: `restore_note_page` brings it back (« Annuler »).
#[tauri::command]
#[specta::specta]
pub async fn delete_note_page(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    let conn = state.db.lock()?;
    notes::delete_page(&conn, &id)?;
    notify(&app, &conn, &[DataScope::Notes], None);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn restore_note_page(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<NotePage> {
    let conn = state.db.lock()?;
    let page = notes::restore_page(&conn, &id)?;
    notify(&app, &conn, &[DataScope::Notes], None);
    Ok(page)
}

/// « Mentionné dans » of a page: the pages and tasks that link to it.
#[tauri::command]
#[specta::specta]
pub async fn note_page_backlinks(
    state: State<'_, AppState>,
    page_id: String,
) -> AppResult<Vec<NoteLinkRef>> {
    let conn = state.db.lock()?;
    notes::get_page(&conn, &page_id)?;
    notes::backlinks(&conn, &page_id)
}

/// The notebook pages that link to a task (its panel's « Mentionné dans »).
#[tauri::command]
#[specta::specta]
pub async fn task_note_mentions(
    state: State<'_, AppState>,
    task_id: String,
) -> AppResult<Vec<NoteLinkRef>> {
    let conn = state.db.lock()?;
    notes::task_mentions(&conn, &task_id)
}

/// The images of a page, oldest first.
#[tauri::command]
#[specta::specta]
pub async fn list_note_attachments(
    state: State<'_, AppState>,
    page_id: String,
) -> AppResult<Vec<NoteAttachment>> {
    let conn = state.db.lock()?;
    notes::get_page(&conn, &page_id)?;
    attachments::list_for_page(&conn, &page_id)
}

/// Copies files into the project's `Notes` attachment folder; returns the new images, in the
/// order of `paths`.
#[tauri::command]
#[specta::specta]
pub async fn add_note_attachments(
    app: AppHandle,
    state: State<'_, AppState>,
    input: AddNoteAttachmentsInput,
) -> AppResult<Vec<NoteAttachment>> {
    let conn = state.db.lock()?;
    let ids = attachments::add_files(
        &conn,
        attachments::AttachmentOwner::NotePage(&input.note_page_id),
        &input.paths,
    )?;
    notify(&app, &conn, &[DataScope::Notes], None);
    added_images(&conn, &input.note_page_id, &ids)
}

/// A pasted or dropped image (base64) becomes an image of the page.
#[tauri::command]
#[specta::specta]
pub async fn add_note_attachment_data(
    app: AppHandle,
    state: State<'_, AppState>,
    input: AddNoteAttachmentDataInput,
) -> AppResult<NoteAttachment> {
    let conn = state.db.lock()?;
    let id = attachments::add_data(
        &conn,
        attachments::AttachmentOwner::NotePage(&input.note_page_id),
        &input.name,
        &input.base64,
    )?;
    notify(&app, &conn, &[DataScope::Notes], None);
    added_images(&conn, &input.note_page_id, &[id])?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::Internal("the new image is not listed".into()))
}

/// An image of another page (or a task's) pasted in this page becomes the page's own copy.
#[tauri::command]
#[specta::specta]
pub async fn copy_note_attachment(
    app: AppHandle,
    state: State<'_, AppState>,
    input: CopyNoteAttachmentInput,
) -> AppResult<NoteAttachment> {
    let conn = state.db.lock()?;
    let id = attachments::copy_to_page(&conn, &input.id, &input.to_page_id)?;
    notify(&app, &conn, &[DataScope::Notes], None);
    added_images(&conn, &input.to_page_id, &[id])?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::Internal("the copied image is not listed".into()))
}

/// An attachment by its id, whoever owns it (an image of another page shown here); `None` when
/// there is none on this device.
#[tauri::command]
#[specta::specta]
pub async fn attachment_info(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Option<AttachmentInfo>> {
    let conn = state.db.lock()?;
    attachments::info(&conn, &id)
}

/// Deletes the page's images taken out of it that no page shows; returns their ids.
#[tauri::command]
#[specta::specta]
pub async fn prune_note_images(
    app: AppHandle,
    state: State<'_, AppState>,
    input: PruneNoteImagesInput,
) -> AppResult<Vec<String>> {
    let conn = state.db.lock()?;
    let gone = attachments::prune_page_images(&conn, &input.page_id, &input.candidate_ids)?;
    if !gone.is_empty() {
        notify(&app, &conn, &[DataScope::Notes], None);
    }
    Ok(gone)
}

fn added_images(
    conn: &Connection,
    page_id: &str,
    ids: &[String],
) -> AppResult<Vec<NoteAttachment>> {
    let mut all = attachments::list_for_page(conn, page_id)?;
    Ok(ids
        .iter()
        .filter_map(|id| {
            all.iter()
                .position(|a| &a.id == id)
                .map(|i| all.swap_remove(i))
        })
        .collect())
}

/// Removes an image of a page and its copy (the Markdown link is the editor's to remove).
#[tauri::command]
#[specta::specta]
pub async fn delete_note_attachment(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    let conn = state.db.lock()?;
    attachments::delete_page_image(&conn, &id)?;
    notify(&app, &conn, &[DataScope::Notes], None);
    Ok(())
}

// --- Views ------------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub async fn get_view(state: State<'_, AppState>, input: GetViewInput) -> AppResult<ViewModel> {
    let conn = state.db.lock()?;
    views::get_view(&conn, &input, today())
}

/// « Portefeuille »: every project over the last `days` days (Taido V2.6).
#[tauri::command]
#[specta::specta]
pub async fn get_portfolio(state: State<'_, AppState>, days: u32) -> AppResult<Portfolio> {
    let conn = state.db.lock()?;
    views::portfolio::portfolio(&conn, days, chrono::Local::now())
}

/// Dashboard of a project, or of « Sans projet », over the last `days` days (Taido V2.5).
#[tauri::command]
#[specta::specta]
pub async fn get_dashboard(
    state: State<'_, AppState>,
    subject_id: Option<String>,
    days: u32,
) -> AppResult<Dashboard> {
    let conn = state.db.lock()?;
    views::dashboard::dashboard(&conn, subject_id.as_deref(), days, chrono::Local::now())
}

/// Kanban of a project, or of « Sans projet » without `subject_id` (Taido V2.2).
#[tauri::command]
#[specta::specta]
pub async fn get_board(state: State<'_, AppState>, subject_id: Option<String>) -> AppResult<Board> {
    let conn = state.db.lock()?;
    views::board::board(&conn, subject_id.as_deref(), today())
}

/// Moves a card to a column (Taido V2.2): the done column completes the task, leaving it
/// reopens it.
#[tauri::command]
#[specta::specta]
pub async fn move_task_to_column(
    app: AppHandle,
    state: State<'_, AppState>,
    input: MoveToColumnInput,
) -> AppResult<()> {
    let conn = state.db.lock()?;
    board_columns::move_task(&conn, &input.task_id, &input.column_id)?;
    notify(&app, &conn, TASK_SCOPES, Some(vec![input.task_id]));
    Ok(())
}

/// Copies files into the task's attachments folder (Taido V2.3).
#[tauri::command]
#[specta::specta]
pub async fn add_attachments(
    app: AppHandle,
    state: State<'_, AppState>,
    input: AddAttachmentsInput,
) -> AppResult<TaskDetail> {
    task_mutation(&app, &state, &[DataScope::Tasks], |c| {
        attachments::add_files(
            c,
            attachments::AttachmentOwner::Task(&input.task_id),
            &input.paths,
        )?;
        tasks::detail(c, &input.task_id)
    })
    .await
}

/// A pasted file (a screenshot) becomes an attachment (Taido V2.3).
#[tauri::command]
#[specta::specta]
pub async fn add_attachment_data(
    app: AppHandle,
    state: State<'_, AppState>,
    input: AddAttachmentDataInput,
) -> AppResult<TaskDetail> {
    task_mutation(&app, &state, &[DataScope::Tasks], |c| {
        attachments::add_data(
            c,
            attachments::AttachmentOwner::Task(&input.task_id),
            &input.name,
            &input.base64,
        )?;
        tasks::detail(c, &input.task_id)
    })
    .await
}

/// Removes an attachment and its copy (Taido V2.3).
#[tauri::command]
#[specta::specta]
pub async fn delete_attachment(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<TaskDetail> {
    task_mutation(&app, &state, &[DataScope::Tasks], |c| {
        let task_id = attachments::delete(c, &id)?;
        tasks::detail(c, &task_id)
    })
    .await
}

/// Preview of an image attachment of a task or of a notebook page, as a `data:` URL (`None`
/// for other files, or an image too large).
#[tauri::command]
#[specta::specta]
pub async fn attachment_preview(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Option<String>> {
    let conn = state.db.lock()?;
    attachments::preview(&conn, &id)
}

/// « + Lier une tâche » (2026-10-11): every task that can be linked to `task_id`, in the
/// app's order with their subtasks, and the recently changed ones.
#[tauri::command]
#[specta::specta]
pub async fn relation_candidates(
    state: State<'_, AppState>,
    task_id: String,
) -> AppResult<RelationCandidates> {
    let conn = state.db.lock()?;
    crate::views::candidates::relation_candidates(&conn, &task_id)
}

/// « Bloque », « Bloquée par », « Liée à » (Taido V2.3).
#[tauri::command]
#[specta::specta]
pub async fn add_relation(
    app: AppHandle,
    state: State<'_, AppState>,
    input: AddRelationInput,
) -> AppResult<TaskDetail> {
    let detail = {
        let conn = state.db.lock()?;
        relations::add(&conn, &input)?;
        notify(
            &app,
            &conn,
            &[DataScope::Tasks],
            Some(vec![input.task_id.clone(), input.other_id.clone()]),
        );
        tasks::detail(&conn, &input.task_id)?
    };
    finish_detail(&state, detail).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_relation(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    let conn = state.db.lock()?;
    let (a, b) = relations::delete(&conn, &id)?;
    notify(&app, &conn, &[DataScope::Tasks], Some(vec![a, b]));
    Ok(())
}

/// « Ajouter les projets à un groupe » (Taido V2.2 bis). Returns the group's id.
#[tauri::command]
#[specta::specta]
pub async fn group_projects(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GroupProjectsInput,
) -> AppResult<String> {
    let conn = state.db.lock()?;
    let id = subjects::group_projects(&conn, &input)?;
    notify(&app, &conn, &[DataScope::Subjects], None);
    Ok(id)
}

/// « Retirer du groupe » (Taido V2.2 bis).
#[tauri::command]
#[specta::specta]
pub async fn ungroup_projects(
    app: AppHandle,
    state: State<'_, AppState>,
    project_ids: Vec<String>,
) -> AppResult<()> {
    let conn = state.db.lock()?;
    subjects::ungroup_projects(&conn, &project_ids)?;
    notify(&app, &conn, &[DataScope::Subjects], None);
    Ok(())
}

/// « Dégrouper » (Taido V2.2 bis): the group goes, its projects stay.
#[tauri::command]
#[specta::specta]
pub async fn dissolve_group(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    let conn = state.db.lock()?;
    subjects::dissolve_group(&conn, &id)?;
    notify(&app, &conn, &[DataScope::Subjects], None);
    Ok(())
}

/// Board columns (Taido V2.2): create, rename, move, delete.
#[tauri::command]
#[specta::specta]
pub async fn create_board_column(
    app: AppHandle,
    state: State<'_, AppState>,
    input: CreateBoardColumnInput,
) -> AppResult<String> {
    let conn = state.db.lock()?;
    let id = board_columns::create(&conn, input.subject_id.as_deref(), &input.name)?;
    notify(&app, &conn, &[DataScope::Tasks], None);
    Ok(id)
}

#[tauri::command]
#[specta::specta]
pub async fn rename_board_column(
    app: AppHandle,
    state: State<'_, AppState>,
    input: RenameBoardColumnInput,
) -> AppResult<()> {
    let conn = state.db.lock()?;
    board_columns::rename(&conn, &input.id, &input.name)?;
    notify(&app, &conn, &[DataScope::Tasks], None);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn move_board_column(
    app: AppHandle,
    state: State<'_, AppState>,
    input: MoveBoardColumnInput,
) -> AppResult<()> {
    let conn = state.db.lock()?;
    board_columns::move_column(&conn, &input.id, input.index as usize)?;
    notify(&app, &conn, &[DataScope::Tasks], None);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_board_column(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    let conn = state.db.lock()?;
    board_columns::delete(&conn, &id)?;
    notify(&app, &conn, &[DataScope::Tasks], None);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn get_counts(state: State<'_, AppState>) -> AppResult<Counts> {
    let conn = state.db.lock()?;
    views::counts(&conn, today())
}

// --- Tasks ------------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub async fn get_task(state: State<'_, AppState>, id: String) -> AppResult<TaskDetail> {
    let detail = {
        let conn = state.db.lock()?;
        tasks::detail(&conn, &id)?
    };
    finish_detail(&state, detail).await
}

#[tauri::command]
#[specta::specta]
pub async fn create_task(
    app: AppHandle,
    state: State<'_, AppState>,
    input: CreateTaskInput,
) -> AppResult<TaskDetail> {
    task_mutation(&app, &state, TASK_SCOPES, |c| tasks::create(c, &input)).await
}

#[tauri::command]
#[specta::specta]
pub async fn update_task(
    app: AppHandle,
    state: State<'_, AppState>,
    input: UpdateTaskInput,
) -> AppResult<TaskDetail> {
    let old_note = if input.description.is_some() {
        let conn = state.db.lock()?;
        tasks::detail(&conn, &input.id)?.description
    } else {
        String::new()
    };
    let scopes = update_task_scopes(&old_note, &input);
    task_mutation(&app, &state, scopes, |c| tasks::update(c, &input)).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_task_due(
    app: AppHandle,
    state: State<'_, AppState>,
    input: SetDueInput,
) -> AppResult<TaskDetail> {
    task_mutation(&app, &state, &[DataScope::Tasks], |c| {
        tasks::set_due(c, &input)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn set_task_workdir_override(
    app: AppHandle,
    state: State<'_, AppState>,
    input: SetWorkdirOverrideInput,
) -> AppResult<TaskDetail> {
    task_mutation(&app, &state, &[DataScope::Tasks], |c| {
        tasks::set_workdir_override(c, &input)
    })
    .await
}

/// Checks or unchecks a task (journal `completed` / `reopened`). Checking closes the task's
/// terminals (the UI confirms first when a session is alive); unchecking does not reopen them.
#[tauri::command]
#[specta::specta]
pub async fn set_task_completed(
    app: AppHandle,
    state: State<'_, AppState>,
    input: SetCompletedInput,
) -> AppResult<TaskDetail> {
    // Checking a parent checks its open children (like Todoist) and closes
    // their terminals with its own.
    let (detail, ids) = {
        let conn = state.db.lock()?;
        let detail = tasks::set_completed(&conn, &input)?;
        (detail, tasks::with_children(&conn, &input.id)?)
    };
    // Only once the task is really checked.
    let detail = if input.completed {
        state.terminals.close_for_tasks(&state.db, &ids);
        // The ring may have changed with the children's terminals.
        let conn = state.db.lock()?;
        tasks::detail(&conn, &input.id)?
    } else {
        detail
    };
    {
        let mut ids = ids;
        ids.extend(detail.parent.as_ref().map(|p| p.id.clone()));
        let conn = state.db.lock()?;
        notify(&app, &conn, TASK_SCOPES_WITH_TERMINALS, Some(ids));
    }
    finish_detail(&state, detail).await
}

/// Soft delete; `restore_task` undoes it within 24 h.
#[tauri::command]
#[specta::specta]
pub async fn delete_task(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<()> {
    // Its children are deleted with it, their terminals closed.
    let mut ids = {
        let conn = state.db.lock()?;
        let ids = tasks::with_children(&conn, &id)?;
        tasks::delete(&conn, &id)?;
        ids
    };
    state.terminals.close_for_tasks(&state.db, &ids);
    let conn = state.db.lock()?;
    // A deleted subtask changes its parent's row.
    if let Ok(Some(parent)) =
        conn.query_row("SELECT parent_id FROM tasks WHERE id = ?1", [&id], |r| {
            r.get::<_, Option<String>>(0)
        })
    {
        ids.push(parent);
    }
    notify(&app, &conn, TASK_DELETE_SCOPES, Some(ids));
    Ok(())
}

/// Undoes `delete_task` (the task's project must not be deleted).
#[tauri::command]
#[specta::specta]
pub async fn restore_task(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<TaskDetail> {
    task_mutation(&app, &state, TASK_RESTORE_SCOPES, |c| {
        tasks::restore(c, &id)
    })
    .await
}

/// "Reporter à aujourd'hui": open tasks due before today become due today (time kept).
/// Returns the number of rescheduled tasks.
#[tauri::command]
#[specta::specta]
pub async fn reschedule_overdue(app: AppHandle, state: State<'_, AppState>) -> AppResult<u32> {
    let conn = state.db.lock()?;
    let ids = tasks::reschedule_overdue(&conn, today())?;
    let n = u32::try_from(ids.len()).unwrap_or(u32::MAX);
    if !ids.is_empty() {
        notify(&app, &conn, &[DataScope::Tasks], Some(ids));
    }
    Ok(n)
}

/// Copies title, description and subtasks (not terminals nor journal), right after the original.
#[tauri::command]
#[specta::specta]
pub async fn duplicate_task(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<TaskDetail> {
    task_mutation(&app, &state, TASK_SCOPES, |c| tasks::duplicate(c, &id)).await
}

/// Clears `workdir_override` when the subject changes.
#[tauri::command]
#[specta::specta]
pub async fn move_task(
    app: AppHandle,
    state: State<'_, AppState>,
    input: MoveTaskInput,
) -> AppResult<TaskDetail> {
    task_mutation(
        &app,
        &state,
        &[DataScope::Tasks, DataScope::Subjects],
        |c| tasks::move_task(c, &input),
    )
    .await
}

// --- Subtasks ---------------------------------------------------------------
//
// A subtask is a child task. Every mutation notifies the parent and the
// child (both rows, both panels).

/// Runs a subtask mutation and notifies with its task's and its own ids.
fn subtask_mutation(
    app: &AppHandle,
    state: &State<'_, AppState>,
    scopes: &[DataScope],
    f: impl FnOnce(&Connection) -> AppResult<Subtask>,
) -> AppResult<Subtask> {
    let conn = state.db.lock()?;
    let subtask = f(&conn)?;
    notify(
        app,
        &conn,
        scopes,
        Some(vec![subtask.task_id.clone(), subtask.id.clone()]),
    );
    Ok(subtask)
}

// Adds a child task in the task's place (`invalid` under a subtask: one level only).
#[tauri::command]
#[specta::specta]
pub async fn add_subtask(
    app: AppHandle,
    state: State<'_, AppState>,
    input: AddSubtaskInput,
) -> AppResult<Subtask> {
    subtask_mutation(&app, &state, TASK_SCOPES, |c| subtasks::add(c, &input))
}

#[tauri::command]
#[specta::specta]
pub async fn update_subtask(
    app: AppHandle,
    state: State<'_, AppState>,
    input: UpdateSubtaskInput,
) -> AppResult<Subtask> {
    subtask_mutation(&app, &state, &[DataScope::Tasks], |c| {
        subtasks::update(c, &input)
    })
}

// Completes or reopens the child task; completing it closes its terminals, like
// `set_task_completed`.
#[tauri::command]
#[specta::specta]
pub async fn toggle_subtask(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Subtask> {
    let subtask = {
        let conn = state.db.lock()?;
        subtasks::toggle(&conn, &id)?
    };
    if subtask.done {
        state
            .terminals
            .close_for_tasks(&state.db, std::slice::from_ref(&id));
    }
    let conn = state.db.lock()?;
    // Closing the terminals changed the ring: read it again.
    let subtask = subtasks::get(&conn, &id).unwrap_or(subtask);
    notify(
        &app,
        &conn,
        TASK_SCOPES_WITH_TERMINALS,
        Some(vec![subtask.task_id.clone(), id]),
    );
    Ok(subtask)
}

// Soft delete of the child task (`restore_task` undoes it); its terminals are closed.
#[tauri::command]
#[specta::specta]
pub async fn delete_subtask(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    let subtask = {
        let conn = state.db.lock()?;
        let subtask = subtasks::get(&conn, &id)?;
        subtasks::delete(&conn, &id)?;
        subtask
    };
    state
        .terminals
        .close_for_tasks(&state.db, std::slice::from_ref(&id));
    let conn = state.db.lock()?;
    notify(
        &app,
        &conn,
        TASK_SCOPES_WITH_TERMINALS,
        Some(vec![subtask.task_id, id]),
    );
    Ok(())
}

// Moves the subtask among its parent's open subtasks.
#[tauri::command]
#[specta::specta]
pub async fn reorder_subtask(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ReorderInput,
) -> AppResult<()> {
    subtask_mutation(&app, &state, &[DataScope::Tasks], |c| {
        subtasks::reorder(c, &input)?;
        subtasks::get(c, &input.id)
    })
    .map(|_| ())
}

// --- Journal ----------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub async fn add_note(
    app: AppHandle,
    state: State<'_, AppState>,
    input: AddNoteInput,
) -> AppResult<JournalEntry> {
    let conn = state.db.lock()?;
    let entry = journal::add_note(&conn, &input)?;
    notify(
        &app,
        &conn,
        &[DataScope::Journal],
        Some(vec![entry.task_id.clone()]),
    );
    Ok(entry)
}

/// Most recent first.
#[tauri::command]
#[specta::specta]
pub async fn list_journal(
    state: State<'_, AppState>,
    task_id: String,
) -> AppResult<Vec<JournalEntry>> {
    let conn = state.db.lock()?;
    journal::list(&conn, &task_id)
}

// --- Settings ---------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub async fn get_settings(state: State<'_, AppState>) -> AppResult<Settings> {
    let conn = state.db.lock()?;
    settings::get(&conn)
}

#[tauri::command]
#[specta::specta]
pub async fn update_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    patch: SettingsPatch,
) -> AppResult<Settings> {
    let conn = state.db.lock()?;
    let settings = settings::update(&conn, &patch)?;
    notify(&app, &conn, &[DataScope::Settings], None);
    // The shared theme (synced setting `appearance`) goes like any other local change.
    if settings.sync_theme
        && (patch.theme.is_some() || patch.color_theme.is_some() || patch.sync_theme.is_some())
    {
        state.sync.poke(&conn);
    }
    Ok(settings)
}

/// Priority 1 to 4; other values are refused (`invalid`).
#[tauri::command]
#[specta::specta]
pub async fn set_task_priority(
    app: AppHandle,
    state: State<'_, AppState>,
    input: SetPriorityInput,
) -> AppResult<TaskDetail> {
    task_mutation(&app, &state, &[DataScope::Tasks], |c| {
        tasks::set_priority(c, &input)
    })
    .await
}

/// « + Ajouter du temps à la main » (Taido V2.1): `minutes` ending now.
#[tauri::command]
#[specta::specta]
pub async fn add_manual_time(
    app: AppHandle,
    state: State<'_, AppState>,
    input: AddManualTimeInput,
) -> AppResult<TaskDetail> {
    task_mutation(&app, &state, &[DataScope::Tasks], |c| {
        time_segments::add_manual(c, &input, &crate::db::now_utc())?;
        tasks::detail(c, &input.task_id)
    })
    .await
}

/// « Arrêter » a running segment of the chrono, this Mac's or another device's (docs/SYNC.md
/// § 0.8).
#[tauri::command]
#[specta::specta]
pub async fn stop_time_segment(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<TaskDetail> {
    task_mutation(&app, &state, &[DataScope::Tasks], |c| {
        let task_id = time_segments::stop(c, &id, &crate::db::now_utc())?;
        tasks::detail(c, &task_id)
    })
    .await
}

/// Removes a stopped segment of the chrono (Taido V2.1).
#[tauri::command]
#[specta::specta]
pub async fn delete_time_segment(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<TaskDetail> {
    task_mutation(&app, &state, &[DataScope::Tasks], |c| {
        let task_id = time_segments::delete(c, &id, &crate::db::now_utc())?;
        tasks::detail(c, &task_id)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::db::test_support::{subject, task};

    #[test]
    fn a_parent_mutation_notifies_its_children_and_a_child_its_parent() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let p = task(&conn, "parent", Some(&s), None);
        let add = |text: &str| {
            subtasks::add(
                &conn,
                &AddSubtaskInput {
                    task_id: p.clone(),
                    text: text.into(),
                },
            )
            .expect("subtask")
            .id
        };
        let (a, b) = (add("a"), add("b"));
        // Renaming, moving or giving a folder to the parent changes its children's panels.
        let parent = tasks::detail(&conn, &p).expect("parent");
        assert_eq!(notified_ids(&parent), vec![p.clone(), a.clone(), b]);
        let child = tasks::detail(&conn, &a).expect("child");
        assert_eq!(notified_ids(&child), vec![a, p]);
    }

    fn input(title: Option<&str>, description: Option<&str>) -> UpdateTaskInput {
        UpdateTaskInput {
            id: "t".into(),
            title: title.map(Into::into),
            description: description.map(Into::into),
        }
    }

    #[test]
    fn a_task_change_seen_by_the_notebook_tells_it() {
        let link = "voir [[page:0b8f8c2e-1d2a-4c3b-9e8f-7a6b5c4d3e2f|P]]";
        // A renamed task: its link chips and « Mentionné dans » show the new title.
        assert!(update_task_scopes("", &input(Some("New"), None)).contains(&DataScope::Notes));
        // A note that links a page, or linked one: the page's « Mentionné dans » changes.
        assert!(update_task_scopes("", &input(None, Some(link))).contains(&DataScope::Notes));
        assert!(
            update_task_scopes(link, &input(None, Some("plus rien"))).contains(&DataScope::Notes)
        );
        // Plain note typing does not refresh every notebook.
        assert_eq!(
            update_task_scopes("a", &input(None, Some("ab"))),
            &[DataScope::Tasks]
        );
        // Deleting or restoring a task: its chips turn dead or alive again.
        assert!(TASK_DELETE_SCOPES.contains(&DataScope::Notes));
        assert!(TASK_RESTORE_SCOPES.contains(&DataScope::Notes));
    }
}
