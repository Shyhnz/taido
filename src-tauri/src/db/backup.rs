//! Daily database backup: `VACUUM INTO` a dated file, 7 copies kept.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::NaiveDate;
use rusqlite::Connection;

use crate::error::AppResult;

pub const KEEP: usize = 7;
const PREFIX: &str = "todo-agents-";
const SUFFIX: &str = ".sqlite3";

/// Backs the database up into `dir` unless today's file already exists, then prunes old
/// copies. Returns the path written, if any.
pub fn daily(conn: &Connection, dir: &Path, today: NaiveDate) -> AppResult<Option<PathBuf>> {
    fs::create_dir_all(dir)?;
    let target = dir.join(format!("{PREFIX}{}{SUFFIX}", today.format("%Y-%m-%d")));
    let written = if target.exists() {
        None
    } else {
        conn.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()])?;
        Some(target)
    };
    prune(dir, KEEP)?;
    Ok(written)
}

/// Keeps the `keep` most recent backups (the date in the name sorts chronologically).
pub fn prune(dir: &Path, keep: usize) -> AppResult<Vec<PathBuf>> {
    let mut backups: Vec<PathBuf> = fs::read_dir(dir)?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(PREFIX) && n.ends_with(SUFFIX))
        })
        .collect();
    backups.sort();
    let excess = backups.len().saturating_sub(keep);
    let removed: Vec<PathBuf> = backups.into_iter().take(excess).collect();
    for path in &removed {
        fs::remove_file(path)?;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::task;
    use crate::db::{open, tasks};

    #[test]
    fn writes_once_per_day_and_keeps_seven() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open(&dir.path().join("db.sqlite3")).expect("db");
        let id = task(&conn, "backed up", None, None);
        let backups = dir.path().join("backups");
        for day in 1..=9 {
            let date = NaiveDate::from_ymd_opt(2026, 9, day).expect("date");
            assert!(daily(&conn, &backups, date).expect("backup").is_some());
        }
        let today = NaiveDate::from_ymd_opt(2026, 9, 9).expect("date");
        assert_eq!(daily(&conn, &backups, today).expect("backup"), None);

        let mut names: Vec<String> = fs::read_dir(&backups)
            .expect("read_dir")
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        let expected: Vec<String> = (3..=9)
            .map(|d| format!("todo-agents-2026-09-0{d}.sqlite3"))
            .collect();
        assert_eq!(names, expected);

        let copy = open(&backups.join("todo-agents-2026-09-09.sqlite3")).expect("copy");
        assert_eq!(tasks::load(&copy, &id).expect("task").title, "backed up");
    }

    #[test]
    fn prune_ignores_other_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(dir.path().join("notes.txt"), "x").expect("write");
        fs::write(dir.path().join("todo-agents-2026-01-01.sqlite3"), "x").expect("write");
        fs::write(dir.path().join("todo-agents-2026-01-02.sqlite3"), "x").expect("write");
        let removed = prune(dir.path(), 1).expect("prune");
        assert_eq!(
            removed,
            vec![dir.path().join("todo-agents-2026-01-01.sqlite3")]
        );
        assert!(dir.path().join("notes.txt").exists());
    }
}
