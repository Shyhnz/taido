use chrono::{Local, NaiveDate, SecondsFormat, TimeZone, Utc};
use rusqlite::Connection;

use super::*;
use crate::db::test_support::{
    claude_terminal, section, set_session_state, sub_project, subject, task,
};
use crate::db::{open_in_memory, subtasks, tasks, terminals};
use crate::model::{
    AddSubtaskInput, LineKind, LineTone, Ring, SetCompletedInput, SetDueInput, UpdateTaskInput,
};

fn today() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 10, 2).expect("date")
}

fn view(conn: &Connection, kind: ViewKind, subject_id: Option<&str>) -> ViewModel {
    get_view(
        conn,
        &GetViewInput {
            kind,
            subject_id: subject_id.map(String::from),
            from: None,
            days: None,
        },
        today(),
    )
    .expect("view")
}

fn due(conn: &Connection, id: &str, date: &str, time: Option<&str>) {
    tasks::set_due(
        conn,
        &SetDueInput {
            id: id.into(),
            date: Some(date.into()),
            time: time.map(String::from),
        },
    )
    .expect("due");
}

fn complete(conn: &Connection, id: &str) {
    tasks::set_completed(
        conn,
        &SetCompletedInput {
            id: id.into(),
            completed: true,
        },
    )
    .expect("complete");
}

/// Marks a task completed at a given local date and time.
fn complete_at(conn: &Connection, id: &str, date: NaiveDate, hour: u32) {
    let local = Local
        .from_local_datetime(&date.and_hms_opt(hour, 0, 0).expect("time"))
        .earliest()
        .expect("local time");
    let at = local
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    conn.execute(
        "UPDATE tasks SET completed_at = ?2 WHERE id = ?1",
        rusqlite::params![id, at],
    )
    .expect("complete_at");
}

fn titles(rows: &[TaskRow]) -> Vec<&str> {
    rows.iter().map(|r| r.title.as_str()).collect()
}

#[test]
fn inbox_view() {
    let conn = open_in_memory().expect("db");
    let s = subject(&conn, "S");
    let _in_subject = task(&conn, "elsewhere", Some(&s), None);
    let a = task(&conn, "a", None, None);
    let b = task(&conn, "b", None, None);
    let c = task(&conn, "c", None, None);
    let d = task(&conn, "d", None, None);
    complete_at(&conn, &a, today(), 9);
    complete_at(&conn, &c, today(), 11);
    let v = view(&conn, ViewKind::Inbox, None);
    assert_eq!(v.kind, ViewKind::Inbox);
    assert_eq!(v.today, "2026-10-02");
    assert_eq!(v.subject, None);
    assert_eq!(v.open_count, 2);
    assert_eq!(v.groups.len(), 1);
    let g = &v.groups[0];
    assert_eq!(g.key, GroupKey::Inbox);
    assert!(!g.show_header);
    assert_eq!(
        g.add_target,
        Some(AddTarget {
            subject_id: None,
            section_id: None,
            due_today: false,
            due_date: None
        })
    );
    assert_eq!(titles(&g.tasks), vec!["b", "d"]);
    assert!(g.tasks.iter().all(|r| r.subject.is_none()));
    assert_eq!(titles(&v.completed), vec!["c", "a"]);
    assert!(v.completed.iter().all(|r| r.ring == Ring::Completed));
    let _ = (b, d);
}

#[test]
fn today_view_with_fixed_date() {
    let conn = open_in_memory().expect("db");
    let sa = subject(&conn, "A");
    let sb = subject(&conn, "B");
    let overdue = task(&conn, "overdue B", Some(&sb), None);
    due(&conn, &overdue, "2026-09-30", None);
    let late = task(&conn, "14:00 B", Some(&sb), None);
    due(&conn, &late, "2026-10-02", Some("14:00"));
    let early = task(&conn, "09:00 inbox", None, None);
    due(&conn, &early, "2026-10-02", Some("09:00"));
    let plain = task(&conn, "today A", Some(&sa), None);
    due(&conn, &plain, "2026-10-02", None);
    let inbox_plain = task(&conn, "today inbox", None, None);
    due(&conn, &inbox_plain, "2026-10-02", None);
    let future = task(&conn, "future", Some(&sa), None);
    due(&conn, &future, "2026-10-03", Some("08:00"));
    let _no_due = task(&conn, "no due", Some(&sa), None);
    let done_today = task(&conn, "done today", Some(&sa), None);
    due(&conn, &done_today, "2026-10-02", None);
    complete_at(&conn, &done_today, today(), 10);
    let done_today_later = task(&conn, "done today later", None, None);
    complete_at(&conn, &done_today_later, today(), 16);
    let done_yesterday = task(&conn, "done yesterday", Some(&sa), None);
    complete_at(
        &conn,
        &done_yesterday,
        NaiveDate::from_ymd_opt(2026, 10, 1).expect("date"),
        23,
    );

    let late_too = task(&conn, "older A", Some(&sa), None);
    due(&conn, &late_too, "2026-09-12", Some("18:00"));
    // A subtask due today shows on its own when its parent (due tomorrow) is not in Today.
    let sub = subtasks::add(
        &conn,
        &AddSubtaskInput {
            task_id: future.clone(),
            text: "sub today".into(),
        },
    )
    .expect("subtask")
    .id;
    due(&conn, &sub, "2026-10-02", Some("10:00"));
    // One whose parent is in Today stays nested.
    let nested = subtasks::add(
        &conn,
        &AddSubtaskInput {
            task_id: plain.clone(),
            text: "nested".into(),
        },
    )
    .expect("subtask")
    .id;
    due(&conn, &nested, "2026-10-02", None);

    let v = view(&conn, ViewKind::Today, None);
    assert_eq!(v.kind, ViewKind::Today);
    let keys: Vec<&GroupKey> = v.groups.iter().map(|g| &g.key).collect();
    assert_eq!(
        keys,
        vec![&GroupKey::TodayOverdue, &GroupKey::TodayRest],
        "no waiting group without agent rings"
    );
    let late_group = &v.groups[0];
    assert!(late_group.show_header);
    assert_eq!(late_group.add_target, None);
    assert_eq!(titles(&late_group.tasks), vec!["older A", "overdue B"]);
    assert!(late_group
        .tasks
        .iter()
        .all(|r| r.due.as_ref().is_some_and(|d| d.overdue)));
    let g = &v.groups[1];
    assert_eq!(g.key, GroupKey::TodayRest);
    assert!(
        g.show_header,
        "the rest is headed when it follows another group"
    );
    assert_eq!(
        g.add_target,
        Some(AddTarget {
            subject_id: None,
            section_id: None,
            due_today: true,
            due_date: None
        })
    );
    assert_eq!(
        titles(&g.tasks),
        vec![
            "09:00 inbox",
            "sub today",
            "14:00 B",
            "today inbox",
            "today A"
        ]
    );
    assert_eq!(v.open_count, 7);
    assert_eq!(titles(&g.tasks[4].children), ["nested"]);
    assert_eq!(
        g.tasks[1].subject.as_ref().map(|s| s.name.as_str()),
        Some("A")
    );
    let row = |title: &str| g.tasks.iter().find(|r| r.title == title).expect("row");
    assert!(!row("today A").due.as_ref().expect("due").overdue);
    assert_eq!(
        row("today A").subject.as_ref().map(|s| s.name.as_str()),
        Some("A")
    );
    assert_eq!(row("09:00 inbox").subject, None);
    assert_eq!(titles(&v.completed), vec!["done today later", "done today"]);
    assert_eq!(
        v.completed[1].subject.as_ref().map(|s| s.name.as_str()),
        Some("A")
    );
}

