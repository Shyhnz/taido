//! Local rows ↔ wire data (docs/SYNC.md § 2.1): synced columns only. Local-only columns
//! (`root_path`, `subpath`, `workdir_override`, `time_segments.agent_session_id`,
//! `attachments.stored_path` once the row exists, `attachments.remote` except as the file
//! job's hint below) are never read nor written here.

use rusqlite::{params, Connection, OptionalExtension};
use sync_proto::{
    AttachmentData, BoardColumnData, Entity, NoteAttachmentData, NoteGroupData, NotePageData,
    RelationData, RelationKind, SectionData, SegmentSource, SettingData, SubjectData, TaskData,
    TimeSegmentData,
};

use crate::db::attachments::{self, AttachmentOwner, FreedFile};
use crate::error::{AppError, AppResult};

pub fn subject(conn: &Connection, id: &str) -> AppResult<Option<SubjectData>> {
    Ok(conn
        .query_row(
            "SELECT name, color, parent_id, position, created_at, deleted_at, is_group \
             FROM subjects WHERE id = ?1",
            [id],
            |r| {
                Ok(SubjectData {
                    name: r.get(0)?,
                    color: r.get(1)?,
                    parent_id: r.get(2)?,
                    position: r.get(3)?,
                    created_at: r.get(4)?,
                    deleted_at: r.get(5)?,
                    is_group: r.get(6)?,
                })
            },
        )
        .optional()?)
}

pub fn section(conn: &Connection, id: &str) -> AppResult<Option<SectionData>> {
    Ok(conn
        .query_row(
            "SELECT subject_id, name, position, created_at FROM sections WHERE id = ?1",
            [id],
            |r| {
                Ok(SectionData {
                    subject_id: r.get(0)?,
                    name: r.get(1)?,
                    position: r.get(2)?,
                    created_at: r.get(3)?,
                })
            },
        )
        .optional()?)
}

pub fn task(conn: &Connection, id: &str) -> AppResult<Option<TaskData>> {
    Ok(conn
        .query_row(
            "SELECT subject_id, section_id, parent_id, title, description, due_date, due_time, \
             priority, completed_at, position, created_at, deleted_at, board_column_id \
             FROM tasks WHERE id = ?1",
            [id],
            |r| {
                Ok(TaskData {
                    subject_id: r.get(0)?,
                    section_id: r.get(1)?,
                    parent_id: r.get(2)?,
                    title: r.get(3)?,
                    description: r.get(4)?,
                    due_date: r.get(5)?,
                    due_time: r.get(6)?,
                    priority: r.get(7)?,
                    completed_at: r.get(8)?,
                    position: r.get(9)?,
                    created_at: r.get(10)?,
                    deleted_at: r.get(11)?,
                    board_column_id: r.get(12)?,
                })
            },
        )
        .optional()?)
}

/// A shared setting (`synced_settings`); an unreadable stored value reads as `None` (logged).
pub fn setting(conn: &Connection, key: &str) -> AppResult<Option<SettingData>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM synced_settings WHERE key = ?1",
            [key],
            |r| r.get(0),
        )
        .optional()?;
    Ok(raw.and_then(|v| match serde_json::from_str(&v) {
        Ok(value) => Some(SettingData { value }),
        Err(e) => {
            log::warn!("sync: unreadable setting {key}: {e}");
            None
        }
    }))
}

pub fn board_column(conn: &Connection, id: &str) -> AppResult<Option<BoardColumnData>> {
    Ok(conn
        .query_row(
            "SELECT subject_id, name, position, is_done, created_at FROM board_columns \
             WHERE id = ?1",
            [id],
            |r| {
                Ok(BoardColumnData {
                    subject_id: r.get(0)?,
                    name: r.get(1)?,
                    position: r.get(2)?,
                    is_done: r.get(3)?,
                    created_at: r.get(4)?,
                })
            },
        )
        .optional()?)
}

