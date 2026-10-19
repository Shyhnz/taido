//! The chrono (Taido V2.1): segments of time spent on a task.
//!
//! Automatic segments follow the existing Claude session states, never a play button: after
//! every session change (`agent_sessions::save`), every completion and deletion, the task is
//! [`reconcile`]d. It runs while one of its own sessions works (or waits for the user's answer
//! when `chrono_counts_waiting` is on) and the task is open; it stops otherwise, with the
//! reason read from the sessions. Shell terminals never count. A heartbeat every 30 s lets
//! the next launch close, at the last beat, the segments a crash left running.
//!
//! Only this Mac's running segments are touched here: those with a session
//! (`agent_session_id IS NOT NULL`). A running segment pulled from another device (V2.7 sync,
//! session always `NULL` here) is the other Mac at work: never closed by this one, and
//! counted up to now like a local one. Only « Arrêter » ([`stop`], a click) stops any running
//! segment, this Mac's or another device's.

use chrono::DateTime;
use rusqlite::{params, Connection, OptionalExtension};

use crate::db::settings::{self, CHRONO_COUNTS_WAITING};
use crate::db::{new_id, tasks};
use crate::error::{AppError, AppResult};
use crate::model::{
    AddManualTimeInput, ChronoSource, ChronoStop, SessionState, TaskChrono, TaskTime, TimeSegment,
};

/// Local setting: the last instant the app was known alive.
const HEARTBEAT: &str = "chrono_heartbeat";
/// Seconds between two heartbeats.
pub const HEARTBEAT_SECS: u64 = 30;
/// Longest manual entry: one day.
pub const MAX_MANUAL_MINUTES: u32 = 24 * 60;

/// SQL (on the alias `t`) of the seconds of a task's stopped segments.
pub const STOPPED_SECONDS_SQL: &str = "(SELECT CAST(ROUND(COALESCE(SUM(\
    (julianday(ts.ended_at) - julianday(ts.started_at)) * 86400), 0)) AS INTEGER) \
    FROM time_segments ts WHERE ts.task_id = t.id AND ts.ended_at IS NOT NULL \
    AND ts.deleted_at IS NULL)";
/// SQL (on the alias `t`) of the start of a task's running segment (the earliest when this
/// Mac and another one both run one).
pub const RUNNING_SINCE_SQL: &str = "(SELECT MIN(ts.started_at) FROM time_segments ts \
    WHERE ts.task_id = t.id AND ts.ended_at IS NULL AND ts.deleted_at IS NULL)";

/// SQL condition (on `time_segments` without alias) of a running segment of this Mac's chrono.
const MINE_RUNNING: &str =
    "ended_at IS NULL AND deleted_at IS NULL AND agent_session_id IS NOT NULL";
/// SQL (on the alias `t`) of the number of a task's segments.
pub const COUNT_SQL: &str =
    "(SELECT COUNT(*) FROM time_segments ts WHERE ts.task_id = t.id AND ts.deleted_at IS NULL)";

/// Builds a row's chrono from the three columns above: `None` without any segment.
pub fn chrono_of(count: i64, seconds: i64, running_since: Option<String>) -> Option<TaskChrono> {
    (count > 0).then(|| TaskChrono {
        seconds: u32::try_from(seconds.max(0)).unwrap_or(u32::MAX),
        running_since,
    })
}

