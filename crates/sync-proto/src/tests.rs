use serde_json::{json, Value};

use super::*;

const REQUEST: &str = include_str!("../fixtures/sync_request.json");
const RESPONSE: &str = include_str!("../fixtures/sync_response.json");

fn task(id: &str, updated_at: &str) -> Change {
    Change::Task(Versioned {
        id: id.into(),
        updated_at: updated_at.into(),
        device_id: "dev-a".into(),
        data: Some(TaskData {
            subject_id: None,
            section_id: None,
            parent_id: None,
            title: "T".into(),
            description: String::new(),
            due_date: Some("2026-10-04".into()),
            due_time: Some("09:30".into()),
            priority: 2,
            completed_at: None,
            position: 1.0,
            created_at: "2026-10-04T08:00:00.000Z".into(),
            deleted_at: None,
            board_column_id: None,
        }),
    })
}

fn setting(key: &str, updated_at: &str, value: Option<Value>) -> Change {
    Change::Setting(Versioned {
        id: key.into(),
        updated_at: updated_at.into(),
        device_id: "0199a3e0-1111-7000-8000-00000000aaaa".into(),
        data: value.map(|value| SettingData { value }),
    })
}

/// Parses `text`, serializes it back and compares as JSON values (key order free).
fn round_trip<T: serde::de::DeserializeOwned + Serialize>(text: &str) -> T {
    let parsed: T = serde_json::from_str(text).expect("parse fixture");
    let back = serde_json::to_value(&parsed).expect("serialize");
    let original: Value = serde_json::from_str(text).expect("fixture json");
    assert_eq!(back, original, "round trip changes the JSON");
    parsed
}

#[test]
fn request_fixture_round_trips_and_validates() {
    let req: SyncRequest = round_trip(REQUEST);
    assert_eq!(req.protocol, PROTOCOL_VERSION);
    assert_eq!(req.cursor, 41);
    assert_eq!(req.changes.len(), 7);
    let entities: Vec<Entity> = req.changes.iter().map(Change::entity).collect();
    assert_eq!(
        entities,
        [
            Entity::Subject,
            Entity::Subject,
            Entity::Section,
            Entity::Task,
            Entity::Task,
            Entity::Section,
            Entity::Setting
        ]
    );
    assert!(req.changes[5].is_tombstone());
    assert_eq!(req.changes[6].id(), SETTING_INBOX_POSITION);
    for change in &req.changes {
        change.validate().expect("fixture change is valid");
    }
}

#[test]
fn response_fixture_round_trips() {
    let res: SyncResponse = round_trip(RESPONSE);
    assert_eq!(res.cursor, 47);
    assert_eq!(res.accepted, 5);
    assert!(!res.has_more);
    assert_eq!(res.server_epoch.len(), 36);
    assert_eq!(
        res.rejected,
        [ChangeKey {
            entity: Entity::Task,
            id: "0199a3f0-0000-7000-8000-000000000009".into()
        }]
    );
    assert!(is_canonical_timestamp(&res.server_time));
    assert!(!res.changes[0].is_tombstone());
    assert!(res.changes[1].is_tombstone());
    assert_eq!(res.changes[1].key().entity, Entity::Task);
    assert_eq!(
        res.changes[2],
        setting(
            SETTING_INBOX_POSITION,
            "2026-10-04T08:45:00.000Z",
            Some(json!(2.5))
        )
    );
    for change in &res.changes {
        change.validate().expect("fixture change is valid");
    }
}

#[test]
fn change_json_shape_is_flat_and_tagged() {
    let value = serde_json::to_value(task("t1", "2026-10-04T09:00:00.000Z")).expect("ser");
    assert_eq!(value["entity"], "task");
    assert_eq!(value["id"], "t1");
    assert_eq!(value["device_id"], "dev-a");
    assert_eq!(value["data"]["priority"], 2);
    assert_eq!(value["data"]["due_time"], "09:30");
    let tomb = json!({
        "entity": "subject", "id": "s1", "updated_at": "2026-10-04T09:00:00.000Z",
        "device_id": "d", "data": null
    });
    let parsed: Change = serde_json::from_value(tomb.clone()).expect("tombstone");
    assert!(parsed.is_tombstone());
    assert_eq!(parsed.entity(), Entity::Subject);
    assert_eq!(serde_json::to_value(&parsed).expect("ser"), tomb);
}

#[test]
fn unknown_entity_and_missing_fields_are_refused() {
    let bad_entity = json!({"entity": "journal", "id": "x", "updated_at": "2026-10-04T09:00:00.000Z",
        "device_id": "", "data": null});
    assert!(serde_json::from_value::<Change>(bad_entity).is_err());
    let missing = json!({"entity": "section", "id": "x", "updated_at": "2026-10-04T09:00:00.000Z",
        "device_id": "", "data": {"name": "A", "position": 1.0, "created_at": "c"}});
    assert!(serde_json::from_value::<Change>(missing).is_err());
}