pub fn time_segment(conn: &Connection, id: &str) -> AppResult<Option<TimeSegmentData>> {
    Ok(conn
        .query_row(
            "SELECT task_id, source, started_at, ended_at, stop_reason, note, created_at, \
             deleted_at FROM time_segments WHERE id = ?1",
            [id],
            |r| {
                let source: String = r.get(1)?;
                Ok(TimeSegmentData {
                    task_id: r.get(0)?,
                    source: if source == "manual" {
                        SegmentSource::Manual
                    } else {
                        SegmentSource::Auto
                    },
                    started_at: r.get(2)?,
                    ended_at: r.get(3)?,
                    stop_reason: r.get(4)?,
                    note: r.get(5)?,
                    created_at: r.get(6)?,
                    deleted_at: r.get(7)?,
                })
            },
        )
        .optional()?)
}

pub fn relation(conn: &Connection, id: &str) -> AppResult<Option<RelationData>> {
    Ok(conn
        .query_row(
            "SELECT from_task_id, to_task_id, kind, created_at, deleted_at FROM task_relations \
             WHERE id = ?1",
            [id],
            |r| {
                let kind: String = r.get(2)?;
                Ok(RelationData {
                    from_task_id: r.get(0)?,
                    to_task_id: r.get(1)?,
                    kind: if kind == "relates_to" {
                        RelationKind::RelatesTo
                    } else {
                        RelationKind::Blocks
                    },
                    created_at: r.get(3)?,
                    deleted_at: r.get(4)?,
                })
            },
        )
        .optional()?)
}

/// An attachment's metadata, with the hash of its file when known (a malformed
/// local hash is not sent). Only a task's: a page image is a `note_attachment`.
pub fn attachment(conn: &Connection, id: &str) -> AppResult<Option<AttachmentData>> {
    Ok(
        file_row(conn, id, "task_id")?.map(|(task_id, f)| AttachmentData {
            task_id,
            file_name: f.file_name,
            mime_type: f.mime_type,
            size: f.size,
            sha256: f.sha256,
            created_at: f.created_at,
            deleted_at: f.deleted_at,
        }),
    )
}

/// A notebook page image's metadata (an `attachments` row owned by a page).
pub fn note_attachment(conn: &Connection, id: &str) -> AppResult<Option<NoteAttachmentData>> {
    Ok(
        file_row(conn, id, "note_page_id")?.map(|(note_page_id, f)| NoteAttachmentData {
            note_page_id,
            file_name: f.file_name,
            mime_type: f.mime_type,
            size: f.size,
            sha256: f.sha256,
            created_at: f.created_at,
            deleted_at: f.deleted_at,
        }),
    )
}

/// Synced columns of an `attachments` row, whoever owns it.
struct FileMeta {
    file_name: String,
    mime_type: String,
    size: u64,
    sha256: Option<String>,
    created_at: String,
    deleted_at: Option<String>,
}

/// The owner id (`owner` = `task_id` or `note_page_id`, a constant) and the synced columns of
/// the attachment `id` when that column is set.
fn file_row(conn: &Connection, id: &str, owner: &str) -> AppResult<Option<(String, FileMeta)>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {owner}, file_name, mime_type, size, created_at, deleted_at, sha256 \
                 FROM attachments WHERE id = ?1 AND {owner} IS NOT NULL"
            ),
            [id],
            |r| {
                Ok((
                    r.get(0)?,
                    FileMeta {
                        file_name: r.get(1)?,
                        mime_type: r.get(2)?,
                        size: u64::try_from(r.get::<_, i64>(3)?).unwrap_or(0),
                        sha256: r
                            .get::<_, Option<String>>(6)?
                            .filter(|h| sync_proto::is_sha256_hex(h)),
                        created_at: r.get(4)?,
                        deleted_at: r.get(5)?,
                    },
                ))
            },
        )
        .optional()?)
}

pub fn note_group(conn: &Connection, id: &str) -> AppResult<Option<NoteGroupData>> {
    Ok(conn
        .query_row(
            "SELECT subject_id, name, position, created_at FROM note_groups WHERE id = ?1",
            [id],
            |r| {
                Ok(NoteGroupData {
                    subject_id: r.get(0)?,
                    name: r.get(1)?,
                    position: r.get(2)?,
                    created_at: r.get(3)?,
                })
            },
        )
        .optional()?)
}

