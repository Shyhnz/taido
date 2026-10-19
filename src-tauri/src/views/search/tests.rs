use rusqlite::Connection;

use super::*;
use crate::db::test_support::{claude_terminal, section, set_session_state, subject, task};
use crate::db::{open_in_memory, tasks};
use crate::model::SetCompletedInput;

/// Sets `updated_at` so that the recency order is known.
fn touched(conn: &Connection, id: &str, at: &str) {
    conn.execute("UPDATE tasks SET updated_at = ?2 WHERE id = ?1", [id, at])
        .expect("touch");
}

struct Data {
    conn: Connection,
    ecrire: String,
    ecriture: String,
}

/// Two projects (« Écriture » with a section « Brouillons », « Globex »), open, completed and
/// deleted tasks.
fn data() -> Data {
    let conn = open_in_memory().expect("db");
    let ecriture = subject(&conn, "Écriture");
    let globex = subject(&conn, "Globex");
    let drafts = section(&conn, &ecriture, "Brouillons");
    let rows = [
        (
            "Écrire le rapport",
            Some(&ecriture),
            None,
            "2026-10-01T10:00:00.000Z",
        ),
        (
            "Rapport mensuel",
            Some(&globex),
            None,
            "2026-10-01T11:00:00.000Z",
        ),
        (
            "Réécrire la doc",
            Some(&globex),
            None,
            "2026-10-01T12:00:00.000Z",
        ),
        (
            "Payer les factures",
            Some(&ecriture),
            Some(&drafts),
            "2026-10-01T13:00:00.000Z",
        ),
        ("écrire au client", None, None, "2026-10-01T14:00:00.000Z"),
        (
            "Écrire supprimée",
            Some(&ecriture),
            None,
            "2026-10-01T15:00:00.000Z",
        ),
        (
            "Préparer le rapport d’écriture",
            None,
            None,
            "2026-10-01T09:00:00.000Z",
        ),
    ];
    let mut ids = Vec::new();
    for (title, s, sec, at) in rows {
        let id = task(&conn, title, s.map(String::as_str), sec.map(String::as_str));
        ids.push((title, id, at));
    }
    let id_of = |t: &str| {
        ids.iter()
            .find(|(title, _, _)| *title == t)
            .map(|(_, id, _)| id.clone())
            .expect("task")
    };
    tasks::set_completed(
        &conn,
        &SetCompletedInput {
            id: id_of("écrire au client"),
            completed: true,
        },
    )
    .expect("complete");
    tasks::delete(&conn, &id_of("Écrire supprimée")).expect("delete");
    for (_, id, at) in &ids {
        touched(&conn, id, at);
    }
    Data {
        ecrire: id_of("Écrire le rapport"),
        conn,
        ecriture,
    }
}

fn titles(conn: &Connection, query: &str) -> Vec<String> {
    search(conn, query)
        .expect("search")
        .into_iter()
        .map(|h| h.title)
        .collect()
}

#[test]
fn rank_table() {
    let rank_of = |title: &str, query: &str| {
        let c = Candidate {
            id: "t".into(),
            title: title.into(),
            subject: None,
            section: None,
            parent_name: None,
            completed: false,
            updated_at: String::new(),
        };
        let folded = fold(query);
        let words: Vec<&str> = folded.split_whitespace().collect();
        rank(&c, &words, &words.join(" "))
    };
    let cases: &[(&str, &str, Option<Rank>)] = &[
        ("Écrire le rapport", "écrire", Some(Rank::TitleStart)),
        ("Écrire le rapport", "rapp", Some(Rank::WordStart)),
        ("Réécrire la doc", "écrire", Some(Rank::InTitle)),
        // Query words with an apostrophe or a hyphen start a word too.
        ("Faire aujourd'hui", "aujourd’hui", Some(Rank::WordStart)),
        ("Envoyer e-mail", "e-mail", Some(Rank::WordStart)),
        ("Relire le-mailing", "e-mail", Some(Rank::InTitle)),
        ("Écrire l’Œuvre", "oeuvre", Some(Rank::WordStart)),
        ("Écrire l’Œuvre", "l'oeuvre", Some(Rank::WordStart)),
        ("Écrire l’Œuvre", "xyz", None),
    ];
    for (title, query, expected) in cases {
        assert_eq!(rank_of(title, query), *expected, "{title:?} / {query:?}");
    }
}

