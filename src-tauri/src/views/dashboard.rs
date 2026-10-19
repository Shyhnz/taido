//! Dashboard of a project, or of « Sans projet » (Taido V2.5): to-do level
//! figures over the last `days` days (today included), computed here so that the UI only
//! shows them. Lists count top-level tasks; time counts every segment of the project's tasks
//! (subtasks included), cut to the period, the running one up to now.

use std::collections::HashMap;

use chrono::{DateTime, Duration, Local, NaiveDate, TimeZone};
use rusqlite::{params, Connection};

use crate::db::{relations, subjects, tasks::make_due};
use crate::error::AppResult;
use crate::model::{Dashboard, DashboardReason, DashboardTask, DayTime};

/// Rows each list block shows.
const LIST_MAX: usize = 5;

struct Task {
    id: String,
    title: String,
    due_date: Option<String>,
    due_time: Option<String>,
    completed_at: Option<DateTime<Local>>,
    created_at: DateTime<Local>,
    blocked_by: Option<String>,
    waiting: bool,
}

struct Segment {
    task_id: String,
    manual: bool,
    start: DateTime<Local>,
    end: DateTime<Local>,
}

fn parse(at: &str) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(at)
        .ok()
        .map(|d| d.with_timezone(&Local))
}

pub fn midnight(day: NaiveDate) -> DateTime<Local> {
    let naive = day.and_hms_opt(0, 0, 0).unwrap_or_default();
    Local
        .from_local_datetime(&naive)
        .earliest()
        .unwrap_or_else(|| Local.from_utc_datetime(&naive))
}

fn secs(d: Duration) -> u32 {
    u32::try_from(d.num_seconds().max(0)).unwrap_or(u32::MAX)
}

/// Seconds of `segment` within [from, to).
fn overlap(s: &Segment, from: DateTime<Local>, to: DateTime<Local>) -> Duration {
    let a = s.start.max(from);
    let b = s.end.min(to);
    if b > a {
        b - a
    } else {
        Duration::zero()
    }
}

