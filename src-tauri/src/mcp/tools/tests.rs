use rusqlite::Connection;
use serde_json::{json, Value};

use super::*;
use crate::db::open_in_memory;
use crate::db::test_support::{claude_terminal, section, sub_project, subject, task};

/// « Perso › Maison » holds « Courses », whose Claude runs in `term-1`.
struct Rig {
    conn: Connection,
    project: String,
    section: String,
    task: String,
}

fn rig() -> Rig {
    let conn = open_in_memory().expect("db");
    let project = subject(&conn, "Perso");
    let section = section(&conn, &project, "Maison");
    let task = task(&conn, "Courses", Some(&project), Some(&section));
    claude_terminal(&conn, &task, "term-1", "s-1", "uuid-1");
    Rig {
        conn,
        project,
        section,
        task,
    }
}

impl Rig {
    fn call(&self, name: &str, args: Value) -> Outcome {
        run(&self.conn, Some("term-1"), name, &args)
    }

    fn task_count(&self) -> i64 {
        self.conn
            .query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
            .expect("count")
    }
}

fn ok(o: &Outcome) {
    assert!(!o.result.is_error, "{}", o.result.text);
}

fn refused(o: &Outcome) {
    assert!(o.result.is_error, "expected a refusal: {}", o.result.text);
    assert!(o.changed.is_empty());
}

#[test]
fn definitions_list_the_nine_tools_with_object_schemas() {
    let defs = definitions();
    let names: Vec<&str> = defs
        .as_array()
        .expect("array")
        .iter()
        .map(|d| d["name"].as_str().expect("name"))
        .collect();
    assert_eq!(names, TOOL_NAMES);
    for d in defs.as_array().expect("array") {
        assert_eq!(d["inputSchema"]["type"], "object");
        assert!(!d["description"].as_str().expect("description").is_empty());
    }
}

#[test]
fn annotations_mark_the_list_tools_read_only_and_the_others_non_destructive() {
    for d in definitions().as_array().expect("array") {
        let name = d["name"].as_str().expect("name");
        let a = &d["annotations"];
        let reads = name.starts_with("list_") || name.starts_with("read_");
        assert_eq!(a["readOnlyHint"], reads, "{name}");
        assert_eq!(a["destructiveHint"], false, "{name}");
        assert_eq!(a["openWorldHint"], false, "{name}");
    }
}

#[test]
fn titles_become_one_line() {
    let r = rig();
    let o = r.call(
        "create_task",
        json!({ "title": "Appeler\nle plombier\r\n\tlundi  matin" }),
    );
    ok(&o);
    let d = crate::db::tasks::detail(&r.conn, &o.changed[0]).expect("detail");
    assert_eq!(d.title, "Appeler le plombier lundi matin");
    ok(&r.call("create_subtask", json!({ "title": "Pain\n et  lait" })));
    let d = crate::db::tasks::detail(&r.conn, &r.task).expect("detail");
    assert_eq!(d.subtasks[0].text, "Pain et lait");
}

#[test]
fn notes_keep_their_line_breaks() {
    let r = rig();
    ok(&r.call("add_to_note", json!({ "text": "Ligne 1\nLigne 2" })));
    let d = crate::db::tasks::detail(&r.conn, &r.task).expect("detail");
    assert_eq!(d.description, "Ligne 1\nLigne 2");
}

#[test]
fn list_tasks_of_a_parent_project_includes_its_sub_projects() {
    let r = rig();
    let client = sub_project(&r.conn, &r.project, "Client", None);
    task(&r.conn, "Devis", Some(&client), None);
    let other = subject(&r.conn, "Boulot");
    task(&r.conn, "Ailleurs", Some(&other), None);

    let o = r.call("list_tasks", json!({}));
    ok(&o);
    let v: Value = serde_json::from_str(&o.result.text).expect("json");
    let tasks: Vec<(&str, &str)> = v["tasks"]
        .as_array()
        .expect("tasks")
        .iter()
        .map(|t| {
            (
                t["title"].as_str().expect("title"),
                t["project"].as_str().expect("project"),
            )
        })
        .collect();
    assert_eq!(tasks, [("Courses", "Perso"), ("Devis", "Perso › Client")]);

    // A sub-project lists only its own tasks.
    let o = r.call("list_tasks", json!({ "project_id": client }));
    let v: Value = serde_json::from_str(&o.result.text).expect("json");
    assert_eq!(v["project"]["name"], "Perso › Client");
    assert_eq!(v["tasks"].as_array().expect("tasks").len(), 1);
    assert_eq!(v["tasks"][0]["title"], "Devis");
}