#[test]
fn subject_view_grouping() {
    let conn = open_in_memory().expect("db");
    let s = subject(&conn, "S");
    let other = subject(&conn, "Other");
    let empty = section(&conn, &s, "Empty");
    let full = section(&conn, &s, "Full");
    let t1 = task(&conn, "t1", Some(&s), Some(&full));
    let _t2 = task(&conn, "t2", Some(&s), Some(&full));
    let _x = task(&conn, "x", Some(&other), None);

    let v = view(&conn, ViewKind::Subject, Some(&s));
    assert_eq!(v.kind, ViewKind::Subject);
    let subj = v.subject.as_ref().expect("subject");
    assert_eq!(subj.id, s);
    assert_eq!(subj.open_count, 2);
    let counts: Vec<u32> = subj.sections.iter().map(|x| x.open_count).collect();
    assert_eq!(counts, vec![0, 2]);
    let keys: Vec<&GroupKey> = v.groups.iter().map(|g| &g.key).collect();
    assert_eq!(
        keys,
        vec![
            &GroupKey::NoSection,
            &GroupKey::Section {
                id: empty.clone(),
                name: "Empty".into(),
                subpath: None
            },
            &GroupKey::Section {
                id: full.clone(),
                name: "Full".into(),
                subpath: None
            },
        ]
    );
    let headers: Vec<bool> = v.groups.iter().map(|g| g.show_header).collect();
    assert_eq!(headers, vec![false, true, true]);
    assert!(v.groups[0].tasks.is_empty());
    assert!(v.groups[1].tasks.is_empty());
    assert_eq!(titles(&v.groups[2].tasks), vec!["t1", "t2"]);
    assert_eq!(
        v.groups[2].add_target,
        Some(AddTarget {
            subject_id: Some(s.clone()),
            section_id: Some(full.clone()),
            due_today: false,
            due_date: None
        })
    );
    assert!(v.groups[2].tasks.iter().all(|r| r.subject.is_none()));
    assert_eq!(v.groups[2].tasks[0].subject_id.as_deref(), Some(s.as_str()));
    assert_eq!(v.open_count, 2);

    let _loose = task(&conn, "loose", Some(&s), None);
    let done_loose = task(&conn, "done loose", Some(&s), None);
    complete(&conn, &done_loose);
    complete(&conn, &t1);
    let v = view(&conn, ViewKind::Subject, Some(&s));
    assert_eq!(v.groups.len(), 3);
    assert_eq!(v.groups[0].key, GroupKey::NoSection);
    assert_eq!(titles(&v.groups[0].tasks), vec!["loose"]);
    assert_eq!(
        v.groups[0].add_target,
        Some(AddTarget {
            subject_id: Some(s.clone()),
            section_id: None,
            due_today: false,
            due_date: None
        })
    );
    assert_eq!(titles(&v.groups[2].tasks), vec!["t2"]);
    tasks::delete(&conn, &_loose).expect("delete");
    let v = view(&conn, ViewKind::Subject, Some(&s));
    assert!(v.groups[0].tasks.is_empty());
    assert_eq!(v.open_count, 1);
    assert_eq!(v.completed.len(), 2);
    assert!(v.completed.iter().all(|r| r.ring == Ring::Completed));
}

#[test]
fn empty_subject_without_sections_keeps_an_addable_no_section_group() {
    let conn = open_in_memory().expect("db");
    let s = subject(&conn, "Empty");
    let v = view(&conn, ViewKind::Subject, Some(&s));
    assert_eq!(v.groups.len(), 1);
    assert_eq!(v.groups[0].key, GroupKey::NoSection);
    assert!(!v.groups[0].show_header);
    assert!(v.groups[0].tasks.is_empty());
    assert_eq!(
        v.groups[0].add_target,
        Some(AddTarget {
            subject_id: Some(s.clone()),
            section_id: None,
            due_today: false,
            due_date: None
        })
    );
}

#[test]
fn subject_view_errors() {
    let conn = open_in_memory().expect("db");
    let missing_id = get_view(
        &conn,
        &GetViewInput {
            kind: ViewKind::Subject,
            subject_id: None,
            from: None,
            days: None,
        },
        today(),
    );
    assert!(matches!(missing_id, Err(AppError::Invalid(_))));
    let unknown = get_view(
        &conn,
        &GetViewInput {
            kind: ViewKind::Subject,
            subject_id: Some("nope".into()),
            from: None,
            days: None,
        },
        today(),
    );
    assert!(matches!(unknown, Err(AppError::NotFound(_))));
}

#[test]
fn today_without_late_tasks_is_a_single_headerless_group() {
    let conn = open_in_memory().expect("db");
    let t = task(&conn, "t", None, None);
    due(&conn, &t, "2026-10-02", None);
    let v = view(&conn, ViewKind::Today, None);
    assert_eq!(v.groups.len(), 1);
    assert_eq!(v.groups[0].key, GroupKey::TodayRest);
    assert!(!v.groups[0].show_header);
    let empty = open_in_memory().expect("db");
    let v = view(&empty, ViewKind::Today, None);
    assert_eq!(v.groups.len(), 1);
    assert!(v.groups[0].tasks.is_empty());
    assert!(v.groups[0].add_target.is_some());
}

