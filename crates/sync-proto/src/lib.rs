//! Wire types of the Todo sync protocol and its conflict rule, shared by the
//! Mac core (`src-tauri`) and the sync server (`sync-server`). The PWA uses a hand-written
//! mirror, `src/lib/sync-proto.ts`, kept in step with this file. Full contract: docs/SYNC.md.
//!
//! JSON is snake_case. Every timestamp the conflict rule compares (`updated_at`) is a
//! **canonical** UTC instant `YYYY-MM-DDTHH:MM:SS.sssZ` (24 characters), so that comparing
//! the strings compares the instants.

use std::cmp::Ordering;
use std::fmt;

use serde::{Deserialize, Serialize};

/// Bumped on any incompatible change of the types below. Sent in every request and response;
/// the server refuses another version with [`ErrorCode::UnsupportedProtocol`].
pub const PROTOCOL_VERSION: u32 = 3;

/// Largest accepted body of `POST /api/sync` (16 MiB).
pub const MAX_SYNC_BODY_BYTES: usize = 16 * 1024 * 1024;
/// Largest accepted body of `POST /api/login` (4 KiB).
pub const MAX_LOGIN_BODY_BYTES: usize = 4 * 1024;
/// Longest accepted identifier (UUIDs are 36 characters).
pub const MAX_ID_LEN: usize = 128;
/// Longest accepted free timestamp (`created_at`, `deleted_at`, `completed_at`).
pub const MAX_STAMP_LEN: usize = 64;
/// Clients push at most this many changes per request (they loop until the outbox is sent).
pub const MAX_PUSH_CHANGES: usize = 500;
/// …and at most this many bytes of serialized changes per request (a single larger change is
/// sent alone; the body limit is [`MAX_SYNC_BODY_BYTES`]).
pub const MAX_PUSH_BYTES: usize = 4 * 1024 * 1024;
/// The server returns at most this many pulled rows per response (`has_more` then `true`).
pub const MAX_PULL_CHANGES: usize = 2000;
/// …and stops a pulled page once its rows' data pass this many bytes (8 MiB; a single larger
/// row still comes, alone): a pull never makes the server hold a whole account in memory.
pub const MAX_PULL_BYTES: usize = 8 * 1024 * 1024;
/// Lowest possible conflict stamp. A row a client enqueues without any known version (first
/// link, a server reset) carries it: accepted when the server lacks the row, loses to any
/// real version (docs/SYNC.md § 2.6).
pub const EPOCH_STAMP: &str = "1970-01-01T00:00:00.000Z";
/// Longest setting key; keys are `[a-z0-9_]`, 1 to 64 bytes.
pub const MAX_SETTING_KEY_LEN: usize = 64;
/// Largest serialized `SettingData.value` (JSON bytes).
pub const MAX_SETTING_VALUE_BYTES: usize = 4096;
/// Position of « Sans projet » among the top-level projects (a JSON number).
pub const SETTING_INBOX_POSITION: &str = "inbox_position";
/// Theme shared by the devices whose « Même thème sur tous mes appareils » is on (Réglages ›
/// Thème): `{"theme": "light|dark|system", "color": "taido|slate|…"}`. A device ignores a
/// value it cannot read (e.g. a colour added by a later version).
pub const SETTING_APPEARANCE: &str = "appearance";
/// Longest attachment file name (bytes).
pub const MAX_FILE_NAME_BYTES: usize = 255;
/// Largest body of one file upload request (8 MiB): a file travels as consecutive chunks, each
/// starting at the number of bytes the server already holds.
pub const MAX_CHUNK_BYTES: usize = 8 * 1024 * 1024;
/// Default largest attachment file, per file (100 MiB); the server can lower or raise it
/// (`TAIDO_MAX_FILE_BYTES`).
pub const DEFAULT_MAX_FILE_BYTES: u64 = 104_857_600;
/// Default total size of the files of one account (2 GiB); the server can change it
/// (`TAIDO_ACCOUNT_QUOTA_BYTES`).
pub const DEFAULT_ACCOUNT_QUOTA_BYTES: u64 = 2_147_483_648;
/// Largest notebook page body (`NotePageData.body`, Markdown), in bytes (256 KiB).
pub const MAX_NOTE_BODY_BYTES: usize = 262_144;
/// Longest notebook page title, in bytes (not blank).
pub const MAX_NOTE_TITLE_BYTES: usize = 500;
/// Accepted `NotePageData.kind` values: a plain page, or a task's end summary.
pub const NOTE_KINDS: [&str; 2] = ["page", "summary"];
/// Accepted `TimeSegmentData.stop_reason` values.
pub const STOP_REASONS: [&str; 5] = [
    "waiting",
    "turn_ended",
    "session_closed",
    "task_done",
    "app_closed",
];

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/// The synced record kinds: the tables and the shared settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Entity {
    Subject,
    Section,
    Task,
    /// A shared setting (protocol 2); its id is the setting key.
    Setting,
    /// A Kanban column (protocol 3).
    BoardColumn,
    /// A tracked time segment of a task (protocol 3).
    TimeSegment,
    /// A link between two tasks (protocol 3).
    Relation,
    /// An attachment's metadata; the file itself is not synced (protocol 3).
    Attachment,
    /// A group of a project's notebook (protocol 3, additive).
    NoteGroup,
    /// A page of a project's notebook (protocol 3, additive).
    NotePage,
    /// An image of a notebook page: an `attachments` row owned by a page (protocol 3,
    /// additive). Its file travels like an attachment's.
    NoteAttachment,
}