#[test]
fn create_task_goes_next_to_the_current_task_by_default() {
    let r = rig();
    let o = r.call("create_task", json!({ "title": "  Réserver le resto  " }));
    ok(&o);
    let d = crate::db::tasks::detail(&r.conn, &o.changed[0]).expect("detail");
    assert_eq!(d.title, "Réserver le resto");
    assert_eq!(d.subject.map(|s| s.id), Some(r.project.clone()));
    assert_eq!(d.section.map(|s| s.id), Some(r.section.clone()));
    assert!(
        o.result.text.contains("Perso › Maison"),
        "{}",
        o.result.text
    );
}

#[test]
fn create_task_takes_a_note_and_a_due_date() {
    let r = rig();
    let o = r.call(
        "create_task",
        json!({ "title": "Dentiste", "note": "Apporter la carte", "due_date": "2026-10-06" }),
    );
    ok(&o);
    let d = crate::db::tasks::detail(&r.conn, &o.changed[0]).expect("detail");
    assert_eq!(d.description, "Apporter la carte");
    assert_eq!(d.due.map(|d| d.date), Some("2026-10-06".to_string()));
}

#[test]
fn create_task_places_in_inbox_project_or_section() {
    let r = rig();
    let other = subject(&r.conn, "Boulot");
    let other_section = section(&r.conn, &other, "Urgent");

    let o = r.call("create_task", json!({ "title": "A", "inbox": true }));
    ok(&o);
    let d = crate::db::tasks::detail(&r.conn, &o.changed[0]).expect("detail");
    assert!(d.subject.is_none() && d.section.is_none());

    let o = r.call("create_task", json!({ "title": "B", "project_id": other }));
    ok(&o);
    let d = crate::db::tasks::detail(&r.conn, &o.changed[0]).expect("detail");
    assert_eq!(d.subject.map(|s| s.id), Some(other.clone()));
    assert!(d.section.is_none());

    let o = r.call(
        "create_task",
        json!({ "title": "C", "section_id": other_section }),
    );
    ok(&o);
    let d = crate::db::tasks::detail(&r.conn, &o.changed[0]).expect("detail");
    assert_eq!(d.subject.map(|s| s.id), Some(other));
    assert_eq!(d.section.map(|s| s.id), Some(other_section));
}

#[test]
fn create_task_refuses_contradictory_places() {
    let r = rig();
    let other = subject(&r.conn, "Boulot");
    let before = r.task_count();
    refused(&r.call(
        "create_task",
        json!({ "title": "A", "inbox": true, "project_id": r.project }),
    ));
    refused(&r.call(
        "create_task",
        json!({ "title": "A", "project_id": other, "section_id": r.section }),
    ));
    refused(&r.call("create_task", json!({ "title": "A", "project_id": "nope" })));
    refused(&r.call("create_task", json!({ "title": "A", "due_date": "demain" })));
    assert_eq!(r.task_count(), before);
}

#[test]
fn titles_and_texts_must_be_present_and_bounded() {
    let r = rig();
    let before = r.task_count();
    refused(&r.call("create_task", json!({ "title": "   " })));
    refused(&r.call("create_task", json!({})));
    refused(&r.call("create_task", json!({ "title": "x".repeat(501) })));
    refused(&r.call("create_subtask", json!({ "title": "" })));
    refused(&r.call("add_to_note", json!({ "text": " \n " })));
    refused(&r.call("add_to_note", json!({ "text": "x".repeat(10_001) })));
    assert_eq!(r.task_count(), before);
    ok(&r.call("create_task", json!({ "title": "é".repeat(500) })));
}

#[test]
fn create_subtask_defaults_to_the_current_task() {
    let r = rig();
    let o = r.call("create_subtask", json!({ "title": "Acheter du pain" }));
    ok(&o);
    let d = crate::db::tasks::detail(&r.conn, &r.task).expect("detail");
    assert_eq!(d.subtasks.len(), 1);
    assert_eq!(d.subtasks[0].text, "Acheter du pain");
    assert_eq!(o.changed, vec![r.task.clone(), d.subtasks[0].id.clone()]);
}

#[test]
fn create_subtask_under_a_subtask_goes_to_its_parent() {
    let r = rig();
    let child = crate::db::tasks::create_child(&r.conn, &r.task, "Lait").expect("child");
    claude_terminal(&r.conn, &child, "term-2", "s-2", "uuid-2");
    let o = run(
        &r.conn,
        Some("term-2"),
        "create_subtask",
        &json!({ "title": "Beurre" }),
    );
    ok(&o);
    let d = crate::db::tasks::detail(&r.conn, &r.task).expect("detail");
    let texts: Vec<&str> = d.subtasks.iter().map(|s| s.text.as_str()).collect();
    assert_eq!(texts, ["Lait", "Beurre"]);
}

