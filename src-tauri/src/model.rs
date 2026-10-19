//! Types shared with the UI (exported to `src/bindings.ts` by tauri-specta).
//!
//! The core computes view models ready to display: the UI never re-derives
//! states, groupings or counts. Dates are ISO strings: timestamps in UTC (`at`, `*_at`),
//! due dates in local time (`YYYY-MM-DD`, `HH:MM`). Dates are formatted for display by the UI.

use serde::{Deserialize, Serialize};
use specta::Type;

// ---------------------------------------------------------------------------
// Subjects and sections
// ---------------------------------------------------------------------------

/// Subject palette. Never orange, red or green: reserved for states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SubjectColor {
    Violet,
    Teal,
    Pink,
    Gray,
    Blue,
    Indigo,
    Brown,
    Slate,
}

impl SubjectColor {
    /// Palette order: new projects without a color take the next one.
    pub const PALETTE: [SubjectColor; 8] = [
        SubjectColor::Violet,
        SubjectColor::Teal,
        SubjectColor::Pink,
        SubjectColor::Gray,
        SubjectColor::Blue,
        SubjectColor::Indigo,
        SubjectColor::Brown,
        SubjectColor::Slate,
    ];

    /// Color after `self` in the palette, wrapping around.
    pub fn next(self) -> SubjectColor {
        let i = Self::PALETTE.iter().position(|c| *c == self).unwrap_or(0);
        Self::PALETTE[(i + 1) % Self::PALETTE.len()]
    }

    pub fn as_str(self) -> &'static str {
        match self {
            SubjectColor::Violet => "violet",
            SubjectColor::Teal => "teal",
            SubjectColor::Pink => "pink",
            SubjectColor::Gray => "gray",
            SubjectColor::Blue => "blue",
            SubjectColor::Indigo => "indigo",
            SubjectColor::Brown => "brown",
            SubjectColor::Slate => "slate",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "violet" => SubjectColor::Violet,
            "teal" => SubjectColor::Teal,
            "pink" => SubjectColor::Pink,
            "gray" => SubjectColor::Gray,
            "blue" => SubjectColor::Blue,
            "indigo" => SubjectColor::Indigo,
            "brown" => SubjectColor::Brown,
            "slate" => SubjectColor::Slate,
            _ => return None,
        })
    }
}

/// Aggregate dot of a subject in the sidebar. `None` when nothing to show.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SubjectDot {
    Waiting,
    Error,
    Done,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Subject {
    pub id: String,
    pub name: String,
    pub color: SubjectColor,
    /// Folder on disk (absolute path), optional (D5): `None` until the project is linked.
    pub root_path: Option<String>,
    pub position: f64,
    /// Sections in display order.
    pub sections: Vec<Section>,
    /// Number of open (not completed) tasks.
    pub open_count: u32,
    pub dot: Option<SubjectDot>,
    /// A sub-project names its parent project (one level only: a
    /// sub-project has no sub-projects). `list_subjects` stays flat, parents before their
    /// sub-projects; the sidebar nests them. A parent's `dot` includes its sub-projects'.
    pub parent_id: Option<String>,
    /// Taido V2.2 bis, product decision: a group only gathers projects in the sidebar, like Brave's
    /// tab groups. It holds no task, no section and no folder; its projects name it as
    /// `parent_id`. Only groups have projects inside.
    pub is_group: bool,
}

/// « Ajouter les projets à un groupe » (Taido V2.2 bis): to `group_id`, or to a new group
/// named `name` (« Nouveau groupe » when empty), placed where the first project was.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GroupProjectsInput {
    pub project_ids: Vec<String>,
    pub group_id: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub id: String,
    pub subject_id: String,
    pub name: String,
    /// Relative to the subject folder.
    pub subpath: Option<String>,
    pub position: f64,
    pub open_count: u32,
}

// ---------------------------------------------------------------------------
// Project notebook
// ---------------------------------------------------------------------------

/// A group of note pages of a project (« Décisions »…). « Épinglées » and « Résumés de
/// tâches » are not groups: they are derived from `pinned_at` and `kind`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteGroup {
    pub id: String,
    pub subject_id: String,
    pub name: String,
    pub position: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum NoteKind {
    Page,
    Summary,
}

impl NoteKind {
    pub fn as_str(self) -> &'static str {
        match self {
            NoteKind::Page => "page",
            NoteKind::Summary => "summary",
        }
    }

    /// The column's value (a `CHECK` guarantees it); anything else reads as a plain page.
    pub fn parse(value: &str) -> NoteKind {
        match value {
            "summary" => NoteKind::Summary,
            _ => NoteKind::Page,
        }
    }
}

/// A page of a project's notebook; `body` is Markdown.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotePage {
    pub id: String,
    pub subject_id: String,
    pub group_id: Option<String>,
    pub kind: NoteKind,
    pub title: String,
    pub body: String,
    pub source_task_id: Option<String>,
    pub pinned_at: Option<String>,
    pub position: f64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateNoteGroupInput {
    pub subject_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNoteGroupInput {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateNotePageInput {
    pub subject_id: String,
    pub group_id: Option<String>,
    pub title: String,
    pub body: String,
    pub kind: NoteKind,
    pub source_task_id: Option<String>,
}

/// `None` keeps the value. Nothing is written when the new values equal the current ones.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNotePageInput {
    pub id: String,
    pub title: Option<String>,
    pub body: Option<String>,
}

/// Where a page goes: « Épinglées », outside any group, « Résumés de tâches » (summaries
/// only: outside any group too) or a group.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum NoteTarget {
    Pinned,
    Ungrouped,
    Summaries,
    Group { id: String },
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MoveNotePageInput {
    pub id: String,
    pub target: NoteTarget,
    /// Index among the target's pages (`None` = at the end). Ignored for `pinned`.
    pub index: Option<u32>,
}

/// Input of `pin_note_page`: pins, or unpins (back to its group and place).
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PinNotePageInput {
    pub id: String,
    pub pinned: bool,
}

/// What a `[[…]]` link points at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum NoteLinkKind {
    Page,
    Task,
}

/// A page or a task that mentions, or is mentioned by, another one (« Mentionné dans »).
/// `alive` is false when the target is deleted or gone (the title is then the link's own copy).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteLinkRef {
    pub kind: NoteLinkKind,
    pub id: String,
    pub title: String,
    pub alive: bool,
}

