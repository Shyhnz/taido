//! Taido V2.2 bis (2026-10-09): groups gather projects in the sidebar, like Brave's tab
//! groups. They hold no task, no section and no folder.

use super::*;
use crate::db::{open_in_memory, sections, tasks, test_support};
use crate::model::{CreateSectionInput, CreateTaskInput, GroupProjectsInput};

fn names(conn: &Connection) -> Vec<(String, Option<String>, bool)> {
    let all = list(conn).expect("list");
    all.iter()
        .map(|s| {
            let parent = s
                .parent_id
                .as_ref()
                .and_then(|p| all.iter().find(|x| &x.id == p))
                .map(|p| p.name.clone());
            (s.name.clone(), parent, s.is_group)
        })
        .collect()
}

fn entry(name: &str, group: Option<&str>, is_group: bool) -> (String, Option<String>, bool) {
    (name.into(), group.map(String::from), is_group)
}

fn group(conn: &Connection, ids: &[&String], group_id: Option<&str>, name: &str) -> String {
    group_projects(
        conn,
        &GroupProjectsInput {
            project_ids: ids.iter().map(|s| (*s).clone()).collect(),
            group_id: group_id.map(String::from),
            name: Some(name.into()),
        },
    )
    .expect("group")
}

#[test]
fn projects_are_grouped_in_place_and_ungrouped_after_their_group() {
    let conn = open_in_memory().expect("db");
    test_support::subject(&conn, "Acme Studio");
    let peak = test_support::subject(&conn, "SummitEvents");
    let admin = test_support::subject(&conn, "Admin");
    let perso = test_support::subject(&conn, "Perso");
    let globex = group(&conn, &[&peak, &admin], None, "Globex");
    assert_eq!(
        names(&conn),
        [
            entry("Acme Studio", None, false),
            entry("Globex", None, true),
            entry("SummitEvents", Some("Globex"), false),
            entry("Admin", Some("Globex"), false),
            entry("Perso", None, false),
        ]
    );
    // Into an existing group: last in it.
    group(&conn, &[&perso], Some(&globex), "");
    assert_eq!(names(&conn)[4], entry("Perso", Some("Globex"), false));
    // Out of it: right after the group.
    ungroup_projects(&conn, std::slice::from_ref(&peak)).expect("ungroup");
    assert_eq!(
        names(&conn),
        [
            entry("Acme Studio", None, false),
            entry("Globex", None, true),
            entry("Admin", Some("Globex"), false),
            entry("Perso", Some("Globex"), false),
            entry("SummitEvents", None, false),
        ]
    );
    // « Dégrouper »: the group goes, its projects stay in its place.
    dissolve_group(&conn, &globex).expect("dissolve");
    assert_eq!(
        names(&conn),
        [
            entry("Acme Studio", None, false),
            entry("Admin", None, false),
            entry("Perso", None, false),
            entry("SummitEvents", None, false),
        ]
    );
}

#[test]
fn an_emptied_group_disappears() {
    let conn = open_in_memory().expect("db");
    let a = test_support::subject(&conn, "A");
    let b = test_support::subject(&conn, "B");
    let first = group(&conn, &[&a], None, "Un");
    let second = group(&conn, &[&b], None, "Deux");
    group(&conn, &[&a], Some(&second), "");
    assert!(get(&conn, &first).is_err(), "the first group is gone");
    ungroup_projects(&conn, &[a.clone(), b.clone()]).expect("ungroup");
    assert!(get(&conn, &second).is_err());
}

