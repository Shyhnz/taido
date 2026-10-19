//! Unit tests of the § 2.4 algorithm on an in-memory database.

use rusqlite::Connection;
use serde_json::{json, Value};
use sync_proto::{Change, ChangeKey, Entity, SyncResponse, MAX_PULL_CHANGES};

use super::{max_rev, RawSyncRequest, RecordsQuota, SyncOutcome};
use crate::error::ServerError;
use crate::store::open_in_memory;

/// [`super::sync`] without the files to delete (most tests only look at the response).
fn sync(
    conn: &mut Connection,
    account_id: &str,
    device_id: &str,
    request: RawSyncRequest,
) -> Result<SyncResponse, ServerError> {
    super::sync(
        conn,
        account_id,
        device_id,
        request,
        RecordsQuota::UNLIMITED,
    )
    .map(|o| o.response)
}

/// [`super::sync_with_page`] with `page_size` rows and no byte budget, without the files.
fn sync_with_page(
    conn: &mut Connection,
    account_id: &str,
    device_id: &str,
    request: RawSyncRequest,
    page_size: usize,
) -> Result<SyncResponse, ServerError> {
    let page = super::Page {
        rows: page_size,
        bytes: usize::MAX,
    };
    super::sync_with_page(
        conn,
        account_id,
        device_id,
        request,
        page,
        RecordsQuota::UNLIMITED,
    )
    .map(|o| o.response)
}

/// [`super::sync_with_page`] with the protocol's rows and a budget of `bytes`.
fn sync_with_bytes(
    conn: &mut Connection,
    device_id: &str,
    request: RawSyncRequest,
    bytes: usize,
) -> Result<SyncResponse, ServerError> {
    let page = super::Page {
        rows: MAX_PULL_CHANGES,
        bytes,
    };
    super::sync_with_page(
        conn,
        ACCOUNT,
        device_id,
        request,
        page,
        RecordsQuota::UNLIMITED,
    )
    .map(|o| o.response)
}

fn sync_quota(
    conn: &mut Connection,
    request: RawSyncRequest,
    quota: RecordsQuota,
) -> Result<SyncResponse, ServerError> {
    super::sync(conn, ACCOUNT, MAC, request, quota).map(|o| o.response)
}

/// The account's counter, and the same total recomputed from the rows.
fn counted_and_actual(conn: &Connection) -> (i64, i64) {
    conn.query_row(
        "SELECT records_bytes,
                (SELECT COALESCE(SUM(LENGTH(CAST(data AS BLOB))), 0) FROM records
                 WHERE account_id = ?1)
         FROM accounts WHERE id = ?1",
        [ACCOUNT],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .expect("bytes")
}

fn quota(max_bytes: u64) -> RecordsQuota {
    RecordsQuota {
        max_bytes,
        disk_low: false,
    }
}

const MAC: &str = "device-mac";
const PHONE: &str = "device-phone";
/// The account of both devices.
const ACCOUNT: &str = "account-user";

/// An in-memory database holding [`ACCOUNT`].
fn db() -> Connection {
    let conn = open_in_memory().expect("db");
    conn.execute(
        "INSERT INTO accounts (id, email, password_hash, created_at)
         VALUES (?1, 'user@example.com', 'phc', '2026-10-10T08:00:00.000Z')",
        [ACCOUNT],
    )
    .expect("account");
    conn
}

fn stamp(seconds: u32) -> String {
    format!("2026-10-04T09:{:02}:{:02}.000Z", seconds / 60, seconds % 60)
}

fn task(id: &str, at: &str, title: &str) -> Value {
    json!({
        "entity": "task", "id": id, "updated_at": at, "device_id": "",
        "data": {
            "subject_id": null, "section_id": null, "parent_id": null,
            "title": title, "description": "", "due_date": null, "due_time": null,
            "priority": 1, "completed_at": null, "position": 1.0,
            "created_at": "2026-10-01T08:00:00.000Z", "deleted_at": null
        }
    })
}

fn tombstone(entity: &str, id: &str, at: &str) -> Value {
    json!({ "entity": entity, "id": id, "updated_at": at, "device_id": "", "data": null })
}

fn request(cursor: u64, changes: Vec<Value>) -> RawSyncRequest {
    RawSyncRequest {
        protocol: sync_proto::PROTOCOL_VERSION,
        cursor,
        changes,
        known_entities: None,
    }
}

/// A request of a client that reads every entity of this build.
fn request_knowing_all(cursor: u64, changes: Vec<Value>) -> RawSyncRequest {
    RawSyncRequest {
        known_entities: Some(Entity::ALL.iter().map(|e| e.as_str().to_string()).collect()),
        ..request(cursor, changes)
    }
}

fn title(change: &Change) -> Option<&str> {
    match change {
        Change::Task(v) => v.data.as_ref().map(|d| d.title.as_str()),
        _ => None,
    }
}

fn ids(response: &SyncResponse) -> Vec<&str> {
    response.changes.iter().map(Change::id).collect()
}

#[test]
fn push_then_pull_from_another_device() {
    let mut conn = db();
    let pushed = sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(
            0,
            vec![task("a", &stamp(1), "A"), task("b", &stamp(2), "B")],
        ),
    )
    .expect("push");
    assert_eq!(pushed.accepted, 2);
    assert!(
        pushed.changes.is_empty(),
        "own accepted rows are not echoed"
    );
    assert_eq!(pushed.cursor, 2);
    assert!(!pushed.has_more);
    assert_eq!(pushed.server_epoch.len(), 36);
    assert!(sync_proto::is_canonical_timestamp(&pushed.server_time));

    let pulled = sync(&mut conn, ACCOUNT, PHONE, request(0, vec![])).expect("pull");
    assert_eq!(ids(&pulled), vec!["a", "b"]);
    assert!(pulled.changes.iter().all(|c| c.device_id() == MAC));
    assert_eq!(pulled.cursor, 2);

    let again = sync(&mut conn, ACCOUNT, PHONE, request(pulled.cursor, vec![])).expect("pull");
    assert!(again.changes.is_empty());
    assert_eq!(again.cursor, 2);
}