#[test]
fn deleted_tasks_and_subjects_never_show() {
    let conn = open_in_memory().expect("db");
    let s = subject(&conn, "S");
    let in_s = task(&conn, "in s", Some(&s), None);
    due(&conn, &in_s, "2026-10-02", None);
    let inbox = task(&conn, "inbox", None, None);
    due(&conn, &inbox, "2026-10-02", None);
    let done = task(&conn, "done", None, None);
    complete_at(&conn, &done, today(), 9);
    tasks::delete(&conn, &inbox).expect("delete");
    tasks::delete(&conn, &done).expect("delete");
    let v = view(&conn, ViewKind::Inbox, None);
    assert!(v.groups[0].tasks.is_empty());
    assert!(v.completed.is_empty());
    assert_eq!(
        titles(&view(&conn, ViewKind::Today, None).groups[0].tasks),
        vec!["in s"]
    );
    subjects::delete(&conn, &s).expect("delete subject");
    let v = view(&conn, ViewKind::Today, None);
    assert!(v.groups[0].tasks.is_empty());
    assert!(v.completed.is_empty());
    assert!(matches!(
        get_view(
            &conn,
            &GetViewInput {
                kind: ViewKind::Subject,
                subject_id: Some(s.clone()),
                from: None,
                days: None,
            },
            today(),
        ),
        Err(AppError::NotFound(_))
    ));
    assert_eq!(
        counts(&conn, today()).expect("counts"),
        Counts {
            inbox: 0,
            today: 0,
            waiting: 0
        }
    );
    subjects::restore(&conn, &s).expect("restore");
    assert_eq!(counts(&conn, today()).expect("counts").today, 1);
}

#[test]
fn row_details() {
    let conn = open_in_memory().expect("db");
    let id = task(&conn, "t", None, None);
    tasks::update(
        &conn,
        &UpdateTaskInput {
            id: id.clone(),
            title: None,
            description: Some("\n first \nsecond".into()),
        },
    )
    .expect("update");
    for text in ["a", "b", "c"] {
        subtasks::add(
            &conn,
            &AddSubtaskInput {
                task_id: id.clone(),
                text: text.into(),
            },
        )
        .expect("subtask");
    }
    let first = subtasks::list_for_task(&conn, &id).expect("list")[0]
        .id
        .clone();
    subtasks::toggle(&conn, &first).expect("toggle");
    let v = view(&conn, ViewKind::Inbox, None);
    let row = &v.groups[0].tasks[0];
    assert_eq!(row.ring, Ring::Human);
    assert_eq!(row.line, None, "the description never shows in lists");
    assert!(row.has_description);
    assert_eq!((row.subtasks_done, row.subtasks_total), (1, 3));
    assert_eq!(row.open_terminals, 0);
    assert_eq!(row.due, None);
    complete(&conn, &id);
    let v = view(&conn, ViewKind::Inbox, None);
    let row = &v.completed[0];
    assert_eq!(row.ring, Ring::Completed);
    assert_eq!(row.line, None);
    // The panel keeps its own line.
    let detail = tasks::detail(&conn, &id).expect("detail");
    assert_eq!(detail.line.map(|l| l.kind), Some(LineKind::Completed));
    let blank = task(&conn, "blank", None, None);
    tasks::update(
        &conn,
        &UpdateTaskInput {
            id: blank,
            title: None,
            description: Some("  \n ".into()),
        },
    )
    .expect("update");
    let v = view(&conn, ViewKind::Inbox, None);
    assert!(!v.groups[0].tasks[0].has_description);
}

#[test]
fn sidebar_counts() {
    let conn = open_in_memory().expect("db");
    let s = subject(&conn, "S");
    let i1 = task(&conn, "i1", None, None);
    let _i2 = task(&conn, "i2", None, None);
    let i3 = task(&conn, "i3", None, None);
    complete(&conn, &i3);
    let t = task(&conn, "t", Some(&s), None);
    due(&conn, &t, "2026-10-01", None);
    due(&conn, &i1, "2026-10-02", Some("10:00"));
    let f = task(&conn, "f", Some(&s), None);
    due(&conn, &f, "2026-10-09", None);
    let c = counts(&conn, today()).expect("counts");
    assert_eq!(
        c,
        Counts {
            inbox: 2,
            today: 2,
            waiting: 0
        }
    );
    let subj = subjects::get(&conn, &s).expect("subject");
    assert_eq!(subj.open_count, 2);
}

/// A task of subject `s` with a Claude session in `state` (`kind` when waiting); its
/// terminal is closed when `open` is false.
fn with_session(
    conn: &Connection,
    title: &str,
    s: Option<&str>,
    state: &str,
    kind: Option<&str>,
    open: bool,
) -> String {
    let t = task(conn, title, s, None);
    let (term, sess) = (format!("term-{title}"), format!("sess-{title}"));
    claude_terminal(conn, &t, &term, &sess, &format!("uuid-{title}"));
    if !open {
        terminals::mark_exited(conn, &term, Some(0)).expect("exit");
    }
    set_session_state(conn, &sess, state, kind, "2026-10-02T09:00:00.000Z");
    t
}

