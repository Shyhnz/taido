//! Applying pulled rows (docs/SYNC.md § 2.5): groups in parent-before-child order with an
//! in-group retry, parking of rows whose parent is missing, UPSERT of the synced columns,
//! tombstones that first delete their uncovered local descendants as local changes, then the
//! normalisation (`normalize`). Runs inside the caller's transaction.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};
use sync_proto::{Change, ChangeKey, Entity, RelationData, Versioned};

use crate::db::attachments::FreedFile;
use crate::db::now_utc;
use crate::error::{AppError, AppResult};
use crate::sync::{normalize, rows, store};

/// What an apply did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ApplyOutcome {
    /// Rows written or deleted from the server's versions.
    pub applied: usize,
    /// Rows parked at the end (waiting for a parent).
    pub parked: usize,
    /// Corrections made by the normalisation (queued as local changes).
    pub corrected: usize,
    /// Files of the attachments this apply deleted (soft delete or tombstone): they
    /// are removed once the transaction is committed, when no live attachment points at them
    /// and they are still the attachment's file.
    pub freed_files: Vec<FreedFile>,
}

/// Applies `pulled` (in the server's order) merged with the parked rows. Keys in `skip` (rows
/// with a pending local change) are not applied; their parked versions are dropped.
pub fn apply(
    conn: &Connection,
    pulled: Vec<Change>,
    skip: &HashSet<ChangeKey>,
) -> AppResult<ApplyOutcome> {
    let rows = merge_with_parked(conn, pulled, skip)?;
    conn.execute("DELETE FROM sync_parked", [])?;

    let mut groups: [Vec<Change>; 9] = Default::default();
    let mut tombstones = Vec::new();
    for change in rows {
        match group_of(&change) {
            Some(g) => groups[g].push(change),
            None => tombstones.push(change),
        }
    }

    let mut outcome = ApplyOutcome::default();
    let mut parked = Vec::new();
    // Tasks applied without their missing section or column, kept to be applied again once
    // it is here.
    let mut waiting = Vec::new();
    store::set_applying(conn, true)?;
    let result = (|| -> AppResult<()> {
        for group in groups {
            let mut pending = group;
            loop {
                let before = pending.len();
                let mut missing = Vec::new();
                for change in pending {
                    match write_row(conn, &change, &mut outcome.freed_files)? {
                        Written::Yes => outcome.applied += 1,
                        Written::Missing => missing.push(change),
                        Written::Waiting { written } => {
                            if written {
                                outcome.applied += 1;
                            }
                            waiting.push(change);
                        }
                    }
                }
                pending = missing;
                if pending.is_empty() || pending.len() == before {
                    break;
                }
            }
            parked.extend(pending);
        }
        tombstones.sort_by_key(|c| tombstone_rank(conn, c));
        let covered: HashSet<ChangeKey> = tombstones.iter().map(Change::key).collect();
        for change in &tombstones {
            if apply_tombstone(conn, change, &covered, &mut outcome.freed_files)? {
                outcome.applied += 1;
            }
        }
        Ok(())
    })();
    // The flag must never stay on, even when the transaction is rolled back by the caller.
    store::set_applying(conn, false)?;
    result?;

    for change in parked.iter().chain(&waiting) {
        let json = serde_json::to_string(change)
            .map_err(|e| AppError::Internal(format!("cannot serialize a parked row: {e}")))?;
        conn.execute(
            "INSERT INTO sync_parked (entity, id, change) VALUES (?1, ?2, ?3) \
             ON CONFLICT (entity, id) DO UPDATE SET change = excluded.change",
            params![change.entity().as_str(), change.id(), json],
        )?;
    }
    for change in &parked {
        log::info!(
            "sync: parked {} {} (its parent is not here yet)",
            change.entity().as_str(),
            change.id()
        );
    }
    outcome.parked = parked.len();
    outcome.corrected = normalize::normalize(conn)?;
    Ok(outcome)
}