#[test]
fn server_stamps_the_token_device() {
    let mut conn = db();
    let mut change = task("a", &stamp(1), "A");
    change["device_id"] = json!("forged");
    sync(&mut conn, ACCOUNT, MAC, request(0, vec![change])).expect("push");
    let pulled = sync(&mut conn, ACCOUNT, PHONE, request(0, vec![])).expect("pull");
    assert_eq!(pulled.changes[0].device_id(), MAC);
}

#[test]
fn newer_push_wins_and_older_push_gets_the_server_row() {
    let mut conn = db();
    sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(0, vec![task("a", &stamp(10), "mac")]),
    )
    .expect("push");
    // The phone synced up to cursor 1, then edits the row with an older clock.
    let refused = sync(
        &mut conn,
        ACCOUNT,
        PHONE,
        request(1, vec![task("a", &stamp(5), "phone")]),
    )
    .expect("older push");
    assert_eq!(refused.accepted, 0);
    assert_eq!(
        ids(&refused),
        vec!["a"],
        "refused key below the cursor comes back"
    );
    assert_eq!(title(&refused.changes[0]), Some("mac"));
    assert_eq!(refused.cursor, 1);

    let accepted = sync(
        &mut conn,
        ACCOUNT,
        PHONE,
        request(1, vec![task("a", &stamp(20), "phone")]),
    )
    .expect("newer push");
    assert_eq!(accepted.accepted, 1);
    assert!(accepted.changes.is_empty());
    let mac = sync(&mut conn, ACCOUNT, MAC, request(1, vec![])).expect("pull");
    assert_eq!(title(&mac.changes[0]), Some("phone"));
}

#[test]
fn equal_stamp_breaks_ties_by_device() {
    let mut conn = db();
    sync(
        &mut conn,
        ACCOUNT,
        PHONE,
        request(0, vec![task("a", &stamp(1), "phone")]),
    )
    .expect("push");
    // "device-mac" < "device-phone": the Mac loses the tie.
    let r = sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(1, vec![task("a", &stamp(1), "mac")]),
    )
    .expect("push");
    assert_eq!(r.accepted, 0);
    assert_eq!(title(&r.changes[0]), Some("phone"));
}

#[test]
fn re_push_of_the_same_change_is_idempotent() {
    let mut conn = db();
    let first = sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(0, vec![task("a", &stamp(1), "A")]),
    )
    .expect("1");
    let second = sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(first.cursor, vec![task("a", &stamp(1), "A")]),
    )
    .expect("2");
    assert_eq!(second.accepted, 1, "equal pair wins");
    assert!(second.changes.is_empty());
    assert!(second.rejected.is_empty());
}

#[test]
fn tombstones_are_final() {
    let mut conn = db();
    sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(0, vec![task("a", &stamp(1), "A")]),
    )
    .expect("push");
    let gone = sync(
        &mut conn,
        ACCOUNT,
        PHONE,
        request(1, vec![tombstone("task", "a", &stamp(0))]),
    )
    .expect("tombstone");
    assert_eq!(
        gone.accepted, 1,
        "an incoming tombstone always wins, even older"
    );
    let revived = sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(0, vec![task("a", &stamp(50), "back")]),
    )
    .expect("revive");
    assert_eq!(revived.accepted, 0);
    assert_eq!(revived.changes.len(), 1);
    assert!(
        revived.changes[0].is_tombstone(),
        "the stored tombstone comes back"
    );
    // A second tombstone does not replace it either (still one row, same revision).
    let again = sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(2, vec![tombstone("task", "a", &stamp(60))]),
    )
    .expect("again");
    assert_eq!(again.accepted, 0);
    assert_eq!(max_rev(&conn).expect("rev"), 2);
}

#[test]
fn invalid_changes_are_rejected_without_failing_the_request() {
    let mut conn = db();
    let mut bad_priority = task("bad", &stamp(1), "x");
    bad_priority["data"]["priority"] = json!(9);
    let bad_stamp = task("late", "2026-10-04 09:00", "x");
    let mut malformed = task("weird", &stamp(1), "x");
    malformed["data"]["priority"] = json!("high");
    let unknown_entity = json!({"entity": "note", "id": "n", "updated_at": stamp(1),
        "device_id": "", "data": null});
    let r = sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(
            0,
            vec![
                task("ok1", &stamp(1), "fine"),
                bad_priority,
                bad_stamp,
                malformed,
                unknown_entity,
                task("ok2", &stamp(2), "fine too"),
            ],
        ),
    )
    .expect("sync");
    assert_eq!(r.accepted, 2);
    let key = |id: &str| ChangeKey {
        entity: Entity::Task,
        id: id.into(),
    };
    assert_eq!(r.rejected, vec![key("bad"), key("late"), key("weird")]);
    let pulled = sync(&mut conn, ACCOUNT, PHONE, request(0, vec![])).expect("pull");
    assert_eq!(ids(&pulled), vec!["ok1", "ok2"]);
}

#[test]
fn page_excludes_accepted_keys_and_includes_others() {
    let mut conn = db();
    sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(0, vec![task("m", &stamp(1), "mac")]),
    )
    .expect("mac");
    let r = sync(
        &mut conn,
        ACCOUNT,
        PHONE,
        request(0, vec![task("p", &stamp(2), "phone")]),
    )
    .expect("p");
    assert_eq!(ids(&r), vec!["m"]);
    assert_eq!(r.cursor, 2);
}