/// A page in the notebook's lists: no body, a plain-text start of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotePageRow {
    pub id: String,
    pub title: String,
    pub kind: NoteKind,
    /// The first 120 characters of the text, without Markdown.
    pub excerpt: String,
    pub updated_at: String,
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteGroupBlock {
    pub group: NoteGroup,
    pub pages: Vec<NotePageRow>,
}

/// A project's notebook as the UI shows it. A pinned page is only in `pinned`; `ungrouped`
/// holds the plain pages outside any group, `summaries` the task summaries outside any group
/// (« Résumés de tâches »).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotebookView {
    pub subject_id: String,
    pub pinned: Vec<NotePageRow>,
    pub ungrouped: Vec<NotePageRow>,
    pub groups: Vec<NoteGroupBlock>,
    pub summaries: Vec<NotePageRow>,
}

/// An image of a notebook page (a file copied into the project's `Notes` folder).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteAttachment {
    pub id: String,
    pub note_page_id: String,
    pub file_name: String,
    /// Absolute path of the copy.
    pub path: String,
    pub mime_type: String,
    pub is_image: bool,
    /// Bytes.
    pub size: u32,
    pub added_at: String,
    /// The copy is still on disk.
    pub exists: bool,
    pub remote: AttachmentRemote,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AddNoteAttachmentsInput {
    pub note_page_id: String,
    /// Absolute paths of the files to copy.
    pub paths: Vec<String>,
}

/// A pasted image, base64-encoded.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AddNoteAttachmentDataInput {
    pub note_page_id: String,
    pub name: String,
    pub base64: String,
}

/// An image of another page (or a task) pasted in a page: copied as the page's own.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CopyNoteAttachmentInput {
    pub id: String,
    pub to_page_id: String,
}

/// An attachment read by its id, whoever owns it (a page's image shown in another page).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    pub id: String,
    pub file_name: String,
    /// Absolute path of the copy.
    pub path: String,
    pub mime_type: String,
    /// Bytes.
    pub size: u32,
    /// The copy is on this device.
    pub exists: bool,
    pub remote: AttachmentRemote,
}

/// The images taken out of a page while it was open, to delete if no page shows them.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PruneNoteImagesInput {
    pub page_id: String,
    pub candidate_ids: Vec<String>,
}

/// A notebook page found by ⌘K.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteHit {
    pub id: String,
    pub title: String,
    pub subject: SubjectTag,
    pub kind: NoteKind,
}

/// Short reference to a subject, shown on task rows ("# Name").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SubjectTag {
    pub id: String,
    pub name: String,
    pub color: SubjectColor,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SectionTag {
    pub id: String,
    pub name: String,
}

// ---------------------------------------------------------------------------
// Ring and second line
// ---------------------------------------------------------------------------

/// What the round checkbox of a task shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Ring {
    Human,
    Completed,
    Starting,
    Working,
    Waiting,
    Done,
    Idle,
    Paused,
    Error,
    Crashed,
}

/// Color role of the second line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum LineTone {
    /// Red text (Waiting).
    Waiting,
    /// Green text (Done).
    Done,
    /// Main text color (Error, Crashed).
    Primary,
    /// Gray (Working, Idle, Paused, Human…).
    Muted,
    /// Light gray (Completed).
    Faint,
}

/// Second line of a task. `text` is final French UI text, except for the parts the UI must
/// format itself (relative dates), carried in `at`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskLine {
    pub kind: LineKind,
    /// The tool of the session the line speaks of (« Codex attend »); `None` otherwise.
    pub agent: Option<Agent>,
    /// Free text: question, activity, last message, description line… (already truncated).
    pub text: Option<String>,
    /// Reference instant for "Terminée {quand}" / "En pause · {il y a 2 h}".
    pub at: Option<String>,
    pub tone: LineTone,
}

/// Which template the UI renders (strings live in `src/i18n/fr.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum LineKind {
    /// First line of the description (`text`).
    Description,
    /// "Terminée {at}".
    Completed,
    WaitingPermission,
    WaitingQuestion,
    WaitingInput,
    Error,
    Crashed,
    Done,
    Working,
    Starting,
    Idle,
    Paused,
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Due {
    /// `YYYY-MM-DD`, local.
    pub date: String,
    /// `HH:MM`, local.
    pub time: Option<String>,
    /// Strictly before today (local).
    pub overdue: bool,
}

/// One row of a list view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskRow {
    pub id: String,
    pub title: String,
    /// Present in the multi-subject view (Today) only; `None` elsewhere.
    pub subject: Option<SubjectTag>,
    pub subject_id: Option<String>,
    pub section_id: Option<String>,
    pub ring: Ring,
    /// Second line, reserved to Claude's state: `None` for Human and Completed
    /// tasks, so always `None` for now. The description never shows in lists.
    pub line: Option<TaskLine>,
    /// The task has a description (note icon on the row).
    pub has_description: bool,
    pub due: Option<Due>,
    /// Open terminals ("2 sessions"); 0.
    pub open_terminals: u32,
    pub subtasks_done: u32,
    pub subtasks_total: u32,
    pub completed_at: Option<String>,
    pub position: f64,
    /// 1 (default look) to 4 (red outline), by design: 2 yellow, 3 orange, 4 red. Shown on the
    /// checkbox's outline; Claude's state (`ring`) is a small dot right of the title.
    pub priority: u8,
    /// Set on a subtask's row.
    pub parent_id: Option<String>,
    /// Subtasks of the task, open ones by position then completed ones (empty for a
    /// subtask: one level only). The task's ring already includes the most critical
    /// state of its subtasks.
    pub children: Vec<TaskRow>,
    /// Time spent on the task (Taido V2.1); `None` until it has a segment.
    pub chrono: Option<TaskChrono>,
    /// Taido V2.3: number of attachments.
    pub attachment_count: u32,
    /// Taido V2.3: open tasks this one blocks (« bloque N »).
    pub blocks_count: u32,
    /// Taido V2.3: title of the first open task blocking this one (« bloquée par : … »).
    pub blocked_by: Option<String>,
    /// Number of open tasks blocking this one (the row's lock and its count).
    pub blocked_by_count: u32,
    /// Number of tasks related to this one (« Liée à », the row's link and its count).
    pub related_count: u32,
}

// ---------------------------------------------------------------------------
// Portfolio (Taido V2.6)
// ---------------------------------------------------------------------------