#[test]
fn claude_states_in_views() {
    let conn = open_in_memory().expect("db");
    let s = subject(&conn, "S");
    let a = with_session(&conn, "a", Some(&s), "waiting", Some("permission"), true);
    conn.execute(
        "UPDATE agent_sessions SET pending_permission = \
         '{\"tool_name\":\"Bash\",\"summary\":\"Commande : rm -rf dist\"}' WHERE id = 'sess-a'",
        [],
    )
    .expect("pending");
    let _b = with_session(&conn, "b", Some(&s), "done", None, true);
    let c = with_session(&conn, "c", None, "crashed", None, false);
    let _d = with_session(&conn, "d", Some(&s), "working", None, true);
    let _e = with_session(&conn, "e", Some(&s), "paused", None, false);
    let h = task(&conn, "h", Some(&s), None);
    due(&conn, &h, "2026-10-01", None);
    let k = with_session(&conn, "k", Some(&s), "waiting", Some("question"), true);
    complete(&conn, &k);

    // Today: « Claude attend » by urgency, then « En retard », then the rest.
    let v = view(&conn, ViewKind::Today, None);
    let keys: Vec<&GroupKey> = v.groups.iter().map(|g| &g.key).collect();
    assert_eq!(
        keys,
        vec![
            &GroupKey::TodayWaiting,
            &GroupKey::TodayOverdue,
            &GroupKey::TodayRest
        ]
    );
    assert!(v.groups.iter().all(|g| g.show_header));
    assert_eq!(titles(&v.groups[0].tasks), ["a", "c", "b"]);
    assert_eq!(titles(&v.groups[1].tasks), ["h"]);
    assert_eq!(
        titles(&v.groups[2].tasks),
        ["d"],
        "Paused is not active today"
    );
    let row_a = &v.groups[0].tasks[0];
    assert_eq!(row_a.ring, Ring::Waiting);
    let line = row_a.line.as_ref().expect("line");
    assert_eq!(line.kind, LineKind::WaitingPermission);
    assert_eq!(line.text.as_deref(), Some("Commande : rm -rf dist"));
    assert_eq!(line.tone, LineTone::Waiting);
    assert_eq!(v.groups[0].tasks[1].ring, Ring::Crashed);
    assert_eq!(v.groups[1].tasks[0].line, None, "Human rows have no line");

    // Counts: one Waiting task.
    let c_counts = counts(&conn, today()).expect("counts");
    assert_eq!(c_counts.waiting, 1);
    assert_eq!(c_counts.today, 5);

    // Subject view: rings everywhere; Completed wins over a waiting session.
    let v = view(&conn, ViewKind::Subject, Some(&s));
    let rings: Vec<(&str, Ring)> = v.groups[0]
        .tasks
        .iter()
        .map(|t| (t.title.as_str(), t.ring))
        .collect();
    assert_eq!(
        rings,
        [
            ("a", Ring::Waiting),
            ("b", Ring::Done),
            ("d", Ring::Working),
            ("e", Ring::Human),
            ("h", Ring::Human)
        ]
    );
    assert_eq!(v.completed[0].ring, Ring::Completed);
    assert_eq!(v.completed[0].line, None);
    // A stopped session: a plain task in lists (no row line).
    assert_eq!(v.groups[0].tasks[3].line, None);

    // Subject dot: red while a task waits, then black, then green.
    let dot = |conn: &Connection| subjects::get(conn, &s).expect("subject").dot;
    assert_eq!(dot(&conn), Some(SubjectDot::Waiting));
    assert_eq!(
        subjects::list(&conn).expect("list")[0].dot,
        Some(SubjectDot::Waiting)
    );
    set_session_state(&conn, "sess-a", "idle", None, "2026-10-02T09:30:00.000Z");
    assert_eq!(dot(&conn), Some(SubjectDot::Done));
    set_session_state(&conn, "sess-d", "error", None, "2026-10-02T09:30:00.000Z");
    assert_eq!(dot(&conn), Some(SubjectDot::Error));
    set_session_state(&conn, "sess-d", "idle", None, "2026-10-02T09:30:00.000Z");
    set_session_state(&conn, "sess-b", "idle", None, "2026-10-02T09:30:00.000Z");
    assert_eq!(dot(&conn), None, "the crashed task c has no project");

    // Task detail: same ring and line as the row, and since when.
    let detail = tasks::detail(&conn, &c).expect("detail");
    assert_eq!(detail.ring, Ring::Crashed);
    assert_eq!(detail.line.map(|l| l.kind), Some(LineKind::Crashed));
    assert_eq!(
        detail.ring_since.as_deref(),
        Some("2026-10-02T09:00:00.000Z")
    );
    let detail = tasks::detail(&conn, &a).expect("detail");
    assert_eq!(detail.ring, Ring::Idle);
    assert_eq!(
        detail.ring_since.as_deref(),
        Some("2026-10-02T09:30:00.000Z")
    );
}

/// Starting counts as Working: a task without a due date is in Today from the
/// launch of Claude, not only once `SessionStart` arrives.
#[test]
fn starting_task_is_in_today() {
    let conn = open_in_memory().expect("db");
    let s = subject(&conn, "S");
    let _t = with_session(&conn, "boot", Some(&s), "starting", None, true);
    let v = view(&conn, ViewKind::Today, None);
    let rows: Vec<&TaskRow> = v.groups.iter().flat_map(|g| &g.tasks).collect();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].title, "boot");
    assert_eq!(rows[0].ring, Ring::Starting);
    assert_eq!(counts(&conn, today()).expect("counts").today, 1);
}

/// A child task of `parent`; with a Claude session in `state` when given.
fn child(
    conn: &Connection,
    parent: &str,
    title: &str,
    state: Option<(&str, Option<&str>)>,
) -> String {
    let id = subtasks::add(
        conn,
        &AddSubtaskInput {
            task_id: parent.into(),
            text: title.into(),
        },
    )
    .expect("subtask")
    .id;
    if let Some((state, kind)) = state {
        let (term, sess) = (format!("term-{title}"), format!("sess-{title}"));
        claude_terminal(conn, &id, &term, &sess, &format!("uuid-{title}"));
        set_session_state(conn, &sess, state, kind, "2026-10-02T09:10:00.000Z");
    }
    id
}