#[test]
fn refused_key_above_the_cursor_comes_once_in_the_page() {
    let mut conn = db();
    sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(0, vec![task("a", &stamp(10), "mac")]),
    )
    .expect("mac");
    // The phone never pulled (cursor 0) and pushes an older version.
    let r = sync(
        &mut conn,
        ACCOUNT,
        PHONE,
        request(0, vec![task("a", &stamp(1), "phone")]),
    )
    .expect("p");
    assert_eq!(ids(&r), vec!["a"]);
    assert_eq!(title(&r.changes[0]), Some("mac"));
}

#[test]
fn cursor_beyond_the_log_means_full_pull() {
    let mut conn = db();
    sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(0, vec![task("a", &stamp(1), "A")]),
    )
    .expect("push");
    // A restored server holds rev 1 only; the phone's cursor is 99. It also pushes a row.
    let r = sync(
        &mut conn,
        ACCOUNT,
        PHONE,
        request(99, vec![task("b", &stamp(2), "B")]),
    )
    .expect("p");
    assert_eq!(ids(&r), vec!["a"], "the gap is filled from 0");
    assert_eq!(r.cursor, 2);
    let r = sync(&mut conn, ACCOUNT, PHONE, request(u64::MAX, vec![])).expect("huge cursor");
    assert_eq!(ids(&r), vec!["a", "b"]);
}

#[test]
fn pages_with_has_more_and_cursor_of_the_last_row() {
    let mut conn = db();
    let changes: Vec<Value> = (0..7)
        .map(|i| task(&format!("t{i}"), &stamp(i), "x"))
        .collect();
    sync(&mut conn, ACCOUNT, MAC, request(0, changes)).expect("push");
    let first = sync_with_page(&mut conn, ACCOUNT, PHONE, request(0, vec![]), 3).expect("page 1");
    assert_eq!(ids(&first), vec!["t0", "t1", "t2"]);
    assert!(first.has_more);
    assert_eq!(first.cursor, 3);
    let second =
        sync_with_page(&mut conn, ACCOUNT, PHONE, request(first.cursor, vec![]), 3).expect("2");
    assert_eq!(ids(&second), vec!["t3", "t4", "t5"]);
    assert!(second.has_more);
    let third =
        sync_with_page(&mut conn, ACCOUNT, PHONE, request(second.cursor, vec![]), 3).expect("3");
    assert_eq!(ids(&third), vec!["t6"]);
    assert!(!third.has_more);
    assert_eq!(third.cursor, 7);
}

#[test]
fn exactly_a_full_page_has_no_more() {
    let mut conn = db();
    let changes: Vec<Value> = (0..3)
        .map(|i| task(&format!("t{i}"), &stamp(i), "x"))
        .collect();
    sync(&mut conn, ACCOUNT, MAC, request(0, changes)).expect("push");
    let r = sync_with_page(&mut conn, ACCOUNT, PHONE, request(0, vec![]), 3).expect("page");
    assert_eq!(r.changes.len(), 3);
    assert!(!r.has_more);
    assert_eq!(r.cursor, 3);
}

#[test]
fn accepted_rows_do_not_fill_the_page() {
    let mut conn = db();
    let changes: Vec<Value> = (0..4)
        .map(|i| task(&format!("m{i}"), &stamp(i), "x"))
        .collect();
    sync(&mut conn, ACCOUNT, MAC, request(0, changes)).expect("mac");
    let mine: Vec<Value> = (0..3)
        .map(|i| task(&format!("p{i}"), &stamp(i), "x"))
        .collect();
    let r = sync_with_page(&mut conn, ACCOUNT, PHONE, request(0, mine), 2).expect("page");
    assert_eq!(ids(&r), vec!["m0", "m1"]);
    assert!(r.has_more);
    assert_eq!(r.cursor, 2);
    // Later pages bring the rest; the phone's own rows come back once it pages past them
    // (harmless: same version).
    let r = sync_with_page(&mut conn, ACCOUNT, PHONE, request(r.cursor, vec![]), 2).expect("2");
    assert_eq!(ids(&r), vec!["m2", "m3"]);
}

#[test]
fn real_page_size_is_the_protocol_constant() {
    let mut conn = db();
    let changes: Vec<Value> = (0..2500)
        .map(|i| task(&format!("t{i:04}"), &stamp(i % 3600), "x"))
        .collect();
    sync(&mut conn, ACCOUNT, MAC, request(0, changes)).expect("push");
    let first = sync(&mut conn, ACCOUNT, PHONE, request(0, vec![])).expect("1");
    assert_eq!(first.changes.len(), MAX_PULL_CHANGES);
    assert!(first.has_more);
    let second = sync(&mut conn, ACCOUNT, PHONE, request(first.cursor, vec![])).expect("2");
    assert_eq!(second.changes.len(), 500);
    assert!(!second.has_more);
    assert_eq!(second.cursor, 2500);
}

#[test]
fn a_page_stops_at_its_byte_budget() {
    let mut conn = db();
    let changes: Vec<Value> = (0..3)
        .map(|i| task(&format!("b{i}"), &stamp(i), &"x".repeat(1000)))
        .collect();
    sync(&mut conn, ACCOUNT, MAC, request(0, changes)).expect("push");
    // Each row weighs 1 279 bytes (1 000 of title plus the other fields): two fit in 2 600, not three.
    let first = sync_with_bytes(&mut conn, PHONE, request(0, vec![]), 2600).expect("1");
    assert_eq!(ids(&first), vec!["b0", "b1"]);
    assert!(first.has_more);
    let second = sync_with_bytes(&mut conn, PHONE, request(first.cursor, vec![]), 2600).expect("2");
    assert_eq!(ids(&second), vec!["b2"]);
    assert!(!second.has_more);
}