pub fn note_page(conn: &Connection, id: &str) -> AppResult<Option<NotePageData>> {
    Ok(conn
        .query_row(
            "SELECT subject_id, group_id, kind, title, body, source_task_id, pinned_at, \
             position, created_at, deleted_at FROM note_pages WHERE id = ?1",
            [id],
            |r| {
                Ok(NotePageData {
                    subject_id: r.get(0)?,
                    group_id: r.get(1)?,
                    kind: r.get(2)?,
                    title: r.get(3)?,
                    body: r.get(4)?,
                    source_task_id: r.get(5)?,
                    pinned_at: r.get(6)?,
                    position: r.get(7)?,
                    created_at: r.get(8)?,
                    deleted_at: r.get(9)?,
                })
            },
        )
        .optional()?)
}

fn source_str(source: SegmentSource) -> &'static str {
    match source {
        SegmentSource::Auto => "auto",
        SegmentSource::Manual => "manual",
    }
}

fn kind_str(kind: RelationKind) -> &'static str {
    match kind {
        RelationKind::Blocks => "blocks",
        RelationKind::RelatesTo => "relates_to",
    }
}

/// The row exists locally (soft-deleted rows count).
pub fn exists(conn: &Connection, entity: Entity, id: &str) -> AppResult<bool> {
    let sql = match entity {
        Entity::Subject => "SELECT 1 FROM subjects WHERE id = ?1",
        Entity::Section => "SELECT 1 FROM sections WHERE id = ?1",
        Entity::Task => "SELECT 1 FROM tasks WHERE id = ?1",
        Entity::Setting => "SELECT 1 FROM synced_settings WHERE key = ?1",
        Entity::BoardColumn => "SELECT 1 FROM board_columns WHERE id = ?1",
        Entity::TimeSegment => "SELECT 1 FROM time_segments WHERE id = ?1",
        Entity::Relation => "SELECT 1 FROM task_relations WHERE id = ?1",
        Entity::Attachment => "SELECT 1 FROM attachments WHERE id = ?1 AND task_id IS NOT NULL",
        Entity::NoteGroup => "SELECT 1 FROM note_groups WHERE id = ?1",
        Entity::NotePage => "SELECT 1 FROM note_pages WHERE id = ?1",
        Entity::NoteAttachment => {
            "SELECT 1 FROM attachments WHERE id = ?1 AND note_page_id IS NOT NULL"
        }
    };
    Ok(conn.query_row(sql, [id], |_| Ok(())).optional()?.is_some())
}