#[test]
fn matches_and_order() {
    let d = data();
    let cases: &[(&str, &[&str])] = &[
        // Accents and case do not matter, either side.
        (
            "écrire",
            &["Écrire le rapport", "Réécrire la doc", "écrire au client"],
        ),
        (
            "ecrire",
            &["Écrire le rapport", "Réécrire la doc", "écrire au client"],
        ),
        (
            "ÉCRIRE",
            &["Écrire le rapport", "Réécrire la doc", "écrire au client"],
        ),
        // Title start > word start > inside the title > project only; completed last.
        (
            "ecri",
            &[
                "Écrire le rapport",
                "Préparer le rapport d’écriture",
                "Réécrire la doc",
                "Payer les factures",
                "écrire au client",
            ],
        ),
        // Every word must match somewhere; equal ranks by most recent update.
        (
            "rapport écri",
            &["Écrire le rapport", "Préparer le rapport d’écriture"],
        ),
        ("globex rapport", &["Rapport mensuel"]),
        ("rapport mens", &["Rapport mensuel"]),
        ("rapport globex doc", &[]),
        // Project or section only.
        ("brouillons", &["Payer les factures"]),
        ("globex", &["Réécrire la doc", "Rapport mensuel"]),
        // Typographic apostrophe matches the typed one.
        ("d'écriture", &["Préparer le rapport d’écriture"]),
        // Deleted tasks never show; empty queries find nothing.
        ("supprimée", &[]),
        ("", &[]),
        ("   ", &[]),
    ];
    for (query, expected) in cases {
        assert_eq!(titles(&d.conn, query), *expected, "query {query:?}");
    }
}

#[test]
fn hits_carry_their_place_ring_and_completion() {
    let d = data();
    let hits = search(&d.conn, "factures").expect("search");
    assert_eq!(hits.len(), 1);
    let hit = &hits[0];
    assert_eq!(
        hit.subject.as_ref().map(|s| s.id.as_str()),
        Some(&*d.ecriture)
    );
    assert_eq!(
        hit.subject.as_ref().map(|s| s.name.as_str()),
        Some("Écriture")
    );
    assert_eq!(
        hit.section.as_ref().map(|s| s.name.as_str()),
        Some("Brouillons")
    );
    assert_eq!((hit.ring, hit.completed), (Ring::Human, false));

    let done = search(&d.conn, "client").expect("search");
    assert_eq!((done[0].ring, done[0].completed), (Ring::Completed, true));
    assert!(done[0].subject.is_none() && done[0].section.is_none());

    // A Claude that works in an open tab: the ring of the rows.
    claude_terminal(&d.conn, &d.ecrire, "term-1", "sess-1", "uuid-1");
    set_session_state(
        &d.conn,
        "sess-1",
        "working",
        None,
        "2026-10-02T09:00:00.000Z",
    );
    let working = search(&d.conn, "écrire le").expect("search");
    assert_eq!(working[0].id, d.ecrire);
    assert_eq!(working[0].ring, Ring::Working);
}

#[test]
fn at_most_twenty_hits_most_recent_first() {
    let conn = open_in_memory().expect("db");
    for n in 0..25 {
        let id = task(&conn, &format!("Lot {n:02}"), None, None);
        touched(&conn, &id, &format!("2026-10-01T10:{n:02}:00.000Z"));
    }
    let found = titles(&conn, "lot");
    assert_eq!(found.len(), MAX_HITS);
    assert_eq!(found.first().map(String::as_str), Some("Lot 24"));
    assert_eq!(found.last().map(String::as_str), Some("Lot 05"));
}

