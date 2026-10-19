//! Soft delete: deleting a task or a subject stamps `deleted_at`,
//! every query ignores stamped rows, `restore_*` clears the stamp, and rows deleted more
//! than [`RETENTION`] ago are purged for good at startup.
//!
//! Deleting a subject stamps its live tasks with the **same instant**: restoring the subject
//! brings back exactly those tasks, not the ones deleted on their own before.

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};

use crate::db::attachments::{self, FreedFile};
use crate::db::notes;
use crate::error::AppResult;

/// How long a deleted row can be restored.
pub const RETENTION: Duration = Duration::hours(24);

/// Rows removed by [`purge`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Purged {
    pub subjects: usize,
    pub tasks: usize,
    /// Notebook pages (their images go with them).
    pub pages: usize,
}

/// Deletes for good the subjects, tasks and notebook pages soft-deleted before `now - RETENTION`.
/// Sections, subtasks, journal entries, notebooks (and their page images) and attachments
/// follow by cascade; the files of those
/// attachments are removed after the commit (V2.7 bis: their tombstones free the server's
/// copies too), unless a live attachment still points at them or the copy is not the
/// attachment's file any more (edited in place, or never hashed): then it stays.
///
/// Removes the files at once (they are hashed first): tests only; the app uses
/// [`purge_rows`] and removes them outside the database lock.
#[cfg(test)]
pub fn purge(conn: &Connection, now: DateTime<Utc>) -> AppResult<Purged> {
    let (purged, files) = purge_rows(conn, now)?;
    attachments::remove_freed(&files);
    Ok(purged)
}