/// The entities every protocol 3 client reads. A sync request without
/// [`SyncRequest::known_entities`] (a client made before the notebook) is sent rows of these
/// only (docs/SYNC.md § 0.1).
pub const LEGACY_ENTITIES: [Entity; 8] = [
    Entity::Subject,
    Entity::Section,
    Entity::Task,
    Entity::Setting,
    Entity::BoardColumn,
    Entity::TimeSegment,
    Entity::Relation,
    Entity::Attachment,
];

/// What the server may send a client that declared `known` (its
/// [`SyncRequest::known_entities`]): the legacy entities, plus the listed names this build
/// knows (unknown names are ignored).
pub fn known_entity_set(known: Option<&[String]>) -> Vec<Entity> {
    let mut out = LEGACY_ENTITIES.to_vec();
    for name in known.unwrap_or_default() {
        if let Some(e) = Entity::parse(name) {
            if !out.contains(&e) {
                out.push(e);
            }
        }
    }
    out
}

impl Entity {
    /// Every entity of this build, the legacy ones first ([`LEGACY_ENTITIES`]).
    pub const ALL: [Entity; 11] = [
        Entity::Subject,
        Entity::Section,
        Entity::Task,
        Entity::Setting,
        Entity::BoardColumn,
        Entity::TimeSegment,
        Entity::Relation,
        Entity::Attachment,
        Entity::NoteGroup,
        Entity::NotePage,
        Entity::NoteAttachment,
    ];

    /// Name on the wire and in the `sync_outbox.entity` / server `records.entity` columns.
    pub fn as_str(self) -> &'static str {
        match self {
            Entity::Subject => "subject",
            Entity::Section => "section",
            Entity::Task => "task",
            Entity::Setting => "setting",
            Entity::BoardColumn => "board_column",
            Entity::TimeSegment => "time_segment",
            Entity::Relation => "relation",
            Entity::Attachment => "attachment",
            Entity::NoteGroup => "note_group",
            Entity::NotePage => "note_page",
            Entity::NoteAttachment => "note_attachment",
        }
    }

    pub fn parse(s: &str) -> Option<Entity> {
        match s {
            "subject" => Some(Entity::Subject),
            "section" => Some(Entity::Section),
            "task" => Some(Entity::Task),
            "setting" => Some(Entity::Setting),
            "board_column" => Some(Entity::BoardColumn),
            "time_segment" => Some(Entity::TimeSegment),
            "relation" => Some(Entity::Relation),
            "attachment" => Some(Entity::Attachment),
            "note_group" => Some(Entity::NoteGroup),
            "note_page" => Some(Entity::NotePage),
            "note_attachment" => Some(Entity::NoteAttachment),
            _ => None,
        }
    }
}

/// Synced columns of `subjects` (a project; `parent_id` set on a sub-project).
/// Never synced: `root_path`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubjectData {
    pub name: String,
    /// Palette key, e.g. `"teal"`. Unknown keys are kept as is.
    pub color: String,
    pub parent_id: Option<String>,
    pub position: f64,
    pub created_at: String,
    /// Soft delete (restorable for 24 h on the device that keeps it).
    pub deleted_at: Option<String>,
    /// A group holds sub-projects and no task (protocol 3; absent = `false`).
    #[serde(default)]
    pub is_group: bool,
}

/// Synced columns of `sections`. Never synced: `subpath`. Sections are hard-deleted: a
/// deleted section travels as a tombstone (`data: null`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SectionData {
    pub subject_id: String,
    pub name: String,
    pub position: f64,
    pub created_at: String,
}

/// Synced columns of `tasks` (a sub-task is a task with `parent_id`).
/// Never synced: `workdir_override`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskData {
    /// `None` = « Sans projet » (inbox).
    pub subject_id: Option<String>,
    pub section_id: Option<String>,
    pub parent_id: Option<String>,
    pub title: String,
    /// The task's note.
    pub description: String,
    /// `YYYY-MM-DD`, local date.
    pub due_date: Option<String>,
    /// `HH:MM`, local time.
    pub due_time: Option<String>,
    /// 1 (default) to 4.
    pub priority: u8,
    pub completed_at: Option<String>,
    pub position: f64,
    pub created_at: String,
    pub deleted_at: Option<String>,
    /// Kanban column of the task (protocol 3; absent = none).
    #[serde(default)]
    pub board_column_id: Option<String>,
}