#[test]
fn folding_table() {
    let cases = [
        ("Écrire", "ecrire"),
        ("ÇA VA", "ca va"),
        ("Œuvre Æther straße", "oeuvre aether strasse"),
        ("l’été", "l'ete"),
        // Already decomposed (e + combining acute accent).
        ("e\u{301}crire", "ecrire"),
        ("Łódź", "lodz"),
        ("naïve über", "naive uber"),
        ("plain ascii 42", "plain ascii 42"),
    ];
    for (input, expected) in cases {
        assert_eq!(fold(input), expected, "{input:?}");
    }
}
/// Subtasks are found too, with their parent's project and section; a
/// parent's ring sums up its children's sessions.
#[test]
fn finds_subtasks_with_their_parents_place() {
    let conn = open_in_memory().expect("db");
    let s = subject(&conn, "Écriture");
    let sec = section(&conn, &s, "Brouillons");
    let parent = task(&conn, "Rapport", Some(&s), Some(&sec));
    let child = crate::db::subtasks::add(
        &conn,
        &crate::model::AddSubtaskInput {
            task_id: parent.clone(),
            text: "Relire le plan".into(),
        },
    )
    .expect("subtask")
    .id;
    claude_terminal(&conn, &child, "term-c", "sess-c", "uuid-c");
    set_session_state(
        &conn,
        "sess-c",
        "waiting",
        Some("input"),
        "2026-10-01T10:00:00.000Z",
    );
    let hits = search(&conn, "plan").expect("search");
    assert_eq!(hits.len(), 1);
    let hit = &hits[0];
    assert_eq!(hit.id, child);
    assert_eq!(
        hit.subject.as_ref().map(|t| t.id.as_str()),
        Some(s.as_str())
    );
    assert_eq!(
        hit.section.as_ref().map(|t| t.name.as_str()),
        Some("Brouillons")
    );
    assert_eq!(hit.ring, Ring::Waiting);
    // Found by its project's name too; the parent shows its child's state.
    let hits = search(&conn, "brouillons").expect("search");
    let rings: Vec<(&str, Ring)> = hits.iter().map(|h| (h.title.as_str(), h.ring)).collect();
    assert!(rings.contains(&("Rapport", Ring::Waiting)), "{rings:?}");
    assert!(
        rings.contains(&("Relire le plan", Ring::Waiting)),
        "{rings:?}"
    );
    // Deleted with its parent.
    tasks::delete(&conn, &parent).expect("delete");
    assert!(search(&conn, "plan").expect("search").is_empty());
}
/// A sub-project's task carries the sub-project, and is found by the
/// parent project's name too.
#[test]
fn sub_project_tasks_carry_their_sub_project() {
    let conn = open_in_memory().expect("db");
    let globex = subject(&conn, "Globex");
    let client = crate::db::test_support::sub_project(&conn, &globex, "Client Durand", None);
    let _t = task(&conn, "Devis", Some(&client), None);
    for query in ["devis", "durand devis", "globex devis", "globex"] {
        let hits = search(&conn, query).expect("search");
        assert_eq!(hits.len(), 1, "{query}");
        let subject = hits[0].subject.as_ref().expect("subject");
        assert_eq!(
            (subject.id.as_str(), subject.name.as_str()),
            (client.as_str(), "Client Durand")
        );
    }
}

fn note_page(conn: &Connection, subject_id: &str, title: &str, body: &str) -> String {
    crate::db::notes::create_page(
        conn,
        &crate::model::CreateNotePageInput {
            subject_id: subject_id.into(),
            group_id: None,
            title: title.into(),
            body: body.into(),
            kind: crate::model::NoteKind::Page,
            source_task_id: None,
        },
    )
    .expect("page")
    .id
}

#[test]
fn finds_a_page_by_body_word_without_accents() {
    let conn = open_in_memory().expect("db");
    let s = subject(&conn, "Écriture");
    let other = subject(&conn, "Globex");
    let by_body = note_page(
        &conn,
        &s,
        "Accès",
        "Le mot de passe est dans le **coffre-fort** été",
    );
    let by_title = note_page(&conn, &other, "Été 2026", "rien");
    let by_title_start = note_page(&conn, &s, "Etes-vous prêt", "");
    let gone = note_page(&conn, &s, "Supprimée été", "été");
    crate::db::notes::delete_page(&conn, &gone).expect("delete");
    let of_trashed = note_page(&conn, &other, "Autre été", "été");
    let _ = of_trashed;
    note_page(&conn, &s, "Sans rapport", "autre chose");

    let hits = search_pages(&conn, "ETE", None).expect("search");
    let ids: Vec<&str> = hits.iter().map(|h| h.id.as_str()).collect();
    // Title matches first (start of title, then the others), then body matches.
    assert_eq!(ids[0], by_title_start);
    assert!(ids.contains(&by_title.as_str()) && ids.contains(&by_body.as_str()));
    assert!(!ids.contains(&gone.as_str()));
    // The page that only has the word in its text comes after the ones that have it in the title.
    let pos = |id: &str| ids.iter().position(|i| *i == id).expect("found");
    assert!(pos(&by_title) < pos(&by_body));
    let body_hit = hits.iter().find(|h| h.id == by_body).expect("body hit");
    assert_eq!(body_hit.subject.name, "Écriture");
    assert_eq!(body_hit.kind, crate::model::NoteKind::Page);
    // The project's name finds its pages too; every word must be found.
    assert_eq!(
        search_pages(&conn, "globex rien", None)
            .expect("search")
            .len(),
        1
    );
    assert!(search_pages(&conn, "coffre inexistant", None)
        .expect("search")
        .is_empty());
    assert_eq!(
        search_pages(&conn, "coffre-fort", None)
            .expect("search")
            .len(),
        1
    );
    assert!(search_pages(&conn, "  ", None).expect("search").is_empty());
    // A trashed project's pages are not offered.
    crate::db::subjects::delete(&conn, &other).expect("trash");
    let hits = search_pages(&conn, "ete", None).expect("search");
    assert!(hits.iter().all(|h| h.subject.id != other));
}