#[test]
fn a_row_larger_than_the_byte_budget_comes_alone() {
    let mut conn = db();
    let changes: Vec<Value> = (0..2)
        .map(|i| task(&format!("big{i}"), &stamp(i), &"x".repeat(1000)))
        .collect();
    sync(&mut conn, ACCOUNT, MAC, request(0, changes)).expect("push");
    let first = sync_with_bytes(&mut conn, PHONE, request(0, vec![]), 10).expect("1");
    assert_eq!(ids(&first), vec!["big0"]);
    assert!(first.has_more);
    let second = sync_with_bytes(&mut conn, PHONE, request(first.cursor, vec![]), 10).expect("2");
    assert_eq!(ids(&second), vec!["big1"]);
    assert!(!second.has_more);
}

#[test]
fn every_entity_round_trips() {
    let mut conn = db();
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../crates/sync-proto/fixtures/sync_request.json"
    ))
    .expect("fixture");
    let changes = fixture["changes"].as_array().expect("changes").clone();
    let expected: Vec<Change> = changes
        .iter()
        .map(|c| serde_json::from_value(c.clone()).expect("change"))
        .collect();
    let r = sync(&mut conn, ACCOUNT, MAC, request(0, changes)).expect("push");
    assert!(r.rejected.is_empty());
    let pulled = sync(&mut conn, ACCOUNT, PHONE, request(0, vec![])).expect("pull");
    assert_eq!(pulled.changes.len(), expected.len());
    for (got, want) in pulled.changes.iter().zip(expected) {
        let mut want = want;
        want.set_device_id(MAC);
        assert_eq!(got, &want);
    }
}

fn setting(key: &str, at: &str, value: Value) -> Value {
    json!({
        "entity": "setting", "id": key, "updated_at": at, "device_id": "",
        "data": { "value": value }
    })
}

fn setting_value(change: &Change) -> Option<&Value> {
    match change {
        Change::Setting(v) => v.data.as_ref().map(|d| &d.value),
        _ => None,
    }
}

fn setting_key(id: &str) -> ChangeKey {
    ChangeKey {
        entity: Entity::Setting,
        id: id.into(),
    }
}

const INBOX: &str = sync_proto::SETTING_INBOX_POSITION;

#[test]
fn setting_push_is_pulled_by_another_device() {
    let mut conn = db();
    let pushed = sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(0, vec![setting(INBOX, &stamp(1), json!(2.5))]),
    )
    .expect("push");
    assert_eq!(pushed.accepted, 1);
    assert!(pushed.rejected.is_empty());

    let pulled = sync(&mut conn, ACCOUNT, PHONE, request(0, vec![])).expect("pull");
    assert_eq!(pulled.changes.len(), 1);
    let change = &pulled.changes[0];
    assert_eq!(change.entity(), Entity::Setting);
    assert_eq!(change.id(), INBOX);
    assert_eq!(change.device_id(), MAC);
    assert_eq!(setting_value(change), Some(&json!(2.5)));

    // A newer value from the phone replaces it and reaches the Mac.
    sync(
        &mut conn,
        ACCOUNT,
        PHONE,
        request(1, vec![setting(INBOX, &stamp(2), json!(-1))]),
    )
    .expect("phone push");
    let mac = sync(&mut conn, ACCOUNT, MAC, request(1, vec![])).expect("mac pull");
    assert_eq!(ids(&mac), vec![INBOX]);
    assert_eq!(setting_value(&mac.changes[0]), Some(&json!(-1)));
    assert_eq!(max_rev(&conn).expect("rev"), 2, "one row per key");
}

#[test]
fn older_setting_is_refused_and_the_stored_value_comes_back() {
    let mut conn = db();
    sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(0, vec![setting(INBOX, &stamp(10), json!(3.0))]),
    )
    .expect("mac");
    let refused = sync(
        &mut conn,
        ACCOUNT,
        PHONE,
        request(1, vec![setting(INBOX, &stamp(5), json!(0.5))]),
    )
    .expect("older push");
    assert_eq!(refused.accepted, 0);
    assert!(refused.rejected.is_empty(), "refused is not rejected");
    assert_eq!(ids(&refused), vec![INBOX]);
    assert_eq!(setting_value(&refused.changes[0]), Some(&json!(3.0)));
    assert_eq!(refused.changes[0].device_id(), MAC);
}

#[test]
fn setting_tombstone_is_rejected_and_the_value_stays() {
    let mut conn = db();
    sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(0, vec![setting(INBOX, &stamp(1), json!(1.0))]),
    )
    .expect("push");
    let r = sync(
        &mut conn,
        ACCOUNT,
        PHONE,
        request(1, vec![tombstone("setting", INBOX, &stamp(50))]),
    )
    .expect("tombstone");
    assert_eq!(r.accepted, 0);
    assert_eq!(r.rejected, vec![setting_key(INBOX)]);
    let pulled = sync(&mut conn, ACCOUNT, PHONE, request(0, vec![])).expect("pull");
    assert_eq!(setting_value(&pulled.changes[0]), Some(&json!(1.0)));
    assert_eq!(max_rev(&conn).expect("rev"), 1);
}

#[test]
fn invalid_settings_are_rejected_and_unknown_keys_accepted() {
    let mut conn = db();
    let too_big = json!("x".repeat(sync_proto::MAX_SETTING_VALUE_BYTES));
    let mut no_value = setting("no_value", &stamp(1), json!(null));
    no_value["data"] = json!({});
    let r = sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(
            0,
            vec![
                setting(INBOX, &stamp(1), json!("2.5")),
                setting("Bad-Key", &stamp(1), json!(1)),
                setting("big", &stamp(1), too_big),
                no_value,
                setting(
                    "future_flag",
                    &stamp(1),
                    json!({"on": true, "list": [1, 2]}),
                ),
                setting(INBOX, &stamp(2), json!(4)),
            ],
        ),
    )
    .expect("sync");
    assert_eq!(r.accepted, 2);
    assert_eq!(
        r.rejected,
        vec![
            setting_key(INBOX),
            setting_key("Bad-Key"),
            setting_key("big"),
            setting_key("no_value"),
        ]
    );
    let pulled = sync(&mut conn, ACCOUNT, PHONE, request(0, vec![])).expect("pull");
    assert_eq!(ids(&pulled), vec!["future_flag", INBOX]);
    assert_eq!(
        setting_value(&pulled.changes[0]),
        Some(&json!({"on": true, "list": [1, 2]}))
    );
    assert_eq!(setting_value(&pulled.changes[1]), Some(&json!(4)));
}