/// Project of a section, when the section exists.
pub fn section_subject(conn: &Connection, id: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row("SELECT subject_id FROM sections WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .optional()?)
}

/// Writes a pulled subject: `INSERT … ON CONFLICT(id) DO UPDATE` of the synced columns, never
/// `INSERT OR REPLACE` (a REPLACE deletes first and the cascades would wipe the children).
pub fn upsert_subject(conn: &Connection, id: &str, stamp: &str, d: &SubjectData) -> AppResult<()> {
    conn.execute(
        "INSERT INTO subjects (id, name, color, parent_id, position, created_at, updated_at, \
         deleted_at, is_group) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, \
         parent_id = excluded.parent_id, position = excluded.position, \
         created_at = excluded.created_at, deleted_at = excluded.deleted_at, \
         is_group = excluded.is_group, updated_at = excluded.updated_at",
        params![
            id,
            d.name,
            d.color,
            d.parent_id,
            d.position,
            d.created_at,
            stamp,
            d.deleted_at,
            d.is_group
        ],
    )?;
    Ok(())
}

pub fn upsert_section(conn: &Connection, id: &str, stamp: &str, d: &SectionData) -> AppResult<()> {
    conn.execute(
        "INSERT INTO sections (id, subject_id, name, position, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT(id) DO UPDATE SET subject_id = excluded.subject_id, name = excluded.name, \
         position = excluded.position, created_at = excluded.created_at, \
         updated_at = excluded.updated_at",
        params![id, d.subject_id, d.name, d.position, d.created_at, stamp],
    )?;
    Ok(())
}

pub fn upsert_task(conn: &Connection, id: &str, stamp: &str, d: &TaskData) -> AppResult<()> {
    conn.execute(
        "INSERT INTO tasks (id, subject_id, section_id, parent_id, title, description, \
         due_date, due_time, priority, completed_at, position, created_at, updated_at, \
         deleted_at, board_column_id) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15) \
         ON CONFLICT(id) DO UPDATE SET subject_id = excluded.subject_id, \
         section_id = excluded.section_id, parent_id = excluded.parent_id, \
         title = excluded.title, description = excluded.description, \
         due_date = excluded.due_date, due_time = excluded.due_time, \
         priority = excluded.priority, completed_at = excluded.completed_at, \
         position = excluded.position, created_at = excluded.created_at, \
         deleted_at = excluded.deleted_at, board_column_id = excluded.board_column_id, \
         updated_at = excluded.updated_at",
        params![
            id,
            d.subject_id,
            d.section_id,
            d.parent_id,
            d.title,
            d.description,
            d.due_date,
            d.due_time,
            d.priority,
            d.completed_at,
            d.position,
            d.created_at,
            stamp,
            d.deleted_at,
            d.board_column_id
        ],
    )?;
    Ok(())
}

/// Writes a pulled setting (last writer wins was decided by the server).
pub fn upsert_setting(conn: &Connection, key: &str, stamp: &str, d: &SettingData) -> AppResult<()> {
    let json = serde_json::to_string(&d.value)
        .map_err(|e| AppError::Internal(format!("cannot serialize setting {key}: {e}")))?;
    conn.execute(
        "INSERT INTO synced_settings (key, value, updated_at) VALUES (?1, ?2, ?3) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, json, stamp],
    )?;
    Ok(())
}

pub fn upsert_board_column(
    conn: &Connection,
    id: &str,
    stamp: &str,
    d: &BoardColumnData,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO board_columns (id, subject_id, name, position, is_done, created_at, \
         updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT(id) DO UPDATE SET subject_id = excluded.subject_id, name = excluded.name, \
         position = excluded.position, is_done = excluded.is_done, \
         created_at = excluded.created_at, updated_at = excluded.updated_at",
        params![
            id,
            d.subject_id,
            d.name,
            d.position,
            d.is_done,
            d.created_at,
            stamp
        ],
    )?;
    Ok(())
}

/// Never writes `agent_session_id` (local-only: a new row gets `NULL`, a known one keeps it),
/// except to drop it when a pulled version runs again a segment stopped here while this Mac
/// already runs a newer one on the task: that row is then no longer its own and can never
/// violate `idx_segments_open` (docs/SYNC.md § 0.8). Without a newer one, it stays this Mac's
/// (its chrono closes it as usual).
pub fn upsert_time_segment(
    conn: &Connection,
    id: &str,
    stamp: &str,
    d: &TimeSegmentData,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO time_segments (id, task_id, source, started_at, ended_at, stop_reason, \
         note, created_at, updated_at, deleted_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) \
         ON CONFLICT(id) DO UPDATE SET task_id = excluded.task_id, source = excluded.source, \
         started_at = excluded.started_at, ended_at = excluded.ended_at, \
         stop_reason = excluded.stop_reason, note = excluded.note, \
         created_at = excluded.created_at, deleted_at = excluded.deleted_at, \
         updated_at = excluded.updated_at, \
         agent_session_id = CASE WHEN excluded.ended_at IS NULL \
           AND time_segments.ended_at IS NOT NULL \
           AND EXISTS (SELECT 1 FROM time_segments o WHERE o.task_id = excluded.task_id \
             AND o.id <> excluded.id AND o.ended_at IS NULL AND o.deleted_at IS NULL \
             AND o.agent_session_id IS NOT NULL) THEN NULL \
           ELSE time_segments.agent_session_id END",
        params![
            id,
            d.task_id,
            source_str(d.source),
            d.started_at,
            d.ended_at,
            d.stop_reason,
            d.note,
            d.created_at,
            stamp,
            d.deleted_at
        ],
    )?;
    Ok(())
}