#[test]
fn small_messages_round_trip() {
    let login = LoginRequest {
        protocol: 1,
        email: "a@b.co".into(),
        password: "secret".into(),
        device_name: "Mac".into(),
    };
    let back: LoginRequest =
        serde_json::from_str(&serde_json::to_string(&login).expect("ser")).expect("de");
    assert_eq!(back, login);
    let res = LoginResponse {
        protocol: 1,
        token: "t".repeat(43),
        device_id: "d".into(),
        server_epoch: "e".into(),
    };
    assert_eq!(
        serde_json::to_value(&res).expect("ser")["server_epoch"],
        "e"
    );
    let back: LoginResponse =
        serde_json::from_str(&serde_json::to_string(&res).expect("ser")).expect("de");
    assert_eq!(back, res);
    let err = ErrorBody {
        error: ErrorCode::UnsupportedProtocol,
        message: "protocol 2".into(),
    };
    let value = serde_json::to_value(&err).expect("ser");
    assert_eq!(
        value,
        json!({"error": "unsupported_protocol", "message": "protocol 2"})
    );
    let health: HealthResponse =
        serde_json::from_value(json!({"ok": true, "protocol": 1})).expect("health");
    assert!(health.ok);
}

#[test]
fn error_codes_map_to_http_statuses() {
    let cases = [
        (ErrorCode::BadRequest, 400),
        (ErrorCode::UnsupportedProtocol, 400),
        (ErrorCode::Unauthorized, 401),
        (ErrorCode::PayloadTooLarge, 413),
        (ErrorCode::RateLimited, 429),
        (ErrorCode::Internal, 500),
    ];
    for (code, status) in cases {
        assert_eq!(code.http_status(), status, "{code:?}");
    }
}

#[test]
fn canonical_timestamps() {
    let ok = [
        "2026-10-04T09:00:00.000Z",
        "1999-01-31T23:59:59.999Z",
        "2026-12-31T00:00:60.000Z",
    ];
    for s in ok {
        assert!(is_canonical_timestamp(s), "{s}");
    }
    let bad = [
        "2026-10-04T09:00:00Z",
        "2026-10-04T09:00:00.000+00:00",
        "2026-10-04 09:00:00.000Z",
        "2026-13-04T09:00:00.000Z",
        "2026-10-00T09:00:00.000Z",
        "2026-10-04T24:00:00.000Z",
        "2026-10-04T09:00:00.0000Z",
        "t",
        "",
    ];
    for s in bad {
        assert!(!is_canonical_timestamp(s), "{s}");
    }
}

#[test]
fn validate_refuses_bad_changes() {
    assert!(task("t1", "2026-10-04T09:00:00.000Z").validate().is_ok());
    assert!(task("t1", "2026-10-04T09:00:00Z").validate().is_err());
    assert!(task("", "2026-10-04T09:00:00.000Z").validate().is_err());
    assert!(task(&"x".repeat(129), "2026-10-04T09:00:00.000Z")
        .validate()
        .is_err());
    let with = |f: &dyn Fn(&mut TaskData)| {
        let mut c = task("t1", "2026-10-04T09:00:00.000Z");
        if let Change::Task(Versioned { data: Some(d), .. }) = &mut c {
            f(d);
        }
        c.validate()
    };
    assert!(with(&|d| d.priority = 0).is_err());
    assert!(with(&|d| d.priority = 5).is_err());
    assert!(with(&|d| d.priority = 4).is_ok());
    assert!(with(&|d| d.position = f64::NAN).is_err());
    assert!(with(&|d| d.position = f64::INFINITY).is_err());
    assert!(with(&|d| d.due_date = Some("04/10/2026".into())).is_err());
    assert!(with(&|d| d.due_time = Some("24:00".into())).is_err());
    assert!(with(&|d| d.due_date = None).is_err(), "time without date");
    assert!(with(&|d| d.parent_id = Some("t1".into())).is_err());
    assert!(with(&|d| d.created_at = String::new()).is_err());
    // Long texts are fine: only the body size is limited.
    assert!(with(&|d| d.title = "a".repeat(100_000)).is_ok());
}

#[test]
fn conflict_rule() {
    let s = |updated_at, device_id, tombstone| Stamp {
        updated_at,
        device_id,
        tombstone,
    };
    let t1 = "2026-10-04T09:00:00.000Z";
    let t2 = "2026-10-04T09:00:00.001Z";
    // Newer wins, older loses.
    assert!(incoming_wins(s(t2, "a", false), s(t1, "b", false)));
    assert!(!incoming_wins(s(t1, "b", false), s(t2, "a", false)));
    // Same instant: the greater device id wins; the same pair is idempotent.
    assert!(incoming_wins(s(t1, "b", false), s(t1, "a", false)));
    assert!(!incoming_wins(s(t1, "a", false), s(t1, "b", false)));
    assert!(incoming_wins(s(t1, "a", false), s(t1, "a", false)));
    // Tombstones: incoming always wins, stored is final.
    assert!(incoming_wins(s(t1, "a", true), s(t2, "z", false)));
    assert!(!incoming_wins(s(t2, "z", false), s(t1, "a", true)));
    assert!(!incoming_wins(s(t2, "z", true), s(t1, "a", true)));
}

#[test]
fn device_id_is_overwritten_by_the_server() {
    let mut c = task("t1", "2026-10-04T09:00:00.000Z");
    c.set_device_id("server-given");
    assert_eq!(c.device_id(), "server-given");
    assert_eq!(c.stamp().device_id, "server-given");
}

#[test]
fn entity_names() {
    for e in [
        Entity::Subject,
        Entity::Section,
        Entity::Task,
        Entity::Setting,
    ] {
        assert_eq!(Entity::parse(e.as_str()), Some(e));
        assert_eq!(
            serde_json::to_value(e).expect("ser"),
            Value::String(e.as_str().into())
        );
    }
    assert_eq!(Entity::parse("journal"), None);
    assert_eq!(Entity::Setting.as_str(), "setting");
    assert_eq!(Entity::parse("setting"), Some(Entity::Setting));
}

