//! The project notebook on the sync: groups, pages and
//! page images are pushed and pulled, parked, tombstoned with their cascades, and normalised
//! (N11: a page outside its project's groups goes outside any group).

use sync_proto::{Entity, NoteAttachmentData, NoteGroupData, NotePageData};

use super::fake::FakeServer;
use super::*;
use crate::db::attachments::{self, AttachmentOwner};
use crate::db::test_support::{subject, task};
use crate::db::{notes, workspace};
use crate::model::{CreateNoteGroupInput, CreateNotePageInput, NoteKind};

async fn linked() -> (FakeServer, Mac) {
    let server = FakeServer::start().await;
    let mac = Mac::new();
    mac.link(&server).await;
    mac.sync().await;
    (server, mac)
}

fn versioned<T>(id: &str, at: &str, data: T) -> Versioned<T> {
    Versioned {
        id: id.into(),
        updated_at: at.into(),
        device_id: "other-device".into(),
        data: Some(data),
    }
}

fn group_change(id: &str, at: &str, subject: &str, name: &str) -> Change {
    Change::NoteGroup(versioned(
        id,
        at,
        NoteGroupData {
            subject_id: subject.into(),
            name: name.into(),
            position: 1.0,
            created_at: at.into(),
        },
    ))
}

fn page_data(subject: &str, group: Option<&str>, at: &str) -> NotePageData {
    NotePageData {
        subject_id: subject.into(),
        group_id: group.map(String::from),
        kind: "page".into(),
        title: "Serveur et accès".into(),
        body: "Accès **SSH** : voir ==coffre==.".into(),
        source_task_id: None,
        pinned_at: None,
        position: 1.0,
        created_at: at.into(),
        deleted_at: None,
    }
}

fn page_change(id: &str, at: &str, data: NotePageData) -> Change {
    Change::NotePage(versioned(id, at, data))
}

fn image_change(id: &str, at: &str, page: &str, name: &str) -> Change {
    Change::NoteAttachment(versioned(
        id,
        at,
        NoteAttachmentData {
            note_page_id: page.into(),
            file_name: name.into(),
            mime_type: "image/png".into(),
            size: 4,
            sha256: None,
            created_at: at.into(),
            deleted_at: None,
        },
    ))
}

fn group_of(mac: &Mac, page: &str) -> Option<String> {
    mac.conn()
        .query_row(
            "SELECT group_id FROM note_pages WHERE id = ?1",
            [page],
            |r| r.get(0),
        )
        .expect("page here")
}

#[tokio::test]
async fn local_notebook_rows_are_pushed_without_local_only_columns() {
    let (server, mac) = linked().await;
    workspace::ensure(&mac.conn(), mac.docs.path()).expect("app folder");
    let (s, t, g, page, image) = {
        let conn = mac.conn();
        let s = subject(&conn, "P");
        let t = task(&conn, "T", Some(&s), None);
        let g = notes::create_group(
            &conn,
            &CreateNoteGroupInput {
                subject_id: s.clone(),
                name: "Décisions".into(),
            },
        )
        .expect("group")
        .id;
        let page = notes::create_page(
            &conn,
            &CreateNotePageInput {
                subject_id: s.clone(),
                group_id: Some(g.clone()),
                title: "Résumé".into(),
                body: "Fait.".into(),
                kind: NoteKind::Summary,
                source_task_id: Some(t.clone()),
            },
        )
        .expect("page")
        .id;
        attachments::add_data(
            &conn,
            AttachmentOwner::NotePage(&page),
            "capture.png",
            "AAEC",
        )
        .expect("image");
        let image: String = conn
            .query_row(
                "SELECT id FROM attachments WHERE note_page_id = ?1",
                [&page],
                |r| r.get(0),
            )
            .expect("image id");
        (s, t, g, page, image)
    };
    mac.sync().await;
    assert!(mac.outbox().is_empty());
    let Some(Change::NoteGroup(v)) = server.get(Entity::NoteGroup, &g) else {
        panic!("group pushed");
    };
    assert_eq!(v.data.expect("data").name, "Décisions");
    let Some(Change::NotePage(v)) = server.get(Entity::NotePage, &page) else {
        panic!("page pushed");
    };
    let d = v.data.expect("data");
    assert_eq!(
        (
            d.subject_id.as_str(),
            d.group_id.as_deref(),
            d.kind.as_str(),
            d.source_task_id.as_deref()
        ),
        (s.as_str(), Some(g.as_str()), "summary", Some(t.as_str()))
    );
    let Some(Change::NoteAttachment(v)) = server.get(Entity::NoteAttachment, &image) else {
        panic!("page image pushed as a note_attachment");
    };
    let d = v.data.expect("data");
    assert_eq!(d.note_page_id, page);
    assert_eq!(d.size, 3);
    assert!(d.sha256.is_some(), "hashed when added");
    assert!(
        server.get(Entity::Attachment, &image).is_none(),
        "never an attachment of a task"
    );
}