pub fn upsert_relation(
    conn: &Connection,
    id: &str,
    stamp: &str,
    d: &RelationData,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO task_relations (id, from_task_id, to_task_id, kind, created_at, \
         updated_at, deleted_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT(id) DO UPDATE SET from_task_id = excluded.from_task_id, \
         to_task_id = excluded.to_task_id, kind = excluded.kind, \
         created_at = excluded.created_at, deleted_at = excluded.deleted_at, \
         updated_at = excluded.updated_at",
        params![
            id,
            d.from_task_id,
            d.to_task_id,
            kind_str(d.kind),
            d.created_at,
            stamp,
            d.deleted_at
        ],
    )?;
    Ok(())
}

/// A live relation with the same tasks and kind as `d` but another id, in either direction:
/// the local unique index allows one per direction, and `relations::add` one per pair (a
/// « Liée à » is symmetric; A blocks B with B blocks A would block both forever).
pub fn twin_relation(conn: &Connection, id: &str, d: &RelationData) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM task_relations WHERE ((from_task_id = ?1 AND to_task_id = ?2) \
             OR (from_task_id = ?2 AND to_task_id = ?1)) \
             AND kind = ?3 AND deleted_at IS NULL AND id <> ?4 ORDER BY id LIMIT 1",
            params![d.from_task_id, d.to_task_id, kind_str(d.kind), id],
            |r| r.get(0),
        )
        .optional()?)
}

/// `stored_path` is local-only: a new row points into this Mac's attachment folder of the
/// task, always absolute and never at another attachment's path (`attachments::pulled_path`;
/// no file is made: the file job downloads it there); a known row keeps its own.
///
/// The pulled `sha256` is stored (a version without one keeps the local hash: the
/// whole-row "last writer wins" must not erase it). `remote` (local-only) is the file job's
/// hint: a new row is `missing` (its file is elsewhere); a live version whose hash differs
/// from the local one is `missing` too (a file's content never changes once sent: the copy
/// here is not that file, the job fetches it next to it and never over it); a live version of
/// a row this Mac had sent, or had deleted, is `local` again, so that the job checks the
/// server still has its file (a restored attachment lost it) and sends it back from here when
/// needed.
///
/// `shared` (local-only): a new row came from another device, so its file may be elsewhere
/// (1); a pulled hash that is not the local one names another device's content (1); else it
/// stays.
///
/// Returns the file of a live attachment this version deletes, with the local hash (what the
/// copy here should be): it goes once the transaction is committed, while it is still that
/// file (`attachments::remove_freed`).
pub fn upsert_attachment(
    conn: &Connection,
    id: &str,
    stamp: &str,
    d: &AttachmentData,
) -> AppResult<Option<FreedFile>> {
    let meta = FileMeta {
        file_name: d.file_name.clone(),
        mime_type: d.mime_type.clone(),
        size: d.size,
        sha256: d.sha256.clone(),
        created_at: d.created_at.clone(),
        deleted_at: d.deleted_at.clone(),
    };
    upsert_file_row(conn, id, stamp, AttachmentOwner::Task(&d.task_id), &meta)
}

/// [`upsert_attachment`] for a notebook page's image: same rules; a new row points into the
/// page's folder (`<project>/Notes`, or the folder of its other images).
pub fn upsert_note_attachment(
    conn: &Connection,
    id: &str,
    stamp: &str,
    d: &NoteAttachmentData,
) -> AppResult<Option<FreedFile>> {
    let meta = FileMeta {
        file_name: d.file_name.clone(),
        mime_type: d.mime_type.clone(),
        size: d.size,
        sha256: d.sha256.clone(),
        created_at: d.created_at.clone(),
        deleted_at: d.deleted_at.clone(),
    };
    upsert_file_row(
        conn,
        id,
        stamp,
        AttachmentOwner::NotePage(&d.note_page_id),
        &meta,
    )
}