/// Synced columns of `board_columns` (protocol 3). `subject_id: None` = the columns of
/// « Sans projet ». Hard-deleted: a deleted column travels as a tombstone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BoardColumnData {
    pub subject_id: Option<String>,
    pub name: String,
    pub position: f64,
    pub is_done: bool,
    pub created_at: String,
}

/// How a time segment was made.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SegmentSource {
    Auto,
    Manual,
}

/// Synced columns of `time_segments` (protocol 3). Never synced: `agent_session_id`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimeSegmentData {
    pub task_id: String,
    pub source: SegmentSource,
    /// Canonical UTC instant.
    pub started_at: String,
    /// Canonical UTC instant, `>= started_at`; `None` while the segment runs.
    pub ended_at: Option<String>,
    /// One of [`STOP_REASONS`].
    pub stop_reason: Option<String>,
    pub note: String,
    pub created_at: String,
    pub deleted_at: Option<String>,
}

/// Kind of a task relation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationKind {
    Blocks,
    RelatesTo,
}

/// Synced columns of `relations` (protocol 3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RelationData {
    pub from_task_id: String,
    pub to_task_id: String,
    pub kind: RelationKind,
    pub created_at: String,
    pub deleted_at: Option<String>,
}

/// Synced columns of `attachments` (protocol 3). Never synced: `stored_path`. The file itself
/// travels apart, in chunks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AttachmentData {
    pub task_id: String,
    /// No `/` or `\`, 1 to [`MAX_FILE_NAME_BYTES`] bytes.
    pub file_name: String,
    pub mime_type: String,
    pub size: u64,
    /// SHA-256 of the file: 64 lowercase hexadecimal characters (see [`is_sha256_hex`]). An
    /// additive optional field: absent (and not written) when unknown, the protocol stays 3.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    pub created_at: String,
    pub deleted_at: Option<String>,
}

/// Synced columns of `note_groups` (a group of a project's notebook, e.g. « Décisions »).
/// Hard-deleted: a deleted group travels as a tombstone and its pages fall back to no group.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NoteGroupData {
    pub subject_id: String,
    /// Not blank.
    pub name: String,
    pub position: f64,
    pub created_at: String,
}

/// Synced columns of `note_pages` (a notebook page, Markdown body).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NotePageData {
    pub subject_id: String,
    /// `None` = outside any group (plain pages on top, summaries in « Résumés de tâches »).
    pub group_id: Option<String>,
    /// One of [`NOTE_KINDS`].
    pub kind: String,
    /// Not blank, at most [`MAX_NOTE_TITLE_BYTES`] bytes.
    pub title: String,
    /// Markdown, at most [`MAX_NOTE_BODY_BYTES`] bytes.
    pub body: String,
    /// The task a summary was written for.
    pub source_task_id: Option<String>,
    /// Set = shown in « Épinglées », ordered by this stamp.
    pub pinned_at: Option<String>,
    pub position: f64,
    pub created_at: String,
    pub deleted_at: Option<String>,
}

/// Synced columns of an `attachments` row owned by a notebook page: same shape as
/// [`AttachmentData`], `note_page_id` instead of `task_id`. Never synced: `stored_path`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NoteAttachmentData {
    pub note_page_id: String,
    /// No `/` or `\`, 1 to [`MAX_FILE_NAME_BYTES`] bytes.
    pub file_name: String,
    pub mime_type: String,
    pub size: u64,
    /// Same as [`AttachmentData::sha256`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    pub created_at: String,
    pub deleted_at: Option<String>,
}

/// One shared setting (docs/SYNC.md § 2.1). The id of its change is the key. Never deleted:
/// a setting has no tombstone (it would be final and forbid any later value).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SettingData {
    /// Any JSON value; known keys constrain it (see [`Change::validate`]).
    pub value: serde_json::Value,
}

/// One version of one row. `data: None` is a **tombstone**: the row is gone for good
/// (hard delete, purge); a tombstone always wins and the row never comes back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Versioned<T> {
    pub id: String,
    /// Conflict key: canonical UTC instant of the change (see [`is_canonical_timestamp`]).
    pub updated_at: String,
    /// Device that made the change. Ignored in a push (the server writes the device of the
    /// token); always set in a pull.
    pub device_id: String,
    pub data: Option<T>,
}

/// A row change, tagged by `entity`:
/// `{"entity":"task","id":"…","updated_at":"…","device_id":"…","data":{…}|null}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "entity", rename_all = "snake_case")]
pub enum Change {
    Subject(Versioned<SubjectData>),
    Section(Versioned<SectionData>),
    Task(Versioned<TaskData>),
    /// The id is the setting key, e.g. [`SETTING_INBOX_POSITION`].
    Setting(Versioned<SettingData>),
    BoardColumn(Versioned<BoardColumnData>),
    TimeSegment(Versioned<TimeSegmentData>),
    Relation(Versioned<RelationData>),
    Attachment(Versioned<AttachmentData>),
    NoteGroup(Versioned<NoteGroupData>),
    NotePage(Versioned<NotePageData>),
    NoteAttachment(Versioned<NoteAttachmentData>),
}