#[tokio::test]
async fn pulled_notebook_rows_are_applied_in_order_and_images_point_into_notes() {
    let (server, mac) = linked().await;
    workspace::ensure(&mac.conn(), mac.docs.path()).expect("app folder");
    // Children first: the image before its page, the page before its group and project.
    server.put(image_change("img", &stamp(1), "pg", "capture.png"));
    server.put(page_change(
        "pg",
        &stamp(2),
        page_data("p", Some("g"), &stamp(2)),
    ));
    server.put(group_change("g", &stamp(3), "p", "Décisions"));
    server.put(subject_change("p", &stamp(4), None, None));
    let report = mac.sync().await;
    assert_eq!(report.parked, 0);
    assert_eq!(group_of(&mac, "pg").as_deref(), Some("g"));
    let expected = mac
        .docs
        .path()
        .join(workspace::FOLDER_NAME)
        .join(attachments::FOLDER_NAME)
        .join(crate::db::subjects::folder_name("Projet p"))
        .join(attachments::NOTES_FOLDER_NAME)
        .join("capture.png");
    assert_eq!(
        mac.text("SELECT stored_path FROM attachments WHERE id = 'img'"),
        Some(expected.to_string_lossy().into_owned())
    );
    assert_eq!(
        mac.text("SELECT remote FROM attachments WHERE id = 'img'")
            .as_deref(),
        Some("missing"),
        "its file is to be downloaded"
    );
    assert!(mac.outbox().is_empty(), "nothing is sent back");
}

#[tokio::test]
async fn group_tombstone_ungroups_pages() {
    let (server, mac) = linked().await;
    server.put(subject_change("p", &stamp(1), None, None));
    server.put(group_change("g", &stamp(2), "p", "Décisions"));
    server.put(page_change(
        "pg",
        &stamp(3),
        page_data("p", Some("g"), &stamp(3)),
    ));
    mac.sync().await;
    assert_eq!(group_of(&mac, "pg").as_deref(), Some("g"));

    server.put(tombstone(Entity::NoteGroup, "g", &stamp(4)));
    let report = mac.sync().await;
    assert_eq!(report.corrected, 0);
    assert_eq!(mac.count("SELECT COUNT(*) FROM note_groups"), 0);
    assert_eq!(group_of(&mac, "pg"), None, "the page stays, without group");
    assert!(
        mac.outbox().is_empty(),
        "the page is not sent back: the device that deleted the group sends it"
    );
}

#[tokio::test]
async fn page_of_unknown_group_is_ungrouped() {
    let (server, mac) = linked().await;
    server.put(subject_change("p", &stamp(1), None, None));
    server.put(subject_change("q", &stamp(2), None, None));
    server.put(group_change("gq", &stamp(3), "q", "Ailleurs"));
    // A group that is not here (deleted elsewhere, or later): the page is applied without it.
    server.put(page_change(
        "lost",
        &stamp(4),
        page_data("p", Some("nowhere"), &stamp(4)),
    ));
    // A group of another project: N11 takes the page out of it, as a local change.
    server.put(page_change(
        "astray",
        &stamp(5),
        page_data("p", Some("gq"), &stamp(5)),
    ));
    let report = mac.sync().await;
    assert_eq!(report.corrected, 1);
    assert_eq!(group_of(&mac, "lost"), None);
    assert_eq!(group_of(&mac, "astray"), None);
    assert_eq!(mac.count("SELECT COUNT(*) FROM note_pages"), 2, "none lost");
    mac.sync().await;
    let Some(Change::NotePage(v)) = server.get(Entity::NotePage, "astray") else {
        panic!("corrected page pushed");
    };
    assert_eq!(v.data.expect("data").group_id, None);
    // The missing group arrives later: the waiting page joins it.
    server.put(group_change("nowhere", &stamp(6), "p", "Décisions"));
    mac.sync().await;
    assert_eq!(group_of(&mac, "lost").as_deref(), Some("nowhere"));
    assert_eq!(mac.count("SELECT COUNT(*) FROM sync_parked"), 0);
    assert!(mac.outbox().is_empty());
}

