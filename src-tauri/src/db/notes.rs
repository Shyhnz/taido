//! Project notebook repository: groups and pages.
//!
//! A page is Markdown in `body`. It sits in a group or outside any group (`group_id` NULL);
//! « Épinglées » (`pinned_at`) and « Résumés de tâches » (`kind = 'summary'` outside any
//! group) are views, not groups. Deleting a group leaves its pages outside any group
//! (FK `ON DELETE SET NULL`). A deleted page is only stamped (`deleted_at`).

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::db::positions::{self, Scope};
use crate::db::{new_id, non_empty, now_utc, subjects, tasks};
use crate::error::{AppError, AppResult};
use crate::model::{
    CreateNoteGroupInput, CreateNotePageInput, MoveNotePageInput, NoteGroup, NoteKind,
    NoteLinkKind, NoteLinkRef, NotePage, NoteTarget, ReorderInput, UpdateNoteGroupInput,
    UpdateNotePageInput,
};

/// Largest page body (bytes of Markdown): the sync protocol's limit.
pub const MAX_NOTE_BODY_BYTES: usize = sync_proto::MAX_NOTE_BODY_BYTES;
/// Longest page title (bytes): the sync protocol's limit.
pub const MAX_NOTE_TITLE_BYTES: usize = sync_proto::MAX_NOTE_TITLE_BYTES;

/// The refusal of restoring a page whose project is in the trash.
pub const TRASHED_PROJECT: &str = "Le projet de cette page est dans la corbeille.";
const GROUP_COLUMNS: &str = "id, subject_id, name, position";
/// The pages of a project in the trash (or of a sub-project whose parent is) are out of reach
/// until it is restored: `FROM note_pages np` + this, then `WHERE np.deleted_at IS NULL AND
/// LIVE_PROJECT`.
const LIVE_PROJECT_JOIN: &str = "JOIN subjects ps ON ps.id = np.subject_id \
                                 LEFT JOIN subjects pg ON pg.id = ps.parent_id";
const LIVE_PROJECT: &str = "ps.deleted_at IS NULL AND pg.deleted_at IS NULL";
const PAGE_COLUMNS: &str = "id, subject_id, group_id, kind, title, body, source_task_id, \
                            pinned_at, position, created_at, updated_at";

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

pub fn create_group(conn: &Connection, input: &CreateNoteGroupInput) -> AppResult<NoteGroup> {
    subjects::ensure_project(conn, &input.subject_id)?;
    let name = non_empty(&input.name, "group name")?;
    let id = new_id();
    let now = now_utc();
    let position = positions::append(
        conn,
        Scope::NoteGroups {
            subject_id: &input.subject_id,
        },
    )?;
    conn.execute(
        "INSERT INTO note_groups (id, subject_id, name, position, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, input.subject_id, name, position, now],
    )?;
    get_group(conn, &id)
}

fn get_group(conn: &Connection, id: &str) -> AppResult<NoteGroup> {
    let sql = format!("SELECT {GROUP_COLUMNS} FROM note_groups WHERE id = ?1");
    conn.query_row(&sql, [id], group_from_row)
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("note group {id}")))
}

pub fn update_group(conn: &Connection, input: &UpdateNoteGroupInput) -> AppResult<NoteGroup> {
    let current = get_group(conn, &input.id)?;
    let name = non_empty(&input.name, "group name")?;
    if name != current.name {
        conn.execute(
            "UPDATE note_groups SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![input.id, name, now_utc()],
        )?;
    }
    get_group(conn, &input.id)
}

/// Deletes the group for good; its pages go outside any group, after the pages already
/// there and in their order (FK `ON DELETE SET NULL`).
pub fn delete_group(conn: &Connection, id: &str) -> AppResult<()> {
    let group = get_group(conn, id)?;
    let tx = conn.unchecked_transaction()?;
    // Plain pages go after the plain pages outside any group, summaries after the summaries.
    for (kind, summaries) in [("page", false), ("summary", true)] {
        let base = positions::append(
            &tx,
            Scope::NotePages {
                subject_id: &group.subject_id,
                group_id: None,
                summaries,
            },
        )?;
        let min: Option<f64> = tx.query_row(
            "SELECT MIN(position) FROM note_pages WHERE group_id = ?1 AND kind = ?2",
            params![id, kind],
            |r| r.get(0),
        )?;
        if let Some(min) = min {
            tx.execute(
                "UPDATE note_pages SET position = ?3 + position - ?4 \
                 WHERE group_id = ?1 AND kind = ?2",
                params![id, kind, base, min],
            )?;
        }
    }
    tx.execute("DELETE FROM note_groups WHERE id = ?1", [id])?;
    tx.commit()?;
    Ok(())
}

pub fn reorder_group(conn: &Connection, input: &ReorderInput) -> AppResult<()> {
    let group = get_group(conn, &input.id)?;
    let tx = conn.unchecked_transaction()?;
    let position = positions::at_index(
        &tx,
        Scope::NoteGroups {
            subject_id: &group.subject_id,
        },
        Some(&input.id),
        input.index as usize,
    )?;
    tx.execute(
        "UPDATE note_groups SET position = ?2, updated_at = ?3 WHERE id = ?1",
        params![input.id, position, now_utc()],
    )?;
    tx.commit()?;
    Ok(())
}

/// The group `id` when it belongs to `subject_id`.
fn ensure_group_of(conn: &Connection, id: &str, subject_id: &str) -> AppResult<String> {
    let group = get_group(conn, id)?;
    if group.subject_id != subject_id {
        return Err(AppError::Invalid(format!(
            "note group {id} belongs to another project"
        )));
    }
    Ok(group.id)
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

fn check_title(title: &str) -> AppResult<String> {
    let title = non_empty(title, "page title")?;
    if title.len() > MAX_NOTE_TITLE_BYTES {
        return Err(AppError::Invalid(format!(
            "page title is longer than {MAX_NOTE_TITLE_BYTES} bytes"
        )));
    }
    Ok(title)
}

fn check_body(body: &str) -> AppResult<()> {
    if body.len() > MAX_NOTE_BODY_BYTES {
        return Err(AppError::Invalid(format!(
            "page is longer than {MAX_NOTE_BODY_BYTES} bytes"
        )));
    }
    Ok(())
}

pub fn create_page(conn: &Connection, input: &CreateNotePageInput) -> AppResult<NotePage> {
    subjects::ensure_project(conn, &input.subject_id)?;
    let title = check_title(&input.title)?;
    check_body(&input.body)?;
    if let Some(task_id) = &input.source_task_id {
        tasks::ensure_exists(conn, task_id)?;
    }
    let tx = conn.unchecked_transaction()?;
    let group_id = match &input.group_id {
        Some(g) => Some(ensure_group_of(&tx, g, &input.subject_id)?),
        None => None,
    };
    let position = positions::append(
        &tx,
        Scope::NotePages {
            subject_id: &input.subject_id,
            group_id: group_id.as_deref(),
            summaries: input.kind == NoteKind::Summary,
        },
    )?;
    let id = new_id();
    let now = now_utc();
    tx.execute(
        "INSERT INTO note_pages (id, subject_id, group_id, kind, title, body, source_task_id, \
         position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            id,
            input.subject_id,
            group_id,
            input.kind.as_str(),
            title,
            input.body,
            input.source_task_id,
            position,
            now
        ],
    )?;
    tx.commit()?;
    get_page(conn, &id)
}