/// Identity of a row across devices.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ChangeKey {
    pub entity: Entity,
    pub id: String,
}

impl Change {
    pub fn entity(&self) -> Entity {
        match self {
            Change::Subject(_) => Entity::Subject,
            Change::Section(_) => Entity::Section,
            Change::Task(_) => Entity::Task,
            Change::Setting(_) => Entity::Setting,
            Change::BoardColumn(_) => Entity::BoardColumn,
            Change::TimeSegment(_) => Entity::TimeSegment,
            Change::Relation(_) => Entity::Relation,
            Change::Attachment(_) => Entity::Attachment,
            Change::NoteGroup(_) => Entity::NoteGroup,
            Change::NotePage(_) => Entity::NotePage,
            Change::NoteAttachment(_) => Entity::NoteAttachment,
        }
    }

    pub fn id(&self) -> &str {
        match self {
            Change::Subject(v) => &v.id,
            Change::Section(v) => &v.id,
            Change::Task(v) => &v.id,
            Change::Setting(v) => &v.id,
            Change::BoardColumn(v) => &v.id,
            Change::TimeSegment(v) => &v.id,
            Change::Relation(v) => &v.id,
            Change::Attachment(v) => &v.id,
            Change::NoteGroup(v) => &v.id,
            Change::NotePage(v) => &v.id,
            Change::NoteAttachment(v) => &v.id,
        }
    }

    pub fn updated_at(&self) -> &str {
        match self {
            Change::Subject(v) => &v.updated_at,
            Change::Section(v) => &v.updated_at,
            Change::Task(v) => &v.updated_at,
            Change::Setting(v) => &v.updated_at,
            Change::BoardColumn(v) => &v.updated_at,
            Change::TimeSegment(v) => &v.updated_at,
            Change::Relation(v) => &v.updated_at,
            Change::Attachment(v) => &v.updated_at,
            Change::NoteGroup(v) => &v.updated_at,
            Change::NotePage(v) => &v.updated_at,
            Change::NoteAttachment(v) => &v.updated_at,
        }
    }

    pub fn device_id(&self) -> &str {
        match self {
            Change::Subject(v) => &v.device_id,
            Change::Section(v) => &v.device_id,
            Change::Task(v) => &v.device_id,
            Change::Setting(v) => &v.device_id,
            Change::BoardColumn(v) => &v.device_id,
            Change::TimeSegment(v) => &v.device_id,
            Change::Relation(v) => &v.device_id,
            Change::Attachment(v) => &v.device_id,
            Change::NoteGroup(v) => &v.device_id,
            Change::NotePage(v) => &v.device_id,
            Change::NoteAttachment(v) => &v.device_id,
        }
    }

    /// Overwrites the device (the server stamps the device of the token on a push).
    pub fn set_device_id(&mut self, device_id: &str) {
        let slot = match self {
            Change::Subject(v) => &mut v.device_id,
            Change::Section(v) => &mut v.device_id,
            Change::Task(v) => &mut v.device_id,
            Change::Setting(v) => &mut v.device_id,
            Change::BoardColumn(v) => &mut v.device_id,
            Change::TimeSegment(v) => &mut v.device_id,
            Change::Relation(v) => &mut v.device_id,
            Change::Attachment(v) => &mut v.device_id,
            Change::NoteGroup(v) => &mut v.device_id,
            Change::NotePage(v) => &mut v.device_id,
            Change::NoteAttachment(v) => &mut v.device_id,
        };
        *slot = device_id.to_string();
    }

    /// `true` for a tombstone (`data: null`).
    pub fn is_tombstone(&self) -> bool {
        match self {
            Change::Subject(v) => v.data.is_none(),
            Change::Section(v) => v.data.is_none(),
            Change::Task(v) => v.data.is_none(),
            Change::Setting(v) => v.data.is_none(),
            Change::BoardColumn(v) => v.data.is_none(),
            Change::TimeSegment(v) => v.data.is_none(),
            Change::Relation(v) => v.data.is_none(),
            Change::Attachment(v) => v.data.is_none(),
            Change::NoteGroup(v) => v.data.is_none(),
            Change::NotePage(v) => v.data.is_none(),
            Change::NoteAttachment(v) => v.data.is_none(),
        }
    }

    pub fn key(&self) -> ChangeKey {
        ChangeKey {
            entity: self.entity(),
            id: self.id().to_string(),
        }
    }

