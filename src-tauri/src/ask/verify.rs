//! Each source the agent cites is checked before it is shown: the item is the project's and holds the quoted sentence. Compared on words only
//! (`norm`): case, accents, punctuation, Markdown and line breaks do not count, every word does.

use std::path::Path;

use rusqlite::{params_from_iter, Connection, OptionalExtension};

use crate::db::questions;
use crate::error::AppResult;
use crate::views::notes::plain_text;
use crate::views::search::fold;

use super::{search, RawSource, Scope, Source, SourceKind};

/// Largest file read to check a quote.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// A quote shorter than this (once normalized) proves nothing: refused.
const MIN_QUOTE_CHARS: usize = 8;

/// Folded words separated by one space.
pub fn norm(text: &str) -> String {
    fold(text)
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn holds(text: &str, quote: &str) -> bool {
    // Padded so that « prix » is not found inside « surprix ».
    format!(" {} ", norm(text)).contains(&format!(" {quote} "))
}

fn in_scope(scope: &Scope) -> String {
    vec!["?"; scope.subjects.len()].join(", ")
}

fn with_id(id: &str, scope: &Scope) -> Vec<String> {
    let mut v = vec![id.to_string()];
    v.extend(scope.subjects.iter().cloned());
    v
}

/// Checks one cited source; `found` tells whether it holds.
pub fn check(conn: &Connection, scope: &Scope, raw: &RawSource) -> AppResult<Source> {
    let quote = raw.quote.trim().to_string();
    let reference = raw.reference.trim().to_string();
    let mut source = Source {
        kind: SourceKind::parse(&raw.kind),
        reference: reference.clone(),
        quote: quote.clone(),
        label: reference.clone(),
        at: None,
        task_id: None,
        found: false,
    };
    let q = norm(&quote);
    if q.chars().count() < MIN_QUOTE_CHARS || reference.is_empty() {
        return Ok(source);
    }
    match source.kind {
        SourceKind::Page => {
            let row: Option<(String, String, String)> = conn
                .query_row(
                    &format!(
                        "SELECT title, body, updated_at FROM note_pages WHERE id = ?1 \
                         AND deleted_at IS NULL AND subject_id IN ({})",
                        in_scope(scope)
                    ),
                    params_from_iter(with_id(&reference, scope)),
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            if let Some((title, body, at)) = row {
                source.found =
                    holds(&format!("{title}\n{}", plain_text(&body)), &q) || holds(&body, &q);
                source.label = title;
                source.at = Some(at);
            }
        }
        SourceKind::Task => {
            let row: Option<(String, String, Option<String>)> = conn
                .query_row(
                    &format!(
                        "SELECT title, description, completed_at FROM tasks WHERE id = ?1 \
                         AND deleted_at IS NULL AND subject_id IN ({})",
                        in_scope(scope)
                    ),
                    params_from_iter(with_id(&reference, scope)),
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            if let Some((title, note, completed_at)) = row {
                source.found = holds(&format!("{title}\n{}", plain_text(&note)), &q);
                source.label = title;
                source.at = completed_at;
                source.task_id = Some(reference.clone());
            }
        }
        SourceKind::Conversation => {
            if let Some((title, exchanges)) = search::session_exchanges(conn, scope, &reference)? {
                source.found = exchanges.iter().any(|e| holds(&e.text, &q));
                source.label = title;
                source.at = exchanges.last().map(|e| e.at.clone());
                source.task_id = conn
                    .query_row(
                        "SELECT task_id FROM agent_sessions WHERE id = ?1",
                        [&reference],
                        |r| r.get(0),
                    )
                    .optional()?;
            } else if let Ok(subject) = questions::subject_of(conn, &reference) {
                if scope.subjects.contains(&subject) {
                    let entry = questions::get(conn, &reference)?;
                    source.found = holds(&format!("{}\n{}", entry.question, entry.answer), &q);
                    source.label = entry.question;
                    source.at = Some(entry.asked_at);
                }
            }
        }
        SourceKind::File => {
            if let Some(root) = &scope.root {
                if let Some((relative, text)) = read_inside(root, &reference) {
                    source.found = holds(&text, &q);
                    source.label = relative.clone();
                    // Relative from now on: the UI opens it under the project's folder.
                    source.reference = relative;
                }
            }
        }
        SourceKind::Unknown => {}
    }
    Ok(source)
}

/// The file at `reference` (relative to `root`, or absolute) when it lies inside `root` once
/// links are resolved, is small and is text: its path relative to `root` and its text.
pub fn read_inside(root: &Path, reference: &str) -> Option<(String, String)> {
    let root = root.canonicalize().ok()?;
    let given = Path::new(reference);
    let path = if given.is_absolute() {
        given.to_path_buf()
    } else {
        root.join(given)
    };
    let real = path.canonicalize().ok()?;
    let relative = real
        .strip_prefix(&root)
        .ok()?
        .to_string_lossy()
        .into_owned();
    let meta = std::fs::metadata(&real).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(&real).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    Some((relative, String::from_utf8_lossy(&bytes).into_owned()))
}

/// Checks every source, the same one cited twice kept once (its first check that holds).
pub fn check_all(conn: &Connection, scope: &Scope, raw: &[RawSource]) -> AppResult<Vec<Source>> {
    let mut out: Vec<Source> = Vec::new();
    for r in raw {
        let s = check(conn, scope, r)?;
        match out
            .iter_mut()
            .find(|o| o.kind == s.kind && o.reference == s.reference)
        {
            Some(o) if !o.found && s.found => *o = s,
            Some(_) => {}
            None => out.push(s),
        }
    }
    Ok(out)
}
