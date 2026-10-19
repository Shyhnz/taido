//! Shared settings synced between devices (table `synced_settings`, entity `setting`,
//! docs/SYNC.md § 2.1). Unlike `settings` (local only), every write here is a local change
//! queued by the triggers of migration 0011. Values are JSON; a setting is never deleted.

use rusqlite::{params, Connection, OptionalExtension};

use crate::db::now_utc;
use crate::error::{AppError, AppResult};

/// « Sans projet »'s position among the top-level projects (a JSON number).
pub use sync_proto::SETTING_INBOX_POSITION as INBOX_POSITION;

/// Stored JSON value of a key; `None` when missing or unreadable (logged).
pub fn get(conn: &Connection, key: &str) -> AppResult<Option<serde_json::Value>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM synced_settings WHERE key = ?1",
            [key],
            |r| r.get(0),
        )
        .optional()?;
    Ok(raw.and_then(|v| match serde_json::from_str(&v) {
        Ok(value) => Some(value),
        Err(e) => {
            log::warn!("ignoring unreadable synced setting {key}: {e}");
            None
        }
    }))
}

/// Writes a value (a local change: the triggers queue it). Nothing is written, and nothing
/// queued, when the stored value is already this one.
pub fn set(conn: &Connection, key: &str, value: &serde_json::Value) -> AppResult<()> {
    if !sync_proto::is_setting_key(key) {
        return Err(AppError::Invalid(format!("bad setting key: {key}")));
    }
    // `3` (written by the phone) and `3.0` (written here) are the same position: comparing
    // the stored text would queue a change that overrides a real move from another device.
    if get(conn, key)?.is_some_and(|stored| same_value(&stored, value)) {
        return Ok(());
    }
    let json = serde_json::to_string(value)
        .map_err(|e| AppError::Internal(format!("cannot serialize setting {key}: {e}")))?;
    conn.execute(
        "INSERT INTO synced_settings (key, value, updated_at) VALUES (?1, ?2, ?3) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, \
         updated_at = excluded.updated_at WHERE value IS NOT excluded.value",
        params![key, json, now_utc()],
    )?;
    Ok(())
}

/// JSON equality where numbers compare by value (`3` equals `3.0`).
fn same_value(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    match (a, b) {
        (serde_json::Value::Number(x), serde_json::Value::Number(y)) => x.as_f64() == y.as_f64(),
        _ => a == b,
    }
}

/// « Sans projet »'s position among the top-level projects; `None` = never set (last). A
/// stored value that is not a finite number reads as `None` (logged).
pub fn inbox_position(conn: &Connection) -> AppResult<Option<f64>> {
    Ok(get(conn, INBOX_POSITION)?.and_then(|v| match v.as_f64() {
        Some(x) if x.is_finite() => Some(x),
        _ => {
            log::warn!("ignoring a non-numeric {INBOX_POSITION}: {v}");
            None
        }
    }))
}

/// Stores « Sans projet »'s position (must be finite).
pub fn set_inbox_position(conn: &Connection, position: f64) -> AppResult<()> {
    let value = serde_json::Number::from_f64(position)
        .map(serde_json::Value::Number)
        .ok_or_else(|| AppError::Internal(format!("{INBOX_POSITION} must be finite")))?;
    set(conn, INBOX_POSITION, &value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    fn raw(conn: &Connection, key: &str, value: &str) {
        conn.execute(
            "INSERT INTO synced_settings (key, value, updated_at) VALUES (?1, ?2, 'x') \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )
        .expect("raw write");
    }

    #[test]
    fn missing_is_none_and_values_round_trip() {
        let conn = open_in_memory().expect("db");
        assert_eq!(inbox_position(&conn).expect("read"), None);
        assert_eq!(get(&conn, "theme_x").expect("read"), None);
        set_inbox_position(&conn, 2.5).expect("set");
        assert_eq!(inbox_position(&conn).expect("read"), Some(2.5));
        set_inbox_position(&conn, -3.0).expect("set");
        assert_eq!(inbox_position(&conn).expect("read"), Some(-3.0));
        let object = serde_json::json!({ "a": [1, 2] });
        set(&conn, "theme_x", &object).expect("set");
        assert_eq!(get(&conn, "theme_x").expect("read"), Some(object));
    }

    #[test]
    fn the_same_number_written_back_queues_nothing() {
        let conn = open_in_memory().expect("db");
        // As pulled from the phone: an integer, no decimal point.
        raw(&conn, INBOX_POSITION, "4");
        let queued = |conn: &Connection| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM sync_outbox WHERE entity = 'setting'",
                [],
                |r| r.get(0),
            )
            .expect("count")
        };
        let before = queued(&conn);
        set_inbox_position(&conn, 4.0).expect("set");
        assert_eq!(queued(&conn), before);
        set_inbox_position(&conn, 5.0).expect("set");
        assert_eq!(inbox_position(&conn).expect("read"), Some(5.0));
    }

    #[test]
    fn unreadable_or_non_numeric_inbox_position_reads_as_none() {
        let conn = open_in_memory().expect("db");
        for value in ["not json", "\"2\"", "null", "{\"x\":1}", "[1]", "true"] {
            raw(&conn, INBOX_POSITION, value);
            assert_eq!(inbox_position(&conn).expect("read"), None, "{value}");
        }
        raw(&conn, INBOX_POSITION, "7");
        assert_eq!(inbox_position(&conn).expect("read"), Some(7.0));
    }

    #[test]
    fn bad_keys_and_non_finite_positions_are_refused() {
        let conn = open_in_memory().expect("db");
        let one = serde_json::json!(1);
        for key in ["", "Inbox", "a-b", &"k".repeat(65)] {
            assert!(
                matches!(set(&conn, key, &one), Err(AppError::Invalid(_))),
                "{key}"
            );
        }
        assert!(set_inbox_position(&conn, f64::NAN).is_err());
        assert!(set_inbox_position(&conn, f64::INFINITY).is_err());
        assert_eq!(inbox_position(&conn).expect("read"), None);
    }

    #[test]
    fn an_equal_write_changes_nothing() {
        let conn = open_in_memory().expect("db");
        set_inbox_position(&conn, 4.0).expect("set");
        conn.execute("UPDATE synced_settings SET updated_at = 'old'", [])
            .expect("mark");
        set_inbox_position(&conn, 4.0).expect("set again");
        let stamp: String = conn
            .query_row("SELECT updated_at FROM synced_settings", [], |r| r.get(0))
            .expect("stamp");
        assert_eq!(stamp, "old");
        set_inbox_position(&conn, 5.0).expect("set other");
        let stamp: String = conn
            .query_row("SELECT updated_at FROM synced_settings", [], |r| r.get(0))
            .expect("stamp");
        assert_ne!(stamp, "old");
    }
}
