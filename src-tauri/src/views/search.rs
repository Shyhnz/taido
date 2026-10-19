//! ⌘K search: live tasks matched on their title, project
//! (and its parent project), section, case and accent insensitive, best matches first.

use std::cmp::Ordering;
use std::collections::HashMap;

use rusqlite::{Connection, Row};

use crate::db::subjects::parse_color;
use crate::error::AppResult;
use crate::model::{NoteHit, NoteKind, Ring, SectionTag, SubjectTag, TaskHit};
use crate::views::notes::plain_text;
use crate::views::rows::{self, Filter};

/// Hits returned at most.
pub const MAX_HITS: usize = 20;

/// How well a task matches, best first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Rank {
    /// The title starts with the whole query.
    TitleStart,
    /// A word of the title starts with a word of the query.
    WordStart,
    /// A word of the query is inside the title.
    InTitle,
    /// Matched through the project or the section only.
    Elsewhere,
}

struct Candidate {
    id: String,
    title: String,
    subject: Option<SubjectTag>,
    section: Option<SectionTag>,
    /// The parent project of a sub-project: « Globex » finds the tasks of
    /// « Globex › Client ». The hit's subject stays the sub-project.
    parent_name: Option<String>,
    completed: bool,
    updated_at: String,
}

/// Every word of `query` must be found in the title, the project or the section. Ordered by
/// open tasks first, then [`Rank`], then most recently updated; [`MAX_HITS`] at most. An
/// empty query finds nothing. Rings are derived like the list rows.
pub fn search(conn: &Connection, query: &str) -> AppResult<Vec<TaskHit>> {
    let folded = fold(query);
    let words: Vec<&str> = folded.split_whitespace().collect();
    if words.is_empty() {
        return Ok(Vec::new());
    }
    let phrase = words.join(" ");
    let mut stmt = conn.prepare(
        "SELECT t.id, t.title, t.subject_id, s.name, s.color, t.section_id, sc.name, \
         t.completed_at IS NOT NULL, t.updated_at, ps.name \
         FROM tasks t LEFT JOIN subjects s ON s.id = t.subject_id \
         LEFT JOIN subjects ps ON ps.id = s.parent_id \
         LEFT JOIN sections sc ON sc.id = t.section_id \
         WHERE t.deleted_at IS NULL",
    )?;
    let candidates = stmt.query_map([], candidate)?;
    let mut scored: Vec<(Rank, Candidate)> = Vec::new();
    for c in candidates {
        let c = c?;
        if let Some(rank) = rank(&c, &words, &phrase) {
            scored.push((rank, c));
        }
    }
    scored.sort_by(|(ra, a), (rb, b)| order(*ra, a, *rb, b));
    scored.truncate(MAX_HITS);

    let ids: Vec<String> = scored.iter().map(|(_, c)| c.id.clone()).collect();
    let rings: HashMap<String, Ring> = rows::load(conn, Filter::Ids(&ids))?
        .iter()
        .map(|t| (t.id.clone(), t.ring()))
        .collect();
    Ok(scored
        .into_iter()
        .map(|(_, c)| TaskHit {
            ring: rings.get(&c.id).copied().unwrap_or(if c.completed {
                Ring::Completed
            } else {
                Ring::Human
            }),
            id: c.id,
            title: c.title,
            subject: c.subject,
            section: c.section,
            completed: c.completed,
        })
        .collect())
}

/// Live notebook pages matching `query` (every word in the title, the text without its
/// Markdown or the project's name; case and accents ignored): title matches first (start of
/// the title, word start, inside), then text matches, most recently updated first; [`MAX_HITS`]
/// at most. The pages of a project in the trash (or of a sub-project whose parent is) are not
/// offered. With `subject`, only that project's pages, all of them, and its name is no match
/// (the notebook's own search).
pub fn search_pages(
    conn: &Connection,
    query: &str,
    subject: Option<&str>,
) -> AppResult<Vec<NoteHit>> {
    let folded = fold(query);
    let words: Vec<&str> = folded.split_whitespace().collect();
    if words.is_empty() {
        return Ok(Vec::new());
    }
    let phrase = words.join(" ");
    let mut stmt = conn.prepare(
        "SELECT p.id, p.title, p.body, p.kind, p.updated_at, s.id, s.name, s.color \
         FROM note_pages p JOIN subjects s ON s.id = p.subject_id \
         LEFT JOIN subjects g ON g.id = s.parent_id \
         WHERE p.deleted_at IS NULL AND s.deleted_at IS NULL AND g.deleted_at IS NULL \
         AND (?1 IS NULL OR p.subject_id = ?1)",
    )?;
    let rows = stmt.query_map([subject], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            SubjectTag {
                id: r.get(5)?,
                name: r.get(6)?,
                color: parse_color(&r.get::<_, String>(7)?),
            },
        ))
    })?;
    let mut scored: Vec<(Rank, String, NoteHit)> = Vec::new();
    for row in rows {
        let (id, title, body, kind, updated_at, subject_tag) = row?;
        let f_title = fold(&title);
        let f_body = fold(&plain_text(&body));
        let f_subject = if subject.is_some() {
            String::new()
        } else {
            fold(&subject_tag.name)
        };
        if !words
            .iter()
            .all(|w| f_title.contains(w) || f_body.contains(w) || f_subject.contains(w))
        {
            continue;
        }
        let rank = if f_title
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .starts_with(&phrase)
        {
            Rank::TitleStart
        } else if words.iter().any(|w| starts_a_word(&f_title, w)) {
            Rank::WordStart
        } else if words.iter().any(|w| f_title.contains(w)) {
            Rank::InTitle
        } else {
            // In the text, or the project's name only.
            Rank::Elsewhere
        };
        scored.push((
            rank,
            updated_at,
            NoteHit {
                id,
                title,
                subject: subject_tag,
                kind: NoteKind::parse(&kind),
            },
        ));
    }
    scored.sort_by(|(ra, ua, a), (rb, ub, b)| {
        ra.cmp(rb)
            .then_with(|| ub.cmp(ua))
            .then_with(|| a.title.cmp(&b.title))
            .then_with(|| a.id.cmp(&b.id))
    });
    if subject.is_none() {
        scored.truncate(MAX_HITS);
    }
    Ok(scored.into_iter().map(|(_, _, hit)| hit).collect())
}

