//! « Portefeuille » (Taido V2.6): every project on one line, and the CSV
//! export of the time segments. Groups (visual only) and « Sans projet » are not projects.

use std::fmt::Write as _;

use chrono::{DateTime, Duration, Local};
use rusqlite::{params, Connection};

use crate::db::subjects;
use crate::error::AppResult;
use crate::model::{Agent, ChronoStop, DashboardTask, Portfolio, PortfolioRow};
use crate::views::dashboard::{self, dashboard};

/// Beyond this many days without activity a project is « inactif ».
pub const INACTIVE_DAYS: u32 = 14;

fn parse(at: &str) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(at)
        .ok()
        .map(|d| d.with_timezone(&Local))
}

/// The open task due soonest; an overdue one comes first.
fn next_task(d: &crate::model::Dashboard) -> Option<DashboardTask> {
    d.late_or_blocked
        .iter()
        .filter(|t| {
            matches!(
                t.reason,
                Some(crate::model::DashboardReason::Overdue { .. })
            )
        })
        .max_by_key(|t| t.days)
        .cloned()
        .or_else(|| d.upcoming.first().cloned())
}

pub fn portfolio(conn: &Connection, days: u32, now: DateTime<Local>) -> AppResult<Portfolio> {
    let all = subjects::list(conn)?;
    let mut rows = Vec::new();
    let (mut open, mut done, mut overdue, mut seconds) = (0, 0, 0, 0);
    let mut open_subtasks = 0;
    for s in all.iter().filter(|s| !s.is_group) {
        let d = dashboard(conn, Some(&s.id), days, now)?;
        let (running, waiting): (u32, u32) = conn.query_row(
            "SELECT \
             COUNT(CASE WHEN a.state IN ('working', 'starting') THEN 1 END), \
             COUNT(CASE WHEN a.state = 'waiting' THEN 1 END) \
             FROM agent_sessions a JOIN tasks t ON t.id = a.task_id \
             JOIN terminals tm ON tm.id = a.current_terminal_id AND tm.closed_at IS NULL \
             WHERE t.subject_id = ?1 AND t.deleted_at IS NULL",
            [&s.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let last: Option<String> = conn.query_row(
            "SELECT MAX(at) FROM ( \
               SELECT MAX(t.updated_at) AS at FROM tasks t \
                 WHERE t.subject_id = ?1 AND t.deleted_at IS NULL \
               UNION ALL SELECT MAX(COALESCE(ts.ended_at, ts.started_at)) FROM time_segments ts \
                 JOIN tasks t ON t.id = ts.task_id \
                 WHERE t.subject_id = ?1 AND ts.deleted_at IS NULL \
               UNION ALL SELECT MAX(a.updated_at) FROM agent_sessions a \
                 JOIN tasks t ON t.id = a.task_id WHERE t.subject_id = ?1)",
            [&s.id],
            |r| r.get(0),
        )?;
        let idle = last
            .as_deref()
            .and_then(parse)
            .map(|at| u32::try_from((now - at).num_days().max(0)).unwrap_or(u32::MAX));
        let group = s
            .parent_id
            .as_ref()
            .and_then(|g| all.iter().find(|x| &x.id == g))
            .map(|g| g.name.clone());
        open += d.open;
        open_subtasks += d.open_subtasks;
        done += d.done;
        overdue += d.overdue;
        seconds += d.seconds;
        rows.push(PortfolioRow {
            subject_id: s.id.clone(),
            name: s.name.clone(),
            color: s.color,
            group,
            open: d.open,
            done: d.done,
            overdue: d.overdue,
            blocked: d.blocked,
            next: next_task(&d),
            sessions_running: running,
            sessions_waiting: waiting,
            seconds: d.seconds,
            last_activity: last,
            inactive_days: idle.filter(|n| *n > INACTIVE_DAYS),
        });
    }
    Ok(Portfolio {
        days: days.clamp(1, 366),
        open,
        open_subtasks,
        done,
        overdue,
        seconds,
        rows,
    })
}

fn csv_field(value: &str) -> String {
    if value.contains([';', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn reason_label(reason: Option<&str>, agent: Agent) -> String {
    match reason.and_then(ChronoStop::parse) {
        Some(ChronoStop::Waiting) => "attend ta réponse".into(),
        Some(ChronoStop::TurnEnded) => format!("{} a fini", agent.label()),
        Some(ChronoStop::SessionClosed) => "session fermée".into(),
        Some(ChronoStop::TaskDone) => "tâche terminée".into(),
        Some(ChronoStop::AppClosed) => "Taido fermé".into(),
        None => String::new(),
    }
}

/// « Exporter les temps (CSV) »: one line per segment started in the period, every project
/// (and « Sans projet »). `;`-separated with a UTF-8 BOM, so that Excel opens it in French.
pub fn time_csv(conn: &Connection, days: u32, now: DateTime<Local>) -> AppResult<String> {
    let days = days.clamp(1, 366);
    let first_day = now.date_naive() - Duration::days(i64::from(days) - 1);
    let from = dashboard::midnight(first_day);
    let mut stmt = conn.prepare(
        "SELECT COALESCE(s.name, 'Sans projet'), t.title, ts.started_at, ts.ended_at, \
         ts.source, ts.stop_reason, ts.note, a.agent \
         FROM time_segments ts JOIN tasks t ON t.id = ts.task_id \
         LEFT JOIN subjects s ON s.id = t.subject_id \
         LEFT JOIN agent_sessions a ON a.id = ts.agent_session_id \
         WHERE ts.deleted_at IS NULL AND t.deleted_at IS NULL \
         ORDER BY ts.started_at, ts.id",
    )?;
    let rows = stmt.query_map(params![], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, Option<String>>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, Option<String>>(7)?,
        ))
    })?;
    let mut out = String::from(
        "\u{feff}Projet;Tâche;Début;Fin;Durée;Durée (min);Source;Raison d'arrêt;Note\r\n",
    );
    for row in rows {
        let (project, task, started, ended, source, reason, note, agent) = row?;
        // Segments whose session is gone read as Claude, the only agent before Codex.
        let agent = agent.as_deref().and_then(Agent::parse).unwrap_or_default();
        let Some(start) = parse(&started) else {
            continue;
        };
        if start < from || start > now {
            continue;
        }
        let end = ended.as_deref().and_then(parse);
        let secs = (end.unwrap_or(now) - start).num_seconds().max(0);
        let _ = write!(
            out,
            "{};{};{};{};{}:{:02}:{:02};{};{};{};{}\r\n",
            csv_field(&project),
            csv_field(&task),
            start.format("%Y-%m-%d %H:%M"),
            end.map(|e| e.format("%Y-%m-%d %H:%M").to_string())
                .unwrap_or_else(|| "en cours".into()),
            secs / 3600,
            secs % 3600 / 60,
            secs % 60,
            (secs + 30) / 60,
            if source == "manual" {
                "à la main"
            } else {
                agent.label()
            },
            reason_label(reason.as_deref(), agent),
            csv_field(&note),
        );
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open_in_memory, test_support};
    use crate::model::GroupProjectsInput;
    use chrono::{NaiveDate, TimeZone};

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

    fn iso(at: DateTime<Local>) -> String {
        at.to_utc()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    #[test]
    fn one_line_per_project_with_its_figures() {
        let conn = open_in_memory().expect("db");
        let peak = test_support::subject(&conn, "Summit Events");
        let admin = test_support::subject(&conn, "Admin");
        subjects::group_projects(
            &conn,
            &GroupProjectsInput {
                project_ids: vec![admin.clone()],
                group_id: None,
                name: Some("Globex".into()),
            },
        )
        .expect("group");
        let late = test_support::task(&conn, "Fuseau", Some(&peak), None);
        let soon = test_support::task(&conn, "Modèle", Some(&peak), None);
        conn.execute(
            "UPDATE tasks SET due_date = '2026-10-07' WHERE id = ?1",
            [&late],
        )
        .expect("late");
        conn.execute(
            "UPDATE tasks SET due_date = '2026-10-12' WHERE id = ?1",
            [&soon],
        )
        .expect("soon");
        test_support::claude_terminal(&conn, &soon, "t1", "s1", "c1");
        test_support::set_session_state(&conn, "s1", "waiting", Some("question"), &iso(now()));
        conn.execute(
            "INSERT INTO time_segments (id, task_id, source, started_at, ended_at, created_at, \
             updated_at) VALUES ('seg', ?1, 'auto', ?2, ?3, ?2, ?2)",
            params![
                soon,
                iso(now() - Duration::hours(2)),
                iso(now() - Duration::hours(1))
            ],
        )
        .expect("segment");
        // Admin: nothing for 20 days.
        let old = test_support::task(&conn, "Vieille", Some(&admin), None);
        conn.execute(
            "UPDATE tasks SET updated_at = ?2, created_at = ?2 WHERE id = ?1",
            params![old, iso(now() - Duration::days(20))],
        )
        .expect("old");

        let p = portfolio(&conn, 7, now()).expect("portfolio");
        assert_eq!(p.rows.len(), 2, "the group is not a row");
        let peak_row = p
            .rows
            .iter()
            .find(|r| r.name == "Summit Events")
            .expect("peak");
        assert_eq!((peak_row.open, peak_row.overdue), (2, 1));
        assert_eq!(
            peak_row.next.as_ref().map(|t| t.title.as_str()),
            Some("Fuseau")
        );
        assert_eq!(
            (peak_row.sessions_running, peak_row.sessions_waiting),
            (0, 1)
        );
        assert_eq!(peak_row.seconds, 3600);
        assert_eq!(peak_row.inactive_days, None);
        let admin_row = p.rows.iter().find(|r| r.name == "Admin").expect("admin");
        assert_eq!(admin_row.group.as_deref(), Some("Globex"));
        assert_eq!(admin_row.inactive_days, Some(20));
        assert_eq!(admin_row.next, None);
        assert_eq!((p.open, p.overdue, p.seconds), (3, 1, 3600));

        let csv = time_csv(&conn, 7, now()).expect("csv");
        let lines: Vec<&str> = csv.trim_end().split("\r\n").collect();
        assert!(lines[0].starts_with("\u{feff}Projet;Tâche;Début;Fin;Durée"));
        assert_eq!(lines.len(), 2);
        assert!(lines[1].starts_with(
            "Summit Events;Modèle;2026-10-09 13:00;2026-10-09 14:00;1:00:00;60;Claude;"
        ));
        assert_eq!(csv_field("a;b"), "\"a;b\"");
    }

    #[test]
    fn the_time_export_names_the_agent_of_each_segment() {
        let conn = open_in_memory().expect("db");
        let t = test_support::task(&conn, "Export", None, None);
        test_support::codex_terminal(&conn, &t, "term", "sess", "019a");
        let start = iso(now() - chrono::Duration::hours(2));
        let end = iso(now() - chrono::Duration::hours(1));
        conn.execute(
            "INSERT INTO time_segments (id, task_id, agent_session_id, source, started_at, \
             ended_at, stop_reason, created_at, updated_at) \
             VALUES ('seg', ?1, 'sess', 'auto', ?2, ?3, 'turn_ended', ?2, ?3)",
            rusqlite::params![t, start, end],
        )
        .expect("segment");
        let csv = time_csv(&conn, 7, now()).expect("csv");
        let line = csv.trim_end().split("\r\n").nth(1).expect("line");
        assert!(line.contains(";Codex;Codex a fini;"), "{line}");
    }

    #[test]
    fn time_csv_export_needs_no_plan() {
        let conn = open_in_memory().expect("db");
        let csv = time_csv(&conn, 30, now()).expect("export without any account");
        assert!(csv.starts_with('\u{feff}'));
    }
}