/// A live page of a live project.
pub fn get_page(conn: &Connection, id: &str) -> AppResult<NotePage> {
    let columns = PAGE_COLUMNS
        .split(", ")
        .map(|c| format!("np.{}", c.trim()))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT {columns} FROM note_pages np {LIVE_PROJECT_JOIN} \
         WHERE np.id = ?1 AND np.deleted_at IS NULL AND {LIVE_PROJECT}"
    );
    conn.query_row(&sql, [id], page_from_row)
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("note page {id}")))
}

/// Changes the title and/or the body. Writes nothing (not even `updated_at`, so nothing
/// reaches the sync) when the values are the current ones.
pub fn update_page(conn: &Connection, input: &UpdateNotePageInput) -> AppResult<NotePage> {
    let current = get_page(conn, &input.id)?;
    let title = match &input.title {
        Some(t) => check_title(t)?,
        None => current.title.clone(),
    };
    let body = match &input.body {
        Some(b) => {
            check_body(b)?;
            b.clone()
        }
        None => current.body.clone(),
    };
    if title == current.title && body == current.body {
        return Ok(current);
    }
    conn.execute(
        "UPDATE note_pages SET title = ?2, body = ?3, updated_at = ?4 WHERE id = ?1",
        params![input.id, title, body, now_utc()],
    )?;
    get_page(conn, &input.id)
}

/// Moves a page: pins it (`pinned_at`; its group is kept, dropping it in a group unpins it),
/// or puts it in a group / outside any group at `index` (`None` = at the end), unpinned.
pub fn move_page(conn: &Connection, input: &MoveNotePageInput) -> AppResult<NotePage> {
    let page = get_page(conn, &input.id)?;
    let tx = conn.unchecked_transaction()?;
    match &input.target {
        NoteTarget::Pinned => {
            if page.pinned_at.is_some() {
                return Ok(page);
            }
            tx.execute(
                "UPDATE note_pages SET pinned_at = ?2, updated_at = ?2 WHERE id = ?1",
                params![page.id, now_utc()],
            )?;
        }
        NoteTarget::Summaries if page.kind != NoteKind::Summary => {
            return Err(AppError::Invalid(
                "only a summary goes to « Résumés de tâches »".into(),
            ));
        }
        target => {
            // A summary sent outside any group goes to « Résumés de tâches ».
            let target = match target {
                NoteTarget::Ungrouped if page.kind == NoteKind::Summary => &NoteTarget::Summaries,
                other => other,
            };
            let group_id = match target {
                NoteTarget::Group { id } => Some(ensure_group_of(&tx, id, &page.subject_id)?),
                _ => None,
            };
            let scope = Scope::NotePages {
                subject_id: &page.subject_id,
                group_id: group_id.as_deref(),
                summaries: matches!(target, NoteTarget::Summaries),
            };
            let position = match input.index {
                Some(i) => positions::at_index(&tx, scope, Some(&page.id), i as usize)?,
                None => positions::append(&tx, scope)?,
            };
            tx.execute(
                "UPDATE note_pages SET group_id = ?2, pinned_at = NULL, position = ?3, \
                 updated_at = ?4 WHERE id = ?1",
                params![page.id, group_id, position, now_utc()],
            )?;
        }
    }
    tx.commit()?;
    get_page(conn, &input.id)
}

/// Pins or unpins a page. Unpinning keeps its group and its position, so the page goes back
/// where it was (outside any group, by its kind, when its group was deleted meanwhile).
/// Writes nothing when the page already is in that state.
pub fn set_pinned(conn: &Connection, id: &str, pinned: bool) -> AppResult<NotePage> {
    let page = get_page(conn, id)?;
    if page.pinned_at.is_some() == pinned {
        return Ok(page);
    }
    let now = now_utc();
    let pinned_at = pinned.then(|| now.clone());
    conn.execute(
        "UPDATE note_pages SET pinned_at = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, pinned_at, now],
    )?;
    get_page(conn, id)
}

/// Suffix of a duplicated page's title.
const COPY_SUFFIX: &str = " (copie)";

/// « <title> (copie) », the title cut (on a character boundary) so the whole stays within
/// [`MAX_NOTE_TITLE_BYTES`].
fn copy_title(title: &str) -> String {
    let room = MAX_NOTE_TITLE_BYTES.saturating_sub(COPY_SUFFIX.len());
    let mut end = title.len().min(room);
    while !title.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{COPY_SUFFIX}", title[..end].trim_end())
}

/// Copies a page (title « … (copie) », same text, kind and group, not pinned) right after
/// the original in its list.
pub fn duplicate_page(conn: &Connection, id: &str) -> AppResult<NotePage> {
    let page = get_page(conn, id)?;
    let tx = conn.unchecked_transaction()?;
    let scope = Scope::NotePages {
        subject_id: &page.subject_id,
        group_id: page.group_id.as_deref(),
        summaries: page.kind == NoteKind::Summary,
    };
    let position = positions::after(&tx, scope, &page.id)?;
    let new = new_id();
    let now = now_utc();
    tx.execute(
        "INSERT INTO note_pages (id, subject_id, group_id, kind, title, body, source_task_id, \
         position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            new,
            page.subject_id,
            page.group_id,
            page.kind.as_str(),
            copy_title(&page.title),
            page.body,
            page.source_task_id,
            position,
            now
        ],
    )?;
    tx.commit()?;
    get_page(conn, &new)
}