#[test]
fn epoch_stamp_is_canonical_and_lowest() {
    assert!(is_canonical_timestamp(EPOCH_STAMP));
    let real = Stamp {
        updated_at: "2026-10-04T09:00:00.000Z",
        device_id: "a",
        tombstone: false,
    };
    let epoch = Stamp {
        updated_at: EPOCH_STAMP,
        device_id: "zzzz",
        tombstone: false,
    };
    assert!(
        !incoming_wins(epoch, real),
        "an epoch stamp loses to a real version"
    );
    assert!(incoming_wins(real, epoch));
}

#[test]
fn change_key_json_shape() {
    let key = ChangeKey {
        entity: Entity::Section,
        id: "s1".into(),
    };
    assert_eq!(
        serde_json::to_value(&key).expect("ser"),
        json!({"entity": "section", "id": "s1"})
    );
}

#[test]
fn setting_json_shape() {
    let wire = json!({
        "entity": "setting", "id": "inbox_position", "updated_at": "2026-10-04T09:00:00.000Z",
        "device_id": "d", "data": {"value": 2.5}
    });
    let parsed: Change = serde_json::from_value(wire.clone()).expect("setting");
    assert_eq!(parsed.entity(), Entity::Setting);
    assert_eq!(parsed.id(), SETTING_INBOX_POSITION);
    assert!(!parsed.is_tombstone());
    assert_eq!(serde_json::to_value(&parsed).expect("ser"), wire);
    // `value` is required (it may be JSON null, but not missing).
    let missing = json!({"entity": "setting", "id": "k", "updated_at": "2026-10-04T09:00:00.000Z",
        "device_id": "d", "data": {}});
    assert!(serde_json::from_value::<Change>(missing).is_err());
}

#[test]
fn validate_settings() {
    let at = "2026-10-04T09:00:00.000Z";
    let check = |key: &str, value: Option<Value>| setting(key, at, value).validate();
    assert!(check(SETTING_INBOX_POSITION, Some(json!(2.5))).is_ok());
    assert!(check(SETTING_INBOX_POSITION, Some(json!(-3))).is_ok());
    assert!(check(SETTING_INBOX_POSITION, Some(json!(u64::MAX))).is_ok());
    assert!(check(SETTING_INBOX_POSITION, Some(json!("2.5"))).is_err());
    assert!(check(SETTING_INBOX_POSITION, Some(Value::Null)).is_err());
    assert!(check(SETTING_INBOX_POSITION, Some(json!({"v": 1}))).is_err());
    // Never deleted, whatever the key.
    assert_eq!(
        check(SETTING_INBOX_POSITION, None),
        Err(ProtoError("a setting is never deleted".into()))
    );
    assert!(check("theme_x", None).is_err());
    // Keys: `[a-z0-9_]`, 1 to 64 bytes.
    assert!(check("Inbox", Some(json!(1))).is_err());
    assert!(check("a-b", Some(json!(1))).is_err());
    assert!(check("é", Some(json!(1))).is_err());
    assert!(check("", Some(json!(1))).is_err());
    assert!(check(&"a".repeat(65), Some(json!(1))).is_err());
    assert!(check(&"a".repeat(64), Some(json!(1))).is_ok());
    assert!(check("theme_x_2", Some(json!({"dark": true, "list": [1, 2]}))).is_ok());
    // Value size, serialized.
    let big = |n: usize| Some(Value::String("a".repeat(n)));
    assert!(check("theme_x", big(MAX_SETTING_VALUE_BYTES - 2)).is_ok());
    assert!(check("theme_x", big(MAX_SETTING_VALUE_BYTES - 1)).is_err());
    assert!(check("theme_x", big(5000)).is_err());
    // The generic checks still run.
    assert!(setting(
        SETTING_INBOX_POSITION,
        "2026-10-04T09:00:00Z",
        Some(json!(1))
    )
    .validate()
    .is_err());
}

#[test]
fn setting_keys() {
    assert!(is_setting_key(SETTING_INBOX_POSITION));
    assert!(is_setting_key("a"));
    assert!(is_setting_key("0_9"));
    assert!(!is_setting_key("inbox position"));
    assert!(!is_setting_key("inbox.position"));
}

#[test]
fn existing_entities_still_check_positions() {
    let mut c = task("t1", "2026-10-04T09:00:00.000Z");
    if let Change::Task(Versioned { data: Some(d), .. }) = &mut c {
        d.position = f64::NAN;
    }
    assert!(c.validate().is_err());
}

// ---------------------------------------------------------------------------
// Protocol 3: V2 entities, account messages
// ---------------------------------------------------------------------------

const V3: &str = include_str!("../fixtures/v3_entities.json");
const AT: &str = "2026-10-10T09:00:00.000Z";

fn v3_change(entity: &str, id: &str, data: Value) -> Change {
    serde_json::from_value(json!({
        "entity": entity, "id": id, "updated_at": AT, "device_id": "d", "data": data
    }))
    .expect("v3 change")
}

fn column(f: &dyn Fn(&mut BoardColumnData)) -> Result<(), ProtoError> {
    let mut d = BoardColumnData {
        subject_id: Some("s1".into()),
        name: "À valider".into(),
        position: 1.0,
        is_done: false,
        created_at: AT.into(),
    };
    f(&mut d);
    Change::BoardColumn(Versioned {
        id: "col-s1-0".into(),
        updated_at: AT.into(),
        device_id: "d".into(),
        data: Some(d),
    })
    .validate()
}