    /// The conflict stamp of this change.
    pub fn stamp(&self) -> Stamp<'_> {
        Stamp {
            updated_at: self.updated_at(),
            device_id: self.device_id(),
            tombstone: self.is_tombstone(),
        }
    }

    /// Structural checks shared by the server and the clients. Lengths of names, titles and
    /// notes are **not** limited (a long title on the Mac must never block the sync); only
    /// the body size is. Notebook pages are the exception: their title and body have limits
    /// that the Mac checks before writing ([`MAX_NOTE_TITLE_BYTES`], [`MAX_NOTE_BODY_BYTES`]).
    pub fn validate(&self) -> Result<(), ProtoError> {
        check_id("id", self.id())?;
        if !is_canonical_timestamp(self.updated_at()) {
            return Err(ProtoError::new(format!(
                "updated_at is not a canonical UTC instant: {:?}",
                self.updated_at()
            )));
        }
        if self.device_id().len() > MAX_ID_LEN {
            return Err(ProtoError::new("device_id is too long"));
        }
        match self {
            Change::Subject(Versioned { data: Some(d), .. }) => {
                check_position(d.position)?;
                check_opt_id("parent_id", d.parent_id.as_deref())?;
                if d.parent_id.as_deref() == Some(self.id()) {
                    return Err(ProtoError::new("a project cannot be its own parent"));
                }
                check_stamp("created_at", Some(&d.created_at))?;
                check_stamp("deleted_at", d.deleted_at.as_deref())?;
            }
            Change::Section(Versioned { data: Some(d), .. }) => {
                check_position(d.position)?;
                check_id("subject_id", &d.subject_id)?;
                check_stamp("created_at", Some(&d.created_at))?;
            }
            Change::Task(Versioned { data: Some(d), .. }) => {
                check_position(d.position)?;
                check_opt_id("subject_id", d.subject_id.as_deref())?;
                check_opt_id("section_id", d.section_id.as_deref())?;
                check_opt_id("parent_id", d.parent_id.as_deref())?;
                if d.parent_id.as_deref() == Some(self.id()) {
                    return Err(ProtoError::new("a task cannot be its own parent"));
                }
                if !(1..=4).contains(&d.priority) {
                    return Err(ProtoError::new(format!(
                        "priority must be 1 to 4: {}",
                        d.priority
                    )));
                }
                if let Some(date) = d.due_date.as_deref() {
                    if !is_date(date) {
                        return Err(ProtoError::new(format!("bad due_date: {date:?}")));
                    }
                }
                if let Some(time) = d.due_time.as_deref() {
                    if !is_time(time) {
                        return Err(ProtoError::new(format!("bad due_time: {time:?}")));
                    }
                    if d.due_date.is_none() {
                        return Err(ProtoError::new("due_time without due_date"));
                    }
                }
                check_stamp("completed_at", d.completed_at.as_deref())?;
                check_stamp("created_at", Some(&d.created_at))?;
                check_stamp("deleted_at", d.deleted_at.as_deref())?;
            }
            Change::BoardColumn(Versioned { data: Some(d), .. }) => {
                check_opt_id("subject_id", d.subject_id.as_deref())?;
                if d.name.trim().is_empty() {
                    return Err(ProtoError::new("a column name cannot be empty"));
                }
                check_position(d.position)?;
                check_stamp("created_at", Some(&d.created_at))?;
            }
            Change::TimeSegment(Versioned { data: Some(d), .. }) => {
                check_id("task_id", &d.task_id)?;
                if !is_canonical_timestamp(&d.started_at) {
                    return Err(ProtoError::new(format!(
                        "started_at is not a canonical UTC instant: {:?}",
                        d.started_at
                    )));
                }
                if let Some(ended) = d.ended_at.as_deref() {
                    if !is_canonical_timestamp(ended) {
                        return Err(ProtoError::new(format!(
                            "ended_at is not a canonical UTC instant: {ended:?}"
                        )));
                    }
                    if ended < d.started_at.as_str() {
                        return Err(ProtoError::new("ended_at is before started_at"));
                    }
                }
                if let Some(reason) = d.stop_reason.as_deref() {
                    if !STOP_REASONS.contains(&reason) {
                        return Err(ProtoError::new(format!("bad stop_reason: {reason:?}")));
                    }
                }
                check_stamp("created_at", Some(&d.created_at))?;
                check_stamp("deleted_at", d.deleted_at.as_deref())?;
            }
            Change::Relation(Versioned { data: Some(d), .. }) => {
                check_id("from_task_id", &d.from_task_id)?;
                check_id("to_task_id", &d.to_task_id)?;
                if d.from_task_id == d.to_task_id {
                    return Err(ProtoError::new("a task cannot be related to itself"));
                }
                check_stamp("created_at", Some(&d.created_at))?;
                check_stamp("deleted_at", d.deleted_at.as_deref())?;
            }
            Change::Attachment(Versioned { data: Some(d), .. }) => {
                check_id("task_id", &d.task_id)?;
                check_file(&d.file_name, d.sha256.as_deref())?;
                check_stamp("created_at", Some(&d.created_at))?;
                check_stamp("deleted_at", d.deleted_at.as_deref())?;
            }
            Change::NoteGroup(Versioned { data: Some(d), .. }) => {
                check_id("subject_id", &d.subject_id)?;
                if d.name.trim().is_empty() {
                    return Err(ProtoError::new("a group name cannot be empty"));
                }
                check_position(d.position)?;
                check_stamp("created_at", Some(&d.created_at))?;
            }
            Change::NotePage(Versioned { data: Some(d), .. }) => {
                check_id("subject_id", &d.subject_id)?;
                check_opt_id("group_id", d.group_id.as_deref())?;
                check_opt_id("source_task_id", d.source_task_id.as_deref())?;
                if !NOTE_KINDS.contains(&d.kind.as_str()) {
                    return Err(ProtoError::new(format!("bad page kind: {:?}", d.kind)));
                }
                if d.title.trim().is_empty() || d.title.len() > MAX_NOTE_TITLE_BYTES {
                    return Err(ProtoError::new(format!(
                        "a page title must be 1 to {MAX_NOTE_TITLE_BYTES} bytes, not blank"
                    )));
                }
                if d.body.len() > MAX_NOTE_BODY_BYTES {
                    return Err(ProtoError::new(format!(
                        "a page body must be at most {MAX_NOTE_BODY_BYTES} bytes"
                    )));
                }
                check_position(d.position)?;
                check_stamp("pinned_at", d.pinned_at.as_deref())?;
                check_stamp("created_at", Some(&d.created_at))?;
                check_stamp("deleted_at", d.deleted_at.as_deref())?;
            }
            Change::NoteAttachment(Versioned { data: Some(d), .. }) => {
                check_id("note_page_id", &d.note_page_id)?;
                check_file(&d.file_name, d.sha256.as_deref())?;
                check_stamp("created_at", Some(&d.created_at))?;
                check_stamp("deleted_at", d.deleted_at.as_deref())?;
            }
            Change::Setting(Versioned { data: None, .. }) => {
                return Err(ProtoError::new("a setting is never deleted"));
            }
            Change::Setting(Versioned { data: Some(d), .. }) => {
                check_setting(self.id(), &d.value)?;
            }
            // Tombstones carry no data.
            _ => {}
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Conflict rule
// ---------------------------------------------------------------------------

/// What the conflict rule looks at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stamp<'a> {
    pub updated_at: &'a str,
    pub device_id: &'a str,
    pub tombstone: bool,
}

/// Last writer wins, whole row, decided by the server only:
/// 1. a stored tombstone is final: nothing replaces it;
/// 2. an incoming tombstone always wins;
/// 3. otherwise the greater `(updated_at, device_id)` wins (strings compared byte-wise,
///    `updated_at` being canonical); an **equal** pair wins too (the same change pushed
///    again is idempotent).
pub fn incoming_wins(incoming: Stamp<'_>, stored: Stamp<'_>) -> bool {
    if stored.tombstone {
        return false;
    }
    if incoming.tombstone {
        return true;
    }
    match incoming.updated_at.cmp(stored.updated_at) {
        Ordering::Greater => true,
        Ordering::Less => false,
        Ordering::Equal => incoming.device_id >= stored.device_id,
    }
}

// ---------------------------------------------------------------------------
// Requests and responses
// ---------------------------------------------------------------------------

/// `POST /api/sync` (Bearer token): pushes local changes and pulls everything newer than
/// `cursor` in one round trip.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncRequest {
    pub protocol: u32,
    /// Highest server revision this device has applied; `0` = never synced (full pull).
    pub cursor: u64,
    /// Local changes since the last sync, at most one per row (its latest version).
    pub changes: Vec<Change>,
    /// Wire names of the entities this client reads (additive, protocol 3; absent = a client
    /// made before the notebook: [`LEGACY_ENTITIES`] only). The server sends rows of the
    /// entities in [`known_entity_set`] only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub known_entities: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncResponse {
    pub protocol: u32,
    /// Identity of the server's database (random UUID made at creation, renewed by a restore).
    /// A client that sees another epoch than the one it stored resets its cursor and
    /// re-enqueues its rows (docs/SYNC.md § 2.6).
    pub server_epoch: String,
    /// New cursor: the server's highest revision once the push is stored, or the revision of
    /// the last returned row when `has_more`.
    pub cursor: u64,
    /// Rows to apply as is, in revision order: rows stored with a revision above the
    /// request's cursor (at most [`MAX_PULL_CHANGES`]) **except** the pushed changes the
    /// server accepted, plus the server's current version of every pushed change it refused.
    pub changes: Vec<Change>,
    /// `true` when more rows wait above `cursor`: the client asks again at once.
    pub has_more: bool,
    /// Pushed changes that failed [`Change::validate`]: not stored. The client drops them
    /// from its outbox and logs them (one odd row never blocks the sync).
    pub rejected: Vec<ChangeKey>,
    /// How many pushed changes were stored (diagnostics only).
    pub accepted: u32,
    /// Server clock, canonical UTC (diagnostics: clock skew between devices).
    pub server_time: String,
}