fn candidate(r: &Row<'_>) -> rusqlite::Result<Candidate> {
    let subject = match r.get::<_, Option<String>>(2)? {
        Some(id) => Some(SubjectTag {
            id,
            name: r.get(3)?,
            color: parse_color(&r.get::<_, String>(4)?),
        }),
        None => None,
    };
    let section = match (
        r.get::<_, Option<String>>(5)?,
        r.get::<_, Option<String>>(6)?,
    ) {
        (Some(id), Some(name)) => Some(SectionTag { id, name }),
        _ => None,
    };
    Ok(Candidate {
        id: r.get(0)?,
        title: r.get(1)?,
        subject,
        section,
        completed: r.get(7)?,
        updated_at: r.get(8)?,
        parent_name: r.get(9)?,
    })
}

fn order(ra: Rank, a: &Candidate, rb: Rank, b: &Candidate) -> Ordering {
    a.completed
        .cmp(&b.completed)
        .then(ra.cmp(&rb))
        .then_with(|| b.updated_at.cmp(&a.updated_at))
        .then_with(|| a.title.cmp(&b.title))
        .then_with(|| a.id.cmp(&b.id))
}

/// `None` when a word of the query is found nowhere.
fn rank(c: &Candidate, words: &[&str], phrase: &str) -> Option<Rank> {
    let title = fold(&c.title);
    let subject = c
        .subject
        .as_ref()
        .map(|s| fold(&s.name))
        .unwrap_or_default();
    let section = c
        .section
        .as_ref()
        .map(|s| fold(&s.name))
        .unwrap_or_default();
    let parent = c.parent_name.as_deref().map(fold).unwrap_or_default();
    let everywhere = words.iter().all(|w| {
        title.contains(w) || subject.contains(w) || parent.contains(w) || section.contains(w)
    });
    if !everywhere {
        return None;
    }
    let rank = if title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .starts_with(phrase)
    {
        Rank::TitleStart
    } else if words.iter().any(|w| starts_a_word(&title, w)) {
        Rank::WordStart
    } else if words.iter().any(|w| title.contains(w)) {
        Rank::InTitle
    } else {
        Rank::Elsewhere
    };
    Some(rank)
}

/// `word` is in `title` where a word starts: at the start or after a character that is not
/// a letter or a digit. Works for query words that hold an apostrophe or a hyphen
/// (« aujourd'hui », « e-mail ») as well as plain ones (« oeuvre » in « l'oeuvre »).
fn starts_a_word(title: &str, word: &str) -> bool {
    title.char_indices().any(|(i, _)| {
        title[i..].starts_with(word)
            && title[..i]
                .chars()
                .next_back()
                .is_none_or(|before| !before.is_alphanumeric())
    })
}

/// Lower case without accents: « Écrire l’Œuvre » → « ecrire l'oeuvre ». Latin letters
/// with diacritics map to their base letter, combining marks (text already decomposed) are
/// dropped. No Unicode tables needed for the French and European text of the app.
pub fn fold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars().flat_map(char::to_lowercase) {
        match c {
            '\u{0300}'..='\u{036f}' => {}
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => out.push('a'),
            'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => out.push('c'),
            'ď' | 'đ' => out.push('d'),
            'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => out.push('e'),
            'ĝ' | 'ğ' | 'ġ' | 'ģ' => out.push('g'),
            'ĥ' | 'ħ' => out.push('h'),
            'ì' | 'í' | 'î' | 'ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' | 'ı' => out.push('i'),
            'ĵ' => out.push('j'),
            'ķ' => out.push('k'),
            'ĺ' | 'ļ' | 'ľ' | 'ŀ' | 'ł' => out.push('l'),
            'ñ' | 'ń' | 'ņ' | 'ň' => out.push('n'),
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ŏ' | 'ő' => out.push('o'),
            'ŕ' | 'ŗ' | 'ř' => out.push('r'),
            'ś' | 'ŝ' | 'ş' | 'š' | 'ș' => out.push('s'),
            'ţ' | 'ť' | 'ŧ' | 'ț' => out.push('t'),
            'ù' | 'ú' | 'û' | 'ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => out.push('u'),
            'ŵ' => out.push('w'),
            'ý' | 'ÿ' | 'ŷ' => out.push('y'),
            'ź' | 'ż' | 'ž' => out.push('z'),
            'œ' => out.push_str("oe"),
            'æ' => out.push_str("ae"),
            'ß' => out.push_str("ss"),
            '’' | '‘' | 'ʼ' => out.push('\''),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests;