/// Every project (groups and « Sans projet » aside) over the last `days` days.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Portfolio {
    pub days: u32,
    pub open: u32,
    /// Open subtasks of every project (shown « dont N sous-tâches »).
    pub open_subtasks: u32,
    pub done: u32,
    pub overdue: u32,
    pub seconds: u32,
    /// Sidebar order; the UI sorts.
    pub rows: Vec<PortfolioRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioRow {
    pub subject_id: String,
    pub name: String,
    pub color: SubjectColor,
    /// Its group's name, if any.
    pub group: Option<String>,
    pub open: u32,
    pub done: u32,
    pub overdue: u32,
    pub blocked: u32,
    /// « Prochaine tâche définie »: the open task due soonest (overdue ones first).
    pub next: Option<DashboardTask>,
    /// Claude sessions working (or starting) and waiting for the answer, now.
    pub sessions_running: u32,
    pub sessions_waiting: u32,
    pub seconds: u32,
    /// Latest change of a task, a segment or a session of the project.
    pub last_activity: Option<String>,
    /// Days since `last_activity` when beyond the inactivity threshold (14 days).
    pub inactive_days: Option<u32>,
}

// ---------------------------------------------------------------------------
// Dashboard (Taido V2.5)
// ---------------------------------------------------------------------------

/// A project's (or « Sans projet »'s) dashboard over the last `days` days, today included.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub days: u32,
    /// Open tasks now, and how many more than at the start of the period.
    pub open: u32,
    pub open_delta: i32,
    /// Open subtasks now (by design: « 11 dont 4 sous-tâches » counts them in the tile).
    pub open_subtasks: u32,
    /// Completed in the period, and in the period before.
    pub done: u32,
    pub done_before: u32,
    /// Open with a due date before today.
    pub overdue: u32,
    /// Open and blocked by an open task, or Claude waits for the answer.
    pub blocked: u32,
    pub blocked_by_relation: u32,
    pub blocked_waiting: u32,
    /// Chrono seconds within the period (automatic and manual).
    pub seconds: u32,
    /// Average time of the tasks completed in the period (all their time), `None` without any.
    pub seconds_per_done: Option<u32>,
    /// Oldest open task and its age in days.
    pub oldest: Option<DashboardTask>,
    /// One entry per day of the period, oldest first.
    pub time_by_day: Vec<DayTime>,
    /// The next dated open tasks (5 at most), by date.
    pub upcoming: Vec<DashboardTask>,
    /// Open tasks without a due date.
    pub undated: u32,
    pub late_or_blocked: Vec<DashboardTask>,
    /// Oldest open tasks (5 at most).
    pub lingering: Vec<DashboardTask>,
    /// Tasks with the most time in the period (5 at most).
    pub time_by_task: Vec<DashboardTask>,
}

/// A task in a dashboard block: what the block needs, nothing else.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DashboardTask {
    pub id: String,
    pub title: String,
    pub due: Option<Due>,
    /// Age in days (oldest, lingering), days late (overdue).
    pub days: Option<u32>,
    /// Seconds in the period (time by task).
    pub seconds: Option<u32>,
    /// Late or blocked: why.
    pub reason: Option<DashboardReason>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum DashboardReason {
    Overdue { days: u32 },
    BlockedBy { title: String },
    Waiting,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DayTime {
    /// `YYYY-MM-DD`, local.
    pub date: String,
    pub auto_seconds: u32,
    pub manual_seconds: u32,
}

// ---------------------------------------------------------------------------
// Attachments and relations (Taido V2.3)
// ---------------------------------------------------------------------------

/// A file copied into the task's folder (`~/Taido/Pièces jointes/<projet>/<tâche>/`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub task_id: String,
    pub file_name: String,
    /// Absolute path of the copy.
    pub path: String,
    pub mime_type: String,
    pub is_image: bool,
    /// Bytes.
    pub size: u32,
    pub added_at: String,
    /// The copy is still on disk.
    pub exists: bool,
    /// Where the file stands with the account's server (V2.7 bis): the tile's indicator.
    pub remote: AttachmentRemote,
}

/// Indicator of an attachment's file with the account's server (V2.7 bis, computed by the
/// core). `none`: nothing to show (on the server and here; always without an account, where
/// a missing file shows « fichier introuvable » as before); `local_only`: « Sur ce Mac
/// seulement » (not sent yet); `uploading`: « Envoi… »; `to_download`: « À télécharger »
/// (on another device or the server, not here yet; also when the copy here was edited in
/// place: a file never changes once sent); `downloading`: « Téléchargement… »; `too_large`:
/// refused by the server (« Trop gros (100 Mo max) »); `quota_full`: the account's space is
/// full (« Espace du compte plein »). The last two are tried again at each sync.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentRemote {
    None,
    LocalOnly,
    Uploading,
    ToDownload,
    Downloading,
    TooLarge,
    QuotaFull,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AddAttachmentsInput {
    pub task_id: String,
    /// Absolute paths of the files to copy.
    pub paths: Vec<String>,
}

/// A pasted file (a screenshot), base64-encoded.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AddAttachmentDataInput {
    pub task_id: String,
    pub name: String,
    pub base64: String,
}

/// What the user picks in the panel; « Bloquée par » is stored as « Bloque » read backwards.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum RelationKind {
    Blocks,
    BlockedBy,
    RelatesTo,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AddRelationInput {
    pub task_id: String,
    pub other_id: String,
    pub kind: RelationKind,
}

/// The other task of a relation, as the panel lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RelatedTask {
    pub relation_id: String,
    pub task_id: String,
    pub title: String,
    /// Set when it is a subtask: shown « Tâche › Sous-tâche » (2026-10-11).
    pub parent_title: Option<String>,
    /// Its project's name (`None`: « Sans projet »).
    pub project: Option<String>,
    pub completed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskRelations {
    pub blocks: Vec<RelatedTask>,
    pub blocked_by: Vec<RelatedTask>,
    pub related: Vec<RelatedTask>,
}

// ---------------------------------------------------------------------------
// Kanban (Taido V2.2)
// ---------------------------------------------------------------------------

/// A column of a project's kanban: a step of progress (2026-10-09), renamable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BoardColumn {
    pub id: String,
    pub name: String,
    /// The last column: completed tasks; dropping a card there completes it.
    pub is_done: bool,
    /// Every card, except in the done column which shows the last three.
    pub cards: Vec<TaskRow>,
    /// Number of tasks in the column (more than `cards` in the done column).
    pub total: u32,
}