fn segment(f: &dyn Fn(&mut TimeSegmentData)) -> Result<(), ProtoError> {
    let mut d = TimeSegmentData {
        task_id: "t1".into(),
        source: SegmentSource::Auto,
        started_at: "2026-10-10T08:00:00.000Z".into(),
        ended_at: Some("2026-10-10T08:30:00.000Z".into()),
        stop_reason: Some("waiting".into()),
        note: String::new(),
        created_at: AT.into(),
        deleted_at: None,
    };
    f(&mut d);
    Change::TimeSegment(Versioned {
        id: "seg1".into(),
        updated_at: AT.into(),
        device_id: "d".into(),
        data: Some(d),
    })
    .validate()
}

fn relation(f: &dyn Fn(&mut RelationData)) -> Result<(), ProtoError> {
    let mut d = RelationData {
        from_task_id: "t1".into(),
        to_task_id: "t2".into(),
        kind: RelationKind::Blocks,
        created_at: AT.into(),
        deleted_at: None,
    };
    f(&mut d);
    Change::Relation(Versioned {
        id: "r1".into(),
        updated_at: AT.into(),
        device_id: "d".into(),
        data: Some(d),
    })
    .validate()
}

fn attachment(f: &dyn Fn(&mut AttachmentData)) -> Result<(), ProtoError> {
    let mut d = AttachmentData {
        task_id: "t1".into(),
        file_name: "plan.pdf".into(),
        mime_type: "application/pdf".into(),
        size: 1234,
        sha256: None,
        created_at: AT.into(),
        deleted_at: None,
    };
    f(&mut d);
    Change::Attachment(Versioned {
        id: "a1".into(),
        updated_at: AT.into(),
        device_id: "d".into(),
        data: Some(d),
    })
    .validate()
}

#[test]
fn protocol_version_is_3() {
    assert_eq!(PROTOCOL_VERSION, 3);
}

#[test]
fn v3_fixture_round_trips_and_validates() {
    let req: SyncRequest = round_trip(V3);
    assert_eq!(req.protocol, 3);
    let entities: Vec<Entity> = req.changes.iter().map(Change::entity).collect();
    assert_eq!(
        entities,
        [
            Entity::Subject,
            Entity::Task,
            Entity::BoardColumn,
            Entity::TimeSegment,
            Entity::Relation,
            Entity::Attachment,
            Entity::Relation,
            Entity::NoteGroup,
            Entity::NotePage,
            Entity::NoteAttachment,
        ]
    );
    assert!(req.changes[6].is_tombstone());
    for change in &req.changes {
        change.validate().expect("fixture change is valid");
    }
}

#[test]
fn v3_entity_names() {
    for (e, name) in [
        (Entity::BoardColumn, "board_column"),
        (Entity::TimeSegment, "time_segment"),
        (Entity::Relation, "relation"),
        (Entity::Attachment, "attachment"),
        (Entity::NoteGroup, "note_group"),
        (Entity::NotePage, "note_page"),
        (Entity::NoteAttachment, "note_attachment"),
    ] {
        assert_eq!(e.as_str(), name);
        assert_eq!(Entity::parse(name), Some(e));
        assert_eq!(
            serde_json::to_value(e).expect("ser"),
            Value::String(name.into())
        );
    }
}

#[test]
fn protocol_2_json_reads_with_defaults() {
    let subject = v3_change(
        "subject",
        "s1",
        json!({"name": "A", "color": "teal", "parent_id": null, "position": 1.0,
            "created_at": AT, "deleted_at": null}),
    );
    match subject {
        Change::Subject(Versioned { data: Some(d), .. }) => assert!(!d.is_group),
        other => panic!("not a subject: {other:?}"),
    }
    let task = v3_change(
        "task",
        "t1",
        json!({"subject_id": null, "section_id": null, "parent_id": null, "title": "T",
            "description": "", "due_date": null, "due_time": null, "priority": 1,
            "completed_at": null, "position": 1.0, "created_at": AT, "deleted_at": null}),
    );
    match task {
        Change::Task(Versioned { data: Some(d), .. }) => assert_eq!(d.board_column_id, None),
        other => panic!("not a task: {other:?}"),
    }
}

#[test]
fn v3_entities_reject_missing_and_unknown_values() {
    let missing = json!({"entity": "relation", "id": "r", "updated_at": AT, "device_id": "d",
        "data": {"from_task_id": "a", "to_task_id": "b", "created_at": AT, "deleted_at": null}});
    assert!(
        serde_json::from_value::<Change>(missing).is_err(),
        "kind is required"
    );
    let bad_kind = json!({"entity": "relation", "id": "r", "updated_at": AT, "device_id": "d",
        "data": {"from_task_id": "a", "to_task_id": "b", "kind": "duplicates",
            "created_at": AT, "deleted_at": null}});
    assert!(serde_json::from_value::<Change>(bad_kind).is_err());
    let bad_source = json!({"entity": "time_segment", "id": "r", "updated_at": AT,
        "device_id": "d", "data": {"task_id": "a", "source": "robot", "started_at": AT,
            "ended_at": null, "stop_reason": null, "note": "", "created_at": AT,
            "deleted_at": null}});
    assert!(serde_json::from_value::<Change>(bad_source).is_err());
}