#[test]
fn children_are_nested_under_their_parent() {
    let conn = open_in_memory().expect("db");
    let s = subject(&conn, "S");
    let p = task(&conn, "parent", Some(&s), None);
    let _other = task(&conn, "other", Some(&s), None);
    let c1 = child(&conn, &p, "c1", None);
    let c2 = child(&conn, &p, "c2", None);
    let c3 = child(&conn, &p, "c3", None);
    complete_at(&conn, &c1, today(), 9);
    complete_at(&conn, &c3, today(), 10);
    // A child due today shows on its own in Today (its parent is not there).
    due(&conn, &c2, "2026-10-02", None);
    tasks::set_priority(
        &conn,
        &crate::model::SetPriorityInput {
            id: c2.clone(),
            priority: 3,
        },
    )
    .expect("priority");

    let v = view(&conn, ViewKind::Subject, Some(&s));
    assert_eq!(titles(&v.groups[0].tasks), ["parent", "other"]);
    assert_eq!(v.open_count, 2, "children are counted with their parent");
    let row = &v.groups[0].tasks[0];
    assert_eq!(row.parent_id, None);
    assert_eq!(row.priority, 1);
    // Open ones by position, then completed ones, most recent first.
    assert_eq!(titles(&row.children), ["c2", "c3", "c1"]);
    assert_eq!((row.subtasks_done, row.subtasks_total), (2, 3));
    let c2_row = &row.children[0];
    assert_eq!(c2_row.parent_id.as_deref(), Some(p.as_str()));
    assert_eq!(c2_row.priority, 3);
    assert_eq!(
        c2_row.due.as_ref().map(|d| d.date.as_str()),
        Some("2026-10-02")
    );
    assert!(c2_row.children.is_empty());
    assert_eq!(row.children[1].ring, Ring::Completed);
    assert!(
        v.completed.is_empty(),
        "completed children stay under their parent"
    );
    assert_eq!(subjects::get(&conn, &s).expect("subject").open_count, 2);

    let today_view = view(&conn, ViewKind::Today, None);
    let rows: Vec<&TaskRow> = today_view.groups.iter().flat_map(|g| &g.tasks).collect();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].title, "c2");
    assert_eq!(rows[0].parent_id.as_deref(), Some(p.as_str()));
    assert_eq!(counts(&conn, today()).expect("counts").today, 1);

    // A completed parent (here without completing its children, like migrated data): its
    // completed children come with it into the completed list; an open one stays in the open
    // list, on its own.
    complete_at(&conn, &p, today(), 11);
    let v = view(&conn, ViewKind::Subject, Some(&s));
    assert_eq!(titles(&v.completed), ["parent"]);
    assert_eq!(titles(&v.completed[0].children), ["c3", "c1"]);
    let mut open = titles(&v.groups[0].tasks);
    open.sort_unstable();
    assert_eq!(open, ["c2", "other"]);
    assert_eq!(subjects::get(&conn, &s).expect("subject").open_count, 2);

    // The panel lists the children as subtasks; a child shows its parent.
    let d = tasks::detail_on(&conn, &p, today()).expect("detail");
    let subs: Vec<(&str, bool, u8)> = d
        .subtasks
        .iter()
        .map(|s| (s.text.as_str(), s.done, s.priority))
        .collect();
    assert_eq!(subs, [("c2", false, 3), ("c3", true, 1), ("c1", true, 1)]);
    assert!(d.subtasks.iter().all(|s| s.task_id == p));
    let d = tasks::detail_on(&conn, &c2, today()).expect("detail");
    assert_eq!(d.parent.map(|r| r.title), Some("parent".to_string()));
    assert_eq!(d.priority, 3);
}

#[test]
fn an_open_child_of_a_completed_parent_still_shows() {
    let conn = open_in_memory().expect("db");
    let s = subject(&conn, "S");
    let p = task(&conn, "parent", Some(&s), None);
    // Completing the parent completes its children (like Todoist)...
    let c = child(&conn, &p, "c", None);
    complete(&conn, &p);
    let v = view(&conn, ViewKind::Subject, Some(&s));
    assert!(v.groups[0].tasks.is_empty());
    assert_eq!(titles(&v.completed[0].children), ["c"]);
    // ...but one can be reopened, and Claude asked a question there.
    tasks::set_completed(
        &conn,
        &SetCompletedInput {
            id: c.clone(),
            completed: false,
        },
    )
    .expect("reopen");
    claude_terminal(&conn, &c, "term-c", "sess-c", "uuid-c");
    set_session_state(
        &conn,
        "sess-c",
        "waiting",
        Some("question"),
        "2026-10-02T09:10:00.000Z",
    );

    let v = view(&conn, ViewKind::Subject, Some(&s));
    assert_eq!(titles(&v.groups[0].tasks), ["c"]);
    assert_eq!(v.groups[0].tasks[0].ring, Ring::Waiting);
    assert_eq!(v.groups[0].tasks[0].parent_id.as_deref(), Some(p.as_str()));
    assert!(v.completed[0].children.is_empty(), "not shown twice");
    let today_view = view(&conn, ViewKind::Today, None);
    assert_eq!(today_view.groups[0].key, GroupKey::TodayWaiting);
    assert_eq!(titles(&today_view.groups[0].tasks), ["c"]);
    let n = counts(&conn, today()).expect("counts");
    assert_eq!((n.waiting, n.today), (1, 1));
    let subject = subjects::get(&conn, &s).expect("subject");
    assert_eq!(subject.dot, Some(SubjectDot::Waiting));
    assert_eq!(subject.open_count, 1);
    assert_eq!(
        subject_dots(&conn).expect("dots").get(&s),
        Some(&SubjectDot::Waiting)
    );

    // Inbox counter and « Reporter à aujourd'hui » see it too.
    let q = task(&conn, "q", None, None);
    let qc = child(&conn, &q, "qc", None);
    due(&conn, &qc, "2026-09-30", None);
    complete_at(&conn, &q, today(), 8);
    assert_eq!(counts(&conn, today()).expect("counts").inbox, 1);
    assert_eq!(
        tasks::reschedule_overdue(&conn, today()).expect("reschedule"),
        vec![qc]
    );
}

#[test]
fn a_parent_ring_sums_up_its_children() {
    let conn = open_in_memory().expect("db");
    let s = subject(&conn, "S");
    // The parent's own Claude works; a child asks a question, another has finished.
    let p = with_session(&conn, "p", Some(&s), "working", None, true);
    let waiting = child(&conn, &p, "w", Some(("waiting", Some("question"))));
    conn.execute(
        "UPDATE agent_sessions SET question = 'On y va ?' WHERE id = 'sess-w'",
        [],
    )
    .expect("question");
    let done = child(&conn, &p, "d", Some(("done", None)));
    let _plain = child(&conn, &p, "plain", None);

    let v = view(&conn, ViewKind::Subject, Some(&s));
    let row = &v.groups[0].tasks[0];
    assert_eq!(row.ring, Ring::Waiting, "the most critical state wins");
    let line = row.line.as_ref().expect("line");
    assert_eq!(line.kind, LineKind::WaitingQuestion);
    assert_eq!(line.text.as_deref(), Some("On y va ?"));
    let rings: Vec<(&str, Ring)> = row
        .children
        .iter()
        .map(|c| (c.title.as_str(), c.ring))
        .collect();
    assert_eq!(
        rings,
        [
            ("w", Ring::Waiting),
            ("d", Ring::Done),
            ("plain", Ring::Human)
        ]
    );
    assert_eq!(row.open_terminals, 1, "the parent's own terminals");
    assert_eq!(row.children[0].open_terminals, 1);

    // Today: the parent once in « Claude attend », counted once.
    let today_view = view(&conn, ViewKind::Today, None);
    assert_eq!(today_view.groups[0].key, GroupKey::TodayWaiting);
    assert_eq!(titles(&today_view.groups[0].tasks), ["p"]);
    let c = counts(&conn, today()).expect("counts");
    assert_eq!((c.waiting, c.today), (1, 1));
    assert_eq!(
        subjects::get(&conn, &s).expect("subject").dot,
        Some(SubjectDot::Waiting)
    );

    // The panel: same ring, since the child's state; subtasks carry their own rings.
    let d = tasks::detail_on(&conn, &p, today()).expect("detail");
    assert_eq!(d.ring, Ring::Waiting);
    assert_eq!(d.ring_since.as_deref(), Some("2026-10-02T09:10:00.000Z"));
    assert_eq!(d.subtasks[0].ring, Ring::Waiting);
    assert_eq!(d.subtasks[0].open_terminals, 1);
    // A child's own panel only knows its own session.
    let d = tasks::detail_on(&conn, &done, today()).expect("detail");
    assert_eq!(d.ring, Ring::Done);

    // Once the question is answered, the parent shows the next most critical state.
    set_session_state(&conn, "sess-w", "working", None, "2026-10-02T09:20:00.000Z");
    let v = view(&conn, ViewKind::Subject, Some(&s));
    assert_eq!(v.groups[0].tasks[0].ring, Ring::Done);
    assert_eq!(counts(&conn, today()).expect("counts").waiting, 0);
    // A deleted child no longer counts.
    tasks::delete(&conn, &done).expect("delete child");
    let v = view(&conn, ViewKind::Subject, Some(&s));
    assert_eq!(v.groups[0].tasks[0].ring, Ring::Working);
    assert_eq!(v.groups[0].tasks[0].subtasks_total, 2);
    let _ = waiting;
}