#[test]
fn create_subtask_takes_another_task_id() {
    let r = rig();
    let other = task(&r.conn, "Autre", Some(&r.project), None);
    ok(&r.call("create_subtask", json!({ "title": "X", "task_id": other })));
    let d = crate::db::tasks::detail(&r.conn, &other).expect("detail");
    assert_eq!(d.subtasks.len(), 1);
}

#[test]
fn add_to_note_appends_a_paragraph() {
    let r = rig();
    ok(&r.call("add_to_note", json!({ "text": "Premier point" })));
    let o = r.call("add_to_note", json!({ "text": "  Deuxième point  " }));
    ok(&o);
    let d = crate::db::tasks::detail(&r.conn, &r.task).expect("detail");
    assert_eq!(d.description, "Premier point\n\nDeuxième point");
    assert_eq!(o.changed, vec![r.task.clone()]);
}

#[test]
fn add_to_note_of_a_subtask_refreshes_its_parent_too() {
    let r = rig();
    let child = crate::db::tasks::create_child(&r.conn, &r.task, "Lait").expect("child");
    let o = r.call(
        "add_to_note",
        json!({ "text": "Demi-écrémé", "task_id": child }),
    );
    ok(&o);
    assert_eq!(o.changed, vec![child.clone(), r.task.clone()]);
    let d = crate::db::tasks::detail(&r.conn, &child).expect("detail");
    assert_eq!(d.description, "Demi-écrémé");
}

#[test]
fn list_projects_names_the_current_task_and_every_project() {
    let r = rig();
    subject(&r.conn, "Boulot");
    let o = r.call("list_projects", json!({}));
    ok(&o);
    assert!(o.changed.is_empty());
    let v: Value = serde_json::from_str(&o.result.text).expect("json");
    assert_eq!(v["current_task"]["id"], r.task.as_str());
    assert_eq!(v["current_task"]["project"]["id"], r.project.as_str());
    assert_eq!(v["current_task"]["section"]["name"], "Maison");
    let names: Vec<&str> = v["projects"]
        .as_array()
        .expect("projects")
        .iter()
        .map(|p| p["name"].as_str().expect("name"))
        .collect();
    assert_eq!(names, ["Perso", "Boulot"]);
    assert_eq!(v["projects"][0]["sections"][0]["id"], r.section.as_str());
}

#[test]
fn list_tasks_defaults_to_the_current_project_and_shows_open_subtasks() {
    let r = rig();
    crate::db::tasks::create_child(&r.conn, &r.task, "Lait").expect("child");
    task(&r.conn, "Sans projet", None, None);
    let o = r.call("list_tasks", json!({}));
    ok(&o);
    let v: Value = serde_json::from_str(&o.result.text).expect("json");
    assert_eq!(v["project"]["id"], r.project.as_str());
    assert_eq!(v["tasks"][0]["title"], "Courses");
    assert_eq!(v["tasks"][0]["section"], "Maison");
    assert_eq!(v["tasks"][0]["subtasks"][0]["title"], "Lait");
    assert_eq!(v["tasks"].as_array().expect("tasks").len(), 1);

    let o = r.call("list_tasks", json!({ "inbox": true }));
    let v: Value = serde_json::from_str(&o.result.text).expect("json");
    assert!(v["project"].is_null());
    assert_eq!(v["tasks"][0]["title"], "Sans projet");
}

#[test]
fn without_an_open_claude_terminal_nothing_is_written() {
    let r = rig();
    let before = r.task_count();
    refused(&run(&r.conn, None, "create_task", &json!({ "title": "A" })));
    refused(&run(
        &r.conn,
        Some("nope"),
        "create_task",
        &json!({ "title": "A" }),
    ));
    r.conn
        .execute(
            "UPDATE terminals SET closed_at = '2026-10-05T10:00:00.000Z' WHERE id = 'term-1'",
            [],
        )
        .expect("close");
    refused(&r.call("create_task", json!({ "title": "A" })));
    assert_eq!(r.task_count(), before);
}

#[test]
fn a_deleted_current_task_refuses_the_defaults() {
    let r = rig();
    crate::db::tasks::delete(&r.conn, &r.task).expect("delete");
    refused(&r.call("create_subtask", json!({ "title": "A" })));
    refused(&r.call("add_to_note", json!({ "text": "A" })));
}

#[test]
fn unknown_tools_and_bad_arguments_are_refused() {
    let r = rig();
    refused(&r.call("delete_task", json!({ "task_id": r.task })));
    refused(&r.call("create_task", json!({ "title": 42 })));
    refused(&r.call("list_tasks", json!({ "inbox": "yes" })));
}