#[test]
fn validate_board_columns() {
    assert!(column(&|_| {}).is_ok());
    assert!(column(&|d| d.subject_id = None).is_ok());
    assert!(column(&|d| d.name = String::new()).is_err());
    assert!(column(&|d| d.name = "   ".into()).is_err());
    assert!(column(&|d| d.position = f64::NAN).is_err());
    assert!(column(&|d| d.position = f64::INFINITY).is_err());
    assert!(column(&|d| d.subject_id = Some(String::new())).is_err());
    assert!(column(&|d| d.subject_id = Some("x".repeat(129))).is_err());
    assert!(column(&|d| d.created_at = String::new()).is_err());
}

#[test]
fn validate_time_segments() {
    assert!(segment(&|_| {}).is_ok());
    assert!(segment(&|d| d.ended_at = None).is_ok());
    assert!(segment(&|d| d.stop_reason = None).is_ok());
    assert!(segment(&|d| d.ended_at = d.started_at.clone().into()).is_ok());
    assert!(segment(&|d| d.task_id = String::new()).is_err());
    assert!(segment(&|d| d.task_id = "x".repeat(129)).is_err());
    assert!(segment(&|d| d.started_at = "2026-10-10T08:00:00Z".into()).is_err());
    assert!(segment(&|d| d.ended_at = Some("nope".into())).is_err());
    assert!(segment(&|d| d.ended_at = Some("2026-10-10T07:59:59.999Z".into())).is_err());
    for reason in [
        "waiting",
        "turn_ended",
        "session_closed",
        "task_done",
        "app_closed",
    ] {
        assert!(
            segment(&|d| d.stop_reason = Some(reason.into())).is_ok(),
            "{reason}"
        );
    }
    assert!(segment(&|d| d.stop_reason = Some("crash".into())).is_err());
    assert!(segment(&|d| d.stop_reason = Some(String::new())).is_err());
    assert!(segment(&|d| d.created_at = String::new()).is_err());
    assert!(segment(&|d| d.deleted_at = Some(String::new())).is_err());
    assert!(segment(&|d| d.note = "a".repeat(100_000)).is_ok());
}

#[test]
fn validate_relations() {
    assert!(relation(&|_| {}).is_ok());
    assert!(relation(&|d| d.kind = RelationKind::RelatesTo).is_ok());
    assert!(
        relation(&|d| d.to_task_id = "t1".into()).is_err(),
        "self relation"
    );
    assert!(relation(&|d| d.from_task_id = String::new()).is_err());
    assert!(relation(&|d| d.to_task_id = "x".repeat(129)).is_err());
    assert!(relation(&|d| d.deleted_at = Some("2026-10-10T09:00:00.000Z".into())).is_ok());
}

#[test]
fn validate_attachments() {
    assert!(attachment(&|_| {}).is_ok());
    assert!(attachment(&|d| d.file_name = String::new()).is_err());
    assert!(attachment(&|d| d.file_name = "  ".into()).is_err());
    assert!(attachment(&|d| d.file_name = "a/b.pdf".into()).is_err());
    assert!(attachment(&|d| d.file_name = "a\\b.pdf".into()).is_err());
    assert!(attachment(&|d| d.file_name = "a".repeat(255)).is_ok());
    assert!(attachment(&|d| d.file_name = "a".repeat(256)).is_err());
    // 255 bytes, not characters.
    assert!(attachment(&|d| d.file_name = "é".repeat(128)).is_err());
    assert!(attachment(&|d| d.task_id = String::new()).is_err());
    assert!(attachment(&|d| d.size = 0).is_ok());
    assert!(attachment(&|d| d.created_at = String::new()).is_err());
}

const HASH: &str = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

#[test]
fn attachment_sha256_is_optional_but_must_be_well_formed() {
    assert!(attachment(&|d| d.sha256 = None).is_ok());
    assert!(attachment(&|d| d.sha256 = Some(HASH.into())).is_ok());
    assert!(attachment(&|d| d.sha256 = Some("0".repeat(64))).is_ok());
    assert!(attachment(&|d| d.sha256 = Some("f".repeat(64))).is_ok());
    // Wrong length.
    assert!(attachment(&|d| d.sha256 = Some(String::new())).is_err());
    assert!(attachment(&|d| d.sha256 = Some("a".repeat(63))).is_err());
    assert!(attachment(&|d| d.sha256 = Some("a".repeat(65))).is_err());
    // Not lowercase hexadecimal.
    assert!(attachment(&|d| d.sha256 = Some(HASH.to_uppercase())).is_err());
    assert!(attachment(&|d| d.sha256 = Some(format!("g{}", &HASH[1..]))).is_err());
    assert!(attachment(&|d| d.sha256 = Some(format!(" {}", &HASH[1..]))).is_err());
    assert!(attachment(&|d| d.sha256 = Some(format!("{}\n", &HASH[1..]))).is_err());
    // 64 bytes but not 64 hex characters.
    assert!(attachment(&|d| d.sha256 = Some("é".repeat(32))).is_err());
}

#[test]
fn sha256_hex_helper() {
    assert!(is_sha256_hex(HASH));
    assert!(!is_sha256_hex(&HASH.to_uppercase()));
    assert!(!is_sha256_hex(&HASH[1..]));
    assert!(!is_sha256_hex(""));
}

#[test]
fn attachment_without_sha256_reads_as_none_and_is_not_written() {
    let old = v3_change(
        "attachment",
        "a1",
        json!({"task_id": "t1", "file_name": "plan.pdf", "mime_type": "application/pdf",
            "size": 1234, "created_at": AT, "deleted_at": null}),
    );
    match &old {
        Change::Attachment(Versioned { data: Some(d), .. }) => assert_eq!(d.sha256, None),
        other => panic!("not an attachment: {other:?}"),
    }
    assert!(old.validate().is_ok());
    let value = serde_json::to_value(&old).expect("ser");
    assert!(
        value["data"].get("sha256").is_none(),
        "an absent hash stays absent on the wire"
    );
    // An explicit null reads the same.
    let null_hash = v3_change(
        "attachment",
        "a1",
        json!({"task_id": "t1", "file_name": "plan.pdf", "mime_type": "application/pdf",
            "size": 1234, "sha256": null, "created_at": AT, "deleted_at": null}),
    );
    assert_eq!(null_hash, old);
}