#[test]
fn a_setting_and_a_task_with_the_same_id_are_separate_rows() {
    let mut conn = db();
    let r = sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(
            0,
            vec![
                task("shared_id", &stamp(1), "task"),
                setting("shared_id", &stamp(1), json!(true)),
            ],
        ),
    )
    .expect("push");
    assert_eq!(r.accepted, 2);
    let pulled = sync(&mut conn, ACCOUNT, PHONE, request(0, vec![])).expect("pull");
    let entities: Vec<Entity> = pulled.changes.iter().map(Change::entity).collect();
    assert_eq!(entities, vec![Entity::Task, Entity::Setting]);
}

// ---- Accounts: rows are scoped by account (V2.7 task 3) ----

const OTHER: &str = "account-bob";
const OTHER_DEVICE: &str = "device-bob";

fn add_other_account(conn: &Connection) {
    conn.execute(
        "INSERT INTO accounts (id, email, password_hash, created_at)
         VALUES (?1, 'bob@example.com', 'phc', '2026-10-10T08:00:00.000Z')",
        [OTHER],
    )
    .expect("second account");
}

fn group(id: &str, at: &str, name: &str) -> Value {
    json!({
        "entity": "subject", "id": id, "updated_at": at, "device_id": "",
        "data": { "name": name, "color": "teal", "parent_id": null, "position": 1.0,
                  "created_at": "2026-10-01T08:00:00.000Z", "deleted_at": null,
                  "is_group": true }
    })
}

fn column(id: &str, at: &str, name: &str) -> Value {
    json!({
        "entity": "board_column", "id": id, "updated_at": at, "device_id": "",
        "data": { "subject_id": null, "name": name, "position": 1.0, "is_done": false,
                  "created_at": "2026-10-01T08:00:00.000Z" }
    })
}

fn pull_all(conn: &mut Connection, account: &str, device: &str) -> SyncResponse {
    sync(conn, account, device, request(0, vec![])).expect("pull")
}

fn setting_f64(change: &Change) -> Option<f64> {
    setting_value(change).and_then(Value::as_f64)
}