fn load_tasks(conn: &Connection, subject_id: Option<&str>) -> AppResult<Vec<Task>> {
    let sql = format!(
        "SELECT t.id, t.title, t.due_date, t.due_time, t.completed_at, t.created_at, \
         {blocked_by}, \
         EXISTS (SELECT 1 FROM agent_sessions a WHERE a.task_id = t.id AND a.state = 'waiting') \
         FROM tasks t WHERE t.subject_id IS ?1 AND t.parent_id IS NULL \
         AND t.deleted_at IS NULL",
        blocked_by = relations::BLOCKED_BY_SQL,
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([subject_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, Option<String>>(6)?,
            r.get::<_, bool>(7)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, title, due_date, due_time, completed, created, blocked_by, waiting) = row?;
        let Some(created_at) = parse(&created) else {
            continue;
        };
        out.push(Task {
            id,
            title,
            due_date,
            due_time,
            completed_at: completed.as_deref().and_then(parse),
            created_at,
            blocked_by,
            waiting,
        });
    }
    Ok(out)
}

/// Segments of every task of the place (subtasks included), mapped to their top-level task.
fn load_segments(
    conn: &Connection,
    subject_id: Option<&str>,
    now: DateTime<Local>,
) -> AppResult<Vec<Segment>> {
    let mut stmt = conn.prepare(
        "SELECT COALESCE(t.parent_id, t.id), s.source, s.started_at, s.ended_at \
         FROM time_segments s JOIN tasks t ON t.id = s.task_id \
         WHERE t.subject_id IS ?1 AND t.deleted_at IS NULL AND s.deleted_at IS NULL",
    )?;
    let rows = stmt.query_map(params![subject_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (task_id, source, started, ended) = row?;
        let Some(start) = parse(&started) else {
            continue;
        };
        let end = ended.as_deref().and_then(parse).unwrap_or(now);
        out.push(Segment {
            task_id,
            manual: source == "manual",
            start,
            end,
        });
    }
    Ok(out)
}

pub fn dashboard(
    conn: &Connection,
    subject_id: Option<&str>,
    days: u32,
    now: DateTime<Local>,
) -> AppResult<Dashboard> {
    if let Some(id) = subject_id {
        subjects::get(conn, id)?;
    }
    let days = days.clamp(1, 366);
    let today = now.date_naive();
    let first_day = today - Duration::days(i64::from(days) - 1);
    let from = midnight(first_day);
    let before = midnight(first_day - Duration::days(i64::from(days)));
    let all = load_tasks(conn, subject_id)?;
    let segments = load_segments(conn, subject_id, now)?;
    let open: Vec<&Task> = all.iter().filter(|t| t.completed_at.is_none()).collect();
    let in_range = |at: Option<DateTime<Local>>, a: DateTime<Local>, b: DateTime<Local>| {
        at.is_some_and(|d| d >= a && d < b)
    };
    let done: Vec<&Task> = all
        .iter()
        .filter(|t| in_range(t.completed_at, from, now + Duration::seconds(1)))
        .collect();
    let done_before = all
        .iter()
        .filter(|t| in_range(t.completed_at, before, from))
        .count();
    // Open at the start of the period: created before it, not completed before it.
    let open_at_start = all
        .iter()
        .filter(|t| t.created_at < from && t.completed_at.is_none_or(|c| c >= from))
        .count();
    let due_of = |t: &Task| make_due(t.due_date.as_deref(), t.due_time.as_deref(), today);
    let late_days = |t: &Task| {
        t.due_date
            .as_deref()
            .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
            .filter(|d| *d < today)
            .map(|d| u32::try_from((today - d).num_days()).unwrap_or(u32::MAX))
    };
    let age = |t: &Task| {
        u32::try_from((today - t.created_at.date_naive()).num_days().max(0)).unwrap_or(0)
    };
    let item = |t: &Task| DashboardTask {
        id: t.id.clone(),
        title: t.title.clone(),
        due: due_of(t),
        days: None,
        seconds: None,
        reason: None,
    };

    let overdue = open.iter().filter(|t| late_days(t).is_some()).count();
    let by_relation = open.iter().filter(|t| t.blocked_by.is_some()).count();
    let waiting = open.iter().filter(|t| t.waiting).count();
    let blocked = open
        .iter()
        .filter(|t| t.blocked_by.is_some() || t.waiting)
        .count();

    // Time: in the period, per task and per day.
    let mut per_task: HashMap<&str, Duration> = HashMap::new();
    let mut total = Duration::zero();
    for s in &segments {
        let d = overlap(s, from, now);
        if d > Duration::zero() {
            *per_task
                .entry(s.task_id.as_str())
                .or_insert_with(Duration::zero) += d;
            total += d;
        }
    }
    let time_by_day = (0..days)
        .map(|i| {
            let day = first_day + Duration::days(i64::from(i));
            let (a, b) = (midnight(day), midnight(day + Duration::days(1)));
            let (mut auto, mut manual) = (Duration::zero(), Duration::zero());
            for s in &segments {
                let d = overlap(s, a, b.min(now));
                if s.manual {
                    manual += d;
                } else {
                    auto += d;
                }
            }
            DayTime {
                date: day.format("%Y-%m-%d").to_string(),
                auto_seconds: secs(auto),
                manual_seconds: secs(manual),
            }
        })
        .collect();
    // Average of the tasks completed in the period, over all their time.
    let seconds_per_done = (!done.is_empty()).then(|| {
        let sum: Duration = done
            .iter()
            .map(|t| {
                segments
                    .iter()
                    .filter(|s| s.task_id == t.id)
                    .map(|s| s.end - s.start)
                    .fold(Duration::zero(), |a, b| a + b)
            })
            .fold(Duration::zero(), |a, b| a + b);
        secs(sum) / u32::try_from(done.len()).unwrap_or(1)
    });

    let mut by_age: Vec<&Task> = open.clone();
    by_age.sort_by_key(|t| t.created_at);
    let oldest = by_age.first().map(|t| DashboardTask {
        days: Some(age(t)),
        ..item(t)
    });
    let lingering = by_age
        .iter()
        .take(LIST_MAX)
        .map(|t| DashboardTask {
            days: Some(age(t)),
            ..item(t)
        })
        .collect();

    let mut dated: Vec<&Task> = open
        .iter()
        .copied()
        .filter(|t| {
            t.due_date
                .as_deref()
                .is_some_and(|d| d >= today.format("%Y-%m-%d").to_string().as_str())
        })
        .collect();
    dated.sort_by(|a, b| {
        (
            a.due_date.as_deref(),
            a.due_time.as_deref().unwrap_or("99:99"),
        )
            .cmp(&(
                b.due_date.as_deref(),
                b.due_time.as_deref().unwrap_or("99:99"),
            ))
    });
    let upcoming = dated.iter().take(LIST_MAX).map(|t| item(t)).collect();
    let undated = open.iter().filter(|t| t.due_date.is_none()).count();

    // Late first (most late first), then blocked by a task, then waiting for the answer.
    let mut late_or_blocked: Vec<DashboardTask> = Vec::new();
    let mut late: Vec<(&Task, u32)> = open
        .iter()
        .filter_map(|t| late_days(t).map(|d| (*t, d)))
        .collect();
    late.sort_by_key(|t| std::cmp::Reverse(t.1));
    for (t, d) in late {
        late_or_blocked.push(DashboardTask {
            days: Some(d),
            reason: Some(DashboardReason::Overdue { days: d }),
            ..item(t)
        });
    }
    for t in &open {
        if late_days(t).is_some() {
            continue;
        }
        let reason = match (&t.blocked_by, t.waiting) {
            (Some(title), _) => DashboardReason::BlockedBy {
                title: title.clone(),
            },
            (None, true) => DashboardReason::Waiting,
            _ => continue,
        };
        late_or_blocked.push(DashboardTask {
            reason: Some(reason),
            ..item(t)
        });
    }

    let titles: HashMap<&str, &Task> = all.iter().map(|t| (t.id.as_str(), t)).collect();
    let mut timed: Vec<(&str, Duration)> = per_task.into_iter().collect();
    timed.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    let time_by_task = timed
        .into_iter()
        .filter_map(|(id, d)| {
            titles.get(id).map(|t| DashboardTask {
                seconds: Some(secs(d)),
                ..item(t)
            })
        })
        .take(LIST_MAX)
        .collect();

    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    let open_subtasks: u32 = conn.query_row(
        "SELECT COUNT(*) FROM tasks t WHERE t.subject_id IS ?1 AND t.parent_id IS NOT NULL \
         AND t.completed_at IS NULL AND t.deleted_at IS NULL",
        [subject_id],
        |r| r.get(0),
    )?;
    Ok(Dashboard {
        days,
        open: count(open.len()),
        open_subtasks,
        open_delta: i32::try_from(open.len()).unwrap_or(i32::MAX)
            - i32::try_from(open_at_start).unwrap_or(i32::MAX),
        done: count(done.len()),
        done_before: count(done_before),
        overdue: count(overdue),
        blocked: count(blocked),
        blocked_by_relation: count(by_relation),
        blocked_waiting: count(waiting),
        seconds: secs(total),
        seconds_per_done,
        oldest,
        time_by_day,
        upcoming,
        undated: count(undated),
        late_or_blocked,
        lingering,
        time_by_task,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open_in_memory, test_support};
    use crate::model::{AddRelationInput, RelationKind};

    /// Friday 9 October 2026, 15:00 local.
    fn now() -> DateTime<Local> {
        Local
            .from_local_datetime(
                &NaiveDate::from_ymd_opt(2026, 10, 9)
                    .and_then(|d| d.and_hms_opt(15, 0, 0))
                    .expect("date"),
            )
            .single()
            .expect("local")
    }

    fn at(days_ago: i64, hour: u32) -> String {
        let day = now().date_naive() - Duration::days(days_ago);
        midnight(day)
            .checked_add_signed(Duration::hours(i64::from(hour)))
            .expect("time")
            .to_utc()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    fn set(conn: &Connection, id: &str, column: &str, value: Option<String>) {
        conn.execute(
            &format!("UPDATE tasks SET {column} = ?2 WHERE id = ?1"),
            params![id, value],
        )
        .expect("set");
    }

    fn segment(conn: &Connection, task: &str, source: &str, start: String, end: String) {
        conn.execute(
            "INSERT INTO time_segments (id, task_id, source, started_at, ended_at, \
             created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?4, ?4)",
            params![crate::db::new_id(), task, source, start, end],
        )
        .expect("segment");
    }

    #[test]
    fn figures_and_blocks_follow_the_definitions() {
        let conn = open_in_memory().expect("db");
        let p = test_support::subject(&conn, "Summit Events");
        let other = test_support::subject(&conn, "Autre");
        let t = |title: &str, days_ago: i64| {
            let id = test_support::task(&conn, title, Some(&p), None);
            set(&conn, &id, "created_at", Some(at(days_ago, 9)));
            id
        };
        let facture = t("Envoyer la facture", 18);
        let appel = t("Appel de recette", 12);
        let modele = t("Modèle d'e-mail", 3);
        let relances = t("Relances", 2);
        let fuseau = t("Corriger le fuseau", 5);
        let export = t("Export PDF", 4);
        let import = t("Import CSV", 10);
        let route = t("Route API", 9);
        let ailleurs = test_support::task(&conn, "Ailleurs", Some(&other), None);
        // Due dates: Monday 12, Tuesday 13 10:00, late since Wednesday 7.
        set(&conn, &modele, "due_date", Some("2026-10-12".into()));
        set(&conn, &appel, "due_date", Some("2026-10-13".into()));
        set(&conn, &appel, "due_time", Some("10:00".into()));
        set(&conn, &fuseau, "due_date", Some("2026-10-07".into()));
        // Done: import 2 days ago (in the 7 days), route 9 days ago (the 7 before).
        set(&conn, &import, "completed_at", Some(at(2, 16)));
        set(&conn, &route, "completed_at", Some(at(9, 16)));
        // Blocked: relances by the open « Modèle »; export waits for Claude.
        crate::db::relations::add(
            &conn,
            &AddRelationInput {
                task_id: relances.clone(),
                other_id: modele.clone(),
                kind: RelationKind::BlockedBy,
            },
        )
        .expect("relation");
        test_support::claude_terminal(&conn, &export, "t1", "s1", "c1");
        test_support::set_session_state(&conn, "s1", "waiting", Some("question"), &at(0, 14));
        // Time: export 1 h auto today, import 30 min manual yesterday + 1 h auto 8 days ago
        // (outside), another project's never counts.
        segment(&conn, &export, "auto", at(0, 10), at(0, 11));
        segment(&conn, &import, "manual", at(1, 12), {
            let s = at(1, 12);
            let d = DateTime::parse_from_rfc3339(&s).expect("d") + Duration::minutes(30);
            d.to_utc()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        });
        segment(&conn, &import, "auto", at(8, 10), at(8, 11));
        segment(&conn, &ailleurs, "auto", at(0, 9), at(0, 12));

        let d = dashboard(&conn, Some(&p), 7, now()).expect("dashboard");
        assert_eq!(d.open, 6);
        assert_eq!(d.open_subtasks, 0);
        let sub = crate::db::tasks::create_child(&conn, &facture, "Relancer").expect("child");
        assert_eq!(
            dashboard(&conn, Some(&p), 7, now())
                .expect("d")
                .open_subtasks,
            1
        );
        crate::db::tasks::delete(&conn, &sub).expect("delete child");
        // Open at the start: facture, appel, import (completed since); not route (before).
        assert_eq!(d.open_delta, 6 - 3);
        assert_eq!((d.done, d.done_before), (1, 1));
        assert_eq!(d.overdue, 1);
        assert_eq!(
            (d.blocked, d.blocked_by_relation, d.blocked_waiting),
            (2, 1, 1)
        );
        assert_eq!(d.seconds, 3600 + 1800);
        // Import: 30 min + 1 h (all its time), one task done.
        assert_eq!(d.seconds_per_done, Some(5400));
        let oldest = d.oldest.as_ref().expect("oldest");
        assert_eq!(
            (oldest.title.as_str(), oldest.days),
            ("Envoyer la facture", Some(18))
        );
        assert_eq!(d.time_by_day.len(), 7);
        let today = d.time_by_day.last().expect("today");
        assert_eq!((today.auto_seconds, today.manual_seconds), (3600, 0));
        assert_eq!(d.time_by_day[5].manual_seconds, 1800);
        let names = |list: &[DashboardTask]| -> Vec<String> {
            list.iter().map(|t| t.title.clone()).collect()
        };
        assert_eq!(names(&d.upcoming), ["Modèle d'e-mail", "Appel de recette"]);
        assert_eq!(d.undated, 3);
        assert_eq!(
            d.late_or_blocked
                .iter()
                .map(|t| (t.title.as_str(), t.reason.clone()))
                .collect::<Vec<_>>(),
            [
                (
                    "Corriger le fuseau",
                    Some(DashboardReason::Overdue { days: 2 })
                ),
                (
                    "Relances",
                    Some(DashboardReason::BlockedBy {
                        title: "Modèle d'e-mail".into()
                    })
                ),
                ("Export PDF", Some(DashboardReason::Waiting)),
            ]
        );
        assert_eq!(
            names(&d.lingering)[..2],
            ["Envoyer la facture", "Appel de recette"]
        );
        assert_eq!(names(&d.time_by_task), ["Export PDF", "Import CSV"]);
        assert_eq!(d.time_by_task[1].seconds, Some(1800));

        // 30 days: the route and the 8-day-old hour come in.
        let d = dashboard(&conn, Some(&p), 30, now()).expect("30 days");
        assert_eq!(d.done, 2);
        assert_eq!(d.seconds, 3600 + 1800 + 3600);
        assert_eq!(d.time_by_day.len(), 30);
        let _ = (facture, ailleurs);
    }

    #[test]
    fn the_inbox_and_an_empty_project() {
        let conn = open_in_memory().expect("db");
        let p = test_support::subject(&conn, "Vide");
        let d = dashboard(&conn, Some(&p), 7, now()).expect("empty");
        assert_eq!((d.open, d.done, d.seconds), (0, 0, 0));
        assert_eq!(d.oldest, None);
        assert_eq!(d.seconds_per_done, None);
        test_support::task(&conn, "Sans projet", None, None);
        assert_eq!(dashboard(&conn, None, 7, now()).expect("inbox").open, 1);
        assert!(dashboard(&conn, Some("nope"), 7, now()).is_err());
    }
}
