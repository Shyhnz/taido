//! What the agent finds with `search_project` and `search_conversations`: the notebook's
//! pages, the completed tasks and the past conversations of a project (and its sub-projects),
//! case and accent insensitive (`views::search::fold`). Done in memory: a project holds a few
//! hundred of them.

use rusqlite::{params_from_iter, Connection};
use serde::Serialize;

use crate::db::questions;
use crate::error::AppResult;
use crate::views::notes::plain_text;
use crate::views::search::fold;

use super::Scope;

/// Hits returned at most by one search.
pub const MAX_HITS: usize = 20;
/// Characters of a hit's excerpt.
const EXCERPT_CHARS: usize = 240;
/// Query words shorter than this are ignored (« le », « de »…), unless all are.
const MIN_WORD_CHARS: usize = 3;

/// One search result, as the agent reads it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Hit {
    /// `page`, `task` or `conversation` (the `kind` of a source citing it).
    pub kind: &'static str,
    /// What `read_note_page`, `read_task` or `read_conversation` takes, and a source's `ref`.
    pub id: String,
    pub title: String,
    /// Last change, completion or exchange (ISO 8601).
    pub at: String,
    pub excerpt: String,
    #[serde(skip)]
    score: usize,
}

fn words(query: &str) -> Vec<String> {
    let folded = fold(query);
    let all: Vec<String> = folded
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect();
    let long: Vec<String> = all
        .iter()
        .filter(|w| w.chars().count() >= MIN_WORD_CHARS)
        .cloned()
        .collect();
    if long.is_empty() {
        all
    } else {
        long
    }
}

/// Distinct query words found in `text` (already folded).
fn found(words: &[String], folded: &str) -> usize {
    words.iter().filter(|w| folded.contains(w.as_str())).count()
}

/// The line of `text` holding the most query words, cut around the first one.
fn excerpt(text: &str, words: &[String]) -> String {
    let best = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .max_by_key(|l| found(words, &fold(l)))
        .unwrap_or("");
    let chars: Vec<char> = best.chars().collect();
    if chars.len() <= EXCERPT_CHARS {
        return best.to_string();
    }
    // Start a little before the first word found (folding keeps one char per char, except
    // for « œ », « æ », « ß »: close enough for an excerpt).
    let folded = fold(best);
    let at = words
        .iter()
        .filter_map(|w| folded.find(w.as_str()))
        .min()
        .map(|byte| folded[..byte].chars().count())
        .unwrap_or(0);
    let start = at
        .saturating_sub(60)
        .min(chars.len().saturating_sub(EXCERPT_CHARS));
    let mut out: String = chars[start..start + EXCERPT_CHARS].iter().collect();
    if start > 0 {
        out.insert(0, '…');
    }
    if start + EXCERPT_CHARS < chars.len() {
        out.push('…');
    }
    out
}

/// Score of an item: query words in the title count double. `None` when none is found.
fn score(words: &[String], title: &str, text: &str) -> Option<usize> {
    let in_title = found(words, &fold(title));
    let in_text = found(words, &fold(text));
    let s = in_title * 2 + in_text;
    (s > 0).then_some(s)
}

fn finish(mut hits: Vec<Hit>) -> Vec<Hit> {
    hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| b.at.cmp(&a.at)));
    hits.truncate(MAX_HITS);
    hits
}

fn placeholders(n: usize) -> String {
    vec!["?"; n].join(", ")
}