/// Input of `move_task_to_column`.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MoveToColumnInput {
    pub task_id: String,
    pub column_id: String,
}

/// Input of `rename_board_column`.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RenameBoardColumnInput {
    pub id: String,
    pub name: String,
}

/// Input of `move_board_column`: `index` among the columns of work (the done column stays last).
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MoveBoardColumnInput {
    pub id: String,
    pub index: u32,
}

/// Input of `create_board_column`.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateBoardColumnInput {
    /// `None`: « Sans projet ».
    pub subject_id: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    /// `None`: « Sans projet ».
    pub subject_id: Option<String>,
    pub columns: Vec<BoardColumn>,
}

// ---------------------------------------------------------------------------
// Chrono (Taido V2.1)
// ---------------------------------------------------------------------------

/// Total time of a task: its stopped segments, plus the running one counted by the UI from
/// `running_since` up to now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskChrono {
    /// Seconds of the stopped segments.
    pub seconds: u32,
    /// Start of the running segment, `None` when paused.
    pub running_since: Option<String>,
}

/// Where a segment comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ChronoSource {
    /// Opened and closed by a Claude session's states.
    Auto,
    /// « + Ajouter du temps à la main ».
    Manual,
}

/// Why a running segment stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ChronoStop {
    /// Claude waits for the user's answer or permission.
    Waiting,
    /// Claude finished its turn, was interrupted or failed; the session stays open.
    TurnEnded,
    /// The session ended (process exited, tab closed).
    SessionClosed,
    /// The task was completed or deleted.
    TaskDone,
    /// The app quit or crashed (closed at the last heartbeat).
    AppClosed,
}

impl ChronoStop {
    pub fn as_str(self) -> &'static str {
        match self {
            ChronoStop::Waiting => "waiting",
            ChronoStop::TurnEnded => "turn_ended",
            ChronoStop::SessionClosed => "session_closed",
            ChronoStop::TaskDone => "task_done",
            ChronoStop::AppClosed => "app_closed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "waiting" => ChronoStop::Waiting,
            "turn_ended" => ChronoStop::TurnEnded,
            "session_closed" => ChronoStop::SessionClosed,
            "task_done" => ChronoStop::TaskDone,
            "app_closed" => ChronoStop::AppClosed,
            _ => return None,
        })
    }
}

/// One segment as the panel's chrono journal lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TimeSegment {
    pub id: String,
    pub source: ChronoSource,
    pub started_at: String,
    /// `None` while running.
    pub ended_at: Option<String>,
    pub stop_reason: Option<ChronoStop>,
    pub note: String,
    /// Duration once stopped (0 while running).
    pub seconds: u32,
}

/// The panel's chrono: the total and the segments, most recent first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskTime {
    pub chrono: TaskChrono,
    pub segments: Vec<TimeSegment>,
}

/// « + Ajouter du temps à la main »: `minutes` ending now.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AddManualTimeInput {
    pub task_id: String,
    pub minutes: u32,
    pub note: String,
}

/// Where the working folder of a task comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum WorkdirSource {
    Task,
    Section,
    Subject,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Workdir {
    pub path: String,
    pub source: WorkdirSource,
    pub exists: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Subtask {
    /// The child task's id.
    pub id: String,
    /// The parent task.
    pub task_id: String,
    pub text: String,
    pub done: bool,
    pub position: f64,
    /// The child's own ring (its Claude sessions), shown on the subtask line.
    pub ring: Ring,
    pub priority: u8,
    pub due: Option<Due>,
    pub open_terminals: u32,
}

/// A task named in another one (a subtask's parent).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskRef {
    pub id: String,
    pub title: String,
}

/// Everything the task panel shows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskDetail {
    pub id: String,
    pub title: String,
    pub description: String,
    pub subject: Option<SubjectTag>,
    pub section: Option<SectionTag>,
    pub due: Option<Due>,
    /// `None` when no folder applies: task without project and without override, or
    /// project without folder (D5) and without override.
    pub workdir: Option<Workdir>,
    pub workdir_override: Option<String>,
    /// `git -C <workdir> branch --show-current`, `None` if not a repo or no folder.
    pub git_branch: Option<String>,
    pub ring: Ring,
    pub line: Option<TaskLine>,
    /// Instant the current ring state started ("depuis…"): completion time, or `None`.
    pub ring_since: Option<String>,
    pub subtasks: Vec<Subtask>,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Terminals of the task kept by the core: running ones, and exited ones until
    /// the user closes their tab. Opening order. Filled by the PTY manager, not the database.
    pub terminals: Vec<TerminalInfo>,
    /// Claude sessions whose terminal is still kept (one per Claude terminal, matched by
    /// `TerminalInfo.agent_session_id`): what the action bar under each terminal shows.
    pub sessions: Vec<SessionView>,
    /// 1 to 4 (see `TaskRow.priority`).
    pub priority: u8,
    /// Set when this task is a subtask: its parent, for the panel's way back.
    pub parent: Option<TaskRef>,
    /// The task's own chrono (Taido V2.1).
    pub time: TaskTime,
    /// Taido V2.3.
    pub attachments: Vec<Attachment>,
    pub relations: TaskRelations,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum JournalKind {
    Created,
    Note,
    SessionStarted,
    Prompt,
    TurnEnded,
    Waiting,
    Error,
    SessionEnded,
    Crashed,
    Resumed,
    Cleared,
    Compacted,
    Completed,
    Reopened,
}