#[test]
fn a_group_holds_no_task_no_section_and_no_group() {
    let conn = open_in_memory().expect("db");
    let a = test_support::subject(&conn, "A");
    let g = group(&conn, &[&a], None, "G");
    let task = tasks::create(
        &conn,
        &CreateTaskInput {
            title: "T".into(),
            description: None,
            subject_id: Some(g.clone()),
            section_id: None,
            due_date: None,
            due_time: None,
        },
    );
    assert!(matches!(task, Err(AppError::Invalid(_))));
    let section = sections::create(
        &conn,
        &CreateSectionInput {
            subject_id: g.clone(),
            name: "S".into(),
            subpath: None,
        },
    );
    assert!(matches!(section, Err(AppError::Invalid(_))));
    let other = test_support::subject(&conn, "Other");
    let g2 = group(&conn, &[&other], None, "G2");
    let nested = group_projects(
        &conn,
        &GroupProjectsInput {
            project_ids: vec![g2],
            group_id: Some(g.clone()),
            name: None,
        },
    );
    assert!(nested.is_err());
    // A project goes only into a group.
    let b = test_support::subject(&conn, "B");
    let into_project = group_projects(
        &conn,
        &GroupProjectsInput {
            project_ids: vec![b],
            group_id: Some(a),
            name: None,
        },
    );
    assert!(into_project.is_err());
}

#[test]
fn a_new_group_without_name_is_named() {
    let conn = open_in_memory().expect("db");
    let a = test_support::subject(&conn, "A");
    let g = group_projects(
        &conn,
        &GroupProjectsInput {
            project_ids: vec![a],
            group_id: None,
            name: None,
        },
    )
    .expect("group");
    assert_eq!(get(&conn, &g).expect("group").name, NEW_GROUP_NAME);
}

/// Migration 0015: parents become groups; one that still holds tasks stays a project in a
/// new group of the same name.
#[test]
fn migration_turns_parents_into_groups() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("db.sqlite3");
    {
        let mut conn = Connection::open(&path).expect("open");
        crate::db::MIGRATIONS
            .to_version(&mut conn, 14)
            .expect("to 14");
        conn.execute_batch(
            "INSERT INTO subjects (id, name, color, root_path, position, created_at, \
               updated_at, parent_id) VALUES
               ('globex', 'Globex', 'teal', NULL, 1, 't', 't', NULL),
               ('admin', 'Admin', 'teal', NULL, 1, 't', 't', 'globex'),
               ('initech', 'Initech', 'pink', NULL, 2, 't', 't', NULL),
               ('peak', 'SummitEvents', 'pink', NULL, 1, 't', 't', 'initech'),
               ('acme', 'Acme Studio', 'violet', NULL, 3, 't', 't', NULL);
             INSERT INTO tasks (id, subject_id, title, position, created_at, updated_at)
               VALUES ('t1', 'initech', 'Réunion', 1, 't', 't');",
        )
        .expect("old data");
    }
    let conn = crate::db::open(&path).expect("migrate");
    let all = names(&conn);
    assert_eq!(all[0], entry("Globex", None, true));
    assert_eq!(all[1], entry("Admin", Some("Globex"), false));
    assert_eq!(all[2], entry("Initech", None, true));
    assert!(all[3..5].contains(&entry("SummitEvents", Some("Initech"), false)));
    assert!(all[3..5].contains(&entry("Initech", Some("Initech"), false)));
    assert_eq!(all[5], entry("Acme Studio", None, false));
    // The task stays in its project, now inside the group.
    assert_eq!(
        tasks::load(&conn, "t1")
            .expect("task")
            .subject_id
            .as_deref(),
        Some("initech")
    );
}

#[test]
fn third_project_is_created_without_account() {
    let conn = open_in_memory().expect("db");
    for i in 0..10 {
        create(
            &conn,
            &CreateSubjectInput {
                name: format!("Project {i}"),
                color: None,
                root_path: None,
                parent_id: None,
            },
        )
        .expect("every project is allowed");
    }
    assert_eq!(list(&conn).expect("list").len(), 10);
}

#[test]
fn groups_need_no_plan() {
    let conn = open_in_memory().expect("db");
    let a = test_support::subject(&conn, "A");
    let id = group_projects(
        &conn,
        &GroupProjectsInput {
            project_ids: vec![a],
            group_id: None,
            name: Some("Work".into()),
        },
    )
    .expect("grouping is allowed");
    assert!(get(&conn, &id).expect("group").is_group);
}