#[test]
fn two_accounts_with_the_same_ids_never_see_each_other() {
    let mut conn = db();
    add_other_account(&conn);
    let a = vec![
        setting("inbox_position", &stamp(10), json!(1.0)),
        group("grp-x", &stamp(10), "A group"),
        column("col-inbox-0", &stamp(10), "A column"),
    ];
    sync(&mut conn, ACCOUNT, MAC, request(0, a)).expect("A push");
    // B pushes the same keys with a NEWER clock: it must not replace A's rows.
    let b = vec![
        setting("inbox_position", &stamp(50), json!(9.0)),
        group("grp-x", &stamp(50), "B group"),
        column("col-inbox-0", &stamp(50), "B column"),
    ];
    let pushed = sync(&mut conn, OTHER, OTHER_DEVICE, request(0, b)).expect("B push");
    assert_eq!(pushed.accepted, 3, "B's rows are new for B");
    assert!(pushed.changes.is_empty(), "A's rows are not sent to B");

    let a_view = pull_all(&mut conn, ACCOUNT, PHONE);
    assert_eq!(a_view.changes.len(), 3);
    for change in &a_view.changes {
        assert_eq!(change.device_id(), MAC);
        assert_eq!(change.updated_at(), stamp(10));
        match change {
            Change::Setting(_) => assert_eq!(setting_f64(change), Some(1.0)),
            Change::Subject(s) => {
                assert_eq!(s.data.as_ref().map(|d| d.name.as_str()), Some("A group"))
            }
            Change::BoardColumn(c) => {
                assert_eq!(c.data.as_ref().map(|d| d.name.as_str()), Some("A column"))
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    let b_view = pull_all(&mut conn, OTHER, "device-bob-2");
    assert_eq!(b_view.changes.len(), 3);
    assert!(b_view.changes.iter().all(|c| c.device_id() == OTHER_DEVICE));
    assert!(b_view.changes.iter().all(|c| c.updated_at() == stamp(50)));
}

#[test]
fn an_older_push_from_b_is_not_refused_by_a_row_of_a() {
    let mut conn = db();
    add_other_account(&conn);
    sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(0, vec![group("grp-x", &stamp(50), "A")]),
    )
    .expect("A");
    let r = sync(
        &mut conn,
        OTHER,
        OTHER_DEVICE,
        request(0, vec![group("grp-x", &stamp(1), "B")]),
    )
    .expect("B");
    assert_eq!(r.accepted, 1, "A's newer row is invisible to B");
    assert!(r.changes.is_empty());
}

#[test]
fn a_tombstone_of_b_does_not_erase_a() {
    let mut conn = db();
    add_other_account(&conn);
    sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(
            0,
            vec![
                task("shared-id", &stamp(1), "A task"),
                column("col-inbox-0", &stamp(1), "A column"),
            ],
        ),
    )
    .expect("A");
    let r = sync(
        &mut conn,
        OTHER,
        OTHER_DEVICE,
        request(
            0,
            vec![
                tombstone("task", "shared-id", &stamp(99)),
                tombstone("board_column", "col-inbox-0", &stamp(99)),
            ],
        ),
    )
    .expect("B tombstones");
    assert_eq!(r.accepted, 2);
    let a_view = pull_all(&mut conn, ACCOUNT, PHONE);
    assert_eq!(a_view.changes.len(), 2);
    assert!(a_view.changes.iter().all(|c| !c.is_tombstone()));
    assert_eq!(title(&a_view.changes[0]), Some("A task"));
    // And A's rows do not block B's later resurrection attempt: B's tombstone is final for B.
    let b_view = pull_all(&mut conn, OTHER, "device-bob-2");
    assert!(b_view.changes.iter().all(Change::is_tombstone));
}

#[test]
fn each_new_entity_round_trips() {
    let mut conn = db();
    let at = "2026-10-10T09:00:00.000Z";
    let changes = vec![
        json!({"entity": "board_column", "id": "col-inbox-1", "updated_at": at,
               "device_id": "", "data": {"subject_id": null, "name": "À valider",
               "position": 2.0, "is_done": false, "created_at": at}}),
        json!({"entity": "time_segment", "id": "seg1", "updated_at": at, "device_id": "",
               "data": {"task_id": "t1", "source": "auto", "started_at": at,
               "ended_at": null, "stop_reason": null, "note": "", "created_at": at,
               "deleted_at": null}}),
        json!({"entity": "relation", "id": "r1", "updated_at": at, "device_id": "",
               "data": {"from_task_id": "t1", "to_task_id": "t2", "kind": "blocks",
               "created_at": at, "deleted_at": null}}),
        json!({"entity": "attachment", "id": "a1", "updated_at": at, "device_id": "",
               "data": {"task_id": "t1", "file_name": "facture.pdf",
               "mime_type": "application/pdf", "size": 12, "created_at": at,
               "deleted_at": null}}),
        group("grp-x", at, "Group"),
    ];
    let expected: Vec<Change> = changes
        .iter()
        .map(|c| serde_json::from_value(c.clone()).expect("change"))
        .collect();
    let pushed = sync(&mut conn, ACCOUNT, MAC, request(0, changes)).expect("push");
    assert!(pushed.rejected.is_empty(), "{:?}", pushed.rejected);
    assert_eq!(pushed.accepted, 5);
    let pulled = pull_all(&mut conn, ACCOUNT, PHONE);
    assert_eq!(pulled.changes.len(), expected.len());
    for (got, want) in pulled.changes.iter().zip(expected) {
        let mut want = want;
        want.set_device_id(MAC);
        assert_eq!(got, &want);
    }
}

#[test]
fn paging_is_correct_when_another_account_writes_between_pages() {
    let mut conn = db();
    add_other_account(&conn);
    let mine = |range: std::ops::Range<u32>| -> Vec<Value> {
        range
            .map(|i| task(&format!("t{i}"), &stamp(i), "x"))
            .collect()
    };
    sync(&mut conn, ACCOUNT, MAC, request(0, mine(0..5))).expect("A push");
    let first = sync_with_page(&mut conn, ACCOUNT, PHONE, request(0, vec![]), 2).expect("p1");
    assert_eq!(ids(&first), vec!["t0", "t1"]);
    assert!(first.has_more);
    assert_eq!(first.cursor, 2);

    // B writes a lot between the pages; A writes one more row after B.
    let noise: Vec<Value> = (0..6)
        .map(|i| task(&format!("b{i}"), &stamp(i), "noise"))
        .collect();
    sync(&mut conn, OTHER, OTHER_DEVICE, request(0, noise)).expect("B push");
    sync(&mut conn, ACCOUNT, MAC, request(5, mine(5..6))).expect("A push 2");

    let second =
        sync_with_page(&mut conn, ACCOUNT, PHONE, request(first.cursor, vec![]), 2).expect("p2");
    assert_eq!(ids(&second), vec!["t2", "t3"]);
    assert!(second.has_more);
    let third =
        sync_with_page(&mut conn, ACCOUNT, PHONE, request(second.cursor, vec![]), 2).expect("p3");
    assert_eq!(ids(&third), vec!["t4", "t5"]);
    assert!(!third.has_more, "B's revisions do not make has_more true");
    assert_eq!(
        third.cursor, 12,
        "the final cursor is the global max revision"
    );
    let done =
        sync_with_page(&mut conn, ACCOUNT, PHONE, request(third.cursor, vec![]), 2).expect("done");
    assert!(done.changes.is_empty());
    assert!(!done.has_more);
}

#[test]
fn only_other_accounts_rows_above_the_page_do_not_set_has_more() {
    let mut conn = db();
    add_other_account(&conn);
    sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(0, vec![task("a", &stamp(1), "A")]),
    )
    .expect("A");
    let noise: Vec<Value> = (0..5)
        .map(|i| task(&format!("b{i}"), &stamp(i), "noise"))
        .collect();
    sync(&mut conn, OTHER, OTHER_DEVICE, request(0, noise)).expect("B");
    let r = sync_with_page(&mut conn, ACCOUNT, PHONE, request(0, vec![]), 1).expect("page");
    assert_eq!(ids(&r), vec!["a"]);
    assert!(!r.has_more);
}

#[test]
fn refused_keys_use_the_accounts_own_row_with_shared_revisions() {
    let mut conn = db();
    add_other_account(&conn);
    sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(0, vec![task("a", &stamp(10), "mac")]),
    )
    .expect("A");
    sync(
        &mut conn,
        OTHER,
        OTHER_DEVICE,
        request(0, vec![task("a", &stamp(99), "bob")]),
    )
    .expect("B");
    // The phone (account A) is at cursor 1 and pushes an older edit: it gets A's row back.
    let r = sync(
        &mut conn,
        ACCOUNT,
        PHONE,
        request(1, vec![task("a", &stamp(5), "phone")]),
    )
    .expect("phone");
    assert_eq!(r.accepted, 0);
    assert_eq!(ids(&r), vec!["a"]);
    assert_eq!(title(&r.changes[0]), Some("mac"));
}