impl JournalKind {
    pub fn as_str(self) -> &'static str {
        match self {
            JournalKind::Created => "created",
            JournalKind::Note => "note",
            JournalKind::SessionStarted => "session_started",
            JournalKind::Prompt => "prompt",
            JournalKind::TurnEnded => "turn_ended",
            JournalKind::Waiting => "waiting",
            JournalKind::Error => "error",
            JournalKind::SessionEnded => "session_ended",
            JournalKind::Crashed => "crashed",
            JournalKind::Resumed => "resumed",
            JournalKind::Cleared => "cleared",
            JournalKind::Compacted => "compacted",
            JournalKind::Completed => "completed",
            JournalKind::Reopened => "reopened",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "created" => JournalKind::Created,
            "note" => JournalKind::Note,
            "session_started" => JournalKind::SessionStarted,
            "prompt" => JournalKind::Prompt,
            "turn_ended" => JournalKind::TurnEnded,
            "waiting" => JournalKind::Waiting,
            "error" => JournalKind::Error,
            "session_ended" => JournalKind::SessionEnded,
            "crashed" => JournalKind::Crashed,
            "resumed" => JournalKind::Resumed,
            "cleared" => JournalKind::Cleared,
            "compacted" => JournalKind::Compacted,
            "completed" => JournalKind::Completed,
            "reopened" => JournalKind::Reopened,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub id: String,
    pub task_id: String,
    pub agent_session_id: Option<String>,
    /// The tool of the entry's session (« Codex a fini son tour »); `None` without session.
    pub agent: Option<Agent>,
    pub kind: JournalKind,
    /// For `created`, `completed`, `reopened`: empty, the UI renders the label.
    pub text: String,
    pub at: String,
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ViewKind {
    /// "Sans projet" in the UI (D2): open tasks without project.
    Inbox,
    Today,
    /// « Prochainement »: one group per
    /// day from `GetViewInput.from`, overdue tasks first.
    Upcoming,
    /// « À faire »: every open task whatever its project, one group
    /// per project (sub-projects after their parent), « Sans projet » at its place among the
    /// top-level projects (last until moved).
    All,
    /// "Projet" in the UI (D1).
    Subject,
    /// « Portefeuille » (Taido V2.6): every project on one line; `get_view` gives an empty
    /// model, the screen reads `get_portfolio`.
    Portfolio,
}

/// Identifies a group; the UI maps it to its French title.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GroupKey {
    /// "Sans projet": the single list, without header.
    Inbox,
    /// Today: "Claude attend" (rings Waiting, Error, Crashed, Done). Only present when not
    /// empty, so never before a session exists.
    TodayWaiting,
    /// Today: "En retard" (due date before today). Only present when not empty.
    TodayOverdue,
    /// Today: the other tasks, without header. Always present (carries the add row).
    TodayRest,
    /// Subject: tasks outside any section, first and without header. Always present.
    NoSection,
    /// Subject: a section, in order.
    Section {
        id: String,
        name: String,
        subpath: Option<String>,
    },
    /// Upcoming: one day (`YYYY-MM-DD`, local), always present even when empty (it carries
    /// the day's add row).
    Day { date: String },
    /// « À faire »: the open tasks of one project (or sub-project); only when not empty.
    Project {
        id: String,
        name: String,
        color: SubjectColor,
        /// Set for a sub-project: its parent's name (« Globex › Client »).
        parent_name: Option<String>,
    },
    /// « À faire »: tasks without project, at its place among the top-level projects; only
    /// when not empty.
    NoProject,
}

/// Default destination of the group's "Ajouter une tâche" row; `None` when the group has none.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AddTarget {
    pub subject_id: Option<String>,
    pub section_id: Option<String>,
    /// Today's group adds tasks due today.
    pub due_today: bool,
    /// Upcoming: the day's group adds tasks due that day (`YYYY-MM-DD`, local); `null`
    /// elsewhere. Optional in TypeScript.
    #[specta(optional)]
    pub due_date: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskGroup {
    pub key: GroupKey,
    /// Whether the UI draws the group's header. Computed by the core: Today shows the
    /// headers of "Claude attend" / "En retard" only when there is more than one group, and
    /// never for the rest; subjects show section headers, never the no-section one.
    pub show_header: bool,
    pub tasks: Vec<TaskRow>,
    pub add_target: Option<AddTarget>,
    /// « À faire » only (`None` elsewhere): where the group's project stands in its level,
    /// so that the UI can drag the group by its header.
    #[specta(optional)]
    pub order: Option<GroupOrder>,
}

/// « À faire »: where a group's project stands in its level (« Sans projet » movable).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GroupOrder {
    /// Parent of a sub-project; `None` for a top-level project and for « Sans projet ».
    pub parent_id: Option<String>,
    /// Index in its level as `reorder_subject` / `reorder_inbox` take it: in the top-level
    /// order (top-level projects and « Sans projet ») or among the parent's live
    /// sub-projects. Projects without open tasks (no group) count too.
    pub index: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ViewModel {
    pub kind: ViewKind,
    /// Set for `ViewKind::Subject`.
    pub subject: Option<Subject>,
    /// Groups in display order. A group may be empty (e.g. an empty section).
    pub groups: Vec<TaskGroup>,
    /// Number of open tasks shown (subtitle "· 7 tâches").
    pub open_count: u32,
    /// Collapsed "Terminées" group: Today = completed today; Inbox/Subject = all completed.
    pub completed: Vec<TaskRow>,
    /// Local date the view was computed for (`YYYY-MM-DD`), for the subtitle.
    pub today: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    /// Open tasks without project ("Sans projet"; the sidebar line shows when > 0).
    pub inbox: u32,
    /// Open tasks of the Today view.
    pub today: u32,
    /// Open tasks whose ring is Waiting (red dot). Always 0 while no session waits.
    pub waiting: u32,
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    Light,
    Dark,
    #[default]
    System,
}

/// Colour theme (Réglages › Thème, 2026-10-11): each has a light and a dark version
/// (`[data-color]` blocks of src/styles/tokens.css). `Taido` is the original blue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ColorTheme {
    #[default]
    Taido,
    Slate,
    Graphite,
    Blueberry,
    Lavender,
    Plum,
    Raspberry,
    Cocoa,
    Sage,
    Lagoon,
}