/// `POST /api/signup` (protocol 3): creates an account and logs this device in
/// (answers with a [`LoginResponse`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignupRequest {
    pub protocol: u32,
    pub email: String,
    pub password: String,
    /// Shown in the server's device list. 1 to 64 characters.
    pub device_name: String,
}

/// `POST /api/login`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoginRequest {
    pub protocol: u32,
    pub email: String,
    pub password: String,
    /// Shown in the server's device list, e.g. « Mac » or « Téléphone ». 1 to 64 characters.
    pub device_name: String,
}

/// `POST /api/password/forgot`: always answered 204, whether the address exists or not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForgotRequest {
    pub protocol: u32,
    pub email: String,
}

/// `POST /api/password/reset`: sets a new password from the e-mailed code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResetRequest {
    pub protocol: u32,
    pub email: String,
    pub code: String,
    pub password: String,
}

/// `GET /api/account` (Bearer token).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountResponse {
    pub protocol: u32,
    pub email: String,
    pub created_at: String,
    /// The address was confirmed (link of the signup mail). Absent from older servers, which
    /// did not ask for it: read as confirmed.
    #[serde(default = "confirmed")]
    pub email_verified: bool,
}

fn confirmed() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoginResponse {
    pub protocol: u32,
    /// Opaque bearer token (43 characters, base64url of 32 random bytes). Shown once.
    pub token: String,
    /// Identifier the server gave this device (UUID).
    pub device_id: String,
    /// See [`SyncResponse::server_epoch`]; stored by the client at link.
    pub server_epoch: String,
}

