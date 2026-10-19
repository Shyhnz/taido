//! Demonstration: create 3 subjects and 10 tasks, reorder, check some,
//! quit, relaunch → everything is kept.

use chrono::NaiveDate;
use rusqlite::Connection;

use crate::db::test_support::{section, task};
use crate::db::{journal, open, settings, subjects, subtasks, tasks};
use crate::model::{
    AddNoteInput, AddSubtaskInput, CreateSubjectInput, GetViewInput, JournalEntry, MoveTaskInput,
    ReorderInput, SetCompletedInput, SetDueInput, Settings, SettingsPatch, Subject, SubjectColor,
    TaskDetail, Theme, ViewKind, ViewModel,
};
use crate::views;

#[derive(Debug, PartialEq)]
struct Snapshot {
    subjects: Vec<Subject>,
    views: Vec<ViewModel>,
    details: Vec<TaskDetail>,
    journals: Vec<Vec<JournalEntry>>,
    settings: Settings,
}

fn snapshot(conn: &Connection, task_ids: &[String]) -> Snapshot {
    let today = NaiveDate::from_ymd_opt(2026, 10, 2).expect("date");
    let subjects = subjects::list(conn).expect("subjects");
    let mut inputs = vec![
        GetViewInput {
            kind: ViewKind::Inbox,
            subject_id: None,
            from: None,
            days: None,
        },
        GetViewInput {
            kind: ViewKind::Today,
            subject_id: None,
            from: None,
            days: None,
        },
    ];
    inputs.extend(subjects.iter().map(|s| GetViewInput {
        kind: ViewKind::Subject,
        subject_id: Some(s.id.clone()),
        from: None,
        days: None,
    }));
    Snapshot {
        views: inputs
            .iter()
            .map(|i| views::get_view(conn, i, today).expect("view"))
            .collect(),
        subjects,
        details: task_ids
            .iter()
            .map(|id| tasks::detail_on(conn, id, today).expect("detail"))
            .collect(),
        journals: task_ids
            .iter()
            .map(|id| journal::list(conn, id).expect("journal"))
            .collect(),
        settings: settings::get(conn).expect("settings"),
    }
}

#[test]
fn demo_survives_a_restart() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("todo-agents.sqlite3");
    let conn = open(&path).expect("open");

    let colors = [SubjectColor::Violet, SubjectColor::Teal, SubjectColor::Blue];
    let subject_ids: Vec<String> = ["Client A", "Perso", "Appli"]
        .iter()
        .zip(colors)
        .map(|(name, color)| {
            subjects::create(
                &conn,
                &CreateSubjectInput {
                    name: (*name).into(),
                    color: Some(color),
                    // "Perso" has no folder on disk (D5).
                    root_path: (*name != "Perso").then(|| format!("/tmp/demo/{name}")),
                    parent_id: None,
                },
            )
            .expect("subject")
            .id
        })
        .collect();
    let front = section(&conn, &subject_ids[0], "Front");
    let _empty = section(&conn, &subject_ids[0], "Back");

    let mut ids = Vec::new();
    for i in 0..10 {
        let (subject, sec) = match i % 4 {
            0 => (None, None),
            1 => (Some(subject_ids[0].as_str()), Some(front.as_str())),
            2 => (Some(subject_ids[1].as_str()), None),
            _ => (Some(subject_ids[2].as_str()), None),
        };
        ids.push(task(&conn, &format!("Tâche {i}"), subject, sec));
    }

    // Reorder subjects, a section and tasks.
    subjects::reorder(
        &conn,
        &ReorderInput {
            id: subject_ids[2].clone(),
            index: 0,
        },
    )
    .expect("reorder subject");
    tasks::move_task(
        &conn,
        &MoveTaskInput {
            id: ids[8].clone(),
            subject_id: None,
            section_id: None,
            index: Some(0),
        },
    )
    .expect("reorder task");
    tasks::move_task(
        &conn,
        &MoveTaskInput {
            id: ids[2].clone(),
            subject_id: Some(subject_ids[0].clone()),
            section_id: Some(front.clone()),
            index: Some(1),
        },
    )
    .expect("move task");

    // Check some, add details.
    for id in [&ids[1], &ids[4], &ids[7]] {
        tasks::set_completed(
            &conn,
            &SetCompletedInput {
                id: id.clone(),
                completed: true,
            },
        )
        .expect("complete");
    }
    tasks::set_due(
        &conn,
        &SetDueInput {
            id: ids[3].clone(),
            date: Some("2026-10-02".into()),
            time: Some("10:30".into()),
        },
    )
    .expect("due");
    subtasks::add(
        &conn,
        &AddSubtaskInput {
            task_id: ids[5].clone(),
            text: "Sous-tâche".into(),
        },
    )
    .expect("subtask");
    journal::add_note(
        &conn,
        &AddNoteInput {
            task_id: ids[6].clone(),
            text: "Une note".into(),
        },
    )
    .expect("note");
    settings::update(
        &conn,
        &SettingsPatch {
            theme: Some(Theme::Dark),
            panel_width: Some(900),
            show_completed: Some(true),
            ..Default::default()
        },
    )
    .expect("settings");

    let before = snapshot(&conn, &ids);
    assert_eq!(before.subjects[0].name, "Appli");
    assert_eq!(before.views[0].groups[0].tasks[0].title, "Tâche 8");
    drop(conn);

    let conn = open(&path).expect("reopen");
    let after = snapshot(&conn, &ids);
    assert_eq!(before, after);
}