/// Editor of « Ouvrir dans ». Since 2026-10-11 the
/// ⋯ menu lists the installed ones (`installed_editors`), no longer a setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Editor {
    #[default]
    Vscode,
    Cursor,
    Zed,
    Windsurf,
    Sublime,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Clair, sombre or système. With `sync_theme`, the shared value when there is one.
    pub theme: Theme,
    /// With `sync_theme`, the shared value when there is one.
    pub color_theme: ColorTheme,
    /// « Même thème sur tous mes appareils » (Todoist's « Sync theme »): theme and colour are
    /// the synced setting `appearance`. On by default.
    pub sync_theme: bool,
    /// Task panel width in px (360–1000, default 460: the one-column panel of the redesign).
    pub panel_width: u32,
    /// "Afficher les terminées" (menu Affichage).
    pub show_completed: bool,
    /// The editor last picked in « Ouvrir dans » (first in its list).
    pub editor: Editor,
    /// Explicit `claude` binary; `None` = found automatically.
    pub claude_path: Option<String>,
    /// One-line recap of each ended session written by Claude Haiku (`claude -p`, a few
    /// hundred tokens of the user's plan per session). By design: on by default.
    pub summarize_sessions: bool,
    /// A discreet notification when Claude finishes or waits. On by default.
    pub notifications: bool,
    /// The app's folder (`~/Taido`; `~/Todo` or `~/Documents/Todo` for a workspace created
    /// before the name), created at first launch: every project gets its folder in it, tasks without project work in its
    /// « Sans projet » folder. `None` only before the first launch.
    pub workspace_root: Option<String>,
    /// Where the first-launch guide stands.
    pub tutorial: Tutorial,
    /// The chrono also runs while Claude waits for the user's answer (Taido V2.1; by design:
    /// off by default).
    pub chrono_counts_waiting: bool,
    /// The tool ⌘T and the main button launch. Local to this Mac.
    pub default_agent: Agent,
    /// Explicit `codex` binary (Réglages › Agents); `None` = automatic detection.
    pub codex_path: Option<String>,
    /// « Avec quelle IA tu travailles ? » was answered (first-launch guide).
    pub agent_chosen: bool,
    /// Dictation: holding Space in a Claude or Codex terminal records (by design: on by default,
    /// can be turned off in Réglages › Agents). The mic button works either way.
    pub voice_space_hold: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: Theme::System,
            color_theme: ColorTheme::Taido,
            sync_theme: true,
            panel_width: 460,
            show_completed: false,
            editor: Editor::Vscode,
            claude_path: None,
            summarize_sessions: true,
            notifications: true,
            workspace_root: None,
            tutorial: Tutorial::default(),
            chrono_counts_waiting: false,
            default_agent: Agent::Claude,
            codex_path: None,
            agent_chosen: false,
            voice_space_hold: true,
        }
    }
}

/// State of the first-launch guide.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TutorialStatus {
    /// Never shown: the UI offers it at a launch without any data.
    #[default]
    NotStarted,
    /// Running: the next launch resumes it at `step`.
    InProgress,
    /// Finished, declined or left: only « Revoir le guide » (Réglages) starts it again.
    Done,
}

/// Progress of the first-launch guide. Local to this Mac and never synced: the phone has no
/// guide. The steps belong to the UI (they follow what is on screen); the core only keeps
/// them across launches.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Tutorial {
    pub status: TutorialStatus,
    /// Current step, an id of `src/features/tutorial/model.ts` (opaque to the core).
    pub step: Option<String>,
    /// Project the guide works in, once created.
    pub subject_id: Option<String>,
    /// Task the guide launches Claude in, once created.
    pub task_id: Option<String>,
}

/// Claude Code as the app sees it (Réglages, check before the first Claude terminal).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    /// Binary used (explicit setting, `TAIDO_CLAUDE_BIN`, `PATH`, usual places).
    pub path: Option<String>,
    /// `claude -v`, e.g. `2.1.288`.
    pub version: Option<String>,
    /// `claude auth status` → `loggedIn` (nothing else of its output is kept); `None` when
    /// it could not be read.
    pub logged_in: Option<bool>,
}

/// Diagnostic tab.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub app_version: String,
    pub claude: AgentStatus,
    pub hooks_port: u16,
    /// `PATH` of the login shell, as terminals get it.
    pub env_path: String,
    /// The login shell could be read (else a fallback `PATH`).
    pub env_from_login_shell: bool,
    pub log_dir: String,
    pub data_dir: String,
}

/// A task found by ⌘K.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskHit {
    pub id: String,
    pub title: String,
    pub subject: Option<SubjectTag>,
    pub section: Option<SectionTag>,
    pub ring: Ring,
    pub completed: bool,
}

/// A task offered by « + Lier une tâche » (Relations, 2026-10-11).
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RelationCandidate {
    pub id: String,
    pub title: String,
    /// Set for a subtask: it comes right after its task, unless that one is not listed.
    pub parent_id: Option<String>,
    pub parent_title: Option<String>,
    pub subject: Option<SubjectTag>,
    /// The project's name as the menu shows it: « Groupe › Projet » inside a group.
    pub project: Option<String>,
    pub section: Option<SectionTag>,
    pub ring: Ring,
    pub completed: bool,
    pub due_date: Option<String>,
}

/// Everything « + Lier une tâche » offers, in the app's order.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RelationCandidates {
    pub tasks: Vec<RelationCandidate>,
    /// « Récentes »: open tasks most recently changed first (ids of `tasks`).
    pub recent: Vec<String>,
}

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TerminalKind {
    /// An AI tool (Claude Code, Codex), launched directly (no shell); which one is the
    /// session's `agent`.
    Agent,
    /// `$SHELL -l`.
    Shell,
    /// `$SHELL -lc "<command>"`.
    Command,
}

impl TerminalKind {
    pub fn as_str(self) -> &'static str {
        match self {
            // Database value of every agent terminal (CHECK of migration 0001).
            TerminalKind::Agent => "claude",
            TerminalKind::Shell => "shell",
            TerminalKind::Command => "command",
        }
    }
}

/// The AI tool a session runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Agent {
    #[default]
    Claude,
    Codex,
}

impl Agent {
    pub fn as_str(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
        }
    }

    pub fn parse(s: &str) -> Option<Agent> {
        match s {
            "claude" => Some(Agent::Claude),
            "codex" => Some(Agent::Codex),
            _ => None,
        }
    }

    /// The name sentences use (« Codex attend »).
    pub fn label(self) -> &'static str {
        match self {
            Agent::Claude => "Claude",
            Agent::Codex => "Codex",
        }
    }
}

/// `--permission-mode` chosen in « Lancer Claude Code ».
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    /// « Normal »: the flag is not passed.
    Default,
    /// « Plan ».
    Plan,
    /// « Accepter les modifications ».
    AcceptEdits,
}

impl PermissionMode {
    /// Value of `--permission-mode`; `None` for « Normal », which passes no flag (Claude Code
    /// 2.1.288 no longer lists `default` among the accepted values).
    pub fn as_cli(self) -> Option<&'static str> {
        match self {
            PermissionMode::Default => None,
            PermissionMode::Plan => Some("plan"),
            PermissionMode::AcceptEdits => Some("acceptEdits"),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            PermissionMode::Default => "default",
            PermissionMode::Plan => "plan",
            PermissionMode::AcceptEdits => "accept_edits",
        }
    }

    /// Reads `agent_sessions.permission_mode` back (`None` for unknown values).
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "default" => PermissionMode::Default,
            "plan" => PermissionMode::Plan,
            "accept_edits" => PermissionMode::AcceptEdits,
            _ => return None,
        })
    }
}