#[test]
fn page_hits_are_capped_and_recent_first() {
    let conn = open_in_memory().expect("db");
    let s = subject(&conn, "S");
    for n in 0..25 {
        let id = note_page(&conn, &s, &format!("Lot {n:02}"), "");
        conn.execute(
            "UPDATE note_pages SET updated_at = ?2 WHERE id = ?1",
            [&id, &format!("2026-10-01T10:{n:02}:00.000Z")],
        )
        .expect("touch");
    }
    let hits = search_pages(&conn, "lot", None).expect("search");
    assert_eq!(hits.len(), MAX_HITS);
    assert_eq!(hits[0].title, "Lot 24");
}

/// I2: the text is read without its Markdown (emphasis inside a word, link and image syntax).
#[test]
fn page_search_reads_the_text_without_its_markdown() {
    let conn = open_in_memory().expect("db");
    let s = subject(&conn, "S");
    let id = note_page(
        &conn,
        &s,
        "Index",
        "Voir [[page:0192f0a1-7c2b-7d3e-9f00-112233445566|Style des mails]] et \
         ![[file:0192f0a1-7c2b-7d3e-9f00-000000000001|50%]]\n\n- [ ] co**ffre** ==fort==",
    );
    for hit in ["style", "coffre", "coffre fort"] {
        let ids: Vec<String> = search_pages(&conn, hit, None)
            .expect("search")
            .into_iter()
            .map(|h| h.id)
            .collect();
        assert_eq!(ids, vec![id.clone()], "{hit}");
    }
    for miss in ["page", "0192f0a1", "file", "50%", "**"] {
        assert!(
            search_pages(&conn, miss, None).expect("search").is_empty(),
            "{miss}"
        );
    }
}

/// I2: a sub-project whose parent is in the trash (the sync can leave one live until it is
/// normalised) offers no page.
#[test]
fn page_search_skips_a_sub_project_whose_parent_is_trashed() {
    let conn = open_in_memory().expect("db");
    let parent = subject(&conn, "Clients");
    let child = crate::db::test_support::sub_project(&conn, &parent, "Site", None);
    let id = note_page(&conn, &child, "Zébu", "");
    assert_eq!(search_pages(&conn, "zebu", None).expect("search").len(), 1);
    conn.execute(
        "UPDATE subjects SET deleted_at = '2026-10-14T10:00:00.000Z' WHERE id = ?1",
        [&parent],
    )
    .expect("trash parent only");
    let _ = id;
    assert!(search_pages(&conn, "zebu", None)
        .expect("search")
        .is_empty());
}

/// I4: the notebook's own search reads whole pages of one project, all of them (no cap), and
/// the project's name is not a match there.
#[test]
fn page_search_in_one_project_reads_whole_pages() {
    let conn = open_in_memory().expect("db");
    let s = subject(&conn, "Atelier");
    let other = subject(&conn, "Autre");
    let long = format!("{} licorne", "mot ".repeat(60));
    let far = note_page(&conn, &s, "Longue", &long);
    note_page(&conn, &other, "Ailleurs", "licorne");
    let ids: Vec<String> = search_pages(&conn, "licorne", Some(&s))
        .expect("search")
        .into_iter()
        .map(|h| h.id)
        .collect();
    assert_eq!(ids, vec![far]);
    assert!(search_pages(&conn, "atelier", Some(&s))
        .expect("search")
        .is_empty());
    for n in 0..25 {
        note_page(&conn, &s, &format!("Lot {n:02}"), "");
    }
    assert_eq!(
        search_pages(&conn, "lot", Some(&s)).expect("search").len(),
        25
    );
}