/// A child's Claude does not pull its parent into Today: the child, due today, shows on its
/// own (like the phone), and the parent only comes in through its own date or its own Claude.
#[test]
fn a_child_session_does_not_pull_its_parent_into_today() {
    let conn = open_in_memory().expect("db");
    let s = subject(&conn, "S");
    let p = task(&conn, "parent", Some(&s), None);
    let c = child(&conn, &p, "c", Some(("working", None)));
    due(&conn, &c, "2026-10-02", None);
    let _later = child(&conn, &p, "later", None);

    let v = view(&conn, ViewKind::Today, None);
    let rows: Vec<&TaskRow> = v.groups.iter().flat_map(|g| g.tasks.iter()).collect();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].title, "c");
    assert!(rows[0].children.is_empty());
    assert_eq!(counts(&conn, today()).expect("counts").today, 1);

    // An undated child with a live Claude also shows on its own.
    due(&conn, &c, "2026-10-09", None);
    let v = view(&conn, ViewKind::Today, None);
    let rows: Vec<&str> = v
        .groups
        .iter()
        .flat_map(|g| g.tasks.iter().map(|t| t.title.as_str()))
        .collect();
    assert_eq!(rows, ["c"]);

    // A waiting child alone in « Claude attend ».
    set_session_state(
        &conn,
        "sess-c",
        "waiting",
        Some("question"),
        "2026-10-02T09:20:00.000Z",
    );
    let v = view(&conn, ViewKind::Today, None);
    assert_eq!(v.groups[0].key, GroupKey::TodayWaiting);
    assert_eq!(titles(&v.groups[0].tasks), ["c"]);
}

fn upcoming_view(conn: &Connection, from: Option<&str>, days: Option<u32>) -> AppResult<ViewModel> {
    get_view(
        conn,
        &GetViewInput {
            kind: ViewKind::Upcoming,
            subject_id: None,
            from: from.map(String::from),
            days,
        },
        today(),
    )
}

fn day_keys(v: &ViewModel) -> Vec<String> {
    v.groups
        .iter()
        .map(|g| match &g.key {
            GroupKey::Day { date } => date.clone(),
            GroupKey::TodayOverdue => "overdue".into(),
            other => format!("{other:?}"),
        })
        .collect()
}