// ---------------------------------------------------------------------------
// Attachment hashes and files (V2.7 bis)
// ---------------------------------------------------------------------------

const HASH: &str = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

fn attachment(id: &str, at: &str, sha256: Option<&str>, deleted_at: Option<&str>) -> Value {
    let mut data = json!({
        "task_id": "t1", "file_name": "facture.pdf", "mime_type": "application/pdf",
        "size": 12, "created_at": "2026-10-01T08:00:00.000Z", "deleted_at": deleted_at
    });
    if let Some(hash) = sha256 {
        data["sha256"] = json!(hash);
    }
    json!({"entity": "attachment", "id": id, "updated_at": at, "device_id": "", "data": data})
}

fn stored_data(conn: &Connection, account: &str, id: &str) -> Value {
    let json: String = conn
        .query_row(
            "SELECT data FROM records WHERE account_id = ?1 AND entity = 'attachment' AND id = ?2",
            [account, id],
            |r| r.get(0),
        )
        .expect("stored");
    serde_json::from_str(&json).expect("json")
}

fn sha256_of(change: &Change) -> Option<&str> {
    match change {
        Change::Attachment(v) => v.data.as_ref().and_then(|d| d.sha256.as_deref()),
        _ => None,
    }
}

#[test]
fn attachment_sha256_survives_push_store_and_pull() {
    let mut conn = db();
    let pushed = sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(
            0,
            vec![
                attachment("a1", &stamp(1), Some(HASH), None),
                attachment("a2", &stamp(1), None, None),
            ],
        ),
    )
    .expect("push");
    assert!(pushed.rejected.is_empty(), "{:?}", pushed.rejected);
    assert_eq!(pushed.accepted, 2);
    assert_eq!(stored_data(&conn, ACCOUNT, "a1")["sha256"], json!(HASH));
    assert!(
        stored_data(&conn, ACCOUNT, "a2").get("sha256").is_none(),
        "an unknown hash is not written"
    );
    let pulled = pull_all(&mut conn, ACCOUNT, PHONE);
    assert_eq!(ids(&pulled), vec!["a1", "a2"]);
    assert_eq!(sha256_of(&pulled.changes[0]), Some(HASH));
    assert_eq!(sha256_of(&pulled.changes[1]), None);
}

#[test]
fn a_malformed_attachment_sha256_is_rejected() {
    let bad = [
        HASH.to_uppercase(),
        HASH[..63].to_string(),
        format!("{}g", &HASH[..63]),
        String::new(),
    ];
    for hash in bad {
        let mut conn = db();
        let r = sync(
            &mut conn,
            ACCOUNT,
            MAC,
            request(
                0,
                vec![
                    attachment("a1", &stamp(1), Some(&hash), None),
                    task("t", &stamp(1), "kept"),
                ],
            ),
        )
        .expect("push");
        assert_eq!(
            r.rejected,
            vec![ChangeKey {
                entity: Entity::Attachment,
                id: "a1".into()
            }],
            "{hash:?}"
        );
        assert_eq!(r.accepted, 1);
    }
}

fn add_file_row(conn: &Connection, account: &str, id: &str) {
    conn.execute(
        "INSERT INTO files (account_id, attachment_id, size, sha256, complete, updated_at)
         VALUES (?1, ?2, 12, ?3, 1, '2026-10-10T08:00:00.000Z')",
        [account, id, HASH],
    )
    .expect("file row");
}

fn file_ids(conn: &Connection, account: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare("SELECT attachment_id FROM files WHERE account_id = ?1 ORDER BY attachment_id")
        .expect("prepare");
    let rows = stmt
        .query_map([account], |r| r.get::<_, String>(0))
        .expect("query");
    rows.collect::<Result<Vec<_>, _>>().expect("rows")
}

#[test]
fn deleting_an_attachment_forgets_its_file_in_the_same_transaction() {
    let mut conn = db();
    add_other_account(&conn);
    let live = |id: &str| attachment(id, &stamp(1), Some(HASH), None);
    sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(0, vec![live("a1"), live("a2"), live("a3")]),
    )
    .expect("A");
    sync(&mut conn, OTHER, OTHER_DEVICE, request(0, vec![live("a1")])).expect("B");
    for id in ["a1", "a2", "a3"] {
        add_file_row(&conn, ACCOUNT, id);
    }
    add_file_row(&conn, OTHER, "a1");

    // A deletion that loses keeps the file.
    let outcome: SyncOutcome = super::sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(0, vec![attachment("a2", &stamp(0), None, Some(&stamp(0)))]),
        RecordsQuota::UNLIMITED,
    )
    .expect("older");
    assert_eq!(outcome.response.accepted, 0);
    assert!(outcome.removed_files.is_empty());

    // Soft delete, tombstone, and a live edit (kept).
    let outcome = super::sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(
            0,
            vec![
                attachment("a1", &stamp(2), Some(HASH), Some(&stamp(2))),
                tombstone("attachment", "a3", &stamp(2)),
                attachment("a2", &stamp(2), Some(HASH), None),
            ],
        ),
        RecordsQuota::UNLIMITED,
    )
    .expect("delete");
    assert_eq!(outcome.response.accepted, 3);
    assert_eq!(outcome.removed_files, vec!["a1", "a3"]);
    assert_eq!(file_ids(&conn, ACCOUNT), vec!["a2"]);
    assert_eq!(
        file_ids(&conn, OTHER),
        vec!["a1"],
        "the other account keeps its file"
    );

    // Nothing left to delete: nothing listed.
    let outcome = super::sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(0, vec![tombstone("attachment", "a1", &stamp(3))]),
        RecordsQuota::UNLIMITED,
    )
    .expect("again");
    assert_eq!(outcome.response.accepted, 1);
    assert!(outcome.removed_files.is_empty());
}