/// A terminal kept by the core. The UI builds its tab label from `kind` and `command`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub task_id: String,
    pub kind: TerminalKind,
    /// The command line, for `command` terminals.
    pub command: Option<String>,
    pub cwd: String,
    pub opened_at: String,
    /// False once the process has exited; the tab stays until the user closes it.
    pub running: bool,
    /// Exit code once exited (`None` while running, or when killed by a signal).
    pub exit_code: Option<i32>,
    /// Claude terminals: the `agent_sessions` row created at launch.
    pub agent_session_id: Option<String>,
    /// The tool of an agent terminal (`None` for shells and commands).
    pub agent: Option<Agent>,
}

// ---------------------------------------------------------------------------
// Claude sessions
// ---------------------------------------------------------------------------

/// State of a Claude session. `Waiting` carries its kind in `SessionView`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Starting,
    Idle,
    Working,
    Waiting,
    Done,
    Error,
    Paused,
    Crashed,
}

impl SessionState {
    /// Value of `agent_sessions.state`.
    pub fn as_str(self) -> &'static str {
        match self {
            SessionState::Starting => "starting",
            SessionState::Idle => "idle",
            SessionState::Working => "working",
            SessionState::Waiting => "waiting",
            SessionState::Done => "done",
            SessionState::Error => "error",
            SessionState::Paused => "paused",
            SessionState::Crashed => "crashed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "starting" => SessionState::Starting,
            "idle" => SessionState::Idle,
            "working" => SessionState::Working,
            "waiting" => SessionState::Waiting,
            "done" => SessionState::Done,
            "error" => SessionState::Error,
            "paused" => SessionState::Paused,
            "crashed" => SessionState::Crashed,
            _ => return None,
        })
    }

    /// Live state: every state but Paused and Crashed.
    pub fn is_live(self) -> bool {
        !matches!(self, SessionState::Paused | SessionState::Crashed)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum WaitingKind {
    Permission,
    Question,
    Input,
}

impl WaitingKind {
    /// Value of `agent_sessions.waiting_kind`.
    pub fn as_str(self) -> &'static str {
        match self {
            WaitingKind::Permission => "permission",
            WaitingKind::Question => "question",
            WaitingKind::Input => "input",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "permission" => WaitingKind::Permission,
            "question" => WaitingKind::Question,
            "input" => WaitingKind::Input,
            _ => return None,
        })
    }
}

/// One Claude session as the panel shows it (action bar).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub id: String,
    /// The tool running the conversation (texts name it: « Codex attend »).
    pub agent: Agent,
    /// Terminal currently running this conversation (`None` once it exited).
    pub terminal_id: Option<String>,
    pub state: SessionState,
    /// Set when `state` is `Waiting`.
    pub waiting_kind: Option<WaitingKind>,
    /// Working: summary of the running tool (« Commande : npm test »), French, truncated.
    pub activity: Option<String>,
    /// Waiting(Question): the question line (160 characters max).
    pub question: Option<String>,
    /// Waiting(Permission): summary of the first pending request (« Commande : rm -rf dist »).
    pub permission: Option<String>,
    /// Pending permission requests beyond the first (« +1 en attente »). 0 while requests are not held.
    pub permissions_more: u32,
    /// Error: `StopFailure.error` (`rate_limit`, `overloaded`…), translated by the UI.
    pub error_kind: Option<String>,
    /// Done: Claude's last message (raw markdown, 500 characters max).
    pub last_message: Option<String>,
    /// Instant the session entered its state (« depuis… »).
    pub since: String,
    /// How full the conversation's context is, from its last reply (the tab's gauge).
    pub context: Option<ContextUsage>,
}

/// How much of its model's context window a conversation uses (`agents::usage`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    /// Tokens the last request sent to the model.
    pub used: u32,
    /// The model's context window.
    pub limit: u32,
    /// `used` out of `limit`, rounded, 0 to 100.
    pub percent: u8,
    /// « Opus 5.5 », « gpt-6-luna »; `None` when unknown.
    pub model: Option<String>,
    /// Codex only: share of the plan's current limit already used.
    pub plan_percent: Option<u8>,
}

/// One Claude conversation of a task, for the « Sessions Claude » history (
/// By design: sessions are work history one can come back to, like `claude --resume`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    /// The tool of the conversation: « Reprendre » relaunches it.
    pub agent: Agent,
    pub state: SessionState,
    /// The tab running it now (a terminal kept by the PTY manager), if any: « Aller à l'onglet ».
    pub terminal_id: Option<String>,
    pub started_at: String,
    /// When the conversation stopped (process exit, `/clear`, quit); `None` while it runs.
    pub ended_at: Option<String>,
    /// First message the user typed (200 characters max).
    pub first_prompt: Option<String>,
    /// Number of messages the user typed.
    pub prompt_count: u32,
    /// The process died without `SessionEnd` (« arrêtée brutalement »).
    pub crashed: bool,
    /// First sentence of Claude's last reply (160 characters max): with `first_prompt`, the
    /// fallback recap while there is no title nor summary.
    pub last_reply: Option<String>,
    /// Title the user gave the session (rename); shown first.
    pub title: Option<String>,
    /// One-line recap written by Claude Haiku once the session ended (120 characters max);
    /// `None` while pending, disabled or failed.
    pub ai_summary: Option<String>,
    /// « Reprendre » is possible: not running in a tab, and at least one message (Claude
    /// keeps nothing of a conversation without messages).
    pub resumable: bool,
}

/// What happened in a session, for its unfolded detail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ExchangeKind {
    /// The user's message (`UserPromptSubmit.prompt`, 2,000 characters max).
    Prompt,
    /// End of Claude's turn (`Stop.last_assistant_message`, 2,000 characters max).
    Reply,
    /// `StopFailure`: the error type in `text`.
    Error,
    /// The conversation was resumed in a new tab.
    Resumed,
    /// `/clear` ended this conversation in its tab.
    Cleared,
    /// The context was compacted.
    Compacted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Exchange {
    pub kind: ExchangeKind,
    pub text: String,
    pub at: String,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResumeSessionInput {
    pub agent_session_id: String,
    /// Initial size computed by the UI, like `open_terminal`.
    pub cols: u16,
    pub rows: u16,
}

/// A raw hook event, for the diagnostic panel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HookEventLog {
    /// Row id (`u32`: specta refuses 64-bit integers; the table is capped at 10,000 rows).
    pub id: u32,
    pub received_at: String,
    pub terminal_id: Option<String>,
    pub event: String,
    /// The JSON body as received.
    pub payload: String,
}