#[test]
fn attachment_sha256_round_trips() {
    let text = json!({"entity": "attachment", "id": "a1", "updated_at": AT, "device_id": "d",
        "data": {"task_id": "t1", "file_name": "plan.pdf", "mime_type": "application/pdf",
            "size": 1234, "sha256": HASH, "created_at": AT, "deleted_at": null}})
    .to_string();
    let change: Change = round_trip(&text);
    match change {
        Change::Attachment(Versioned { data: Some(d), .. }) => {
            assert_eq!(d.sha256.as_deref(), Some(HASH));
        }
        other => panic!("not an attachment: {other:?}"),
    }
}

#[test]
fn malformed_sha256_in_json_is_refused_by_validate() {
    let bad = v3_change(
        "attachment",
        "a1",
        json!({"task_id": "t1", "file_name": "plan.pdf", "mime_type": "application/pdf",
            "size": 1234, "sha256": "NOT-A-HASH", "created_at": AT, "deleted_at": null}),
    );
    assert!(bad.validate().is_err());
}

#[test]
fn file_limits_and_chunk_size() {
    assert_eq!(MAX_CHUNK_BYTES, 8 * 1024 * 1024);
    assert_eq!(DEFAULT_MAX_FILE_BYTES, 104_857_600);
    assert_eq!(DEFAULT_ACCOUNT_QUOTA_BYTES, 2_147_483_648);
    // A chunk never exceeds the sync body limit.
    const { assert!(MAX_CHUNK_BYTES <= MAX_SYNC_BODY_BYTES) };
}

#[test]
fn file_status_round_trips() {
    let status = FileStatus {
        protocol: PROTOCOL_VERSION,
        received: 8_388_608,
        size: 62_914_560,
        complete: false,
    };
    let value = serde_json::to_value(&status).expect("ser");
    assert_eq!(
        value,
        json!({"protocol": 3, "received": 8_388_608, "size": 62_914_560, "complete": false})
    );
    let back: FileStatus = serde_json::from_value(value).expect("de");
    assert_eq!(back, status);
    // Every field is required.
    assert!(serde_json::from_value::<FileStatus>(
        json!({"protocol": 3, "received": 0, "size": 10})
    )
    .is_err());
}

#[test]
fn v3_tombstones_and_ids() {
    for entity in [
        "board_column",
        "time_segment",
        "relation",
        "attachment",
        "note_group",
        "note_page",
        "note_attachment",
    ] {
        let tomb = v3_change(entity, "x", Value::Null);
        assert!(tomb.is_tombstone());
        assert_eq!(tomb.entity().as_str(), entity);
        assert!(tomb.validate().is_ok(), "{entity}");
        let bad = v3_change(entity, "", Value::Null);
        assert!(bad.validate().is_err(), "{entity} empty id");
    }
}

#[test]
fn account_messages_round_trip() {
    let signup = SignupRequest {
        protocol: 3,
        email: "a@b.co".into(),
        password: "0123456789".into(),
        device_name: "Mac".into(),
    };
    let back: SignupRequest =
        serde_json::from_str(&serde_json::to_string(&signup).expect("ser")).expect("de");
    assert_eq!(back, signup);
    let login = LoginRequest {
        protocol: 3,
        email: "a@b.co".into(),
        password: "pw".into(),
        device_name: "Mac".into(),
    };
    assert_eq!(
        serde_json::to_value(&login).expect("ser"),
        json!({"protocol": 3, "email": "a@b.co", "password": "pw", "device_name": "Mac"})
    );
    let forgot: ForgotRequest =
        serde_json::from_value(json!({"protocol": 3, "email": "a@b.co"})).expect("forgot");
    assert_eq!(forgot.email, "a@b.co");
    let reset: ResetRequest = serde_json::from_value(
        json!({"protocol": 3, "email": "a@b.co", "code": "123456", "password": "newpassword"}),
    )
    .expect("reset");
    assert_eq!(reset.code, "123456");
    let account = AccountResponse {
        protocol: 3,
        email: "a@b.co".into(),
        created_at: AT.into(),
        email_verified: false,
    };
    let value = serde_json::to_value(&account).expect("ser");
    assert!(value.get("plan").is_none());
    assert_eq!(value["email_verified"], false);
    let back: AccountResponse = serde_json::from_value(value).expect("de");
    assert_eq!(back, account);
    // An older server does not send it: confirmed.
    let old: AccountResponse =
        serde_json::from_value(json!({"protocol": 3, "email": "a@b.co", "created_at": AT}))
            .expect("de");
    assert!(old.email_verified);
    // A login without email is refused (protocol 2 clients get unsupported_protocol first).
    assert!(serde_json::from_value::<LoginRequest>(
        json!({"protocol": 2, "password": "pw", "device_name": "Mac"})
    )
    .is_err());
}