/// Parked rows first, a pulled version of the same key replacing the parked one; skipped and
/// invalid rows removed. A parked row whose key has an outbox entry (a local change, pending
/// or just sent) is dropped: the local change goes out, and the server sends its own version
/// back when that one wins (§ 2.4 step 5).
fn merge_with_parked(
    conn: &Connection,
    pulled: Vec<Change>,
    skip: &HashSet<ChangeKey>,
) -> AppResult<Vec<Change>> {
    let mut stmt = conn.prepare(
        "SELECT p.entity, p.id, p.change FROM sync_parked p WHERE NOT EXISTS \
         (SELECT 1 FROM sync_outbox o WHERE o.entity = p.entity AND o.id = p.id)",
    )?;
    let stored: Vec<(String, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    let mut out: Vec<Change> = Vec::new();
    let mut index: HashMap<ChangeKey, usize> = HashMap::new();
    for (entity, id, json) in stored {
        match serde_json::from_str::<Change>(&json) {
            Ok(change) => {
                index.insert(change.key(), out.len());
                out.push(change);
            }
            Err(e) => log::warn!("sync: dropping unreadable parked row {entity} {id}: {e}"),
        }
    }
    for change in pulled {
        match index.get(&change.key()) {
            Some(&i) => out[i] = change,
            None => {
                index.insert(change.key(), out.len());
                out.push(change);
            }
        }
    }
    Ok(out
        .into_iter()
        .filter(|c| {
            if skip.contains(&c.key()) {
                return false;
            }
            match c.validate() {
                Ok(()) => true,
                Err(e) => {
                    log::warn!(
                        "sync: ignoring invalid pulled {} {}: {e}",
                        c.entity().as_str(),
                        c.id()
                    );
                    false
                }
            }
        })
        .collect())
}

/// Group 0–8 of a data row (§ 2.5 and protocol 3): settings (they reference nothing),
/// projects, sub-projects, sections and notebook groups, Kanban columns, tasks, child tasks,
/// notebook pages (a summary names its task), then the rows that hang on tasks or pages
/// (segments, relations, attachments, page images). `None` for a tombstone (applied last).
fn group_of(change: &Change) -> Option<usize> {
    match change {
        Change::Setting(Versioned { data: Some(_), .. }) => Some(0),
        Change::Subject(Versioned { data: Some(d), .. }) => {
            Some(if d.parent_id.is_none() { 1 } else { 2 })
        }
        Change::Section(Versioned { data: Some(_), .. })
        | Change::NoteGroup(Versioned { data: Some(_), .. }) => Some(3),
        Change::BoardColumn(Versioned { data: Some(_), .. }) => Some(4),
        Change::Task(Versioned { data: Some(d), .. }) => {
            Some(if d.parent_id.is_none() { 5 } else { 6 })
        }
        Change::NotePage(Versioned { data: Some(_), .. }) => Some(7),
        Change::TimeSegment(Versioned { data: Some(_), .. })
        | Change::Relation(Versioned { data: Some(_), .. })
        | Change::Attachment(Versioned { data: Some(_), .. })
        | Change::NoteAttachment(Versioned { data: Some(_), .. }) => Some(8),
        _ => None,
    }
}

/// Tombstone order: attachments and page images, relations, segments, notebook pages, tasks
/// with a parent, tasks, sections, notebook groups, columns, sub-projects, projects (the
/// parent is read locally: a tombstone carries no data).
fn tombstone_rank(conn: &Connection, change: &Change) -> u8 {
    let has_parent = |table: &str| -> bool {
        conn.query_row(
            &format!("SELECT parent_id IS NOT NULL FROM {table} WHERE id = ?1"),
            [change.id()],
            |r| r.get::<_, bool>(0),
        )
        .unwrap_or(false)
    };
    match change.entity() {
        Entity::Attachment | Entity::NoteAttachment => 0,
        Entity::Relation => 1,
        Entity::TimeSegment => 2,
        Entity::NotePage => 3,
        Entity::Task => {
            if has_parent("tasks") {
                4
            } else {
                5
            }
        }
        Entity::Section => 6,
        Entity::NoteGroup => 7,
        Entity::BoardColumn => 8,
        Entity::Subject => {
            if has_parent("subjects") {
                9
            } else {
                10
            }
        }
        // Never reached: a setting tombstone is invalid, dropped before the apply.
        Entity::Setting => 11,
    }
}

/// What [`write_row`] did.
enum Written {
    Yes,
    /// A reference is missing: the row is retried, then parked.
    Missing,
    /// A task whose section or Kanban column is not here (yet), or a notebook page whose group
    /// or summarised task is not: written without it (`written`, unless this version is
    /// already here so), and kept to be applied again when it arrives.
    Waiting {
        written: bool,
    },
}

/// Writes a data row when its references are present. A task whose section belongs to
/// another project is written without section; one whose section or column is missing too,
/// and waits for it (a later page, or a row parked behind its project). A task in another
/// project's column is corrected by the normalisation (N9). An attachment this version
/// deletes adds its file to `freed`.
fn write_row(conn: &Connection, change: &Change, freed: &mut Vec<FreedFile>) -> AppResult<Written> {
    let stamp = change.updated_at();
    match change {
        Change::Setting(Versioned {
            id, data: Some(d), ..
        }) => rows::upsert_setting(conn, id, stamp, d)?,
        Change::Subject(Versioned {
            id, data: Some(d), ..
        }) => {
            if let Some(parent) = &d.parent_id {
                if !rows::exists(conn, Entity::Subject, parent)? {
                    return Ok(Written::Missing);
                }
            }
            rows::upsert_subject(conn, id, stamp, d)?;
        }
        Change::Section(Versioned {
            id, data: Some(d), ..
        }) => {
            if !rows::exists(conn, Entity::Subject, &d.subject_id)? {
                return Ok(Written::Missing);
            }
            rows::upsert_section(conn, id, stamp, d)?;
        }
        Change::Task(Versioned {
            id, data: Some(d), ..
        }) => {
            if let Some(subject) = &d.subject_id {
                if !rows::exists(conn, Entity::Subject, subject)? {
                    return Ok(Written::Missing);
                }
            }
            if let Some(parent) = &d.parent_id {
                if !rows::exists(conn, Entity::Task, parent)? {
                    return Ok(Written::Missing);
                }
            }
            // `Some(None)`: the section is missing; `Some(Some(p))`: it belongs to `p`.
            let section_subject = match &d.section_id {
                None => None,
                Some(section) => Some(rows::section_subject(conn, section)?),
            };
            let section_missing = matches!(section_subject, Some(None));
            let section_off = match &section_subject {
                Some(Some(subject)) => Some(subject) != d.subject_id.as_ref(),
                Some(None) => true,
                None => false,
            };
            let column_missing = match &d.board_column_id {
                None => false,
                Some(column) => !rows::exists(conn, Entity::BoardColumn, column)?,
            };
            let mut data = d.clone();
            if section_off {
                data.section_id = None;
            }
            if column_missing {
                data.board_column_id = None;
            }
            let waits = section_missing || column_missing;
            if !waits {
                rows::upsert_task(conn, id, stamp, &data)?;
            } else {
                let here = store::known(conn, Entity::Task.as_str(), id)?.as_deref() == Some(stamp)
                    && rows::task(conn, id)?.as_ref() == Some(&data);
                if !here {
                    rows::upsert_task(conn, id, stamp, &data)?;
                    store::set_known(conn, Entity::Task.as_str(), id, stamp)?;
                }
                return Ok(Written::Waiting { written: !here });
            }
        }
        Change::BoardColumn(Versioned {
            id, data: Some(d), ..
        }) => {
            if let Some(subject) = &d.subject_id {
                if !rows::exists(conn, Entity::Subject, subject)? {
                    return Ok(Written::Missing);
                }
            }
            rows::upsert_board_column(conn, id, stamp, d)?;
        }
        Change::TimeSegment(Versioned {
            id, data: Some(d), ..
        }) => {
            if !rows::exists(conn, Entity::Task, &d.task_id)? {
                return Ok(Written::Missing);
            }
            rows::upsert_time_segment(conn, id, stamp, d)?;
        }
        Change::Relation(Versioned {
            id, data: Some(d), ..
        }) => {
            if !rows::exists(conn, Entity::Task, &d.from_task_id)?
                || !rows::exists(conn, Entity::Task, &d.to_task_id)?
            {
                return Ok(Written::Missing);
            }
            write_relation(conn, id, stamp, d)?;
        }
        Change::Attachment(Versioned {
            id, data: Some(d), ..
        }) => {
            if !rows::exists(conn, Entity::Task, &d.task_id)? {
                return Ok(Written::Missing);
            }
            if let Some(file) = rows::upsert_attachment(conn, id, stamp, d)? {
                freed.push(file);
            }
        }
        Change::NoteGroup(Versioned {
            id, data: Some(d), ..
        }) => {
            if !rows::exists(conn, Entity::Subject, &d.subject_id)? {
                return Ok(Written::Missing);
            }
            rows::upsert_note_group(conn, id, stamp, d)?;
        }
        Change::NotePage(Versioned {
            id, data: Some(d), ..
        }) => {
            if !rows::exists(conn, Entity::Subject, &d.subject_id)? {
                return Ok(Written::Missing);
            }
            // A group of another project is written as is (N11 takes the page out of it).
            let group_missing = match &d.group_id {
                None => false,
                Some(group) => rows::note_group_subject(conn, group)?.is_none(),
            };
            let task_missing = match &d.source_task_id {
                None => false,
                Some(task) => !rows::exists(conn, Entity::Task, task)?,
            };
            if !group_missing && !task_missing {
                rows::upsert_note_page(conn, id, stamp, d)?;
            } else {
                let mut data = d.clone();
                if group_missing {
                    data.group_id = None;
                }
                if task_missing {
                    data.source_task_id = None;
                }
                let here = store::known(conn, Entity::NotePage.as_str(), id)?.as_deref()
                    == Some(stamp)
                    && rows::note_page(conn, id)?.as_ref() == Some(&data);
                if !here {
                    rows::upsert_note_page(conn, id, stamp, &data)?;
                    store::set_known(conn, Entity::NotePage.as_str(), id, stamp)?;
                }
                return Ok(Written::Waiting { written: !here });
            }
        }
        Change::NoteAttachment(Versioned {
            id, data: Some(d), ..
        }) => {
            if !rows::exists(conn, Entity::NotePage, &d.note_page_id)? {
                return Ok(Written::Missing);
            }
            if let Some(file) = rows::upsert_note_attachment(conn, id, stamp, d)? {
                freed.push(file);
            }
        }
        _ => return Ok(Written::Missing),
    }
    store::set_known(conn, change.entity().as_str(), change.id(), stamp)?;
    Ok(Written::Yes)
}

/// Runs `f` with `applying = 0`: its writes are local changes, queued by the triggers and
/// pushed (then back to `applying = 1`).
fn as_local_change(conn: &Connection, f: impl FnOnce() -> AppResult<()>) -> AppResult<()> {
    store::set_applying(conn, false)?;
    let result = f();
    store::set_applying(conn, true)?;
    result
}

/// Writes a pulled relation. Two devices may link the same tasks with the same kind under
/// two ids, in the same direction (which the local unique index refuses) or the reverse one
/// (which `relations::add` refuses): the lowest id is kept, the other one is soft-deleted as
/// a local change (so every device ends with the same live relation).
fn write_relation(conn: &Connection, id: &str, stamp: &str, d: &RelationData) -> AppResult<()> {
    let twin = match d.deleted_at {
        Some(_) => None,
        None => rows::twin_relation(conn, id, d)?,
    };
    let Some(twin) = twin else {
        return rows::upsert_relation(conn, id, stamp, d);
    };
    let now = now_utc();
    if id < twin.as_str() {
        as_local_change(conn, || {
            conn.execute(
                "UPDATE task_relations SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1",
                params![twin, now],
            )?;
            Ok(())
        })?;
        rows::upsert_relation(conn, id, stamp, d)
    } else {
        // The pulled one goes: written deleted, as a local change stamped after its version.
        store::set_known(conn, Entity::Relation.as_str(), id, stamp)?;
        let gone = RelationData {
            deleted_at: Some(now.clone()),
            ..d.clone()
        };
        as_local_change(conn, || rows::upsert_relation(conn, id, &now, &gone))
    }
}

/// A tombstone: the row's local descendants still here are deleted as local changes (their
/// tombstones are queued), except those this response tombstones too, then the row as an
/// applied change. Deepest rows go first, so that no cascade deletes a row behind the
/// triggers' back. `false` for an unknown row. The files of the attachments it deletes go to
/// `freed`.
fn apply_tombstone(
    conn: &Connection,
    change: &Change,
    covered: &HashSet<ChangeKey>,
    freed: &mut Vec<FreedFile>,
) -> AppResult<bool> {
    let entity = change.entity();
    let id = change.id();
    store::forget_known(conn, entity.as_str(), id)?;
    if !rows::exists(conn, entity, id)? {
        return Ok(false);
    }
    let mut doomed: Vec<(Entity, String)> = Vec::new();
    match entity {
        Entity::Task => {
            let children = rows::task_descendants(conn, id)?;
            let mut all = children.clone();
            all.push(id.to_string());
            doomed.extend(rows::rows_of_tasks(conn, &all)?);
            doomed.extend(children.into_iter().map(|t| (Entity::Task, t)));
        }
        // A setting has no descendants (and its tombstone never gets here: it is invalid).
        // A column's tasks are not descendants (`board_column_id` is `ON DELETE SET NULL`, like
        // `section_id`): the device that deleted the column sends its tasks' new versions.
        // A notebook group's pages fall back to no group through `ON DELETE SET NULL` while
        // `applying = 1`, silently: the device that deleted the group sends their versions.
        Entity::Section | Entity::Setting | Entity::BoardColumn | Entity::NoteGroup => {}
        Entity::TimeSegment | Entity::Relation | Entity::Attachment | Entity::NoteAttachment => {}
        Entity::NotePage => {
            let images = rows::images_of_pages(conn, &[id.to_string()])?;
            doomed.extend(images.into_iter().map(|a| (Entity::NoteAttachment, a)));
        }
        Entity::Subject => {
            let tree = rows::subject_tree(conn, id)?;
            let tasks = rows::tasks_of_subjects(conn, &tree)?;
            doomed.extend(rows::rows_of_tasks(conn, &tasks)?);
            doomed.extend(tasks.into_iter().map(|t| (Entity::Task, t)));
            let sections = rows::sections_of_subjects(conn, &tree)?;
            doomed.extend(sections.into_iter().map(|s| (Entity::Section, s)));
            let columns = rows::columns_of_subjects(conn, &tree)?;
            doomed.extend(columns.into_iter().map(|c| (Entity::BoardColumn, c)));
            let notebook = rows::notebook_of_subjects(conn, &tree)?;
            let pages: Vec<String> = notebook
                .iter()
                .filter(|(e, _)| *e == Entity::NotePage)
                .map(|(_, p)| p.clone())
                .collect();
            let images = rows::images_of_pages(conn, &pages)?;
            doomed.extend(images.into_iter().map(|a| (Entity::NoteAttachment, a)));
            doomed.extend(notebook);
            doomed.extend(
                tree.into_iter()
                    .filter(|s| s.as_str() != id)
                    .map(|s| (Entity::Subject, s)),
            );
        }
    }
    for (e, row) in doomed {
        let applied = covered.contains(&ChangeKey {
            entity: e,
            id: row.clone(),
        });
        if matches!(e, Entity::Attachment | Entity::NoteAttachment) {
            if let Some(file) = rows::attachment_file(conn, &row)? {
                freed.push(file);
            }
        }
        store::set_applying(conn, applied)?;
        rows::delete(conn, e, &row)?;
        if applied {
            store::forget_known(conn, e.as_str(), &row)?;
        }
    }
    store::set_applying(conn, true)?;
    if matches!(entity, Entity::Attachment | Entity::NoteAttachment) {
        if let Some(file) = rows::attachment_file(conn, id)? {
            freed.push(file);
        }
    }
    rows::delete(conn, entity, id)?;
    Ok(true)
}

/// Tasks whose terminals must be closed before applying `changes` (§ 3.4 step 4): tasks the
/// response deletes (tombstone or `deleted_at` newly set) or completes, tasks of the projects
/// it deletes, and all their local descendants.
pub fn tasks_to_close(conn: &Connection, changes: &[Change]) -> AppResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    let mut add = |ids: Vec<String>| {
        for id in ids {
            if !out.contains(&id) {
                out.push(id);
            }
        }
    };
    for change in changes {
        match change {
            Change::Task(v) => {
                let Some(local) = rows::task(conn, &v.id)? else {
                    continue;
                };
                let closes = match &v.data {
                    None => true,
                    Some(d) => {
                        (d.deleted_at.is_some() && local.deleted_at.is_none())
                            || (d.completed_at.is_some() && local.completed_at.is_none())
                    }
                };
                if closes {
                    let mut ids = vec![v.id.clone()];
                    ids.extend(rows::task_descendants(conn, &v.id)?);
                    add(ids);
                }
            }
            Change::Subject(v) => {
                let Some(local) = rows::subject(conn, &v.id)? else {
                    continue;
                };
                let deletes = match &v.data {
                    None => true,
                    Some(d) => d.deleted_at.is_some() && local.deleted_at.is_none(),
                };
                if deletes {
                    let tree = rows::subject_tree(conn, &v.id)?;
                    add(rows::tasks_of_subjects(conn, &tree)?);
                }
            }
            Change::Section(_)
            | Change::Setting(_)
            | Change::BoardColumn(_)
            | Change::TimeSegment(_)
            | Change::Relation(_)
            | Change::Attachment(_)
            | Change::NoteGroup(_)
            | Change::NotePage(_)
            | Change::NoteAttachment(_) => {}
        }
    }
    Ok(out)
}