/// Size of a terminal, returned by `attach_terminal`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

// ---------------------------------------------------------------------------
// Command inputs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenTerminalInput {
    pub task_id: String,
    pub kind: TerminalKind,
    /// Agent terminals: the tool to launch; `None` = the default agent (Réglages › Agents).
    pub agent: Option<Agent>,
    /// Required for `command` terminals, ignored otherwise.
    pub command: Option<String>,
    /// Claude only: first prompt; empty or `None` = no prompt.
    pub initial_prompt: Option<String>,
    /// Claude only; `None` = `Default`.
    pub permission_mode: Option<PermissionMode>,
    /// Claude only: write the task context file; `None` = true.
    pub add_task_context: Option<bool>,
    /// Initial size computed by the UI.
    pub cols: u16,
    pub rows: u16,
}

/// Renames a session in the history (« Sessions Claude »).
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RenameSessionInput {
    pub agent_session_id: String,
    /// Trimmed, 120 characters max; `""` goes back to the automatic recap.
    pub title: String,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SetPriorityInput {
    pub id: String,
    /// 1 to 4; other values are refused (`invalid`).
    pub priority: u8,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WriteTerminalInput {
    pub terminal_id: String,
    /// UTF-8 text: keystrokes, pastes.
    pub data: String,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResizeTerminalInput {
    pub terminal_id: String,
    pub cols: u16,
    pub rows: u16,
}

/// Folder chosen when a terminal has none (`no_folder`) or lost it (`folder_missing`).
/// The core stores it at the right level: see `set_task_folder`.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SetTaskFolderInput {
    pub task_id: String,
    /// Absolute path of an existing folder.
    pub path: String,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateSubjectInput {
    pub name: String,
    /// `None`: next color of the palette after the last created project.
    pub color: Option<SubjectColor>,
    /// `None`: project without folder (D5). A sub-project without folder uses its parent's.
    pub root_path: Option<String>,
    /// `Some`: created as a sub-project of this top-level project.
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSubjectInput {
    pub id: String,
    pub name: Option<String>,
    pub color: Option<SubjectColor>,
    /// `None` keeps the folder; `Some("")` unlinks it (stored as NULL); else an absolute path.
    pub root_path: Option<String>,
    /// `None` keeps it; `Some("")` makes it a top-level project; else the new parent (a
    /// top-level project other than itself, and only if it has no sub-projects itself).
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateSectionInput {
    pub subject_id: String,
    pub name: String,
    pub subpath: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSectionInput {
    pub id: String,
    pub name: Option<String>,
    /// `Some("")` clears the subfolder.
    pub subpath: Option<String>,
}

/// Moves an item to `index` among its siblings (0 = first). The core computes the position.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReorderInput {
    pub id: String,
    pub index: u32,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskInput {
    pub title: String,
    pub description: Option<String>,
    pub subject_id: Option<String>,
    pub section_id: Option<String>,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTaskInput {
    pub id: String,
    pub title: Option<String>,
    pub description: Option<String>,
}

/// Sets or clears the due date (`date: None` clears both).
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SetDueInput {
    pub id: String,
    pub date: Option<String>,
    pub time: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SetWorkdirOverrideInput {
    pub id: String,
    /// `None` clears the override.
    pub path: Option<String>,
}

/// Moves a task. `subject_id: None` = "Sans projet"; `section_id: None` = outside sections;
/// `index: None` = at the end.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MoveTaskInput {
    pub id: String,
    pub subject_id: Option<String>,
    pub section_id: Option<String>,
    pub index: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SetCompletedInput {
    pub id: String,
    pub completed: bool,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GetViewInput {
    pub kind: ViewKind,
    pub subject_id: Option<String>,
    /// Upcoming: first day shown (`YYYY-MM-DD`, local); `None` = today. Days before today
    /// show no tasks (overdue ones are grouped at the top instead).
    pub from: Option<String>,
    /// Upcoming: number of days shown; `None` = 7.
    pub days: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AddSubtaskInput {
    pub task_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSubtaskInput {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AddNoteInput {
    pub task_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub theme: Option<Theme>,
    pub color_theme: Option<ColorTheme>,
    pub sync_theme: Option<bool>,
    pub panel_width: Option<u32>,
    pub show_completed: Option<bool>,
    pub editor: Option<Editor>,
    /// `""` clears it (automatic detection); `None` leaves it unchanged.
    pub claude_path: Option<String>,
    pub summarize_sessions: Option<bool>,
    pub notifications: Option<bool>,
    /// Replaces the whole guide progress.
    pub tutorial: Option<Tutorial>,
    pub chrono_counts_waiting: Option<bool>,
    pub default_agent: Option<Agent>,
    /// `""` clears it (automatic detection); `None` leaves it unchanged.
    pub codex_path: Option<String>,
    pub agent_chosen: Option<bool>,
    pub voice_space_hold: Option<bool>,
}

/// Application `open_path` uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum OpenWith {
    /// The system file manager (Finder on macOS): opens the folder itself.
    #[default]
    Finder,
    /// The editor chosen in the settings (`Settings.editor`).
    Editor,
    Terminal,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenPathInput {
    /// Absolute path of an existing folder or file.
    pub path: String,
    /// `None` = `Finder`.
    pub with: Option<OpenWith>,
    /// With `Editor`: the editor picked in « Ouvrir dans », remembered as the last used
    /// (`Settings.editor`). `None` = the last used.
    pub editor: Option<Editor>,
}

#[cfg(test)]
mod agent_tests {
    use super::Agent;

    #[test]
    fn agent_round_trips_through_its_text() {
        for agent in [Agent::Claude, Agent::Codex] {
            assert_eq!(Agent::parse(agent.as_str()), Some(agent));
        }
        assert_eq!(Agent::parse("cursor"), None);
        assert_eq!(Agent::default(), Agent::Claude);
        assert_eq!(
            serde_json::to_string(&Agent::Codex).expect("json"),
            "\"codex\""
        );
    }
}