/// Soft delete (the page can be restored).
pub fn delete_page(conn: &Connection, id: &str) -> AppResult<()> {
    get_page(conn, id)?;
    let now = now_utc();
    conn.execute(
        "UPDATE note_pages SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1",
        params![id, now],
    )?;
    Ok(())
}

/// Brings a soft-deleted page back where it was (outside any group when its group is gone).
pub fn restore_page(conn: &Connection, id: &str) -> AppResult<NotePage> {
    // The page of a project in the trash would come back out of reach: refuse before writing.
    let sql = format!(
        "SELECT ({LIVE_PROJECT}) FROM note_pages np {LIVE_PROJECT_JOIN} \
         WHERE np.id = ?1 AND np.deleted_at IS NOT NULL"
    );
    let live: Option<bool> = conn.query_row(&sql, [id], |r| r.get(0)).optional()?;
    if live == Some(false) {
        return Err(AppError::Invalid(TRASHED_PROJECT.into()));
    }
    let n = conn.execute(
        "UPDATE note_pages SET deleted_at = NULL, updated_at = ?2 \
         WHERE id = ?1 AND deleted_at IS NOT NULL",
        params![id, now_utc()],
    )?;
    if n == 0 {
        return Err(AppError::NotFound(format!("deleted note page {id}")));
    }
    get_page(conn, id)
}

/// A project's groups and live pages, by position (the UI derives « Épinglées » and
/// « Résumés de tâches »).
pub fn list_for_subject(
    conn: &Connection,
    subject_id: &str,
) -> AppResult<(Vec<NoteGroup>, Vec<NotePage>)> {
    let sql = format!(
        "SELECT {GROUP_COLUMNS} FROM note_groups WHERE subject_id = ?1 ORDER BY position, id"
    );
    let groups = conn
        .prepare(&sql)?
        .query_map([subject_id], group_from_row)?
        .collect::<Result<_, _>>()?;
    let sql = format!(
        "SELECT {PAGE_COLUMNS} FROM note_pages WHERE subject_id = ?1 AND deleted_at IS NULL \
         ORDER BY position, id"
    );
    let pages = conn
        .prepare(&sql)?
        .query_map([subject_id], page_from_row)?
        .collect::<Result<_, _>>()?;
    Ok((groups, pages))
}

// ---------------------------------------------------------------------------
// Links and « Mentionné dans »
// ---------------------------------------------------------------------------

/// What a `[[kind:id|Title]]` link (or a `![[file:id|l%]]` image) points at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    Page,
    Task,
    File,
}

/// The links of a page body, in order: `[[page:<id>|Title]]`, `[[task:<id>|Title]]`,
/// `[[file:<id>|<l>%]]` (the image form `![[file:…]]` too). `<id>` is 36 characters of
/// `[0-9a-f-]`; the part after `|` is optional.
pub fn links_in(body: &str) -> Vec<(LinkKind, String)> {
    scan_links(body)
        .into_iter()
        .map(|l| (l.kind, l.id.to_string()))
        .collect()
}

/// One link found in a body: where it sits (`start..end`, the `!` of an image included), what
/// it points at and the title (or width) it carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkSpan<'a> {
    pub start: usize,
    pub end: usize,
    pub kind: LinkKind,
    pub id: &'a str,
    pub label: &'a str,
}

/// Every link of `body`, in order (see [`links_in`] for the syntax).
pub fn scan_links(body: &str) -> Vec<LinkSpan<'_>> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(open) = body[from..].find("[[") {
        let open = from + open;
        from = open + 2;
        let rest = &body[from..];
        let (kind, after) = if let Some(r) = rest.strip_prefix("page:") {
            (LinkKind::Page, r)
        } else if let Some(r) = rest.strip_prefix("task:") {
            (LinkKind::Task, r)
        } else if let Some(r) = rest.strip_prefix("file:") {
            (LinkKind::File, r)
        } else {
            continue;
        };
        let id_len = after
            .bytes()
            .take_while(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b) || *b == b'-')
            .count();
        if id_len != 36 {
            continue;
        }
        let (id, tail) = after.split_at(36);
        let (label, tail) = match tail.strip_prefix('|') {
            Some(t) => match t.find(']') {
                Some(i) => (&t[..i], &t[i..]),
                None => continue,
            },
            None => ("", tail),
        };
        let Some(tail) = tail.strip_prefix("]]") else {
            continue;
        };
        let end = body.len() - tail.len();
        let start = if body[..open].ends_with('!') {
            open - 1
        } else {
            open
        };
        out.push(LinkSpan {
            start,
            end,
            kind,
            id,
            label,
        });
        from = end;
    }
    out
}

/// Live pages (other than `except`) whose body links to `kind:id`, most recently changed first.
fn pages_linking_to(
    conn: &Connection,
    kind: LinkKind,
    id: &str,
    except: Option<&str>,
) -> AppResult<Vec<NoteLinkRef>> {
    let prefix = match kind {
        LinkKind::Page => "page",
        LinkKind::Task => "task",
        LinkKind::File => "file",
    };
    let mut stmt = conn.prepare(&format!(
        "SELECT np.id, np.title, np.body FROM note_pages np {LIVE_PROJECT_JOIN} \
         WHERE np.deleted_at IS NULL AND {LIVE_PROJECT} AND np.id IS NOT ?2 \
         AND instr(np.body, ?1) > 0 ORDER BY np.updated_at DESC, np.id"
    ))?;
    let rows = stmt.query_map(params![format!("[[{prefix}:{id}"), except], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (page_id, title, body) = row?;
        if links_in(&body).iter().any(|(k, l)| *k == kind && l == id) {
            out.push(NoteLinkRef {
                kind: NoteLinkKind::Page,
                id: page_id,
                title,
                alive: true,
            });
        }
    }
    Ok(out)
}

/// « Mentionné dans » of a page: the live pages and tasks (their note) that link to it.
pub fn backlinks(conn: &Connection, page_id: &str) -> AppResult<Vec<NoteLinkRef>> {
    let mut out = pages_linking_to(conn, LinkKind::Page, page_id, Some(page_id))?;
    let mut stmt = conn.prepare(
        "SELECT id, title, description FROM tasks \
         WHERE deleted_at IS NULL AND instr(description, ?1) > 0 \
         ORDER BY updated_at DESC, id",
    )?;
    let rows = stmt.query_map([format!("[[page:{page_id}")], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (id, title, note) = row?;
        if links_in(&note)
            .iter()
            .any(|(k, l)| *k == LinkKind::Page && l == page_id)
        {
            out.push(NoteLinkRef {
                kind: NoteLinkKind::Task,
                id,
                title,
                alive: true,
            });
        }
    }
    Ok(out)
}

