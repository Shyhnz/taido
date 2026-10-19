//! The app's folder: `~/Taido` (`~/Todo` before the product got its
//! name on 2026-10-06), created at first launch, in the home folder rather than Documents so
//! that macOS asks no permission (a workspace recorded before, such as `~/Todo` or
//! `~/Documents/Todo`, is kept). Every project without folder gets `<workspace>/<name>`, every
//! sub-project `<its parent's folder>/<name>` (see `subjects::ensure_own_folder`), and tasks
//! without project work in `<workspace>/Sans projet`. Projects linked to a folder of their
//! own keep it. Only folders are created, never a file in them.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};

use crate::db::{now_utc, settings, subjects};
use crate::error::AppResult;

/// Name of the app's folder in the home folder (the product's name, to rename with it).
pub const FOLDER_NAME: &str = "Taido";
/// Folder of the tasks without project.
pub const NO_PROJECT_FOLDER: &str = "Sans projet";

/// The workspace folder recorded in the settings.
pub fn root(conn: &Connection) -> AppResult<Option<PathBuf>> {
    Ok(settings::get(conn)?.workspace_root.map(PathBuf::from))
}

/// Folder of the tasks without project (`None` before the first launch).
pub fn no_project_folder(conn: &Connection) -> AppResult<Option<String>> {
    Ok(root(conn)?.map(|r| r.join(NO_PROJECT_FOLDER).to_string_lossy().into_owned()))
}

/// At startup: records `<home>/Taido` the first time (a folder recorded before is kept),
/// creates it and « Sans projet », then gives every project without folder its own.
/// Returns the number of projects that got a folder.
pub fn ensure(conn: &Connection, home: &Path) -> AppResult<usize> {
    let root = match root(conn)? {
        Some(r) => r,
        None => {
            let r = home.join(FOLDER_NAME);
            settings::set_workspace_root(conn, &r.to_string_lossy())?;
            r
        }
    };
    std::fs::create_dir_all(root.join(NO_PROJECT_FOLDER))?;
    let mut stmt = conn.prepare(
        "SELECT id FROM subjects WHERE root_path IS NULL AND deleted_at IS NULL \
         AND is_group = 0 ORDER BY parent_id IS NOT NULL, position",
    )?;
    let ids: Vec<String> = stmt
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let mut created = 0;
    for id in ids {
        // One project's failure (a name the disk refuses, a folder without permission) never
        // stops the others: names come from the phone too.
        match ensure_project_folder(conn, &id) {
            Ok(Some(_)) => created += 1,
            Ok(None) => {}
            Err(e) => log::warn!("cannot create the folder of project {id}: {e}"),
        }
    }
    Ok(created)
}

/// A project without folder gets one: in the workspace for a top-level project, in its
/// parent's folder for a sub-project. Another project's folder is never shared: a name
/// already taken gets « (2) », « (3) »… Returns the folder set, `None` when nothing to do.
pub fn ensure_project_folder(conn: &Connection, id: &str) -> AppResult<Option<String>> {
    let subject = subjects::get(conn, id)?;
    // A group has no folder (Taido V2.2 bis).
    if subject.root_path.is_some() || subject.is_group {
        return Ok(None);
    }
    // A project of a group gets its folder in the app's folder, like any project.
    let parent = match &subject.parent_id {
        Some(p) if !subjects::get(conn, p)?.is_group => Some(p.clone()),
        _ => None,
    };
    let base = match &parent {
        // A parent's folder that is gone is never recreated: the sub-project waits.
        Some(parent) => match subjects::get(conn, parent)?.root_path {
            Some(p) if Path::new(&p).is_dir() => PathBuf::from(p),
            _ => return Ok(None),
        },
        // The app's own folder is created when missing.
        None => match root(conn)? {
            Some(r) => {
                std::fs::create_dir_all(&r)?;
                r
            }
            None => return Ok(None),
        },
    };
    let name = subjects::folder_name(&subject.name);
    let mut dir = base.join(&name);
    let mut n = 2;
    while taken(conn, &dir.to_string_lossy(), id)? {
        dir = base.join(format!("{name} ({n})"));
        n += 1;
    }
    std::fs::create_dir_all(&dir)?;
    let path = dir.to_string_lossy().into_owned();
    conn.execute(
        "UPDATE subjects SET root_path = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, path, now_utc()],
    )?;
    Ok(Some(path))
}

/// Another live project already works in this folder.
fn taken(conn: &Connection, path: &str, id: &str) -> AppResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM subjects WHERE root_path = ?1 AND id <> ?2 AND deleted_at IS NULL",
        params![path, id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

#[cfg(test)]
mod tests;
