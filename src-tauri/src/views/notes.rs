//! The notebook view model: « Épinglées », the pages outside any
//! group, the groups and « Résumés de tâches », with a plain-text excerpt of every page.

use rusqlite::Connection;

use crate::db::{notes, subjects};
use crate::error::AppResult;
use crate::model::{NoteGroupBlock, NoteKind, NotePage, NotePageRow, NotebookView};

/// Characters of a page's excerpt.
pub const EXCERPT_CHARS: usize = 120;

/// A project's notebook. A pinned page is only in `pinned` (oldest pin first); the other
/// lists keep the order of their positions. Plain pages and summaries outside any group are
/// two lists; inside a group both kinds share the group's order.
pub fn notebook(conn: &Connection, subject_id: &str) -> AppResult<NotebookView> {
    subjects::ensure_project(conn, subject_id)?;
    let (groups, pages) = notes::list_for_subject(conn, subject_id)?;
    let mut pinned: Vec<&NotePage> = pages.iter().filter(|p| p.pinned_at.is_some()).collect();
    pinned.sort_by(|a, b| a.pinned_at.cmp(&b.pinned_at).then_with(|| a.id.cmp(&b.id)));
    let unpinned = || pages.iter().filter(|p| p.pinned_at.is_none());
    Ok(NotebookView {
        subject_id: subject_id.to_string(),
        pinned: pinned.into_iter().map(row).collect(),
        ungrouped: unpinned()
            .filter(|p| p.group_id.is_none() && p.kind == NoteKind::Page)
            .map(row)
            .collect(),
        summaries: unpinned()
            .filter(|p| p.group_id.is_none() && p.kind == NoteKind::Summary)
            .map(row)
            .collect(),
        groups: groups
            .into_iter()
            .map(|group| NoteGroupBlock {
                pages: unpinned()
                    .filter(|p| p.group_id.as_deref() == Some(group.id.as_str()))
                    .map(row)
                    .collect(),
                group,
            })
            .collect(),
    })
}

fn row(page: &NotePage) -> NotePageRow {
    NotePageRow {
        id: page.id.clone(),
        title: page.title.clone(),
        kind: page.kind,
        excerpt: excerpt(&page.body),
        updated_at: page.updated_at.clone(),
        pinned: page.pinned_at.is_some(),
    }
}

/// The start of a page as plain text: Markdown marks, links (their title stays), images and
/// HTML tags removed, lines joined by one space, cut at [`EXCERPT_CHARS`] characters.
pub fn excerpt(body: &str) -> String {
    let mut out = String::new();
    for line in body.lines() {
        let text = plain_line(line);
        if text.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&text);
        if out.chars().count() >= EXCERPT_CHARS {
            break;
        }
    }
    out.chars()
        .take(EXCERPT_CHARS)
        .collect::<String>()
        .trim_end()
        .to_string()
}