#[tokio::test]
async fn page_and_project_tombstones_take_their_notebook() {
    let (server, mac) = linked().await;
    server.put(subject_change("p", &stamp(1), None, None));
    server.put(group_change("g", &stamp(2), "p", "Décisions"));
    server.put(page_change(
        "pg",
        &stamp(3),
        page_data("p", Some("g"), &stamp(3)),
    ));
    server.put(page_change(
        "other",
        &stamp(4),
        page_data("p", None, &stamp(4)),
    ));
    server.put(image_change("img", &stamp(5), "pg", "a.png"));
    server.put(image_change("img2", &stamp(6), "other", "b.png"));
    mac.sync().await;
    assert_eq!(mac.count("SELECT COUNT(*) FROM attachments"), 2);

    // Another device purged the page: its image goes with it, sent as a local tombstone.
    server.put(tombstone(Entity::NotePage, "pg", &stamp(7)));
    mac.sync().await;
    assert_eq!(mac.count("SELECT COUNT(*) FROM note_pages"), 1);
    assert_eq!(mac.count("SELECT COUNT(*) FROM attachments"), 1);
    mac.sync().await;
    assert!(server
        .get(Entity::NoteAttachment, "img")
        .is_some_and(|c| c.is_tombstone()));

    // The project is purged: its group, page and image go too, each as a tombstone.
    server.put(tombstone(Entity::Subject, "p", &stamp(8)));
    mac.sync().await;
    for table in ["note_groups", "note_pages", "attachments"] {
        assert_eq!(
            mac.count(&format!("SELECT COUNT(*) FROM {table}")),
            0,
            "{table}"
        );
    }
    mac.sync().await;
    for (entity, id) in [
        (Entity::NoteGroup, "g"),
        (Entity::NotePage, "other"),
        (Entity::NoteAttachment, "img2"),
    ] {
        assert!(
            server.get(entity, id).is_some_and(|c| c.is_tombstone()),
            "{id} tombstoned"
        );
    }
    assert!(mac.outbox().is_empty());
}

#[tokio::test]
async fn a_summary_waits_for_its_task() {
    let (server, mac) = linked().await;
    server.put(subject_change("p", &stamp(1), None, None));
    let mut data = page_data("p", None, &stamp(2));
    data.kind = "summary".into();
    data.source_task_id = Some("t".into());
    server.put(page_change("sum", &stamp(2), data));
    mac.sync().await;
    assert_eq!(
        mac.text("SELECT source_task_id FROM note_pages WHERE id = 'sum'"),
        None,
        "applied without its task"
    );
    server.put(task_change(
        "t",
        &stamp(3),
        task_data(Some("p"), None, &stamp(3)),
    ));
    mac.sync().await;
    assert_eq!(
        mac.text("SELECT source_task_id FROM note_pages WHERE id = 'sum'")
            .as_deref(),
        Some("t")
    );
    assert_eq!(mac.count("SELECT COUNT(*) FROM sync_parked"), 0);
    assert!(mac.outbox().is_empty());
}

#[test]
fn re_enqueue_queues_the_notebook() {
    let conn = crate::db::open_in_memory().expect("db");
    let s = subject(&conn, "P");
    let g = notes::create_group(
        &conn,
        &CreateNoteGroupInput {
            subject_id: s.clone(),
            name: "Décisions".into(),
        },
    )
    .expect("group")
    .id;
    let page = notes::create_page(
        &conn,
        &CreateNotePageInput {
            subject_id: s,
            group_id: None,
            title: "Accès".into(),
            body: String::new(),
            kind: NoteKind::Page,
            source_task_id: None,
        },
    )
    .expect("page")
    .id;
    conn.execute(
        "INSERT INTO attachments (id, note_page_id, file_name, stored_path, mime_type, size, \
         created_at, updated_at) VALUES ('img', ?1, 'a.png', '/x/a.png', 'image/png', 1, 'c', 'c')",
        [&page],
    )
    .expect("image");
    conn.execute("DELETE FROM sync_outbox", []).expect("clear");
    crate::sync::engine::re_enqueue(&conn).expect("re-enqueue");
    let mut stmt = conn
        .prepare("SELECT entity || '|' || id FROM sync_outbox ORDER BY 1")
        .expect("prepare");
    let keys: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows");
    assert!(keys.contains(&format!("note_group|{g}")), "{keys:?}");
    assert!(keys.contains(&format!("note_page|{page}")), "{keys:?}");
    assert!(
        keys.contains(&"note_attachment|img".to_string()),
        "{keys:?}"
    );
    assert!(!keys.contains(&"attachment|img".to_string()), "{keys:?}");
}

// ---------------------------------------------------------------------------
// Fix round 1: declared entities, tolerant pull, cursor reset when the set grows
// ---------------------------------------------------------------------------