fn upsert_file_row(
    conn: &Connection,
    id: &str,
    stamp: &str,
    owner: AttachmentOwner<'_>,
    d: &FileMeta,
) -> AppResult<Option<FreedFile>> {
    let (owner_column, owner_id) = match owner {
        AttachmentOwner::Task(task_id) => ("task_id", task_id),
        AttachmentOwner::NotePage(page_id) => ("note_page_id", page_id),
    };
    let local: Option<(String, bool, Option<String>)> = conn
        .query_row(
            "SELECT stored_path, deleted_at IS NULL, sha256 FROM attachments WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let stored_path = match &local {
        Some(_) => String::new(), // not written: ON CONFLICT keeps the row's own path
        None => attachments::pulled_path(conn, owner, &d.file_name)?
            .to_string_lossy()
            .into_owned(),
    };
    let size = i64::try_from(d.size).unwrap_or(i64::MAX);
    let sha256 = d.sha256.as_deref().filter(|h| sync_proto::is_sha256_hex(h));
    conn.execute(
        &format!(
            "INSERT INTO attachments (id, {owner_column}, file_name, stored_path, mime_type, \
             size, created_at, updated_at, deleted_at, sha256, remote, shared) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'missing', 1) \
             ON CONFLICT(id) DO UPDATE SET {owner_column} = excluded.{owner_column}, \
             file_name = excluded.file_name, mime_type = excluded.mime_type, \
             size = excluded.size, created_at = excluded.created_at, \
             deleted_at = excluded.deleted_at, updated_at = excluded.updated_at, \
             shared = CASE WHEN excluded.sha256 IS NOT NULL \
               AND excluded.sha256 IS NOT attachments.sha256 THEN 1 ELSE attachments.shared END, \
             sha256 = COALESCE(excluded.sha256, attachments.sha256), \
             remote = CASE WHEN excluded.deleted_at IS NULL AND excluded.sha256 IS NOT NULL \
               AND attachments.sha256 IS NOT NULL AND excluded.sha256 <> attachments.sha256 \
               THEN 'missing' WHEN excluded.deleted_at IS NULL \
               AND (attachments.remote = 'sent' OR attachments.deleted_at IS NOT NULL) \
               THEN 'local' ELSE attachments.remote END"
        ),
        params![
            id,
            owner_id,
            d.file_name,
            stored_path,
            d.mime_type,
            size,
            d.created_at,
            stamp,
            d.deleted_at,
            sha256
        ],
    )?;
    Ok(match local {
        Some((path, true, sha256)) if d.deleted_at.is_some() => Some(FreedFile {
            id: id.to_string(),
            path,
            sha256,
        }),
        _ => None,
    })
}

pub fn upsert_note_group(
    conn: &Connection,
    id: &str,
    stamp: &str,
    d: &NoteGroupData,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO note_groups (id, subject_id, name, position, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT(id) DO UPDATE SET subject_id = excluded.subject_id, name = excluded.name, \
         position = excluded.position, created_at = excluded.created_at, \
         updated_at = excluded.updated_at",
        params![id, d.subject_id, d.name, d.position, d.created_at, stamp],
    )?;
    Ok(())
}

pub fn upsert_note_page(
    conn: &Connection,
    id: &str,
    stamp: &str,
    d: &NotePageData,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO note_pages (id, subject_id, group_id, kind, title, body, source_task_id, \
         pinned_at, position, created_at, updated_at, deleted_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) \
         ON CONFLICT(id) DO UPDATE SET subject_id = excluded.subject_id, \
         group_id = excluded.group_id, kind = excluded.kind, title = excluded.title, \
         body = excluded.body, source_task_id = excluded.source_task_id, \
         pinned_at = excluded.pinned_at, position = excluded.position, \
         created_at = excluded.created_at, deleted_at = excluded.deleted_at, \
         updated_at = excluded.updated_at",
        params![
            id,
            d.subject_id,
            d.group_id,
            d.kind,
            d.title,
            d.body,
            d.source_task_id,
            d.pinned_at,
            d.position,
            d.created_at,
            stamp,
            d.deleted_at
        ],
    )?;
    Ok(())
}