/// The whole body as plain text (what the search reads): the excerpt's rules, no cut.
pub fn plain_text(body: &str) -> String {
    body.lines()
        .map(plain_line)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn plain_line(line: &str) -> String {
    let mut s = line.trim_start();
    // Block marks: quote, heading, task box, bullet, number.
    loop {
        let before = s;
        s = s.trim_start_matches('>').trim_start();
        s = s.trim_start_matches('#').trim_start();
        for mark in ["- [ ] ", "- [x] ", "- [X] ", "- ", "* ", "+ "] {
            if let Some(rest) = s.strip_prefix(mark) {
                s = rest.trim_start();
            }
        }
        let digits = s.bytes().take_while(u8::is_ascii_digit).count();
        if digits > 0 && s[digits..].starts_with(". ") {
            s = s[digits + 2..].trim_start();
        }
        if s == before {
            break;
        }
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while !rest.is_empty() {
        if let Some(r) = rest.strip_prefix("![[") {
            // An image: nothing to read.
            rest = r.find("]]").map_or("", |i| &r[i + 2..]);
        } else if let Some(r) = rest.strip_prefix("[[") {
            // `[[page:<id>|Title]]`: the title; without one, nothing.
            let inner = r.find("]]").map_or(r, |i| &r[..i]);
            if let Some((_, title)) = inner.split_once('|') {
                out.push_str(title);
            }
            rest = r.find("]]").map_or("", |i| &r[i + 2..]);
        } else if let Some(r) = rest.strip_prefix("![") {
            rest = skip_link(r).unwrap_or(r);
        } else if let Some(r) = rest.strip_prefix('[') {
            // `[text](url)`: the text.
            match r.find("](") {
                Some(i) if skip_link(&r[i..]).is_some() => {
                    out.push_str(&r[..i]);
                    rest = skip_link(&r[i..]).unwrap_or("");
                }
                _ => {
                    out.push('[');
                    rest = r;
                }
            }
        } else if let Some(r) = rest.strip_prefix('<') {
            // An HTML tag (`<u>`), only when it closes.
            match r.find('>') {
                Some(i) if !r[..i].contains(char::is_whitespace) && !r[..i].is_empty() => {
                    rest = &r[i + 1..];
                }
                _ => {
                    out.push('<');
                    rest = r;
                }
            }
        } else {
            let c = rest.chars().next().unwrap_or(' ');
            if !matches!(c, '*' | '`' | '~' | '=' | '\\') {
                out.push(c);
            }
            rest = &rest[c.len_utf8()..];
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `text](url)` (the part after the opening bracket's text, starting at `](`): what follows
/// the closing parenthesis, `None` when it is not a link.
fn skip_link(s: &str) -> Option<&str> {
    let s = s.find("](").map(|i| &s[i + 2..])?;
    s.find(')').map(|i| &s[i + 1..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::db::test_support::subject;
    use crate::model::{CreateNoteGroupInput, CreateNotePageInput, MoveNotePageInput, NoteTarget};

    fn page(
        conn: &Connection,
        s: &str,
        group: Option<&str>,
        kind: NoteKind,
        title: &str,
        body: &str,
    ) -> NotePage {
        notes::create_page(
            conn,
            &CreateNotePageInput {
                subject_id: s.into(),
                group_id: group.map(String::from),
                title: title.into(),
                body: body.into(),
                kind,
                source_task_id: None,
            },
        )
        .expect("page")
    }

    fn ids(rows: &[NotePageRow]) -> Vec<&str> {
        rows.iter().map(|r| r.title.as_str()).collect()
    }

    #[test]
    fn pinned_page_only_in_pinned() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let g = notes::create_group(
            &conn,
            &CreateNoteGroupInput {
                subject_id: s.clone(),
                name: "Décisions".into(),
            },
        )
        .expect("group");
        let a = page(&conn, &s, Some(&g.id), NoteKind::Page, "Dans le groupe", "");
        let b = page(&conn, &s, None, NoteKind::Page, "Libre", "");
        let c = page(&conn, &s, Some(&g.id), NoteKind::Page, "Autre", "");
        let mv = |id: &str| {
            notes::move_page(
                &conn,
                &MoveNotePageInput {
                    id: id.into(),
                    target: NoteTarget::Pinned,
                    index: None,
                },
            )
            .expect("pin");
        };
        mv(&b.id);
        std::thread::sleep(std::time::Duration::from_millis(5));
        mv(&a.id);
        let view = notebook(&conn, &s).expect("notebook");
        assert_eq!(ids(&view.pinned), vec!["Libre", "Dans le groupe"]);
        assert!(view.pinned.iter().all(|r| r.pinned));
        assert!(view.ungrouped.is_empty());
        assert_eq!(view.groups.len(), 1);
        assert_eq!(view.groups[0].group.name, "Décisions");
        assert_eq!(ids(&view.groups[0].pages), vec!["Autre"]);
        assert_eq!(view.groups[0].pages[0].id, c.id);
        assert!(view.summaries.is_empty());
    }

    #[test]
    fn summary_without_group_in_summaries() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let g = notes::create_group(
            &conn,
            &CreateNoteGroupInput {
                subject_id: s.clone(),
                name: "G".into(),
            },
        )
        .expect("group");
        page(&conn, &s, None, NoteKind::Page, "P1", "");
        page(&conn, &s, None, NoteKind::Summary, "R1", "Fait.");
        let moved = page(&conn, &s, None, NoteKind::Summary, "R2", "Fait aussi.");
        page(&conn, &s, None, NoteKind::Page, "P2", "");
        notes::move_page(
            &conn,
            &MoveNotePageInput {
                id: moved.id,
                target: NoteTarget::Group { id: g.id },
                index: None,
            },
        )
        .expect("move");
        let view = notebook(&conn, &s).expect("notebook");
        assert_eq!(ids(&view.ungrouped), vec!["P1", "P2"]);
        assert_eq!(ids(&view.summaries), vec!["R1"]);
        assert_eq!(view.summaries[0].kind, NoteKind::Summary);
        // A summary moved into a group stays a summary there.
        assert_eq!(ids(&view.groups[0].pages), vec!["R2"]);
        assert_eq!(view.groups[0].pages[0].kind, NoteKind::Summary);
        // Another project's notebook is empty; a group (not a project) is refused.
        let other = subject(&conn, "Autre");
        assert!(notebook(&conn, &other).expect("empty").ungrouped.is_empty());
        assert!(notebook(&conn, "nope").is_err());
    }

    #[test]
    fn excerpt_strips_markdown() {
        let body = "# Titre\n\n**Gras**, *italique*, ==surligné==, ~~barré~~ et <u>souligné</u>.\n\
                    - [ ] une case\n- [x] faite\n> citation avec `code`\n1. premier\n\
                    Voir [[page:0192f0a1-7c2b-7d3e-9f00-112233445566|Style des mails]] et \
                    [le site](https://exemple.fr/a_b) ![[file:0192f0a1-7c2b-7d3e-9f00-112233445566|50%]] fin";
        assert_eq!(
            excerpt(body),
            "Titre Gras, italique, surligné, barré et souligné. une case faite citation avec code \
             premier Voir Style des mails et le site fin"
                .chars()
                .take(EXCERPT_CHARS)
                .collect::<String>()
                .trim_end()
        );
        assert_eq!(excerpt(""), "");
        assert_eq!(excerpt("a < b et c > d"), "a < b et c > d");
        let long = "é".repeat(300);
        assert_eq!(excerpt(&long).chars().count(), EXCERPT_CHARS);
        assert_eq!(
            excerpt("![[file:0192f0a1-7c2b-7d3e-9f00-112233445566|25%]]"),
            ""
        );
    }
}