#[test]
fn new_error_codes() {
    let cases = [
        (ErrorCode::EmailTaken, 409, "email_taken"),
        (ErrorCode::WeakPassword, 400, "weak_password"),
        (ErrorCode::BadEmail, 400, "bad_email"),
        (ErrorCode::InvalidCode, 400, "invalid_code"),
        (ErrorCode::MailUnavailable, 503, "mail_unavailable"),
    ];
    for (code, status, name) in cases {
        assert_eq!(code.http_status(), status, "{code:?}");
        assert_eq!(serde_json::to_value(code).expect("ser"), json!(name));
    }
}

#[test]
fn file_error_codes() {
    let cases = [
        (ErrorCode::FileTooLarge, 413, "file_too_large"),
        (ErrorCode::QuotaExceeded, 507, "quota_exceeded"),
        (ErrorCode::NotFound, 404, "not_found"),
        (ErrorCode::HashMismatch, 400, "hash_mismatch"),
        (ErrorCode::ChunkOffset, 409, "chunk_offset"),
    ];
    for (code, status, name) in cases {
        assert_eq!(code.http_status(), status, "{code:?}");
        assert_eq!(serde_json::to_value(code).expect("ser"), json!(name));
        let back: ErrorCode = serde_json::from_value(json!(name)).expect("de");
        assert_eq!(back, code);
    }
}

// ---------------------------------------------------------------------------
// Project notebook: note_group, note_page, note_attachment
// ---------------------------------------------------------------------------

fn note_group(f: &dyn Fn(&mut NoteGroupData)) -> Result<(), ProtoError> {
    let mut d = NoteGroupData {
        subject_id: "s1".into(),
        name: "Décisions".into(),
        position: 1.0,
        created_at: AT.into(),
    };
    f(&mut d);
    Change::NoteGroup(Versioned {
        id: "g1".into(),
        updated_at: AT.into(),
        device_id: "d".into(),
        data: Some(d),
    })
    .validate()
}

fn note_page(f: &dyn Fn(&mut NotePageData)) -> Result<(), ProtoError> {
    let mut d = NotePageData {
        subject_id: "s1".into(),
        group_id: Some("g1".into()),
        kind: "page".into(),
        title: "Style des mails".into(),
        body: "Bleu nuit".into(),
        source_task_id: None,
        pinned_at: None,
        position: 1.0,
        created_at: AT.into(),
        deleted_at: None,
    };
    f(&mut d);
    Change::NotePage(Versioned {
        id: "p1".into(),
        updated_at: AT.into(),
        device_id: "d".into(),
        data: Some(d),
    })
    .validate()
}

fn note_attachment(f: &dyn Fn(&mut NoteAttachmentData)) -> Result<(), ProtoError> {
    let mut d = NoteAttachmentData {
        note_page_id: "p1".into(),
        file_name: "maquette.png".into(),
        mime_type: "image/png".into(),
        size: 2048,
        sha256: None,
        created_at: AT.into(),
        deleted_at: None,
    };
    f(&mut d);
    Change::NoteAttachment(Versioned {
        id: "a1".into(),
        updated_at: AT.into(),
        device_id: "d".into(),
        data: Some(d),
    })
    .validate()
}

#[test]
fn note_body_limit_is_256_kib() {
    assert_eq!(MAX_NOTE_BODY_BYTES, 262_144);
    assert_eq!(MAX_NOTE_TITLE_BYTES, 500);
}

#[test]
fn notebook_entities_round_trip_as_in_the_fixture() {
    let req: SyncRequest = round_trip(V3);
    let notebook: Vec<&Change> = req
        .changes
        .iter()
        .filter(|c| c.entity().as_str().starts_with("note_"))
        .collect();
    assert_eq!(notebook.len(), 3);
    match notebook[1] {
        Change::NotePage(Versioned { data: Some(d), .. }) => {
            assert_eq!(d.kind, "summary");
            assert_eq!(d.group_id.as_deref(), Some(notebook[0].id()));
            assert!(d.body.contains("![[file:"));
        }
        other => panic!("not a page: {other:?}"),
    }
    match notebook[2] {
        Change::NoteAttachment(Versioned { data: Some(d), .. }) => {
            assert_eq!(d.note_page_id, notebook[1].id());
            assert_eq!(d.sha256.as_deref(), Some(HASH));
        }
        other => panic!("not a page image: {other:?}"),
    }
    // A page image without a hash leaves it out of the JSON, like a task's attachment.
    let text = json!({"entity": "note_attachment", "id": "a1", "updated_at": AT,
        "device_id": "d", "data": {"note_page_id": "p1", "file_name": "x.png",
        "mime_type": "image/png", "size": 1, "created_at": AT, "deleted_at": null}});
    let change: Change = serde_json::from_value(text.clone()).expect("parse");
    assert_eq!(serde_json::to_value(&change).expect("ser"), text);
}

#[test]
fn validate_note_groups() {
    assert!(note_group(&|_| {}).is_ok());
    assert!(note_group(&|d| d.name = String::new()).is_err());
    assert!(note_group(&|d| d.name = "  ".into()).is_err());
    assert!(note_group(&|d| d.subject_id = String::new()).is_err());
    assert!(note_group(&|d| d.position = f64::NAN).is_err());
    assert!(note_group(&|d| d.created_at = String::new()).is_err());
}