/// Project of a notebook group, when the group exists.
pub fn note_group_subject(conn: &Connection, id: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT subject_id FROM note_groups WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .optional()?)
}

/// The file of an attachment (soft-deleted rows count: stored path and hash), before the sync
/// deletes the row.
pub fn attachment_file(conn: &Connection, id: &str) -> AppResult<Option<FreedFile>> {
    Ok(conn
        .query_row(
            "SELECT stored_path, sha256 FROM attachments WHERE id = ?1",
            [id],
            |r| {
                Ok(FreedFile {
                    id: id.to_string(),
                    path: r.get(0)?,
                    sha256: r.get(1)?,
                })
            },
        )
        .optional()?)
}

/// Hard-deletes one row (the cascades follow).
pub fn delete(conn: &Connection, entity: Entity, id: &str) -> AppResult<()> {
    let sql = match entity {
        Entity::Subject => "DELETE FROM subjects WHERE id = ?1",
        Entity::Section => "DELETE FROM sections WHERE id = ?1",
        Entity::Task => "DELETE FROM tasks WHERE id = ?1",
        // Never reached by the sync: a setting tombstone is invalid (no delete).
        Entity::Setting => "DELETE FROM synced_settings WHERE key = ?1",
        Entity::BoardColumn => "DELETE FROM board_columns WHERE id = ?1",
        Entity::TimeSegment => "DELETE FROM time_segments WHERE id = ?1",
        Entity::Relation => "DELETE FROM task_relations WHERE id = ?1",
        Entity::Attachment => "DELETE FROM attachments WHERE id = ?1 AND task_id IS NOT NULL",
        Entity::NoteGroup => "DELETE FROM note_groups WHERE id = ?1",
        Entity::NotePage => "DELETE FROM note_pages WHERE id = ?1",
        Entity::NoteAttachment => {
            "DELETE FROM attachments WHERE id = ?1 AND note_page_id IS NOT NULL"
        }
    };
    conn.execute(sql, [id])?;
    Ok(())
}

/// Recursion bound of the tree queries: a cycle pulled before the normalisation must not
/// loop (real trees are one or two levels deep).
const MAX_DEPTH: i64 = 64;

/// Ids of a task's descendants (child tasks, recursively), deepest first, without the task.
pub fn task_descendants(conn: &Connection, id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE d(id, depth) AS (SELECT id, 1 FROM tasks WHERE parent_id = ?1 \
         UNION SELECT t.id, d.depth + 1 FROM tasks t JOIN d ON t.parent_id = d.id \
         WHERE d.depth < ?2) \
         SELECT id FROM d WHERE id <> ?1 GROUP BY id ORDER BY MAX(depth) DESC, id",
    )?;
    let ids = stmt
        .query_map(params![id, MAX_DEPTH], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(ids)
}

/// A subject and its sub-projects (recursively), deepest first: the subject comes last.
pub fn subject_tree(conn: &Connection, id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE d(id, depth) AS (SELECT ?1, 0 UNION SELECT s.id, d.depth + 1 \
         FROM subjects s JOIN d ON s.parent_id = d.id WHERE d.depth < ?2) \
         SELECT id FROM d GROUP BY id ORDER BY id = ?1, MAX(depth) DESC, id",
    )?;
    let ids = stmt
        .query_map(params![id, MAX_DEPTH], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(ids)
}