/// [`purge`] without touching the files: returns what to remove of the purged attachments'
/// files, for [`attachments::remove_freed`] to do once the database lock is released (it
/// hashes every copy).
pub fn purge_rows(
    conn: &Connection,
    now: DateTime<Utc>,
) -> AppResult<(Purged, Vec<attachments::Removal>)> {
    let cutoff = (now - RETENTION).to_rfc3339_opts(SecondsFormat::Millis, true);
    // Attachments that may go with the purged rows (more than needed: checked after).
    let candidates: Vec<FreedFile> = {
        let mut stmt = conn.prepare(
            "SELECT a.id, a.stored_path, a.sha256 FROM attachments a \
             JOIN tasks t ON t.id = a.task_id \
             LEFT JOIN tasks p ON p.id = t.parent_id \
             LEFT JOIN subjects s ON s.id = t.subject_id \
             LEFT JOIN subjects g ON g.id = s.parent_id \
             WHERE t.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL \
             OR s.deleted_at IS NOT NULL OR g.deleted_at IS NOT NULL \
             UNION \
             SELECT a.id, a.stored_path, a.sha256 FROM attachments a \
             JOIN note_pages np ON np.id = a.note_page_id \
             JOIN subjects s ON s.id = np.subject_id \
             LEFT JOIN subjects g ON g.id = s.parent_id \
             WHERE np.deleted_at IS NOT NULL OR s.deleted_at IS NOT NULL \
             OR g.deleted_at IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(FreedFile {
                id: r.get(0)?,
                path: r.get(1)?,
                sha256: r.get(2)?,
            })
        })?;
        rows.collect::<Result<_, _>>()?
    };
    let tx = conn.unchecked_transaction()?;
    hand_over_shared_images(&tx, &cutoff)?;
    // Subjects first: their tasks go with them by cascade.
    let subjects = tx.execute(
        "DELETE FROM subjects WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
        [&cutoff],
    )?;
    let tasks = tx.execute(
        "DELETE FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
        [&cutoff],
    )?;
    let pages = tx.execute(
        "DELETE FROM note_pages WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
        [&cutoff],
    )?;
    tx.commit()?;
    let mut gone = Vec::new();
    for file in candidates {
        let here = conn
            .query_row(
                "SELECT 1 FROM attachments WHERE id = ?1",
                [&file.id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !here {
            gone.push(file);
        }
    }
    let files = attachments::removals(conn, gone).unwrap_or_else(|e| {
        log::warn!("purge: cannot list the files of purged attachments: {e}");
        Vec::new()
    });
    Ok((
        Purged {
            subjects,
            tasks,
            pages,
        },
        files,
    ))
}

/// Before the pages deleted before `cutoff` (or whose project is) go: each of their images
/// that another page still shows (`[[file:<id>`, a live page first, else a deleted one not
/// purged yet) becomes that page's, so it syncs as a change of its new page and keeps its row
/// and file; a duplicated page (or one where a pasted image could not be copied) shares the
/// original's image ids. The images no other page shows go with their page.
fn hand_over_shared_images(conn: &Connection, cutoff: &str) -> AppResult<()> {
    const DOOMED: &str = "SELECT np.id FROM note_pages np \
         JOIN subjects s ON s.id = np.subject_id \
         LEFT JOIN subjects g ON g.id = s.parent_id \
         WHERE (np.deleted_at IS NOT NULL AND np.deleted_at < ?1) \
         OR (s.deleted_at IS NOT NULL AND s.deleted_at < ?1) \
         OR (g.deleted_at IS NOT NULL AND g.deleted_at < ?1)";
    let images: Vec<String> = {
        let sql = format!("SELECT id FROM attachments WHERE note_page_id IN ({DOOMED})");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([cutoff], |r| r.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    if images.is_empty() {
        return Ok(());
    }
    let sql = format!(
        "SELECT id, body FROM note_pages WHERE id NOT IN ({DOOMED}) AND instr(body, ?2) > 0 \
         ORDER BY deleted_at IS NOT NULL, updated_at DESC, id"
    );
    let mut holders = conn.prepare(&sql)?;
    let now = crate::db::now_utc();
    for image in images {
        let rows = holders.query_map(params![cutoff, format!("[[file:{image}")], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut holder = None;
        for row in rows {
            let (page, body) = row?;
            if notes::links_in(&body)
                .iter()
                .any(|(k, id)| *k == notes::LinkKind::File && *id == image)
            {
                holder = Some(page);
                break;
            }
        }
        if let Some(page) = holder {
            conn.execute(
                "UPDATE attachments SET note_page_id = ?2, updated_at = ?3 WHERE id = ?1",
                params![image, page, now],
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::db::test_support::{subject, task};

    fn stamp(conn: &Connection, table: &str, id: &str, at: &str) {
        conn.execute(
            &format!("UPDATE {table} SET deleted_at = ?2 WHERE id = ?1"),
            [id, at],
        )
        .expect("stamp");
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).expect("count")
    }

    /// The rows go under the lock; the files are hashed and removed after it, and a copy
    /// edited in place stays.
    #[test]
    fn purged_files_are_removed_after_the_rows_and_an_edited_copy_stays() {
        let conn = open_in_memory().expect("db");
        let dir = tempfile::tempdir().expect("dir");
        crate::db::settings::set_workspace_root(&conn, &dir.path().join("Taido").to_string_lossy())
            .expect("root");
        let t = task(&conn, "Ancien", None, None);
        let mut copies = Vec::new();
        for (name, bytes) in [("photo.jpg", &b"photo"[..]), ("notes.txt", &b"notes"[..])] {
            let original = dir.path().join(name);
            std::fs::write(&original, bytes).expect("original");
            attachments::add_files(
                &conn,
                attachments::AttachmentOwner::Task(&t),
                &[original.to_string_lossy().into_owned()],
            )
            .expect("attach");
        }
        for a in attachments::list(&conn, &t).expect("list") {
            copies.push((a.file_name, std::path::PathBuf::from(a.path)));
        }
        let notes = &copies
            .iter()
            .find(|(n, _)| n == "notes.txt")
            .expect("notes")
            .1;
        let photo = &copies
            .iter()
            .find(|(n, _)| n == "photo.jpg")
            .expect("photo")
            .1;
        std::fs::write(notes, b"notes reprises ici").expect("edit in place");
        stamp(&conn, "tasks", &t, "2026-09-01T00:00:00.000Z");
        let now = DateTime::parse_from_rfc3339("2026-10-02T12:00:00.000Z")
            .expect("now")
            .with_timezone(&Utc);

        let (purged, files) = purge_rows(&conn, now).expect("purge");
        assert_eq!(purged.tasks, 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM attachments"), 0);
        assert_eq!(files.len(), 2);
        assert!(
            photo.is_file() && notes.is_file(),
            "nothing removed under the lock"
        );
        assert_eq!(attachments::remove_freed(&files), 1);
        assert!(!photo.exists());
        assert_eq!(std::fs::read(notes).expect("kept"), b"notes reprises ici");
    }

    #[test]
    fn purges_only_rows_deleted_more_than_a_day_ago() {
        let conn = open_in_memory().expect("db");
        let now = DateTime::parse_from_rfc3339("2026-10-02T12:00:00.000Z")
            .expect("now")
            .with_timezone(&Utc);
        let old_subject = subject(&conn, "Old");
        let recent_subject = subject(&conn, "Recent");
        let in_old = task(&conn, "in old", Some(&old_subject), None);
        let old_task = task(&conn, "old task", None, None);
        let recent_task = task(&conn, "recent task", None, None);
        let live = task(&conn, "live", None, None);
        stamp(&conn, "subjects", &old_subject, "2026-10-01T11:59:59.999Z");
        stamp(&conn, "tasks", &in_old, "2026-10-01T11:59:59.999Z");
        stamp(
            &conn,
            "subjects",
            &recent_subject,
            "2026-10-01T12:00:00.001Z",
        );
        stamp(&conn, "tasks", &old_task, "2026-09-20T08:00:00.000Z");
        stamp(&conn, "tasks", &recent_task, "2026-10-02T11:00:00.000Z");

        let purged = purge(&conn, now).expect("purge");
        assert_eq!(
            purged,
            Purged {
                subjects: 1,
                tasks: 1,
                pages: 0
            }
        );
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM subjects"), 1);
        let left: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT title FROM tasks ORDER BY title")
                .expect("prepare");
            let rows = stmt.query_map([], |r| r.get(0)).expect("query");
            rows.collect::<Result<_, _>>().expect("rows")
        };
        assert_eq!(left, vec!["live", "recent task"]);
        let _ = live;
        assert_eq!(purge(&conn, now).expect("again"), Purged::default());
    }

    /// A soft-deleted notebook page goes after the retention delay, with its image rows and
    /// files; a recent one, a live one and another page's image stay.
    #[test]
    fn purges_old_deleted_note_pages_with_their_images() {
        use crate::db::attachments::AttachmentOwner;
        use crate::db::notes;
        use crate::model::{CreateNotePageInput, NoteKind};

        let conn = open_in_memory().expect("db");
        let dir = tempfile::tempdir().expect("dir");
        crate::db::settings::set_workspace_root(&conn, &dir.path().join("Taido").to_string_lossy())
            .expect("root");
        let s = subject(&conn, "S");
        let new_page = |title: &str| {
            notes::create_page(
                &conn,
                &CreateNotePageInput {
                    subject_id: s.clone(),
                    group_id: None,
                    title: title.into(),
                    body: String::new(),
                    kind: NoteKind::Page,
                    source_task_id: None,
                },
            )
            .expect("page")
            .id
        };
        let (old, recent, live) = (new_page("Old"), new_page("Recent"), new_page("Live"));
        let mut copies = Vec::new();
        for page in [&old, &recent, &live] {
            attachments::add_data(
                &conn,
                AttachmentOwner::NotePage(page),
                "i.png",
                "iVBORw0KGgo=",
            )
            .expect("image");
            let image = attachments::list_for_page(&conn, page)
                .expect("list")
                .remove(0);
            copies.push(std::path::PathBuf::from(image.path));
        }
        stamp(&conn, "note_pages", &old, "2026-09-01T00:00:00.000Z");
        stamp(&conn, "note_pages", &recent, "2026-10-02T11:00:00.000Z");
        let now = DateTime::parse_from_rfc3339("2026-10-02T12:00:00.000Z")
            .expect("now")
            .with_timezone(&Utc);

        let (purged, files) = purge_rows(&conn, now).expect("purge");
        assert_eq!(purged.pages, 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM note_pages"), 2);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM attachments"), 2);
        assert_eq!(files.len(), 1);
        assert!(copies[0].is_file(), "nothing removed under the lock");
        assert_eq!(attachments::remove_freed(&files), 1);
        assert!(!copies[0].exists());
        assert!(copies[1].is_file() && copies[2].is_file());
        assert_eq!(purge(&conn, now).expect("again"), Purged::default());
    }

    /// I1: a duplicated page shows the original's images (same ids). Purging the original
    /// hands each image still shown by another page (live, or deleted but not purged) to that
    /// page, so it syncs as a change, never as a tombstone; its row and file stay.
    #[test]
    fn purging_a_page_hands_its_shared_images_to_the_pages_that_show_them() {
        use crate::db::attachments::AttachmentOwner;
        use crate::db::notes;
        use crate::model::{CreateNotePageInput, NoteKind, UpdateNotePageInput};

        let conn = open_in_memory().expect("db");
        let dir = tempfile::tempdir().expect("dir");
        crate::db::settings::set_workspace_root(&conn, &dir.path().join("Taido").to_string_lossy())
            .expect("root");
        let s = subject(&conn, "S");
        let original = notes::create_page(
            &conn,
            &CreateNotePageInput {
                subject_id: s.clone(),
                group_id: None,
                title: "Maquettes".into(),
                body: String::new(),
                kind: NoteKind::Page,
                source_task_id: None,
            },
        )
        .expect("page")
        .id;
        let mut images = Vec::new();
        for _ in 0..3 {
            images.push(
                attachments::add_data(
                    &conn,
                    AttachmentOwner::NotePage(&original),
                    "i.png",
                    "iVBORw0KGgo=",
                )
                .expect("image"),
            );
        }
        let (shared, kept_by_deleted, alone) = (&images[0], &images[1], &images[2]);
        let body = format!("![[file:{shared}|50%]]\n\n![[file:{alone}]]");
        notes::update_page(
            &conn,
            &UpdateNotePageInput {
                id: original.clone(),
                title: None,
                body: Some(body),
            },
        )
        .expect("body");
        let copy = notes::duplicate_page(&conn, &original)
            .expect("duplicate")
            .id;
        notes::update_page(
            &conn,
            &UpdateNotePageInput {
                id: copy.clone(),
                title: None,
                body: Some(format!("![[file:{shared}|50%]]")),
            },
        )
        .expect("copy body");
        // A page deleted recently (restorable) still shows the second image.
        let recent = notes::duplicate_page(&conn, &original)
            .expect("duplicate")
            .id;
        notes::update_page(
            &conn,
            &UpdateNotePageInput {
                id: recent.clone(),
                title: None,
                body: Some(format!("![[file:{kept_by_deleted}]]")),
            },
        )
        .expect("recent body");
        let path_of = |id: &str| -> std::path::PathBuf {
            conn.query_row(
                "SELECT stored_path FROM attachments WHERE id = ?1",
                [id],
                |r| r.get::<_, String>(0),
            )
            .expect("path")
            .into()
        };
        let (shared_path, deleted_path, alone_path) =
            (path_of(shared), path_of(kept_by_deleted), path_of(alone));
        stamp(&conn, "note_pages", &original, "2026-09-01T00:00:00.000Z");
        stamp(&conn, "note_pages", &recent, "2026-10-02T11:00:00.000Z");
        let now = DateTime::parse_from_rfc3339("2026-10-02T12:00:00.000Z")
            .expect("now")
            .with_timezone(&Utc);

        let (purged, files) = purge_rows(&conn, now).expect("purge");
        assert_eq!(purged.pages, 1);
        let owner = |id: &str| -> Option<String> {
            conn.query_row(
                "SELECT note_page_id FROM attachments WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .optional()
            .expect("owner")
        };
        assert_eq!(owner(shared).as_deref(), Some(copy.as_str()));
        assert_eq!(owner(kept_by_deleted).as_deref(), Some(recent.as_str()));
        assert_eq!(owner(alone), None, "an image no other page shows goes");
        // Only the lone image's file is to remove; the shared ones stay on disk.
        assert_eq!(attachments::remove_freed(&files), 1);
        assert!(shared_path.is_file() && deleted_path.is_file());
        assert!(!alone_path.exists());
        // The handed-over images leave as changes of their new page, not as tombstones.
        let outbox = |id: &str| -> (String, i64) {
            conn.query_row(
                "SELECT entity, purged FROM sync_outbox WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("outbox")
        };
        assert_eq!(outbox(shared), ("note_attachment".to_string(), 0));
        assert_eq!(outbox(kept_by_deleted), ("note_attachment".to_string(), 0));
        assert_eq!(outbox(alone), ("note_attachment".to_string(), 1));
        // The copy still lists its image.
        let listed = attachments::list_for_page(&conn, &copy).expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(&listed[0].id, shared);
    }
}