#[test]
fn upcoming_view_groups_by_day() {
    let conn = open_in_memory().expect("db");
    let sa = subject(&conn, "A");
    let late = task(&conn, "late", Some(&sa), None);
    due(&conn, &late, "2026-09-30", None);
    let later = task(&conn, "later", None, None);
    due(&conn, &later, "2026-09-28", None);
    let today_plain = task(&conn, "today A", Some(&sa), None);
    due(&conn, &today_plain, "2026-10-02", None);
    let today_timed = task(&conn, "today 08:00", Some(&sa), None);
    due(&conn, &today_timed, "2026-10-02", Some("08:00"));
    let monday = task(&conn, "monday", None, None);
    due(&conn, &monday, "2026-10-05", None);
    let far = task(&conn, "far", None, None);
    due(&conn, &far, "2026-10-20", None);
    let done = task(&conn, "done", None, None);
    due(&conn, &done, "2026-10-03", None);
    complete(&conn, &done);
    let _undated = task(&conn, "undated", None, None);
    // A subtask due on Saturday shows on Saturday on its own, and stays nested in its
    // parent (due on Monday); one due on Monday, like its parent, only nested.
    let add_sub = |text: &str, date: &str| {
        let id = subtasks::add(
            &conn,
            &AddSubtaskInput {
                task_id: monday.clone(),
                text: text.into(),
            },
        )
        .expect("subtask")
        .id;
        due(&conn, &id, date, None);
        id
    };
    add_sub("sub", "2026-10-03");
    add_sub("sub monday", "2026-10-05");
    add_sub("sub late", "2026-10-01");
    // A completed dated subtask is not listed.
    let sub_done = add_sub("sub done", "2026-10-04");
    complete(&conn, &sub_done);

    let v = upcoming_view(&conn, None, None).expect("view");
    assert_eq!(v.kind, ViewKind::Upcoming);
    assert_eq!(v.today, "2026-10-02");
    assert_eq!(
        day_keys(&v),
        [
            "overdue",
            "2026-10-02",
            "2026-10-03",
            "2026-10-04",
            "2026-10-05",
            "2026-10-06",
            "2026-10-07",
            "2026-10-08"
        ]
    );
    assert!(v.groups.iter().all(|g| g.show_header));
    assert_eq!(titles(&v.groups[0].tasks), ["later", "late", "sub late"]);
    assert_eq!(
        v.groups[0].tasks[2].parent_id.as_deref(),
        Some(monday.as_str())
    );
    assert_eq!(v.groups[0].add_target, None);
    assert_eq!(titles(&v.groups[1].tasks), ["today 08:00", "today A"]);
    assert!(v.groups[1].tasks.iter().all(|t| t.subject.is_some()));
    assert_eq!(
        titles(&v.groups[2].tasks),
        ["sub"],
        "completed are not listed"
    );
    assert_eq!(
        v.groups[2].tasks[0].parent_id.as_deref(),
        Some(monday.as_str())
    );
    assert!(v.groups[3].tasks.is_empty());
    assert_eq!(titles(&v.groups[4].tasks), ["monday"]);
    assert_eq!(
        titles(&v.groups[4].tasks[0].children),
        ["sub", "sub monday", "sub late", "sub done"]
    );
    assert_eq!(v.open_count, 7);
    assert!(v.completed.is_empty());
    assert_eq!(
        v.groups[1].add_target,
        Some(AddTarget {
            subject_id: None,
            section_id: None,
            due_today: true,
            due_date: Some("2026-10-02".into())
        })
    );
    assert_eq!(
        v.groups[2].add_target,
        Some(AddTarget {
            subject_id: None,
            section_id: None,
            due_today: false,
            due_date: Some("2026-10-03".into())
        })
    );

    // A range starting in the past: its past days are empty (« En retard » has them).
    let v = upcoming_view(&conn, Some("2026-09-30"), Some(4)).expect("view");
    assert_eq!(
        day_keys(&v),
        [
            "overdue",
            "2026-09-30",
            "2026-10-01",
            "2026-10-02",
            "2026-10-03"
        ]
    );
    assert!(v.groups[1].tasks.is_empty());
    assert_eq!(v.groups[3].tasks.len(), 2);

    // A range in the future: no « En retard ».
    let v = upcoming_view(&conn, Some("2026-10-19"), Some(3)).expect("view");
    assert_eq!(day_keys(&v), ["2026-10-19", "2026-10-20", "2026-10-21"]);
    assert_eq!(titles(&v.groups[1].tasks), ["far"]);

    // Days are clamped to 1..=62; a bad date is refused.
    let v = upcoming_view(&conn, Some("2026-10-19"), Some(0)).expect("view");
    assert_eq!(day_keys(&v), ["2026-10-19"]);
    let v = upcoming_view(&conn, Some("2026-10-19"), Some(500)).expect("view");
    assert_eq!(v.groups.len(), UPCOMING_MAX_DAYS as usize);
    for bad in ["2026-13-01", "02/10/2026", "2026-1-01"] {
        assert!(
            matches!(
                upcoming_view(&conn, Some(bad), None),
                Err(AppError::Invalid(_))
            ),
            "{bad}"
        );
    }
    // Without overdue tasks, no « En retard » group.
    tasks::reschedule_overdue(&conn, today()).expect("reschedule");
    let v = upcoming_view(&conn, None, None).expect("view");
    assert_eq!(day_keys(&v)[0], "2026-10-02");
    assert_eq!(
        titles(&v.groups[0].tasks),
        ["today 08:00", "later", "sub late", "late", "today A"]
    );
}

/// `AddTarget.due_date` is `null` when unset (optional on the TypeScript side).
#[test]
fn add_target_carries_an_optional_date() {
    let target = AddTarget {
        subject_id: None,
        section_id: None,
        due_today: true,
        due_date: None,
    };
    let json = serde_json::to_value(&target).expect("json");
    assert_eq!(
        json,
        serde_json::json!({
            "subjectId": null, "sectionId": null, "dueToday": true, "dueDate": null
        })
    );
    let dated = AddTarget {
        due_date: Some("2026-10-03".into()),
        ..target
    };
    let json = serde_json::to_value(&dated).expect("json");
    assert_eq!(json["dueDate"], "2026-10-03");
}

/// « À faire »: one group per project with open tasks, in sidebar order
/// (sub-projects after their parent), « Sans projet » last; subtasks nested.
#[test]
fn all_view_groups_every_open_task_by_project() {
    // Globex and Perso are groups (no tasks of their own).
    let conn = open_in_memory().expect("db");
    let globex = subject(&conn, "Globex");
    let empty = subject(&conn, "Empty");
    let perso = subject(&conn, "Perso");
    let client = sub_project(&conn, &globex, "Client", None);
    let quiet = sub_project(&conn, &globex, "Quiet", None);
    let other = sub_project(&conn, &perso, "Other", None);
    let sec = section(&conn, &client, "Sec");
    // Created out of order: sections and positions decide, not creation.
    let in_sec = task(&conn, "c-sec", Some(&client), Some(&sec));
    let _c1 = task(&conn, "c1", Some(&client), None);
    let _o1 = task(&conn, "o1", Some(&other), None);
    let _i1 = task(&conn, "i1", None, None);
    let done = task(&conn, "done", Some(&quiet), None);
    complete(&conn, &done);
    let deleted = task(&conn, "deleted", Some(&empty), None);
    tasks::delete(&conn, &deleted).expect("delete");
    let _sub = child(&conn, &in_sec, "c-sec child", None);

    let v = view(&conn, ViewKind::All, None);
    assert_eq!(v.kind, ViewKind::All);
    assert_eq!(v.subject, None);
    let keys: Vec<&GroupKey> = v.groups.iter().map(|g| &g.key).collect();
    let project = |id: &str, name: &str, color, parent: Option<&str>| GroupKey::Project {
        id: id.into(),
        name: name.into(),
        color,
        parent_name: parent.map(String::from),
    };
    use crate::model::SubjectColor::Teal;
    assert_eq!(
        keys,
        vec![
            &project(&client, "Client", Teal, Some("Globex")),
            &project(&other, "Other", Teal, Some("Perso")),
            &GroupKey::NoProject,
        ]
    );
    let group_titles: Vec<Vec<&str>> = v.groups.iter().map(|g| titles(&g.tasks)).collect();
    assert_eq!(
        group_titles,
        vec![vec!["c1", "c-sec"], vec!["o1"], vec!["i1"]]
    );
    assert!(v.groups.iter().all(|g| g.show_header));
    // Rows carry no project tag (the header names it); subtasks stay under their parent.
    let first = &v.groups[0].tasks[0];
    assert_eq!(first.subject, None);
    assert_eq!(first.subject_id.as_deref(), Some(client.as_str()));
    assert_eq!(titles(&v.groups[0].tasks[1].children), ["c-sec child"]);
    // Add rows: the group's project (no section), « Sans projet » for the last one.
    let target = |subject_id: Option<&str>| {
        Some(AddTarget {
            subject_id: subject_id.map(String::from),
            section_id: None,
            due_today: false,
            due_date: None,
        })
    };
    assert_eq!(v.groups[0].add_target, target(Some(&client)));
    assert_eq!(v.groups[2].add_target, target(None));
    assert!(v.completed.is_empty());
    assert_eq!(v.open_count, 4);

    // The sidebar order rules: moving Perso first moves its projects.
    subjects::reorder(
        &conn,
        &crate::model::ReorderInput {
            id: perso.clone(),
            index: 0,
        },
    )
    .expect("reorder");
    let v = view(&conn, ViewKind::All, None);
    let first_titles: Vec<&str> = v.groups.iter().map(|g| g.tasks[0].title.as_str()).collect();
    assert_eq!(first_titles, ["o1", "c1", "i1"]);

    // Nothing open: no group at all.
    let conn = open_in_memory().expect("db");
    let v = view(&conn, ViewKind::All, None);
    assert!(v.groups.is_empty());
    assert_eq!(v.open_count, 0);
}