/// `GET /api/health`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealthResponse {
    pub ok: bool,
    pub protocol: u32,
}

/// Answer of the file status route: how much of an attachment's file the
/// server holds, so an interrupted upload resumes from `received`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileStatus {
    pub protocol: u32,
    /// Bytes received so far: the `offset` of the next chunk.
    pub received: u64,
    /// Total size of the file, as declared by the attachment.
    pub size: u64,
    /// `true` once all bytes are in and the SHA-256 matched: the file is kept.
    pub complete: bool,
}

/// Body of every error response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorBody {
    pub error: ErrorCode,
    /// English detail for the logs; never shown to the user.
    pub message: String,
}

/// Stable error codes and their HTTP statuses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// 400: malformed JSON or a bad field outside the changes (`device_name`). A change that
    /// fails [`Change::validate`] does **not** fail the request: it is listed in
    /// [`SyncResponse::rejected`].
    BadRequest,
    /// 401: wrong password, missing, unknown or revoked token.
    Unauthorized,
    /// 429: too many failed logins, or a login already being checked (see docs/SYNC.md § 4.3).
    RateLimited,
    /// 400: `protocol` differs from [`PROTOCOL_VERSION`].
    UnsupportedProtocol,
    /// 413: body above the limit.
    PayloadTooLarge,
    /// 409: signup with an address that already has an account.
    EmailTaken,
    /// 400: password too short.
    WeakPassword,
    /// 400: address that is not `x@y.z` or longer than 254 characters.
    BadEmail,
    /// 403: `POST /api/signup` on a server that closed account creation (`TAIDO_SIGNUPS=closed`).
    SignupsClosed,
    /// 400: reset code wrong, expired or used up.
    InvalidCode,
    /// 503: the server has no e-mail sending configured.
    MailUnavailable,
    /// 413: a file above the per-file limit ([`DEFAULT_MAX_FILE_BYTES`] by default).
    FileTooLarge,
    /// 507: the account would exceed its storage quota ([`DEFAULT_ACCOUNT_QUOTA_BYTES`] by
    /// default).
    QuotaExceeded,
    /// 404: no such attachment (or not a live attachment of this account), or no such file.
    NotFound,
    /// 400: the finished file does not match the attachment's `sha256`; nothing is kept.
    HashMismatch,
    /// 409: an upload chunk does not start at the number of bytes already received; the
    /// client reads the file status again and resumes from `received`.
    ChunkOffset,
    /// 500.
    Internal,
}