/// Opens or closes the task's automatic segment to match its sessions and its state.
/// Returns whether a segment opened or closed.
pub fn reconcile(conn: &Connection, task_id: &str, now: &str) -> AppResult<bool> {
    let task: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT completed_at, deleted_at FROM tasks WHERE id = ?1",
            [task_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((completed_at, deleted_at)) = task else {
        return Ok(false);
    };
    let task_open = completed_at.is_none() && deleted_at.is_none();
    let counts_waiting: bool = settings::read(conn, CHRONO_COUNTS_WAITING)?.unwrap_or(false);
    let sessions: Vec<(String, SessionState)> = {
        let mut stmt = conn.prepare(
            "SELECT id, state FROM agent_sessions WHERE task_id = ?1 \
             ORDER BY state_changed_at DESC, id",
        )?;
        let rows = stmt.query_map([task_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter_map(|(id, state)| SessionState::parse(&state).map(|s| (id, s)))
            .collect()
    };
    let counts = |s: SessionState| {
        s == SessionState::Working || (counts_waiting && s == SessionState::Waiting)
    };
    let running_session = sessions.iter().find(|(_, s)| counts(*s)).map(|(id, _)| id);
    let open: Option<String> = conn
        .query_row(
            &format!("SELECT id FROM time_segments WHERE task_id = ?1 AND {MINE_RUNNING}"),
            [task_id],
            |r| r.get(0),
        )
        .optional()?;
    match (open, running_session.filter(|_| task_open)) {
        (None, Some(session_id)) => {
            conn.execute(
                "INSERT INTO time_segments (id, task_id, agent_session_id, source, started_at, \
                 created_at, updated_at) VALUES (?1, ?2, ?3, 'auto', ?4, ?4, ?4)",
                params![new_id(), task_id, session_id, now],
            )?;
            beat(conn, now)?;
            Ok(true)
        }
        (Some(segment), None) => {
            let reason = if !task_open {
                ChronoStop::TaskDone
            } else if sessions.iter().any(|(_, s)| *s == SessionState::Waiting) {
                ChronoStop::Waiting
            } else if sessions.iter().any(|(_, s)| s.is_live()) {
                ChronoStop::TurnEnded
            } else {
                ChronoStop::SessionClosed
            };
            close(conn, &segment, now, reason)?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// Reconciles every task that has a running segment or a live session (the setting changed).
pub fn reconcile_all(conn: &Connection, now: &str) -> AppResult<()> {
    let ids: Vec<String> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT task_id FROM time_segments WHERE {MINE_RUNNING} \
             UNION SELECT task_id FROM agent_sessions WHERE state NOT IN ('paused', 'crashed')"
        ))?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    for id in ids {
        reconcile(conn, &id, now)?;
    }
    Ok(())
}

/// Stops a running segment at `at` (never before its start).
fn close(conn: &Connection, segment_id: &str, at: &str, reason: ChronoStop) -> AppResult<()> {
    conn.execute(
        "UPDATE time_segments SET ended_at = max(started_at, ?2), stop_reason = ?3, \
         updated_at = ?2 WHERE id = ?1",
        params![segment_id, at, reason.as_str()],
    )?;
    Ok(())
}

/// Stops every running segment of this Mac (⌘Q, before the sessions are paused).
pub fn close_all(conn: &Connection, now: &str, reason: ChronoStop) -> AppResult<usize> {
    let n = conn.execute(
        &format!(
            "UPDATE time_segments SET ended_at = max(started_at, ?1), stop_reason = ?2, \
             updated_at = ?1 WHERE {MINE_RUNNING}"
        ),
        params![now, reason.as_str()],
    )?;
    Ok(n)
}

/// At startup: segments still running were left by a crash; they stop at the last heartbeat
/// (never after `now`, never before their start). Returns how many.
pub fn recover_after_crash(conn: &Connection, now: &str) -> AppResult<usize> {
    let last: String = settings::read::<String>(conn, HEARTBEAT)?
        .filter(|beat| beat.as_str() <= now)
        .unwrap_or_default();
    // An empty heartbeat: each segment stops at its start (no time is invented).
    close_all(conn, &last, ChronoStop::AppClosed)
}

/// Records that the app is alive.
pub fn beat(conn: &Connection, now: &str) -> AppResult<()> {
    settings::write(conn, HEARTBEAT, &now)
}

/// « + Ajouter du temps à la main »: a stopped manual segment of `minutes` ending `now`.
pub fn add_manual(conn: &Connection, input: &AddManualTimeInput, now: &str) -> AppResult<()> {
    tasks::ensure_exists(conn, &input.task_id)?;
    if input.minutes == 0 || input.minutes > MAX_MANUAL_MINUTES {
        return Err(AppError::Invalid(format!(
            "manual time must be 1 to {MAX_MANUAL_MINUTES} minutes"
        )));
    }
    let end = DateTime::parse_from_rfc3339(now)
        .map_err(|e| AppError::Internal(format!("bad instant {now}: {e}")))?;
    let start = (end - chrono::Duration::minutes(i64::from(input.minutes)))
        .to_utc()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    conn.execute(
        "INSERT INTO time_segments (id, task_id, source, started_at, ended_at, note, \
         created_at, updated_at) VALUES (?1, ?2, 'manual', ?3, ?4, ?5, ?4, ?4)",
        params![new_id(), input.task_id, start, now, input.note.trim()],
    )?;
    Ok(())
}

/// Removes a segment (soft delete). Returns its task. A running segment cannot be removed:
/// it is stopped first (« Arrêter », [`stop`]).
pub fn delete(conn: &Connection, id: &str, now: &str) -> AppResult<String> {
    let row: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT task_id, ended_at FROM time_segments WHERE id = ?1 AND deleted_at IS NULL",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((task_id, ended_at)) = row else {
        return Err(AppError::NotFound(format!("time segment {id}")));
    };
    if ended_at.is_none() {
        return Err(AppError::Invalid(
            "a running segment cannot be removed".into(),
        ));
    }
    conn.execute(
        "UPDATE time_segments SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1",
        params![id, now],
    )?;
    Ok(task_id)
}

/// « Arrêter » (Taido V2 follow-up, docs/SYNC.md § 0.8): stops a running segment by hand, at
/// `now` (never before its start), with no stop reason; a stopped one is left as is. Any
/// running segment: this Mac's own or one pulled from another device (a lost Mac's chrono).
/// Returns its task. The change syncs
/// like any other; this Mac's chrono opens a new segment at the next reconcile that counts.
pub fn stop(conn: &Connection, id: &str, now: &str) -> AppResult<String> {
    let row: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT task_id, ended_at FROM time_segments WHERE id = ?1 AND deleted_at IS NULL",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((task_id, ended_at)) = row else {
        return Err(AppError::NotFound(format!("time segment {id}")));
    };
    // Already stopped (by another device, or by Claude a moment ago): nothing to do.
    if ended_at.is_some() {
        return Ok(task_id);
    }
    conn.execute(
        "UPDATE time_segments SET ended_at = max(started_at, ?2), stop_reason = NULL, \
         updated_at = ?2 WHERE id = ?1",
        params![id, now],
    )?;
    Ok(task_id)
}

fn seconds_between(start: &str, end: &str) -> u32 {
    match (
        DateTime::parse_from_rfc3339(start),
        DateTime::parse_from_rfc3339(end),
    ) {
        (Ok(s), Ok(e)) => u32::try_from((e - s).num_seconds().max(0)).unwrap_or(u32::MAX),
        _ => 0,
    }
}

/// The panel's chrono: total and segments, most recent first.
pub fn task_time(conn: &Connection, task_id: &str) -> AppResult<TaskTime> {
    let mut stmt = conn.prepare(
        "SELECT id, source, started_at, ended_at, stop_reason, note FROM time_segments \
         WHERE task_id = ?1 AND deleted_at IS NULL ORDER BY started_at DESC, id DESC",
    )?;
    let rows = stmt.query_map([task_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, String>(5)?,
        ))
    })?;
    let mut segments = Vec::new();
    for row in rows {
        let (id, source, started_at, ended_at, stop_reason, note) = row?;
        let seconds = ended_at
            .as_deref()
            .map(|end| seconds_between(&started_at, end))
            .unwrap_or(0);
        segments.push(TimeSegment {
            id,
            source: if source == "manual" {
                ChronoSource::Manual
            } else {
                ChronoSource::Auto
            },
            started_at,
            ended_at,
            stop_reason: stop_reason.as_deref().and_then(ChronoStop::parse),
            note,
            seconds,
        });
    }
    let chrono = TaskChrono {
        seconds: segments.iter().map(|s| s.seconds).sum(),
        running_since: segments
            .iter()
            .filter(|s| s.ended_at.is_none())
            .map(|s| s.started_at.clone())
            .min(),
    };
    Ok(TaskTime { chrono, segments })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open_in_memory, test_support};
    use crate::model::SettingsPatch;

    const T0: &str = "2026-10-09T10:00:00.000Z";
    const T1: &str = "2026-10-09T10:05:00.000Z";
    const T2: &str = "2026-10-09T10:07:30.000Z";
    const T3: &str = "2026-10-09T10:10:00.000Z";

    fn setup() -> (Connection, String) {
        let conn = open_in_memory().expect("db");
        let task = test_support::task(&conn, "Export PDF", None, None);
        test_support::claude_terminal(&conn, &task, "term", "sess", "claude");
        (conn, task)
    }

    /// Sets the session's state, then reconciles, as `agent_sessions::save` does.
    fn state(conn: &Connection, task: &str, state: &str, at: &str) {
        test_support::set_session_state(conn, "sess", state, None, at);
        reconcile(conn, task, at).expect("reconcile");
    }

    fn time(conn: &Connection, task: &str) -> TaskTime {
        task_time(conn, task).expect("time")
    }

    /// A running segment pulled from another Mac (no session here) is that Mac at work: this
    /// Mac's chrono never closes it, and the views count it up to now.
    #[test]
    fn a_running_segment_of_another_mac_is_never_closed_here() {
        let (conn, task) = setup();
        conn.execute(
            "INSERT INTO time_segments (id, task_id, source, started_at, created_at, \
             updated_at) VALUES ('theirs', ?1, 'auto', ?2, ?2, ?2)",
            params![task, T0],
        )
        .expect("pulled segment");
        // This Mac works on the same task at the same time: both run.
        state(&conn, &task, "working", T1);
        let t = time(&conn, &task);
        assert_eq!(t.segments.len(), 2);
        assert_eq!(t.chrono.running_since.as_deref(), Some(T0));
        let running: Option<String> = conn
            .query_row(
                &format!("SELECT {RUNNING_SINCE_SQL} FROM tasks t WHERE t.id = ?1"),
                [&task],
                |r| r.get(0),
            )
            .expect("running since");
        assert_eq!(running.as_deref(), Some(T0));
        // Waiting, every reconcile, a crash recovery and a quit: only this Mac's stops.
        state(&conn, &task, "waiting", T2);
        reconcile_all(&conn, T2).expect("reconcile all");
        beat(&conn, T2).expect("beat");
        recover_after_crash(&conn, T3).expect("recover");
        close_all(&conn, T3, ChronoStop::AppClosed).expect("quit");
        let theirs: (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT ended_at, stop_reason FROM time_segments WHERE id = 'theirs'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("theirs");
        assert_eq!(theirs, (None, None));
        let t = time(&conn, &task);
        assert_eq!(t.chrono.running_since.as_deref(), Some(T0));
        assert_eq!(t.chrono.seconds, 150, "this Mac's own segment, T1 to T2");
    }

    #[test]
    fn runs_while_claude_works_and_pauses_while_it_waits() {
        let (conn, task) = setup();
        state(&conn, &task, "starting", T0);
        assert!(time(&conn, &task).segments.is_empty(), "not while starting");
        state(&conn, &task, "working", T0);
        assert_eq!(time(&conn, &task).chrono.running_since.as_deref(), Some(T0));
        state(&conn, &task, "waiting", T1);
        let t = time(&conn, &task);
        assert_eq!(t.chrono.running_since, None);
        assert_eq!(t.chrono.seconds, 300);
        assert_eq!(t.segments[0].stop_reason, Some(ChronoStop::Waiting));
        // The answer resumes it in a new segment.
        state(&conn, &task, "working", T2);
        state(&conn, &task, "done", T3);
        let t = time(&conn, &task);
        assert_eq!(t.segments.len(), 2);
        assert_eq!(t.segments[0].stop_reason, Some(ChronoStop::TurnEnded));
        assert_eq!(t.chrono.seconds, 300 + 150);
    }

    #[test]
    fn closing_the_session_or_completing_the_task_stops_it() {
        let (conn, task) = setup();
        state(&conn, &task, "working", T0);
        state(&conn, &task, "paused", T1);
        assert_eq!(
            time(&conn, &task).segments[0].stop_reason,
            Some(ChronoStop::SessionClosed)
        );
        state(&conn, &task, "working", T2);
        conn.execute(
            "UPDATE tasks SET completed_at = ?2 WHERE id = ?1",
            params![task, T3],
        )
        .expect("complete");
        reconcile(&conn, &task, T3).expect("reconcile");
        let t = time(&conn, &task);
        assert_eq!(t.segments[0].stop_reason, Some(ChronoStop::TaskDone));
        assert_eq!(t.chrono.running_since, None);
        // A completed task never restarts, even if Claude still works.
        reconcile(&conn, &task, T3).expect("again");
        assert_eq!(time(&conn, &task).segments.len(), 2);
    }

    #[test]
    fn the_setting_counts_the_wait_for_the_answer() {
        let (conn, task) = setup();
        state(&conn, &task, "working", T0);
        state(&conn, &task, "waiting", T1);
        crate::db::settings::update(
            &conn,
            &SettingsPatch {
                chrono_counts_waiting: Some(true),
                ..Default::default()
            },
        )
        .expect("setting");
        assert!(
            time(&conn, &task).chrono.running_since.is_some(),
            "resumed at once"
        );
        state(&conn, &task, "working", T2);
        assert_eq!(
            time(&conn, &task).segments.len(),
            2,
            "still the same segment"
        );
    }

    #[test]
    fn a_crash_stops_running_segments_at_the_last_heartbeat() {
        let (conn, task) = setup();
        state(&conn, &task, "working", T0);
        beat(&conn, T1).expect("beat");
        assert_eq!(recover_after_crash(&conn, T3).expect("recover"), 1);
        let t = time(&conn, &task);
        assert_eq!(t.segments[0].ended_at.as_deref(), Some(T1));
        assert_eq!(t.segments[0].stop_reason, Some(ChronoStop::AppClosed));
        assert_eq!(t.chrono.seconds, 300);
    }

    #[test]
    fn without_heartbeat_a_crashed_segment_counts_nothing() {
        let (conn, task) = setup();
        state(&conn, &task, "working", T1);
        conn.execute("DELETE FROM settings WHERE key = ?1", [HEARTBEAT])
            .expect("forget beat");
        recover_after_crash(&conn, T3).expect("recover");
        assert_eq!(time(&conn, &task).chrono.seconds, 0);
    }

    #[test]
    fn manual_time_and_deletion() {
        let (conn, task) = setup();
        let input = AddManualTimeInput {
            task_id: task.clone(),
            minutes: 15,
            note: " Réunion ".into(),
        };
        add_manual(&conn, &input, T3).expect("manual");
        let t = time(&conn, &task);
        assert_eq!(t.chrono.seconds, 900);
        assert_eq!(t.segments[0].source, ChronoSource::Manual);
        assert_eq!(t.segments[0].note, "Réunion");
        assert!(add_manual(
            &conn,
            &AddManualTimeInput {
                minutes: 0,
                ..input.clone()
            },
            T3
        )
        .is_err());
        let id = t.segments[0].id.clone();
        assert_eq!(delete(&conn, &id, T3).expect("delete"), task);
        assert!(time(&conn, &task).segments.is_empty());
        // A running segment stays.
        state(&conn, &task, "working", T0);
        let running = time(&conn, &task).segments[0].id.clone();
        assert!(delete(&conn, &running, T3).is_err());
    }

    /// « Arrêter » stops this Mac's running segment with no reason; it is then removable, and
    /// Claude's next turn opens a new segment (never the stopped one again).
    #[test]
    fn stopping_this_macs_segment_by_hand() {
        let (conn, task) = setup();
        state(&conn, &task, "working", T0);
        let seg = time(&conn, &task).segments[0].id.clone();
        assert_eq!(stop(&conn, &seg, T1).expect("stop"), task);
        let t = time(&conn, &task);
        assert_eq!(t.segments[0].ended_at.as_deref(), Some(T1));
        assert_eq!(t.segments[0].stop_reason, None);
        assert_eq!(t.chrono.running_since, None);
        assert_eq!(t.chrono.seconds, 300);
        // Stopping again changes nothing; an unknown segment is not found.
        assert_eq!(stop(&conn, &seg, T3).expect("again"), task);
        assert_eq!(time(&conn, &task).segments[0].ended_at.as_deref(), Some(T1));
        assert!(matches!(
            stop(&conn, "nope", T3),
            Err(AppError::NotFound(_))
        ));
        // Claude waits: every chrono path leaves the stopped segment as it is.
        state(&conn, &task, "waiting", T1);
        reconcile_all(&conn, T1).expect("reconcile all");
        recover_after_crash(&conn, T1).expect("recover");
        close_all(&conn, T1, ChronoStop::AppClosed).expect("quit");
        let t = time(&conn, &task);
        assert_eq!(t.segments.len(), 1);
        assert_eq!(t.segments[0].ended_at.as_deref(), Some(T1));
        assert_eq!(t.segments[0].stop_reason, None);
        // Claude works again: a new segment opens.
        state(&conn, &task, "working", T2);
        let t = time(&conn, &task);
        assert_eq!(t.segments.len(), 2);
        assert_eq!(t.segments[0].ended_at, None);
        assert_ne!(t.segments[0].id, seg);
        assert_eq!(t.segments[1].ended_at.as_deref(), Some(T1));
        // A stopped segment is removed like any other.
        delete(&conn, &seg, T3).expect("remove");
        assert_eq!(time(&conn, &task).segments.len(), 1);
    }

    /// The running segment of another (maybe lost) Mac is stopped here by hand, and never
    /// before its start.
    #[test]
    fn stopping_another_macs_segment_by_hand() {
        let (conn, task) = setup();
        conn.execute(
            "INSERT INTO time_segments (id, task_id, source, started_at, created_at, \
             updated_at) VALUES ('theirs', ?1, 'auto', ?2, ?2, ?2)",
            params![task, T2],
        )
        .expect("pulled segment");
        state(&conn, &task, "working", T0);
        stop(&conn, "theirs", T1).expect("stop theirs");
        let theirs: (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT ended_at, stop_reason FROM time_segments WHERE id = 'theirs'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("theirs");
        assert_eq!(theirs, (Some(T2.to_string()), None), "clamped to its start");
        // This Mac's own segment still runs.
        assert_eq!(time(&conn, &task).chrono.running_since.as_deref(), Some(T0));
        delete(&conn, "theirs", T3).expect("removable");
    }

    #[test]
    fn shell_terminals_and_other_tasks_do_not_count() {
        let (conn, task) = setup();
        let other = test_support::task(&conn, "Facture", None, None);
        state(&conn, &task, "working", T0);
        reconcile(&conn, &other, T0).expect("other");
        assert!(time(&conn, &other).segments.is_empty());
    }
}