/// « Sans projet » movable: its group sits at its
/// index among the top-level projects (last by default), after the sub-projects of the
/// project before it; every « À faire » group carries its index in its level, hidden
/// projects and the hidden inbox counted; no other view sets `order`.
#[test]
fn all_view_places_no_project_at_its_index_and_orders_every_group() {
    use crate::db::top_level::{self, TopItem};
    // Globex and Perso are groups.
    let conn = open_in_memory().expect("db");
    let globex = subject(&conn, "Globex");
    let _empty = subject(&conn, "Empty");
    let perso = subject(&conn, "Perso");
    let client = sub_project(&conn, &globex, "Client", None);
    let quiet = sub_project(&conn, &globex, "Quiet", None);
    let other = sub_project(&conn, &perso, "Other", None);
    for (title, s) in [("c1", &client), ("q1", &quiet), ("o1", &other)] {
        task(&conn, title, Some(s), None);
    }
    let inbox_task = task(&conn, "i1", None, None);
    // (first title, (parent, index)) of every group.
    type Listed = (String, Option<(Option<String>, u32)>);
    let groups = |conn: &Connection| -> Vec<Listed> {
        view(conn, ViewKind::All, None)
            .groups
            .iter()
            .map(|g| {
                (
                    g.tasks[0].title.clone(),
                    g.order.as_ref().map(|o| (o.parent_id.clone(), o.index)),
                )
            })
            .collect()
    };
    let top = |title: &str, index: u32| (title.to_string(), Some((None, index)));
    let sub = |title: &str, parent: &str, index: u32| {
        (title.to_string(), Some((Some(parent.to_string()), index)))
    };

    // Default: last, after every top-level item (Empty counts, it has no group).
    assert_eq!(
        groups(&conn),
        vec![
            sub("c1", &globex, 0),
            sub("q1", &globex, 1),
            sub("o1", &perso, 0),
            top("i1", 3),
        ]
    );
    // First.
    top_level::reorder(&conn, &TopItem::Inbox, 0).expect("first");
    assert_eq!(
        groups(&conn),
        vec![
            top("i1", 0),
            sub("c1", &globex, 0),
            sub("q1", &globex, 1),
            sub("o1", &perso, 0),
        ]
    );
    // After Globex: after its projects too.
    top_level::reorder(&conn, &TopItem::Inbox, 1).expect("after Globex");
    assert_eq!(
        groups(&conn),
        vec![
            sub("c1", &globex, 0),
            sub("q1", &globex, 1),
            top("i1", 1),
            sub("o1", &perso, 0),
        ]
    );
    // After Empty (no group): right before Perso's projects.
    top_level::reorder(&conn, &TopItem::Inbox, 2).expect("after Empty");
    let listed = groups(&conn);
    assert_eq!(listed[2], top("i1", 2));
    assert_eq!(listed[3], sub("o1", &perso, 0));
    assert_eq!(top_level::inbox_index(&conn).expect("index"), 2);

    // Hidden (no open task): no group, its slot still counts.
    tasks::delete(&conn, &inbox_task).expect("delete");
    assert_eq!(
        groups(&conn),
        vec![
            sub("c1", &globex, 0),
            sub("q1", &globex, 1),
            sub("o1", &perso, 0),
        ]
    );

    // Other views carry no order.
    due(
        &conn,
        &task(&conn, "today", Some(&client), None),
        "2026-10-02",
        None,
    );
    task(&conn, "inbox", None, None);
    for (kind, subject_id) in [
        (ViewKind::Inbox, None),
        (ViewKind::Today, None),
        (ViewKind::Upcoming, None),
        (ViewKind::Subject, Some(client.as_str())),
    ] {
        let v = view(&conn, kind, subject_id);
        assert!(v.groups.iter().all(|g| g.order.is_none()), "{kind:?}");
    }
}
/// A parent's dot sums up its sub-projects' tasks; its open count stays its
/// own; Today orders projects like the sidebar (a sub-project right after its parent).
#[test]
fn sub_projects_in_dots_counts_and_today_order() {
    // P is a group (no tasks of its own).
    let conn = open_in_memory().expect("db");
    let p = subject(&conn, "P");
    let q = subject(&conn, "Q");
    let c = sub_project(&conn, &p, "C", None);
    let _waiting = with_session(&conn, "w", Some(&c), "waiting", Some("permission"), true);
    let dot = |id: &str| subjects::get(&conn, id).expect("subject").dot;
    assert_eq!(dot(&p), Some(SubjectDot::Waiting));
    assert_eq!(dot(&c), Some(SubjectDot::Waiting));
    assert_eq!(dot(&q), None);
    let listed: Vec<(String, Option<SubjectDot>, u32)> = subjects::list(&conn)
        .expect("list")
        .into_iter()
        .map(|s| (s.name, s.dot, s.open_count))
        .collect();
    assert_eq!(
        listed,
        vec![
            ("P".into(), Some(SubjectDot::Waiting), 0),
            ("C".into(), Some(SubjectDot::Waiting), 1),
            ("Q".into(), None, 0),
        ]
    );

    // Today orders projects like the sidebar: the group's project before Q.
    let conn = open_in_memory().expect("db");
    let p = subject(&conn, "P");
    let q = subject(&conn, "Q");
    let c = sub_project(&conn, &p, "C", None);
    for (title, s) in [("q", &q), ("c", &c)] {
        let t = task(&conn, title, Some(s), None);
        due(&conn, &t, "2026-10-02", None);
    }
    let v = view(&conn, ViewKind::Today, None);
    assert_eq!(titles(&v.groups[0].tasks), ["c", "q"]);
}