#[test]
fn validate_note_pages() {
    assert!(note_page(&|_| {}).is_ok());
    assert!(note_page(&|d| d.kind = "summary".into()).is_ok());
    assert!(note_page(&|d| d.group_id = None).is_ok());
    assert!(note_page(&|d| d.pinned_at = Some(AT.into())).is_ok());
    assert!(note_page(&|d| d.source_task_id = Some("t1".into())).is_ok());
    // Unknown kind.
    assert!(note_page(&|d| d.kind = "draft".into()).is_err());
    assert!(note_page(&|d| d.kind = String::new()).is_err());
    // Title: 1 to 500 bytes, not blank.
    assert!(note_page(&|d| d.title = String::new()).is_err());
    assert!(note_page(&|d| d.title = "   ".into()).is_err());
    assert!(note_page(&|d| d.title = "a".repeat(500)).is_ok());
    assert!(note_page(&|d| d.title = "a".repeat(501)).is_err());
    // Body: at most 256 KiB (bytes, not characters).
    assert!(note_page(&|d| d.body = String::new()).is_ok());
    assert!(note_page(&|d| d.body = "a".repeat(MAX_NOTE_BODY_BYTES)).is_ok());
    assert!(note_page(&|d| d.body = "a".repeat(MAX_NOTE_BODY_BYTES + 1)).is_err());
    assert!(note_page(&|d| d.body = "é".repeat(MAX_NOTE_BODY_BYTES / 2 + 1)).is_err());
    // References and stamps.
    assert!(note_page(&|d| d.subject_id = String::new()).is_err());
    assert!(note_page(&|d| d.group_id = Some(String::new())).is_err());
    assert!(note_page(&|d| d.source_task_id = Some(String::new())).is_err());
    assert!(note_page(&|d| d.pinned_at = Some(String::new())).is_err());
    assert!(note_page(&|d| d.deleted_at = Some("x".repeat(65))).is_err());
    assert!(note_page(&|d| d.position = f64::INFINITY).is_err());
}

#[test]
fn validate_note_attachments() {
    assert!(note_attachment(&|_| {}).is_ok());
    assert!(note_attachment(&|d| d.file_name = "a/b.png".into()).is_err());
    assert!(note_attachment(&|d| d.file_name = "a\\b.png".into()).is_err());
    assert!(note_attachment(&|d| d.file_name = " ".into()).is_err());
    assert!(note_attachment(&|d| d.file_name = "a".repeat(256)).is_err());
    assert!(note_attachment(&|d| d.note_page_id = String::new()).is_err());
    assert!(note_attachment(&|d| d.sha256 = Some(HASH.into())).is_ok());
    assert!(note_attachment(&|d| d.sha256 = Some(HASH.to_uppercase())).is_err());
    assert!(note_attachment(&|d| d.created_at = String::new()).is_err());
}

#[test]
fn notebook_entities_reject_missing_fields() {
    let page = json!({"entity": "note_page", "id": "p", "updated_at": AT, "device_id": "d",
        "data": {"subject_id": "s", "group_id": null, "title": "T", "body": "",
            "source_task_id": null, "pinned_at": null, "position": 1.0, "created_at": AT,
            "deleted_at": null}});
    assert!(
        serde_json::from_value::<Change>(page).is_err(),
        "kind is required"
    );
    let image = json!({"entity": "note_attachment", "id": "a", "updated_at": AT,
        "device_id": "d", "data": {"task_id": "t", "file_name": "x.png",
            "mime_type": "image/png", "size": 1, "created_at": AT, "deleted_at": null}});
    assert!(
        serde_json::from_value::<Change>(image).is_err(),
        "a page image names its page"
    );
}

// ---------------------------------------------------------------------------
// Known entities (fix round 1): the server sends a client only the entities it knows
// ---------------------------------------------------------------------------

#[test]
fn every_entity_is_listed_once_and_legacy_ones_first() {
    assert_eq!(Entity::ALL.len(), 11);
    for e in Entity::ALL {
        assert_eq!(Entity::parse(e.as_str()), Some(e));
    }
    assert_eq!(&Entity::ALL[..8], &LEGACY_ENTITIES[..]);
    for e in [Entity::NoteGroup, Entity::NotePage, Entity::NoteAttachment] {
        assert!(!LEGACY_ENTITIES.contains(&e));
    }
}

#[test]
fn known_entities_is_optional_and_left_out_when_absent() {
    let req: SyncRequest = round_trip(REQUEST);
    assert_eq!(req.known_entities, None);
    let text = serde_json::to_value(&req).expect("ser");
    assert!(text.get("known_entities").is_none(), "absent stays absent");
    let v3: SyncRequest = round_trip(V3);
    let names: Vec<&str> = Entity::ALL.iter().map(|e| e.as_str()).collect();
    assert_eq!(
        v3.known_entities
            .as_deref()
            .map(|k| k.iter().map(String::as_str).collect::<Vec<_>>()),
        Some(names)
    );
}

#[test]
fn a_client_without_known_entities_knows_the_legacy_ones() {
    assert_eq!(known_entity_set(None), LEGACY_ENTITIES.to_vec());
    let listed = vec![
        "note_page".to_string(),
        "later_thing".to_string(),
        "task".to_string(),
    ];
    let known = known_entity_set(Some(&listed));
    assert!(known.contains(&Entity::NotePage));
    assert!(!known.contains(&Entity::NoteGroup));
    // The legacy ones are always known (every protocol 3 client reads them).
    for e in LEGACY_ENTITIES {
        assert!(known.contains(&e));
    }
}

#[test]
fn account_response_tolerates_legacy_plan() {
    let legacy =
        r#"{"protocol":3,"email":"a@b.co","plan":"pro","created_at":"2026-01-01T00:00:00Z"}"#;
    let account = serde_json::from_str::<AccountResponse>(legacy).expect("legacy plan ignored");
    assert_eq!(account.email, "a@b.co");
}