/// The live pages that link to a task.
pub fn task_mentions(conn: &Connection, task_id: &str) -> AppResult<Vec<NoteLinkRef>> {
    pages_linking_to(conn, LinkKind::Task, task_id, None)
}

/// A link's target as it is now: its current title when it is alive, else `copy` (the title
/// the link carries) with `alive` false.
pub fn resolve_link(
    conn: &Connection,
    kind: NoteLinkKind,
    id: &str,
    copy: &str,
) -> AppResult<NoteLinkRef> {
    let sql = match kind {
        NoteLinkKind::Page => format!(
            "SELECT np.title FROM note_pages np {LIVE_PROJECT_JOIN} \
             WHERE np.id = ?1 AND np.deleted_at IS NULL AND {LIVE_PROJECT}"
        ),
        NoteLinkKind::Task => {
            "SELECT title FROM tasks WHERE id = ?1 AND deleted_at IS NULL".to_string()
        }
    };
    let title: Option<String> = conn.query_row(&sql, [id], |r| r.get(0)).optional()?;
    Ok(NoteLinkRef {
        kind,
        id: id.to_string(),
        alive: title.is_some(),
        title: title.unwrap_or_else(|| copy.to_string()),
    })
}

fn group_from_row(r: &Row<'_>) -> rusqlite::Result<NoteGroup> {
    Ok(NoteGroup {
        id: r.get(0)?,
        subject_id: r.get(1)?,
        name: r.get(2)?,
        position: r.get(3)?,
    })
}