// --- Notebook ---------------------------------------------------------------

impl Rig {
    fn pages(&self, project: &str) -> Vec<crate::model::NotePage> {
        crate::db::notes::list_for_subject(&self.conn, project)
            .expect("pages")
            .1
    }
}

#[test]
fn create_note_page_defaults_to_current_project() {
    let r = rig();
    let o = r.call(
        "create_note_page",
        json!({ "title": "  Accès\nserveur ", "body": "Voir **ssh**." }),
    );
    ok(&o);
    assert!(o.notes && o.changed.is_empty());
    let pages = r.pages(&r.project);
    assert_eq!(pages.len(), 1);
    assert_eq!(pages[0].title, "Accès serveur");
    assert_eq!(pages[0].body, "Voir **ssh**.");
    assert_eq!(pages[0].group_id, None);
    assert!(o.result.text.contains(&pages[0].id), "{}", o.result.text);
    // In a group, by name (accents and case ignored) or id; an unknown group is refused.
    let g = crate::db::notes::create_group(
        &r.conn,
        &crate::model::CreateNoteGroupInput {
            subject_id: r.project.clone(),
            name: "Décisions".into(),
        },
    )
    .expect("group");
    ok(&r.call(
        "create_note_page",
        json!({ "title": "A", "body": "", "group": "decisions" }),
    ));
    ok(&r.call(
        "create_note_page",
        json!({ "title": "B", "body": "x", "group": g.id }),
    ));
    let in_group = r
        .pages(&r.project)
        .into_iter()
        .filter(|p| p.group_id.as_deref() == Some(g.id.as_str()))
        .count();
    assert_eq!(in_group, 2);
    refused(&r.call(
        "create_note_page",
        json!({ "title": "C", "body": "", "group": "Inconnu" }),
    ));
    // Another project, named.
    let other = subject(&r.conn, "Boulot");
    ok(&r.call(
        "create_note_page",
        json!({ "title": "D", "body": "", "project_id": other }),
    ));
    assert_eq!(r.pages(&other).len(), 1);
    // Bad input writes nothing.
    let count = r.pages(&r.project).len();
    refused(&r.call("create_note_page", json!({ "title": "  ", "body": "x" })));
    refused(&r.call("create_note_page", json!({ "body": "x" })));
    assert_eq!(r.pages(&r.project).len(), count);
}

#[test]
fn create_note_page_needs_a_project_for_an_inbox_task() {
    let r = rig();
    let loose = task(&r.conn, "Sans projet", None, None);
    claude_terminal(&r.conn, &loose, "term-2", "s-2", "uuid-2");
    let o = run(
        &r.conn,
        Some("term-2"),
        "create_note_page",
        &json!({ "title": "A", "body": "" }),
    );
    refused(&o);
    let o = run(&r.conn, Some("term-2"), "list_note_pages", &json!({}));
    refused(&o);
}

#[test]
fn add_to_note_page_appends_a_paragraph() {
    let r = rig();
    let o = r.call(
        "create_note_page",
        json!({ "title": "Journal", "body": "Début.\n\n" }),
    );
    ok(&o);
    let id = r.pages(&r.project)[0].id.clone();
    let o = r.call(
        "add_to_note_page",
        json!({ "id": id, "text": "Suite\nsur deux lignes" }),
    );
    ok(&o);
    assert!(o.notes);
    assert_eq!(
        r.pages(&r.project)[0].body,
        "Début.\n\nSuite\nsur deux lignes"
    );
    // An empty page takes the text as is.
    ok(&r.call("create_note_page", json!({ "title": "Vide", "body": "" })));
    let empty = r
        .pages(&r.project)
        .into_iter()
        .find(|p| p.title == "Vide")
        .expect("page");
    ok(&r.call("add_to_note_page", json!({ "id": empty.id, "text": "Un" })));
    refused(&r.call("add_to_note_page", json!({ "id": id, "text": "   " })));
    refused(&r.call("add_to_note_page", json!({ "id": "nope", "text": "x" })));
}