impl ErrorCode {
    pub fn http_status(self) -> u16 {
        match self {
            ErrorCode::BadRequest
            | ErrorCode::UnsupportedProtocol
            | ErrorCode::WeakPassword
            | ErrorCode::BadEmail
            | ErrorCode::InvalidCode
            | ErrorCode::HashMismatch => 400,
            ErrorCode::Unauthorized => 401,
            ErrorCode::SignupsClosed => 403,
            ErrorCode::NotFound => 404,
            ErrorCode::EmailTaken | ErrorCode::ChunkOffset => 409,
            ErrorCode::PayloadTooLarge | ErrorCode::FileTooLarge => 413,
            ErrorCode::QuotaExceeded => 507,
            ErrorCode::MailUnavailable => 503,
            ErrorCode::RateLimited => 429,
            ErrorCode::Internal => 500,
        }
    }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/// A refused change (maps to [`ErrorCode::BadRequest`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtoError(pub String);

impl ProtoError {
    fn new(message: impl Into<String>) -> Self {
        ProtoError(message.into())
    }
}

impl fmt::Display for ProtoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ProtoError {}

/// `YYYY-MM-DDTHH:MM:SS.sssZ` exactly (what `db::now_utc`, SQLite
/// `strftime('%Y-%m-%dT%H:%M:%fZ','now')` and JavaScript `Date.prototype.toISOString` give
/// for years 0000–9999), with plausible field ranges.
pub fn is_canonical_timestamp(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 24 {
        return false;
    }
    let digits = [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22];
    if !digits.iter().all(|&i| b[i].is_ascii_digit()) {
        return false;
    }
    let seps = [
        (4, b'-'),
        (7, b'-'),
        (10, b'T'),
        (13, b':'),
        (16, b':'),
        (19, b'.'),
        (23, b'Z'),
    ];
    if !seps.iter().all(|&(i, c)| b[i] == c) {
        return false;
    }
    let n = |i: usize| u32::from(b[i] - b'0') * 10 + u32::from(b[i + 1] - b'0');
    let (month, day, hour, minute, second) = (n(5), n(8), n(11), n(14), n(17));
    (1..=12).contains(&month)
        && (1..=31).contains(&day)
        && hour <= 23
        && minute <= 59
        && second <= 60
}

/// `YYYY-MM-DD`.
pub fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && [0, 1, 2, 3, 5, 6, 8, 9]
            .iter()
            .all(|&i| b[i].is_ascii_digit())
        && (1..=12).contains(&(u32::from(b[5] - b'0') * 10 + u32::from(b[6] - b'0')))
        && (1..=31).contains(&(u32::from(b[8] - b'0') * 10 + u32::from(b[9] - b'0')))
}

/// `HH:MM`, 00:00 to 23:59.
pub fn is_time(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && [0, 1, 3, 4].iter().all(|&i| b[i].is_ascii_digit())
        && (u32::from(b[0] - b'0') * 10 + u32::from(b[1] - b'0')) <= 23
        && (u32::from(b[3] - b'0') * 10 + u32::from(b[4] - b'0')) <= 59
}

/// Exactly 64 characters, each `0-9` or `a-f` (a SHA-256 digest, lowercase hexadecimal).
pub fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn check_id(field: &str, id: &str) -> Result<(), ProtoError> {
    if id.trim().is_empty() || id.len() > MAX_ID_LEN {
        return Err(ProtoError::new(format!(
            "{field} must be 1 to {MAX_ID_LEN} bytes"
        )));
    }
    Ok(())
}

fn check_opt_id(field: &str, id: Option<&str>) -> Result<(), ProtoError> {
    id.map_or(Ok(()), |id| check_id(field, id))
}

fn check_stamp(field: &str, value: Option<&str>) -> Result<(), ProtoError> {
    match value {
        Some(v) if v.is_empty() || v.len() > MAX_STAMP_LEN => Err(ProtoError::new(format!(
            "{field} must be 1 to {MAX_STAMP_LEN} bytes"
        ))),
        _ => Ok(()),
    }
}

/// The file name and optional hash of an attachment or a page image.
fn check_file(file_name: &str, sha256: Option<&str>) -> Result<(), ProtoError> {
    if file_name.trim().is_empty()
        || file_name.len() > MAX_FILE_NAME_BYTES
        || file_name.contains(['/', '\\'])
    {
        return Err(ProtoError::new(
            "file_name must be 1 to 255 bytes without / or \\",
        ));
    }
    if let Some(hash) = sha256 {
        if !is_sha256_hex(hash) {
            return Err(ProtoError::new(
                "sha256 must be 64 lowercase hexadecimal characters",
            ));
        }
    }
    Ok(())
}

fn check_position(position: f64) -> Result<(), ProtoError> {
    if position.is_finite() {
        Ok(())
    } else {
        Err(ProtoError::new("position must be a finite number"))
    }
}

/// `[a-z0-9_]`, 1 to [`MAX_SETTING_KEY_LEN`] bytes.
pub fn is_setting_key(key: &str) -> bool {
    (1..=MAX_SETTING_KEY_LEN).contains(&key.len())
        && key
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// Key shape, value size, and the value type of the known keys. Unknown keys are accepted as
/// is (forward compatible within a protocol version).
fn check_setting(key: &str, value: &serde_json::Value) -> Result<(), ProtoError> {
    if !is_setting_key(key) {
        return Err(ProtoError::new(format!("bad setting key: {key:?}")));
    }
    let size = serde_json::to_string(value)
        .map_err(|e| ProtoError::new(format!("setting value: {e}")))?
        .len();
    if size > MAX_SETTING_VALUE_BYTES {
        return Err(ProtoError::new("setting value is too large"));
    }
    if key == SETTING_INBOX_POSITION && !value.as_f64().is_some_and(f64::is_finite) {
        return Err(ProtoError::new("inbox_position must be a number"));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