/// Tasks of these subjects and their child tasks (recursively, wherever the children are),
/// deepest first.
pub fn tasks_of_subjects(conn: &Connection, subject_ids: &[String]) -> AppResult<Vec<String>> {
    let mut depths: Vec<(String, i64)> = Vec::new();
    let mut stmt = conn.prepare(
        "WITH RECURSIVE d(id, depth) AS (SELECT id, 0 FROM tasks WHERE subject_id = ?1 \
         UNION SELECT t.id, d.depth + 1 FROM tasks t JOIN d ON t.parent_id = d.id \
         WHERE d.depth < ?2) SELECT id, MAX(depth) FROM d GROUP BY id",
    )?;
    for subject in subject_ids {
        let found: Vec<(String, i64)> = stmt
            .query_map(params![subject, MAX_DEPTH], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        for (id, depth) in found {
            match depths.iter_mut().find(|(known, _)| *known == id) {
                Some(entry) => entry.1 = entry.1.max(depth),
                None => depths.push((id, depth)),
            }
        }
    }
    depths.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    Ok(depths.into_iter().map(|(id, _)| id).collect())
}

/// Sections of these subjects.
pub fn sections_of_subjects(conn: &Connection, subject_ids: &[String]) -> AppResult<Vec<String>> {
    let mut out = Vec::new();
    let mut stmt = conn.prepare("SELECT id FROM sections WHERE subject_id = ?1")?;
    for subject in subject_ids {
        let ids: Vec<String> = stmt
            .query_map([subject], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        out.extend(ids);
    }
    Ok(out)
}

/// Rows hanging on these tasks: their segments, relations (either side) and attachments.
pub fn rows_of_tasks(conn: &Connection, task_ids: &[String]) -> AppResult<Vec<(Entity, String)>> {
    let mut out: Vec<(Entity, String)> = Vec::new();
    for (entity, sql) in [
        (
            Entity::Attachment,
            "SELECT id FROM attachments WHERE task_id = ?1 ORDER BY id",
        ),
        (
            Entity::Relation,
            "SELECT id FROM task_relations WHERE from_task_id = ?1 OR to_task_id = ?1 \
             ORDER BY id",
        ),
        (
            Entity::TimeSegment,
            "SELECT id FROM time_segments WHERE task_id = ?1 ORDER BY id",
        ),
    ] {
        let mut stmt = conn.prepare(sql)?;
        for task in task_ids {
            let ids: Vec<String> = stmt
                .query_map([task], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            for id in ids {
                if !out.iter().any(|(e, known)| *e == entity && *known == id) {
                    out.push((entity, id));
                }
            }
        }
    }
    Ok(out)
}

/// Notebook groups and pages of these subjects, pages first.
pub fn notebook_of_subjects(
    conn: &Connection,
    subject_ids: &[String],
) -> AppResult<Vec<(Entity, String)>> {
    let mut out: Vec<(Entity, String)> = Vec::new();
    for (entity, sql) in [
        (
            Entity::NotePage,
            "SELECT id FROM note_pages WHERE subject_id = ?1 ORDER BY id",
        ),
        (
            Entity::NoteGroup,
            "SELECT id FROM note_groups WHERE subject_id = ?1 ORDER BY id",
        ),
    ] {
        let mut stmt = conn.prepare(sql)?;
        for subject in subject_ids {
            let ids: Vec<String> = stmt
                .query_map([subject], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            out.extend(ids.into_iter().map(|id| (entity, id)));
        }
    }
    Ok(out)
}

/// Images of these notebook pages.
pub fn images_of_pages(conn: &Connection, page_ids: &[String]) -> AppResult<Vec<String>> {
    let mut out = Vec::new();
    let mut stmt =
        conn.prepare("SELECT id FROM attachments WHERE note_page_id = ?1 ORDER BY id")?;
    for page in page_ids {
        let ids: Vec<String> = stmt
            .query_map([page], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        out.extend(ids);
    }
    Ok(out)
}

/// Kanban columns of these subjects.
pub fn columns_of_subjects(conn: &Connection, subject_ids: &[String]) -> AppResult<Vec<String>> {
    let mut out = Vec::new();
    let mut stmt =
        conn.prepare("SELECT id FROM board_columns WHERE subject_id = ?1 ORDER BY id")?;
    for subject in subject_ids {
        let ids: Vec<String> = stmt
            .query_map([subject], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        out.extend(ids);
    }
    Ok(out)
}