/// Pages of the notebook and completed tasks (title and note) of the project.
pub fn search_project(conn: &Connection, scope: &Scope, query: &str) -> AppResult<Vec<Hit>> {
    let words = words(query);
    if words.is_empty() {
        return Ok(Vec::new());
    }
    let ids = placeholders(scope.subjects.len());
    let mut hits = Vec::new();
    let mut stmt = conn.prepare(&format!(
        "SELECT id, title, body, updated_at FROM note_pages \
         WHERE deleted_at IS NULL AND subject_id IN ({ids})"
    ))?;
    let rows = stmt.query_map(params_from_iter(&scope.subjects), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    for row in rows {
        let (id, title, body, at) = row?;
        let text = plain_text(&body);
        if let Some(score) = score(&words, &title, &text) {
            hits.push(Hit {
                kind: "page",
                id,
                excerpt: excerpt(&text, &words),
                title,
                at,
                score,
            });
        }
    }
    let mut stmt = conn.prepare(&format!(
        "SELECT id, title, description, completed_at FROM tasks \
         WHERE deleted_at IS NULL AND completed_at IS NOT NULL AND subject_id IN ({ids})"
    ))?;
    let rows = stmt.query_map(params_from_iter(&scope.subjects), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    for row in rows {
        let (id, title, note, at) = row?;
        let text = plain_text(&note);
        if let Some(score) = score(&words, &title, &text) {
            hits.push(Hit {
                kind: "task",
                id,
                excerpt: excerpt(&text, &words),
                title,
                at,
                score,
            });
        }
    }
    Ok(finish(hits))
}

/// One exchange of a past conversation.
pub struct Exchange {
    /// « Utilisateur », « Claude » or « Codex ».
    pub who: String,
    pub text: String,
    pub at: String,
}

/// The exchanges (user prompts and agent replies) of an agent session, oldest first, and
/// the title of its task; `None` when the session is not one of the project's.
pub fn session_exchanges(
    conn: &Connection,
    scope: &Scope,
    session_id: &str,
) -> AppResult<Option<(String, Vec<Exchange>)>> {
    let ids = placeholders(scope.subjects.len());
    let mut args: Vec<String> = vec![session_id.to_string()];
    args.extend(scope.subjects.iter().cloned());
    let mut stmt = conn.prepare(&format!(
        "SELECT t.title, j.kind, j.text, j.at, a.agent FROM journal_entries j \
         JOIN agent_sessions a ON a.id = j.agent_session_id \
         JOIN tasks t ON t.id = a.task_id \
         WHERE j.agent_session_id = ?1 AND t.deleted_at IS NULL \
         AND j.kind IN ('prompt', 'turn_ended') AND t.subject_id IN ({ids}) \
         ORDER BY j.at, j.rowid"
    ))?;
    let rows = stmt.query_map(params_from_iter(&args), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
        ))
    })?;
    let mut title = None;
    let mut out = Vec::new();
    for row in rows {
        let (t, kind, text, at, agent) = row?;
        title.get_or_insert(t);
        if text.trim().is_empty() {
            continue;
        }
        let who = if kind == "prompt" {
            "Utilisateur".to_string()
        } else {
            crate::model::Agent::parse(&agent)
                .unwrap_or_default()
                .label()
                .to_string()
        };
        out.push(Exchange { who, text, at });
    }
    Ok(title.map(|t| (t, out)))
}

/// Past conversations of the project: the agent sessions of its tasks (open or completed),
/// and the questions already asked to it (`questions::`). One hit per session or question.
pub fn search_conversations(conn: &Connection, scope: &Scope, query: &str) -> AppResult<Vec<Hit>> {
    let words = words(query);
    if words.is_empty() {
        return Ok(Vec::new());
    }
    let ids = placeholders(scope.subjects.len());
    let mut stmt = conn.prepare(&format!(
        "SELECT a.id FROM agent_sessions a JOIN tasks t ON t.id = a.task_id \
         WHERE t.deleted_at IS NULL AND t.subject_id IN ({ids})"
    ))?;
    let sessions: Vec<String> = stmt
        .query_map(params_from_iter(&scope.subjects), |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let mut hits = Vec::new();
    for id in sessions {
        let Some((title, exchanges)) = session_exchanges(conn, scope, &id)? else {
            continue;
        };
        let mut best: Option<(usize, &Exchange)> = None;
        let mut total = 0;
        for e in &exchanges {
            let n = found(&words, &fold(&e.text));
            total = total.max(n);
            if n > 0 && best.is_none_or(|(b, _)| n > b) {
                best = Some((n, e));
            }
        }
        let Some((_, e)) = best else {
            continue;
        };
        let at = exchanges.last().map(|x| x.at.clone()).unwrap_or_default();
        hits.push(Hit {
            kind: "conversation",
            excerpt: format!("{} : {}", e.who, excerpt(&e.text, &words)),
            id,
            title: format!("Conversation de la tâche « {title} »"),
            at,
            score: total,
        });
    }
    for q in questions::for_subjects(conn, &scope.subjects)? {
        let text = format!("{}\n{}", q.question, q.answer);
        if let Some(score) = score(&words, &q.question, &q.answer) {
            hits.push(Hit {
                kind: "conversation",
                excerpt: excerpt(&text, &words),
                title: format!("Question déjà posée : {}", q.question),
                id: q.id,
                at: q.asked_at,
                score,
            });
        }
    }
    Ok(finish(hits))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_ignore_short_ones_unless_all_are() {
        assert_eq!(words("le Prix pilote"), vec!["prix", "pilote"]);
        assert_eq!(words("de la"), vec!["de", "la"]);
        assert!(words("  ").is_empty());
    }

    #[test]
    fn excerpt_takes_the_best_line_and_cuts_long_ones() {
        let w = words("pilote");
        assert_eq!(
            excerpt("Titre\nLe prix pilote : 25 €\nautre", &w),
            "Le prix pilote : 25 €"
        );
        let long = format!("{} pilote {}", "a ".repeat(200), "b ".repeat(200));
        let e = excerpt(&long, &w);
        assert!(e.starts_with('…') && e.ends_with('…'), "{e}");
        assert!(e.contains("pilote"));
    }
}