#[test]
fn the_counter_follows_pushes_edits_and_deletions() {
    let mut conn = db();
    sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(0, vec![task("q1", &stamp(1), "short")]),
    )
    .expect("1");
    let (counted, actual) = counted_and_actual(&conn);
    assert!(counted > 0);
    assert_eq!(counted, actual);
    sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(0, vec![task("q1", &stamp(2), &"x".repeat(500))]),
    )
    .expect("bigger");
    let (counted, actual) = counted_and_actual(&conn);
    assert_eq!(counted, actual);
    let tombstone = json!({"entity": "task", "id": "q1", "updated_at": stamp(3),
        "device_id": "", "data": null});
    sync(&mut conn, ACCOUNT, MAC, request(0, vec![tombstone])).expect("delete");
    assert_eq!(counted_and_actual(&conn), (0, 0));
}

#[test]
fn a_push_that_would_pass_the_quota_is_refused_whole() {
    let mut conn = db();
    sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(0, vec![task("q1", &stamp(1), "a")]),
    )
    .expect("1");
    let (used, _) = counted_and_actual(&conn);
    let limit = quota(u64::try_from(used).expect("used") + 100);
    let push = request(
        0,
        vec![
            task("q2", &stamp(2), "b"),
            task("q3", &stamp(3), &"x".repeat(1000)),
        ],
    );
    let err = sync_quota(&mut conn, push, limit).expect_err("over quota");
    assert!(matches!(err, ServerError::RecordsQuota));
    // Nothing of the refused push was kept.
    let pulled = sync(&mut conn, ACCOUNT, PHONE, request(0, vec![])).expect("pull");
    assert_eq!(ids(&pulled), vec!["q1"]);
    assert_eq!(counted_and_actual(&conn).0, used);
}

#[test]
fn a_full_account_can_still_shrink() {
    let mut conn = db();
    sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request(0, vec![task("q1", &stamp(1), &"x".repeat(1000))]),
    )
    .expect("1");
    // The quota went down below what the account holds: shrinking still works.
    let edit = request(0, vec![task("q1", &stamp(2), "short now")]);
    sync_quota(&mut conn, edit, quota(10)).expect("a smaller edit is accepted");
    let tombstone = json!({"entity": "task", "id": "q1", "updated_at": stamp(3),
        "device_id": "", "data": null});
    sync_quota(&mut conn, request(0, vec![tombstone]), quota(10)).expect("a deletion too");
}

#[test]
fn a_low_disk_refuses_growth_only() {
    let mut conn = db();
    let low = RecordsQuota {
        max_bytes: u64::MAX,
        disk_low: true,
    };
    let err = sync_quota(&mut conn, request(0, vec![task("q1", &stamp(1), "a")]), low)
        .expect_err("growth on a low disk");
    assert!(matches!(err, ServerError::RecordsQuota));
    // An empty push (a pull) still works.
    sync_quota(&mut conn, request(0, vec![]), low).expect("pull");
}

fn note_page(id: &str, at: &str) -> Value {
    json!({
        "entity": "note_page", "id": id, "updated_at": at, "device_id": "",
        "data": {"subject_id": "s1", "group_id": null, "kind": "page", "title": "Accès",
                 "body": "", "source_task_id": null, "pinned_at": null, "position": 1.0,
                 "created_at": at, "deleted_at": null}
    })
}

#[test]
fn notebook_rows_reach_only_clients_that_know_them() {
    let mut conn = db();
    let pushed = sync(
        &mut conn,
        ACCOUNT,
        MAC,
        request_knowing_all(
            0,
            vec![
                task("a", &stamp(1), "A"),
                note_page("p1", &stamp(2)),
                task("b", &stamp(3), "B"),
                tombstone("note_group", "g1", &stamp(4)),
            ],
        ),
    )
    .expect("push from a new Mac");
    assert_eq!(
        pushed.accepted, 4,
        "a new client's notebook rows are stored"
    );

    // A client made before the notebook declares nothing: exactly the historical rows.
    let old = sync(&mut conn, ACCOUNT, PHONE, request(0, vec![])).expect("old pull");
    assert_eq!(ids(&old), vec!["a", "b"]);
    assert_eq!(old.cursor, 4);
    assert!(!old.has_more);

    // A client that knows them gets them, in revision order.
    let new = sync(&mut conn, ACCOUNT, PHONE, request_knowing_all(0, vec![])).expect("pull");
    assert_eq!(ids(&new), vec!["a", "p1", "b", "g1"]);

    // Paging: filtered rows take no room and the cursor stays right.
    let first = sync_with_page(&mut conn, ACCOUNT, PHONE, request(0, vec![]), 1).expect("p1");
    assert_eq!(
        (ids(&first), first.has_more, first.cursor),
        (vec!["a"], true, 1)
    );
    let second =
        sync_with_page(&mut conn, ACCOUNT, PHONE, request(first.cursor, vec![]), 1).expect("p2");
    // Only a filtered row is left after `b`: no more, the cursor is the log's end.
    assert_eq!(
        (ids(&second), second.has_more, second.cursor),
        (vec!["b"], false, 4)
    );

    // An old client never gets a notebook row back as the answer to a refused push either,
    // and a name the server does not know is ignored.
    let odd = RawSyncRequest {
        known_entities: Some(vec!["later_thing".into()]),
        ..request(0, vec![])
    };
    let odd = sync(&mut conn, ACCOUNT, PHONE, odd).expect("odd pull");
    assert_eq!(ids(&odd), vec!["a", "b"]);
}