#[test]
fn read_note_page_of_other_project_by_id() {
    let r = rig();
    let other = subject(&r.conn, "Boulot");
    let target = crate::db::notes::create_page(
        &r.conn,
        &crate::model::CreateNotePageInput {
            subject_id: other.clone(),
            group_id: None,
            title: "Cible".into(),
            body: String::new(),
            kind: crate::model::NoteKind::Page,
            source_task_id: None,
        },
    )
    .expect("target");
    let page = crate::db::notes::create_page(
        &r.conn,
        &crate::model::CreateNotePageInput {
            subject_id: other.clone(),
            group_id: None,
            title: "Style des mails".into(),
            body: format!(
                "Voir [[page:{}|Ancien titre]], [[task:{}|Courses]] et [[page:{}|Perdue]].\n\
                 ![[file:{}|50%]]",
                target.id,
                r.task,
                "0192f0a1-7c2b-7d3e-9f00-000000000001",
                "0192f0a1-7c2b-7d3e-9f00-000000000002",
            ),
            kind: crate::model::NoteKind::Page,
            source_task_id: None,
        },
    )
    .expect("page");
    let o = r.call("read_note_page", json!({ "id": page.id }));
    ok(&o);
    assert!(!o.notes && o.changed.is_empty());
    let t = &o.result.text;
    assert!(t.contains("Style des mails"), "{t}");
    assert!(t.contains("Boulot"), "{t}");
    // Links read as [[Title]] with the title they have now; a dead one keeps its copy.
    assert!(
        t.contains("Voir [[Cible]], [[Courses]] et [[Perdue]]."),
        "{t}"
    );
    assert!(
        !t.contains("page:") && !t.contains("task:") && !t.contains("file:"),
        "{t}"
    );
    refused(&r.call("read_note_page", json!({ "id": "nope" })));
}

#[test]
fn list_note_pages_shows_groups_pinned_and_summaries() {
    let r = rig();
    ok(&r.call(
        "create_note_page",
        json!({ "title": "Libre", "body": "Un **texte**" }),
    ));
    let v: Value = {
        let o = r.call("list_note_pages", json!({}));
        ok(&o);
        assert!(!o.notes && o.changed.is_empty());
        serde_json::from_str(&o.result.text).expect("json")
    };
    assert_eq!(v["project"]["name"], "Perso");
    let pages = v["pages"].as_array().expect("pages");
    assert_eq!(pages.len(), 1);
    assert_eq!(pages[0]["title"], "Libre");
    assert_eq!(pages[0]["excerpt"], "Un texte");
    assert!(pages[0]["id"].is_string());
}

#[test]
fn a_task_note_that_links_a_page_tells_the_notebook() {
    let r = rig();
    let link = "Voir [[page:0192f0a1-7c2b-7d3e-9f00-112233445566|Style]]";
    // That page's « Mentionné dans » now lists the task.
    let o = r.call("add_to_note", json!({ "text": link }));
    ok(&o);
    assert!(o.notes);
    let o = r.call("create_task", json!({ "title": "Mails", "note": link }));
    ok(&o);
    assert!(o.notes);
    // Plain text leaves the notebooks alone.
    let o = r.call("add_to_note", json!({ "text": "rien" }));
    ok(&o);
    assert!(!o.notes);
}

/// I3: the pages of a project in the trash are refused, with a message that says why.
#[test]
fn note_tools_refuse_a_project_in_the_trash() {
    let r = rig();
    let other = subject(&r.conn, "Boulot");
    let page = crate::db::notes::create_page(
        &r.conn,
        &crate::model::CreateNotePageInput {
            subject_id: other.clone(),
            group_id: None,
            title: "Accès".into(),
            body: "ssh".into(),
            kind: crate::model::NoteKind::Page,
            source_task_id: None,
        },
    )
    .expect("page");
    crate::db::subjects::delete(&r.conn, &other).expect("trash");
    for o in [
        r.call("read_note_page", json!({ "id": page.id })),
        r.call("add_to_note_page", json!({ "id": page.id, "text": "x" })),
        r.call(
            "create_note_page",
            json!({ "title": "N", "body": "", "project_id": other }),
        ),
    ] {
        refused(&o);
        assert!(o.result.text.contains("trash"), "{}", o.result.text);
    }
    crate::db::subjects::restore(&r.conn, &other).expect("restore");
    ok(&r.call("read_note_page", json!({ "id": page.id })));
}

/// m5: the title limit is the core's, in bytes, told plainly.
#[test]
fn create_note_page_limits_the_title_in_bytes() {
    let r = rig();
    // 300 « é » = 600 bytes, under 500 characters.
    let long = "é".repeat(300);
    let o = r.call("create_note_page", json!({ "title": long, "body": "" }));
    refused(&o);
    assert!(o.result.text.contains("500 bytes"), "{}", o.result.text);
    assert!(o.result.text.contains("accented"), "{}", o.result.text);
    assert!(r.pages(&r.project).is_empty());
    ok(&r.call(
        "create_note_page",
        json!({ "title": "é".repeat(250), "body": "" }),
    ));
}