fn all_names() -> Vec<String> {
    Entity::ALL.iter().map(|e| e.as_str().to_string()).collect()
}

#[tokio::test]
async fn the_mac_declares_every_entity_it_knows() {
    let (server, mac) = linked().await;
    mac.sync().await;
    let requests = server.state().requests.clone();
    assert!(!requests.is_empty());
    for request in &requests {
        assert_eq!(request.known_entities, Some(all_names()));
    }
}

#[tokio::test]
async fn a_response_with_an_unknown_entity_is_applied_without_error() {
    let (server, mac) = linked().await;
    server.state().script.push_back(super::fake::Scripted::Raw(
        200,
        "application/json",
        r#"{"protocol":3,"server_epoch":"epoch-1","cursor":7,"has_more":false,
            "rejected":[],"accepted":0,"server_time":"2026-10-14T10:00:00.000Z",
            "changes":[
              {"entity":"later_thing","id":"x1","updated_at":"2026-10-14T09:00:00.000Z",
               "device_id":"other-device","data":{"anything":true}},
              {"entity":"subject","id":"p","updated_at":"2026-10-14T09:00:00.000Z",
               "device_id":"other-device","data":{"name":"Projet p","color":"teal",
               "parent_id":null,"position":1.0,"created_at":"2026-10-14T09:00:00.000Z",
               "deleted_at":null,"is_group":false}},
              {"entity":"later_thing","id":"x2","updated_at":"2026-10-14T09:00:00.000Z",
               "device_id":"other-device","data":null}
            ]}"#,
    ));
    let report = mac.sync().await;
    assert_eq!(report.applied, 1);
    assert_eq!(mac.count("SELECT COUNT(*) FROM subjects WHERE id = 'p'"), 1);
    assert_eq!(mac.count("SELECT COUNT(*) FROM sync_parked"), 0);
}

#[tokio::test]
async fn a_grown_entity_set_pulls_again_from_the_start_once() {
    let (server, mac) = linked().await;
    // Rows the server held back while this Mac was an older build.
    server.put(subject_change("p", &stamp(1), None, None));
    mac.sync().await;
    let cursor = crate::sync::store::cursor(&mac.conn()).expect("cursor");
    assert!(cursor > 0);
    assert_eq!(
        crate::db::settings::read::<Vec<String>>(&mac.conn(), crate::sync::store::KNOWN_ENTITIES)
            .expect("read"),
        Some(all_names()),
        "the declared set is kept"
    );

    // As if the previous build declared only the legacy entities.
    let legacy: Vec<String> = sync_proto::LEGACY_ENTITIES
        .iter()
        .map(|e| e.as_str().to_string())
        .collect();
    crate::db::settings::write(&mac.conn(), crate::sync::store::KNOWN_ENTITIES, &legacy)
        .expect("write");
    server.state().requests.clear();
    mac.sync().await;
    let first = server.state().requests[0].cursor;
    assert_eq!(first, 0, "the first pull after the set grew starts from 0");
    assert_eq!(
        crate::db::settings::read::<Vec<String>>(&mac.conn(), crate::sync::store::KNOWN_ENTITIES)
            .expect("read"),
        Some(all_names())
    );

    // Once only.
    server.state().requests.clear();
    mac.sync().await;
    assert!(server.state().requests[0].cursor > 0);

    // A Mac upgraded from a build that stored no set at all also starts again once.
    crate::db::settings::remove(&mac.conn(), crate::sync::store::KNOWN_ENTITIES).expect("rm");
    server.state().requests.clear();
    mac.sync().await;
    assert_eq!(server.state().requests[0].cursor, 0);
}

#[tokio::test]
async fn the_fake_server_holds_notebook_rows_back_from_old_clients() {
    // Mirrors the real server (docs/SYNC.md § 0.1), so the core tests see what a Mac sees.
    let (server, mac) = linked().await;
    server.put(subject_change("p", &stamp(1), None, None));
    server.put(group_change("g", &stamp(2), "p", "Décisions"));
    mac.sync().await;
    assert_eq!(mac.count("SELECT COUNT(*) FROM note_groups"), 1);
}

/// Rows pulled from another device (a task renamed or deleted, a page changed) refresh the
/// notebooks too: link chips and « Mentionné dans » read tasks and pages.
#[test]
fn pulled_rows_refresh_the_notebooks() {
    assert!(crate::sync::SYNC_APPLIED_SCOPES.contains(&crate::events::DataScope::Notes));
    assert!(crate::sync::SYNC_APPLIED_SCOPES.contains(&crate::events::DataScope::Tasks));
}