fn page_from_row(r: &Row<'_>) -> rusqlite::Result<NotePage> {
    Ok(NotePage {
        id: r.get(0)?,
        subject_id: r.get(1)?,
        group_id: r.get(2)?,
        kind: NoteKind::parse(&r.get::<_, String>(3)?),
        title: r.get(4)?,
        body: r.get(5)?,
        source_task_id: r.get(6)?,
        pinned_at: r.get(7)?,
        position: r.get(8)?,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::{subject, task};
    use crate::db::{open_in_memory, subjects, trash};
    use rusqlite::params;

    fn group(conn: &Connection, subject_id: &str, name: &str) -> NoteGroup {
        create_group(
            conn,
            &CreateNoteGroupInput {
                subject_id: subject_id.into(),
                name: name.into(),
            },
        )
        .expect("create group")
    }

    fn page_in(
        conn: &Connection,
        subject_id: &str,
        group_id: Option<&str>,
        title: &str,
    ) -> NotePage {
        create_page(
            conn,
            &CreateNotePageInput {
                subject_id: subject_id.into(),
                group_id: group_id.map(String::from),
                title: title.into(),
                body: String::new(),
                kind: NoteKind::Page,
                source_task_id: None,
            },
        )
        .expect("create page")
    }

    fn summary(conn: &Connection, subject_id: &str, title: &str) -> NotePage {
        create_page(
            conn,
            &CreateNotePageInput {
                subject_id: subject_id.into(),
                group_id: None,
                title: title.into(),
                body: "Done.".into(),
                kind: NoteKind::Summary,
                source_task_id: None,
            },
        )
        .expect("create summary")
    }

    fn outbox_len(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM sync_outbox", [], |r| r.get(0))
            .expect("count")
    }

    fn titles(pages: &[NotePage], group_id: Option<&str>) -> Vec<String> {
        let mut own: Vec<&NotePage> = pages
            .iter()
            .filter(|p| p.group_id.as_deref() == group_id && p.pinned_at.is_none())
            .collect();
        own.sort_by(|a, b| a.position.total_cmp(&b.position));
        own.into_iter().map(|p| p.title.clone()).collect()
    }

    #[test]
    fn create_page_appends_in_its_group() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let g = group(&conn, &s, "Décisions");
        let a = page_in(&conn, &s, Some(&g.id), " A ");
        let b = page_in(&conn, &s, Some(&g.id), "B");
        let loose = page_in(&conn, &s, None, "Loose");
        assert_eq!(a.title, "A");
        assert_eq!((a.position, b.position, loose.position), (1.0, 2.0, 1.0));
        assert_eq!(a.group_id.as_deref(), Some(g.id.as_str()));
        assert_eq!(a.kind, NoteKind::Page);
        let (groups, pages) = list_for_subject(&conn, &s).expect("list");
        assert_eq!(groups, vec![g.clone()]);
        assert_eq!(titles(&pages, Some(&g.id)), vec!["A", "B"]);
        // A group of another project is refused.
        let other = subject(&conn, "Other");
        let bad = create_page(
            &conn,
            &CreateNotePageInput {
                subject_id: other,
                group_id: Some(g.id),
                title: "X".into(),
                body: String::new(),
                kind: NoteKind::Page,
                source_task_id: None,
            },
        );
        assert!(matches!(bad, Err(AppError::Invalid(_))));
        let bad = create_page(
            &conn,
            &CreateNotePageInput {
                subject_id: s.clone(),
                group_id: None,
                title: "  ".into(),
                body: String::new(),
                kind: NoteKind::Page,
                source_task_id: None,
            },
        );
        assert!(matches!(bad, Err(AppError::Invalid(_))));
    }

    #[test]
    fn update_page_with_same_text_does_not_touch_updated_at() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let p = page_in(&conn, &s, None, "Title");
        conn.execute("DELETE FROM sync_outbox", []).expect("clear");
        let same = update_page(
            &conn,
            &UpdateNotePageInput {
                id: p.id.clone(),
                title: Some("Title".into()),
                body: Some(String::new()),
            },
        )
        .expect("same");
        assert_eq!(same.updated_at, p.updated_at);
        assert_eq!(outbox_len(&conn), 0, "nothing queued for the sync");
        std::thread::sleep(std::time::Duration::from_millis(5));
        let changed = update_page(
            &conn,
            &UpdateNotePageInput {
                id: p.id.clone(),
                title: None,
                body: Some("Hello".into()),
            },
        )
        .expect("changed");
        assert_eq!(changed.body, "Hello");
        assert_eq!(changed.title, "Title");
        assert_ne!(changed.updated_at, p.updated_at);
        assert_eq!(outbox_len(&conn), 1);
    }

    #[test]
    fn move_to_pinned_sets_pinned_at_and_keeps_group() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let g = group(&conn, &s, "G");
        let p = page_in(&conn, &s, Some(&g.id), "P");
        let moved = move_page(
            &conn,
            &MoveNotePageInput {
                id: p.id.clone(),
                target: NoteTarget::Pinned,
                index: None,
            },
        )
        .expect("pin");
        assert!(moved.pinned_at.is_some());
        assert_eq!(moved.group_id.as_deref(), Some(g.id.as_str()));
        // Pinning twice keeps the first stamp.
        let again = move_page(
            &conn,
            &MoveNotePageInput {
                id: p.id,
                target: NoteTarget::Pinned,
                index: None,
            },
        )
        .expect("pin again");
        assert_eq!(again.pinned_at, moved.pinned_at);
    }

    #[test]
    fn move_from_pinned_to_group_unpins() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let g = group(&conn, &s, "G");
        let h = group(&conn, &s, "H");
        let a = page_in(&conn, &s, Some(&h.id), "A");
        let p = page_in(&conn, &s, Some(&g.id), "P");
        let mv = |id: &str, target: NoteTarget, index: Option<u32>| {
            move_page(
                &conn,
                &MoveNotePageInput {
                    id: id.into(),
                    target,
                    index,
                },
            )
            .expect("move")
        };
        mv(&p.id, NoteTarget::Pinned, None);
        let moved = mv(&p.id, NoteTarget::Group { id: h.id.clone() }, Some(0));
        assert_eq!(moved.pinned_at, None);
        assert_eq!(moved.group_id.as_deref(), Some(h.id.as_str()));
        let (_, pages) = list_for_subject(&conn, &s).expect("list");
        assert_eq!(titles(&pages, Some(&h.id)), vec!["P", "A"]);
        // Out of a group, appended outside any group.
        let out = mv(&a.id, NoteTarget::Ungrouped, None);
        assert_eq!(out.group_id, None);
        // A group of another project is refused.
        let other = subject(&conn, "Other");
        let foreign = group(&conn, &other, "Foreign");
        let bad = move_page(
            &conn,
            &MoveNotePageInput {
                id: a.id,
                target: NoteTarget::Group { id: foreign.id },
                index: None,
            },
        );
        assert!(matches!(bad, Err(AppError::Invalid(_))));
    }

    #[test]
    fn move_page_into_summaries_is_refused_for_a_plain_page() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let g = group(&conn, &s, "G");
        let plain = page_in(&conn, &s, Some(&g.id), "Plain");
        let bad = move_page(
            &conn,
            &MoveNotePageInput {
                id: plain.id.clone(),
                target: NoteTarget::Summaries,
                index: None,
            },
        );
        assert!(matches!(bad, Err(AppError::Invalid(_))));
        assert_eq!(
            get_page(&conn, &plain.id).expect("get").group_id.as_deref(),
            Some(g.id.as_str()),
            "nothing changed"
        );
        // A summary goes there, and stays a summary in a group.
        let sum = summary(&conn, &s, "Summary");
        let in_group = move_page(
            &conn,
            &MoveNotePageInput {
                id: sum.id.clone(),
                target: NoteTarget::Group { id: g.id },
                index: Some(0),
            },
        )
        .expect("into a group");
        assert_eq!(in_group.kind, NoteKind::Summary);
        let back = move_page(
            &conn,
            &MoveNotePageInput {
                id: sum.id,
                target: NoteTarget::Summaries,
                index: None,
            },
        )
        .expect("back");
        assert_eq!(back.group_id, None);
    }

    #[test]
    fn delete_group_leaves_its_pages_ungrouped() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let g = group(&conn, &s, "G");
        let loose = page_in(&conn, &s, None, "Loose");
        let a = page_in(&conn, &s, Some(&g.id), "A");
        let b = page_in(&conn, &s, Some(&g.id), "B");
        delete_group(&conn, &g.id).expect("delete");
        let (groups, pages) = list_for_subject(&conn, &s).expect("list");
        assert!(groups.is_empty());
        assert!(pages.iter().all(|p| p.group_id.is_none()));
        // After the pages that were already outside any group, in their order.
        assert_eq!(titles(&pages, None), vec!["Loose", "A", "B"]);
        assert_eq!(pages.len(), 3);
        let _ = (loose, a, b);
        assert!(matches!(
            delete_group(&conn, &g.id),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn body_over_limit_is_refused() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let big = "x".repeat(MAX_NOTE_BODY_BYTES + 1);
        let bad = create_page(
            &conn,
            &CreateNotePageInput {
                subject_id: s.clone(),
                group_id: None,
                title: "Big".into(),
                body: big.clone(),
                kind: NoteKind::Page,
                source_task_id: None,
            },
        );
        assert!(matches!(bad, Err(AppError::Invalid(_))));
        let p = page_in(&conn, &s, None, "Small");
        let bad = update_page(
            &conn,
            &UpdateNotePageInput {
                id: p.id.clone(),
                title: None,
                body: Some(big),
            },
        );
        assert!(matches!(bad, Err(AppError::Invalid(_))));
        // Exactly the limit passes; so does a title of 500 bytes, not 501.
        let ok = "x".repeat(MAX_NOTE_BODY_BYTES);
        update_page(
            &conn,
            &UpdateNotePageInput {
                id: p.id.clone(),
                title: Some("t".repeat(500)),
                body: Some(ok),
            },
        )
        .expect("at the limit");
        let bad = update_page(
            &conn,
            &UpdateNotePageInput {
                id: p.id,
                title: Some("t".repeat(501)),
                body: None,
            },
        );
        assert!(matches!(bad, Err(AppError::Invalid(_))));
    }

    #[test]
    fn deleting_a_subject_deletes_its_notebook() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let g = group(&conn, &s, "G");
        let p = page_in(&conn, &s, Some(&g.id), "P");
        conn.execute(
            "INSERT INTO attachments (id, note_page_id, file_name, stored_path, mime_type, \
             size, created_at, updated_at) VALUES ('img', ?1, 'a.png', '/tmp/a.png', \
             'image/png', 3, 'c', 'c')",
            [&p.id],
        )
        .expect("page image");
        subjects::delete(&conn, &s).expect("delete");
        let later = chrono::Utc::now() + chrono::Duration::days(2);
        trash::purge(&conn, later).expect("purge");
        for table in ["note_groups", "note_pages", "attachments"] {
            let n: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .expect("count");
            assert_eq!(n, 0, "{table}");
        }
    }

    /// Restoring a page whose project is in the trash is refused before anything is written.
    #[test]
    fn restoring_a_page_of_a_trashed_project_is_refused_and_writes_nothing() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let p = page_in(&conn, &s, None, "P");
        delete_page(&conn, &p.id).expect("delete");
        subjects::delete(&conn, &s).expect("trash project");
        let refused = restore_page(&conn, &p.id);
        assert!(
            matches!(&refused, Err(AppError::Invalid(m)) if m == TRASHED_PROJECT),
            "{refused:?}"
        );
        let stamp: Option<String> = conn
            .query_row(
                "SELECT deleted_at FROM note_pages WHERE id = ?1",
                [&p.id],
                |r| r.get(0),
            )
            .expect("row");
        assert!(stamp.is_some(), "the page stays deleted");
        // The project back, the page can be restored.
        subjects::restore(&conn, &s).expect("restore project");
        assert_eq!(restore_page(&conn, &p.id).expect("restore").title, "P");
    }

    #[test]
    fn delete_and_restore_page() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let p = page_in(&conn, &s, None, "P");
        let t = task(&conn, "T", Some(&s), None);
        delete_page(&conn, &p.id).expect("delete");
        assert!(list_for_subject(&conn, &s).expect("list").1.is_empty());
        assert!(matches!(get_page(&conn, &p.id), Err(AppError::NotFound(_))));
        let back = restore_page(&conn, &p.id).expect("restore");
        assert_eq!(back.title, "P");
        assert_eq!(list_for_subject(&conn, &s).expect("list").1.len(), 1);
        // A deleted source task only unlinks the summary.
        let sum = create_page(
            &conn,
            &CreateNotePageInput {
                subject_id: s.clone(),
                group_id: None,
                title: "Sum".into(),
                body: String::new(),
                kind: NoteKind::Summary,
                source_task_id: Some(t.clone()),
            },
        )
        .expect("summary");
        assert_eq!(sum.source_task_id.as_deref(), Some(t.as_str()));
        conn.execute("DELETE FROM tasks WHERE id = ?1", params![t])
            .expect("purge task");
        assert_eq!(get_page(&conn, &sum.id).expect("get").source_task_id, None);
    }

    #[test]
    fn groups_rename_and_reorder() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let a = group(&conn, &s, "A");
        let _b = group(&conn, &s, "B");
        let renamed = update_group(
            &conn,
            &UpdateNoteGroupInput {
                id: a.id.clone(),
                name: " Décisions ".into(),
            },
        )
        .expect("rename");
        assert_eq!(renamed.name, "Décisions");
        reorder_group(&conn, &ReorderInput { id: a.id, index: 1 }).expect("reorder");
        let names: Vec<_> = list_for_subject(&conn, &s)
            .expect("list")
            .0
            .into_iter()
            .map(|g| g.name)
            .collect();
        assert_eq!(names, vec!["B", "Décisions"]);
    }

    #[test]
    fn ungrouped_and_summaries_are_ordered_apart() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let p1 = page_in(&conn, &s, None, "P1");
        let s1 = summary(&conn, &s, "S1");
        let p2 = page_in(&conn, &s, None, "P2");
        let s2 = summary(&conn, &s, "S2");
        let x = page_in(&conn, &s, None, "X");
        let mv = |id: &str, target: NoteTarget, index: u32| {
            move_page(
                &conn,
                &MoveNotePageInput {
                    id: id.into(),
                    target,
                    index: Some(index),
                },
            )
            .expect("move")
        };
        let order = |summaries: bool| -> Vec<String> {
            let (_, pages) = list_for_subject(&conn, &s).expect("list");
            let mut own: Vec<&NotePage> = pages
                .iter()
                .filter(|p| p.group_id.is_none() && (p.kind == NoteKind::Summary) == summaries)
                .collect();
            own.sort_by(|a, b| a.position.total_cmp(&b.position));
            own.into_iter().map(|p| p.title.clone()).collect()
        };
        // Drop X at index 1 of the plain list [P1, P2]: between them, whatever sits between.
        mv(&x.id, NoteTarget::Ungrouped, 1);
        assert_eq!(order(false), vec!["P1", "X", "P2"]);
        mv(&x.id, NoteTarget::Ungrouped, 2);
        assert_eq!(order(false), vec!["P1", "P2", "X"]);
        // Reordering inside the summaries.
        mv(&s2.id, NoteTarget::Summaries, 0);
        assert_eq!(order(true), vec!["S2", "S1"]);
        mv(&s2.id, NoteTarget::Summaries, 1);
        assert_eq!(order(true), vec!["S1", "S2"]);
        let _ = (&p1, &p2);
        // A deleted group's pages: plain after the plain ones, summaries after the summaries.
        let g = group(&conn, &s, "G");
        mv(&x.id, NoteTarget::Group { id: g.id.clone() }, 0);
        mv(&s1.id, NoteTarget::Group { id: g.id.clone() }, 0);
        delete_group(&conn, &g.id).expect("delete group");
        assert_eq!(order(false), vec!["P1", "P2", "X"]);
        assert_eq!(order(true), vec!["S2", "S1"]);
    }

    const ID_A: &str = "0192f0a1-7c2b-7d3e-9f00-112233445566";
    const ID_B: &str = "0192f0a1-7c2b-7d3e-9f00-aabbccddeeff";
    const ID_C: &str = "0192f0a1-7c2b-7d3e-9f00-000000000001";

    #[test]
    fn links_in_finds_pages_tasks_files() {
        let body = format!(
            "Voir [[page:{ID_A}|Style des mails]] et [[task:{ID_B}|Envoyer]].\n\
             ![[file:{ID_C}|50%]] ![[file:{ID_C}]] [[page:{ID_B}]]\n\
             pas un lien : [[page:nope|X]] [[note:{ID_A}]] [[page:{ID_A}|ouvert"
        );
        assert_eq!(
            links_in(&body),
            vec![
                (LinkKind::Page, ID_A.to_string()),
                (LinkKind::Task, ID_B.to_string()),
                (LinkKind::File, ID_C.to_string()),
                (LinkKind::File, ID_C.to_string()),
                (LinkKind::Page, ID_B.to_string()),
            ]
        );
        assert!(links_in("").is_empty());
        assert!(links_in("[[page:ÉÉÉ|é]] [[").is_empty());
    }

    #[test]
    fn backlinks_list_pages_mentioning_a_page() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let target = page_in(&conn, &s, None, "Cible");
        let mention = |title: &str, body: String| {
            let p = page_in(&conn, &s, None, title);
            update_page(
                &conn,
                &UpdateNotePageInput {
                    id: p.id.clone(),
                    title: None,
                    body: Some(body),
                },
            )
            .expect("body");
            p
        };
        let one = mention("Une", format!("voir [[page:{}|Cible]]", target.id));
        let two = mention(
            "Deux",
            format!("[[page:{}|Ancien titre]] et encore", target.id),
        );
        mention("Autre", "aucun lien".into());
        let gone = mention("Supprimée", format!("[[page:{}|Cible]]", target.id));
        delete_page(&conn, &gone.id).expect("delete");
        mention("Soi", format!("[[page:{}|Cible]]", ID_A));
        let t = task(&conn, "Mails transactionnels", Some(&s), None);
        conn.execute(
            "UPDATE tasks SET description = ?2 WHERE id = ?1",
            params![t, format!("cf. [[page:{}|Cible]]", target.id)],
        )
        .expect("note");
        let refs = backlinks(&conn, &target.id).expect("backlinks");
        let mut got: Vec<(NoteLinkKind, String, String, bool)> = refs
            .into_iter()
            .map(|r| (r.kind, r.id, r.title, r.alive))
            .collect();
        got.sort();
        let mut want = vec![
            (NoteLinkKind::Page, one.id, "Une".to_string(), true),
            (NoteLinkKind::Page, two.id, "Deux".to_string(), true),
            (
                NoteLinkKind::Task,
                t.clone(),
                "Mails transactionnels".to_string(),
                true,
            ),
        ];
        want.sort();
        assert_eq!(got, want);
        // The pages that mention a task.
        let page = mention("Cite la tâche", format!("fait : [[task:{t}|x]]"));
        let refs = task_mentions(&conn, &t).expect("mentions");
        assert_eq!(refs.len(), 1);
        assert_eq!(
            (refs[0].kind, refs[0].id.as_str()),
            (NoteLinkKind::Page, page.id.as_str())
        );
        assert_eq!(refs[0].title, "Cite la tâche");
    }

    #[test]
    fn dead_link_is_not_alive() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let p = page_in(&conn, &s, None, "Vivante");
        let t = task(&conn, "Tâche", Some(&s), None);
        let r = resolve_link(&conn, NoteLinkKind::Page, &p.id, "Copie").expect("page");
        assert_eq!((r.alive, r.title.as_str()), (true, "Vivante"));
        let r = resolve_link(&conn, NoteLinkKind::Task, &t, "Copie").expect("task");
        assert_eq!((r.alive, r.title.as_str()), (true, "Tâche"));
        delete_page(&conn, &p.id).expect("delete");
        tasks::delete(&conn, &t).expect("delete task");
        let r = resolve_link(&conn, NoteLinkKind::Page, &p.id, "Copie").expect("dead page");
        assert_eq!((r.alive, r.title.as_str()), (false, "Copie"));
        let r = resolve_link(&conn, NoteLinkKind::Task, &t, "Copie").expect("dead task");
        assert_eq!((r.alive, r.title.as_str()), (false, "Copie"));
        let r = resolve_link(&conn, NoteLinkKind::Page, ID_C, "Jamais").expect("unknown");
        assert!(!r.alive);
    }

    #[test]
    fn notebook_of_a_trashed_project_is_closed() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let g = group(&conn, &s, "G");
        subjects::delete(&conn, &s).expect("trash project");
        let new_group = create_group(
            &conn,
            &CreateNoteGroupInput {
                subject_id: s.clone(),
                name: "Autre".into(),
            },
        );
        assert!(matches!(new_group, Err(AppError::NotFound(_))));
        let new_page = create_page(
            &conn,
            &CreateNotePageInput {
                subject_id: s.clone(),
                group_id: Some(g.id),
                title: "P".into(),
                body: String::new(),
                kind: NoteKind::Page,
                source_task_id: None,
            },
        );
        assert!(matches!(new_page, Err(AppError::NotFound(_))));
    }

    /// I3: the pages of a trashed project are out of reach (open, links, « Mentionné dans »)
    /// until the project is restored.
    #[test]
    fn pages_of_a_trashed_project_are_out_of_reach_until_it_is_restored() {
        let conn = open_in_memory().expect("db");
        let gone = subject(&conn, "Gone");
        let live = subject(&conn, "Live");
        let t = task(&conn, "T", Some(&live), None);
        let target = page_in(&conn, &live, None, "Cible");
        let hidden = page_in(&conn, &gone, None, "Cachée");
        let body = format!("[[page:{}|Cible]] [[task:{t}|T]]", target.id);
        conn.execute(
            "UPDATE note_pages SET body = ?2 WHERE id = ?1",
            params![hidden.id, body],
        )
        .expect("body");
        let pointing = page_in(&conn, &live, None, "Pointe");
        conn.execute(
            "UPDATE note_pages SET body = ?2 WHERE id = ?1",
            params![pointing.id, format!("[[page:{}|Cachée]]", hidden.id)],
        )
        .expect("body");
        subjects::delete(&conn, &gone).expect("trash");

        assert!(matches!(
            get_page(&conn, &hidden.id),
            Err(AppError::NotFound(_))
        ));
        let r = resolve_link(&conn, NoteLinkKind::Page, &hidden.id, "Cachée").expect("link");
        assert!(!r.alive);
        assert!(backlinks(&conn, &target.id).expect("backlinks").is_empty());
        assert!(task_mentions(&conn, &t).expect("mentions").is_empty());
        let edit = update_page(
            &conn,
            &UpdateNotePageInput {
                id: hidden.id.clone(),
                title: Some("X".into()),
                body: None,
            },
        );
        assert!(matches!(edit, Err(AppError::NotFound(_))));

        subjects::restore(&conn, &gone).expect("restore");
        assert_eq!(get_page(&conn, &hidden.id).expect("back").title, "Cachée");
        assert!(
            resolve_link(&conn, NoteLinkKind::Page, &hidden.id, "")
                .expect("link")
                .alive
        );
        assert_eq!(backlinks(&conn, &target.id).expect("backlinks").len(), 1);
        assert_eq!(task_mentions(&conn, &t).expect("mentions").len(), 1);
    }

    /// m1: pinning a page already pinned writes nothing.
    #[test]
    fn pinning_a_pinned_page_again_writes_nothing() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let p = page_in(&conn, &s, None, "P");
        let pin = |id: &str| {
            move_page(
                &conn,
                &MoveNotePageInput {
                    id: id.into(),
                    target: NoteTarget::Pinned,
                    index: None,
                },
            )
            .expect("pin")
        };
        pin(&p.id);
        conn.execute(
            "UPDATE note_pages SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1",
            [&p.id],
        )
        .expect("age");
        let first = get_page(&conn, &p.id).expect("page");
        let before = outbox_len(&conn);
        let seq: i64 = conn
            .query_row("SELECT seq FROM sync_guard WHERE id = 1", [], |r| r.get(0))
            .expect("seq");
        let again = pin(&p.id);
        assert_eq!(again.updated_at, first.updated_at);
        assert_eq!(outbox_len(&conn), before);
        let seq_after: i64 = conn
            .query_row("SELECT seq FROM sync_guard WHERE id = 1", [], |r| r.get(0))
            .expect("seq");
        assert_eq!(seq_after, seq);
    }

    /// m2: a summary sent « outside any group » lands in « Résumés de tâches ».
    #[test]
    fn a_summary_moved_outside_any_group_goes_to_the_summaries() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let g = group(&conn, &s, "G");
        let first = summary(&conn, &s, "R1");
        let r = summary(&conn, &s, "R2");
        move_page(
            &conn,
            &MoveNotePageInput {
                id: r.id.clone(),
                target: NoteTarget::Group { id: g.id.clone() },
                index: None,
            },
        )
        .expect("into group");
        let back = move_page(
            &conn,
            &MoveNotePageInput {
                id: r.id.clone(),
                target: NoteTarget::Ungrouped,
                index: Some(0),
            },
        )
        .expect("out");
        assert_eq!(back.group_id, None);
        let view = crate::views::notes::notebook(&conn, &s).expect("view");
        assert!(view.ungrouped.is_empty());
        let order: Vec<&str> = view.summaries.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(order, vec![r.id.as_str(), first.id.as_str()]);
    }

    #[test]
    fn unpin_keeps_the_group_and_the_position() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let g = group(&conn, &s, "G");
        let a = page_in(&conn, &s, Some(&g.id), "A");
        let p = page_in(&conn, &s, Some(&g.id), "P");
        let b = page_in(&conn, &s, Some(&g.id), "B");
        let pinned = set_pinned(&conn, &p.id, true).expect("pin");
        assert!(pinned.pinned_at.is_some());
        let (_, pages) = list_for_subject(&conn, &s).expect("list");
        assert_eq!(titles(&pages, Some(&g.id)), vec!["A", "B"]);
        let unpinned = set_pinned(&conn, &p.id, false).expect("unpin");
        assert_eq!(unpinned.pinned_at, None);
        assert_eq!(unpinned.group_id.as_deref(), Some(g.id.as_str()));
        assert_eq!(unpinned.position, p.position);
        let (_, pages) = list_for_subject(&conn, &s).expect("list");
        assert_eq!(titles(&pages, Some(&g.id)), vec!["A", "P", "B"]);
        // Unpinning an unpinned page writes nothing.
        let before = outbox_len(&conn);
        let same = set_pinned(&conn, &p.id, false).expect("unpin again");
        assert_eq!(same.updated_at, unpinned.updated_at);
        assert_eq!(outbox_len(&conn), before);
        let _ = (a, b);
    }

    #[test]
    fn unpin_after_its_group_died_lands_outside_any_group() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let g = group(&conn, &s, "G");
        let p = page_in(&conn, &s, Some(&g.id), "P");
        let sum = summary(&conn, &s, "Résumé");
        let sum = move_page(
            &conn,
            &MoveNotePageInput {
                id: sum.id,
                target: NoteTarget::Group { id: g.id.clone() },
                index: None,
            },
        )
        .expect("summary into group");
        set_pinned(&conn, &p.id, true).expect("pin");
        set_pinned(&conn, &sum.id, true).expect("pin summary");
        delete_group(&conn, &g.id).expect("delete group");
        let p = set_pinned(&conn, &p.id, false).expect("unpin");
        let sum = set_pinned(&conn, &sum.id, false).expect("unpin summary");
        assert_eq!((p.group_id, p.pinned_at), (None, None));
        assert_eq!((sum.group_id, sum.kind), (None, NoteKind::Summary));
    }

    #[test]
    fn duplicate_copies_right_after_the_original() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let g = group(&conn, &s, "G");
        let a = page_in(&conn, &s, Some(&g.id), "A");
        page_in(&conn, &s, Some(&g.id), "B");
        update_page(
            &conn,
            &UpdateNotePageInput {
                id: a.id.clone(),
                title: None,
                body: Some("Texte **gras**".into()),
            },
        )
        .expect("body");
        let copy = duplicate_page(&conn, &a.id).expect("duplicate");
        assert_ne!(copy.id, a.id);
        assert_eq!(copy.title, "A (copie)");
        assert_eq!(copy.body, "Texte **gras**");
        assert_eq!(copy.kind, NoteKind::Page);
        assert_eq!(copy.group_id.as_deref(), Some(g.id.as_str()));
        assert_eq!(copy.pinned_at, None);
        let (_, pages) = list_for_subject(&conn, &s).expect("list");
        assert_eq!(titles(&pages, Some(&g.id)), vec!["A", "A (copie)", "B"]);
        // A summary stays a summary, in « Résumés de tâches ».
        let sum = summary(&conn, &s, "Résumé");
        let sum_copy = duplicate_page(&conn, &sum.id).expect("duplicate summary");
        assert_eq!(
            (sum_copy.kind, sum_copy.group_id),
            (NoteKind::Summary, None)
        );
    }

    #[test]
    fn duplicate_of_a_long_title_stays_within_the_limit() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        // 249 « é » (2 bytes each) + « x » = 499 bytes.
        let long = format!("{}x", "é".repeat(249));
        let p = page_in(&conn, &s, None, &long);
        let copy = duplicate_page(&conn, &p.id).expect("duplicate");
        assert!(copy.title.len() <= MAX_NOTE_TITLE_BYTES);
        assert!(copy.title.ends_with(" (copie)"));
        assert!(copy.title.starts_with("éé"));
        assert!(matches!(
            duplicate_page(&conn, "missing"),
            Err(AppError::NotFound(_))
        ));
    }
}
