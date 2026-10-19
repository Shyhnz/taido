//! End-to-end sync (docs/SYNC.md § 9, integrator): two Mac core databases (temp files) linked
//! to the real sync server (`taido-sync-server`, in process on `127.0.0.1:<random port>`, temp
//! data dir). Every test ends by checking that both devices hold the same synced rows.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;
use taido_sync_server::{reset_epoch, start_for_tests, start_for_tests_at, TestServer};

use crate::db::{
    self, attachments, board_columns, notes, sections, subjects, tasks, terminals, time_segments,
    workspace,
};
use crate::error::{AppResult, ErrorKind};
use crate::model::{
    CreateNoteGroupInput, CreateNotePageInput, CreateSectionInput, CreateSubjectInput,
    CreateTaskInput, MoveNotePageInput, NoteKind, NoteTarget, SetCompletedInput, SetDueInput,
    SetPriorityInput, UpdateNotePageInput, UpdateSubjectInput, UpdateTaskInput,
};
use crate::sync::client::SyncClient;
use crate::sync::engine::{self, RunReport, SyncError, SyncHooks};
use crate::sync::model::{AccountInfo, AccountInput, SyncState, SyncStatus};
use crate::sync::service::{SyncEvents, SyncService};
use crate::sync::store;

pub(super) const EMAIL: &str = "user@example.com";
pub(super) const PASSWORD: &str = "un mot de passe assez long";

#[derive(Default)]
pub(super) struct Hooks {
    closed: Mutex<Vec<String>>,
}

impl SyncHooks for Hooks {
    fn close_tasks(&self, task_ids: &[String]) {
        self.closed
            .lock()
            .expect("closed")
            .extend(task_ids.iter().cloned());
    }
}

pub(super) struct NoEvents;

impl SyncEvents for NoEvents {
    fn status_changed(&self, _status: &SyncStatus) {}
    fn data_changed(&self, _conn: &Connection) {}
}

/// The server and its data dir; restartable on the same address.
pub(super) struct Server {
    dir: tempfile::TempDir,
    pub(super) running: Option<TestServer>,
    pub(super) url: String,
    /// The account of [`EMAIL`] (where the server keeps its files).
    pub(super) account_id: String,
}

impl Server {
    pub(super) async fn start() -> Server {
        let dir = tempfile::tempdir().expect("server dir");
        let running = start_for_tests(dir.path()).await.expect("start server");
        let account_id = running
            .create_account(EMAIL, PASSWORD)
            .expect("create account");
        let url = running.base_url.clone();
        Server {
            dir,
            running: Some(running),
            url,
            account_id,
        }
    }

    fn db_file(&self) -> PathBuf {
        self.dir.path().join("sync.sqlite3")
    }

    pub(super) async fn stop(&mut self) {
        if let Some(s) = self.running.take() {
            s.stop().await;
        }
    }

    pub(super) async fn restart(&mut self) {
        let addr = self.url.trim_start_matches("http://").to_string();
        let running = start_for_tests_at(self.dir.path(), &addr)
            .await
            .expect("restart server");
        assert_eq!(running.base_url, self.url);
        self.running = Some(running);
    }
}

/// One Mac: a database file, its documents folder, a client.
pub(super) struct Device {
    pub(super) db: Arc<Mutex<Connection>>,
    _dir: tempfile::TempDir,
    pub(super) docs: tempfile::TempDir,
    pub(super) client: SyncClient,
    hooks: Hooks,
}

impl Device {
    pub(super) fn new() -> Device {
        let dir = tempfile::tempdir().expect("device dir");
        let conn = db::open(&dir.path().join("todo.sqlite3")).expect("open db");
        Device {
            db: Arc::new(Mutex::new(conn)),
            _dir: dir,
            docs: tempfile::tempdir().expect("documents"),
            client: SyncClient::new(),
            hooks: Hooks::default(),
        }
    }

    pub(super) fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().expect("db lock")
    }

    pub(super) async fn link(&self, server: &Server) {
        engine::login(&self.db, &self.client, &server.url, EMAIL, PASSWORD)
            .await
            .expect("link");
    }

    pub(super) async fn run(&self) -> Result<RunReport, SyncError> {
        engine::run_once(&self.db, self.docs.path(), &self.client, &self.hooks).await
    }

    pub(super) async fn sync(&self) -> RunReport {
        self.run().await.expect("sync")
    }

    pub(super) fn pending(&self) -> u32 {
        store::pending(&self.conn()).expect("pending")
    }

    pub(super) fn project(&self, name: &str, parent: Option<&str>) -> String {
        // Taido V2.2 bis: only a group holds projects.
        if let Some(p) = parent {
            self.conn()
                .execute("UPDATE subjects SET is_group = 1 WHERE id = ?1", [p])
                .expect("group");
        }
        subjects::create(
            &self.conn(),
            &CreateSubjectInput {
                name: name.into(),
                color: None,
                root_path: None,
                parent_id: parent.map(String::from),
            },
        )
        .expect("create project")
        .id
    }

    fn section(&self, subject: &str, name: &str) -> String {
        sections::create(
            &self.conn(),
            &CreateSectionInput {
                subject_id: subject.into(),
                name: name.into(),
                subpath: None,
            },
        )
        .expect("create section")
        .id
    }

    pub(super) fn task(&self, title: &str, subject: Option<&str>, section: Option<&str>) -> String {
        tasks::create(
            &self.conn(),
            &CreateTaskInput {
                title: title.into(),
                description: None,
                subject_id: subject.map(String::from),
                section_id: section.map(String::from),
                due_date: None,
                due_time: None,
            },
        )
        .expect("create task")
        .id
    }

    pub(super) fn retitle(&self, id: &str, title: &str) {
        tasks::update(
            &self.conn(),
            &UpdateTaskInput {
                id: id.into(),
                title: Some(title.into()),
                description: None,
            },
        )
        .expect("retitle");
    }

    pub(super) fn title(&self, id: &str) -> Option<String> {
        self.text("SELECT title FROM tasks WHERE id = ?1", id)
    }

    pub(super) fn text(&self, sql: &str, id: &str) -> Option<String> {
        self.conn()
            .query_row(sql, [id], |r| r.get::<_, Option<String>>(0))
            .unwrap_or(None)
    }

    pub(super) fn exists(&self, table: &str, id: &str) -> bool {
        self.conn()
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE id = ?1"),
                [id],
                |r| r.get::<_, i64>(0),
            )
            .expect("count")
            == 1
    }

    /// Every synced column of every row, sorted: two devices in sync have equal dumps.
    pub(super) fn dump(&self) -> Vec<String> {
        let conn = self.conn();
        let mut out = Vec::new();
        let mut q = |sql: &str, n: usize| {
            let mut stmt = conn.prepare(sql).expect("prepare");
            let rows = stmt
                .query_map([], |r| {
                    let mut cols = Vec::with_capacity(n);
                    for i in 0..n {
                        let v: rusqlite::types::Value = r.get(i)?;
                        cols.push(format!("{v:?}"));
                    }
                    Ok(cols.join("|"))
                })
                .expect("query");
            for row in rows {
                out.push(row.expect("row"));
            }
        };
        q(
            "SELECT 'subject', id, name, color, parent_id, position, created_at, deleted_at, \
             is_group FROM subjects ORDER BY id",
            9,
        );
        q(
            "SELECT 'section', id, subject_id, name, position, created_at FROM sections \
             ORDER BY id",
            6,
        );
        q(
            "SELECT 'task', id, subject_id, section_id, parent_id, title, description, \
             due_date, due_time, priority, completed_at, position, created_at, deleted_at, \
             board_column_id FROM tasks ORDER BY id",
            15,
        );
        q(
            "SELECT 'setting', key, value FROM synced_settings ORDER BY key",
            3,
        );
        q(
            "SELECT 'column', id, subject_id, name, position, is_done, created_at \
             FROM board_columns ORDER BY id",
            7,
        );
        q(
            "SELECT 'segment', id, task_id, source, started_at, ended_at, stop_reason, note, \
             created_at, deleted_at FROM time_segments ORDER BY id",
            10,
        );
        q(
            "SELECT 'relation', id, from_task_id, to_task_id, kind, created_at, deleted_at \
             FROM task_relations ORDER BY id",
            7,
        );
        q(
            "SELECT 'attachment', id, task_id, note_page_id, file_name, mime_type, size, \
             sha256, created_at, deleted_at FROM attachments ORDER BY id",
            10,
        );
        q(
            "SELECT 'note_group', id, subject_id, name, position, created_at FROM note_groups \
             ORDER BY id",
            6,
        );
        q(
            "SELECT 'note_page', id, subject_id, group_id, kind, title, body, source_task_id, \
             pinned_at, position, created_at, deleted_at FROM note_pages ORDER BY id",
            12,
        );
        out
    }
}

/// Syncs both devices until neither has anything to push, then checks they are equal.
pub(super) async fn converge(a: &Device, b: &Device) {
    for _ in 0..5 {
        a.sync().await;
        b.sync().await;
        if a.pending() == 0 && b.pending() == 0 {
            break;
        }
    }
    a.sync().await;
    assert_eq!(a.pending(), 0, "A has nothing left to push");
    assert_eq!(b.pending(), 0, "B has nothing left to push");
    assert_eq!(a.dump(), b.dump(), "both devices hold the same rows");
}

/// Lets the wall clock move on, so the next edit gets a later stamp than the previous one
/// made on the other device.
async fn tick() {
    tokio::time::sleep(Duration::from_millis(5)).await;
}

#[tokio::test]
async fn projects_sections_tasks_and_folders_reach_the_other_mac() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());

    let p = a.project("Globex", None);
    let sp = a.project("Site", Some(&p));
    // Taido V2.2 bis: Globex is a group; its project holds the section and the task.
    let s = a.section(&sp, "Admin");
    let t = a.task("Facturer", Some(&sp), Some(&s));
    let child = tasks::create_child(&a.conn(), &t, "Relancer").expect("child");
    let u = a.task("Maquette", Some(&sp), None);
    {
        let conn = a.conn();
        tasks::update(
            &conn,
            &UpdateTaskInput {
                id: t.clone(),
                title: None,
                description: Some("Note **importante**".into()),
            },
        )
        .expect("note");
        tasks::set_due(
            &conn,
            &SetDueInput {
                id: t.clone(),
                date: Some("2026-10-12".into()),
                time: Some("17:00".into()),
            },
        )
        .expect("due");
        tasks::set_priority(
            &conn,
            &SetPriorityInput {
                id: t.clone(),
                priority: 3,
            },
        )
        .expect("priority");
        // Renaming the project and the sub-project last gives them the highest revisions:
        // the other Mac pulls their tasks before them and must order the apply itself.
        for (id, name) in [(&p, "Globex Labs"), (&sp, "Site web")] {
            subjects::update(
                &conn,
                &UpdateSubjectInput {
                    id: id.clone(),
                    name: Some(name.into()),
                    color: None,
                    root_path: None,
                    parent_id: None,
                },
            )
            .expect("rename");
        }
    }

    a.link(&server).await;
    let pushed = a.sync().await;
    assert_eq!(pushed.pushed, 6);
    assert_eq!(pushed.accepted, 6);
    b.link(&server).await;
    let pulled = b.sync().await;
    assert_eq!(pulled.applied, 6);
    assert_eq!(pulled.parked, 0);
    converge(&a, &b).await;

    assert_eq!(b.title(&child).as_deref(), Some("Relancer"));
    assert_eq!(
        b.text("SELECT parent_id FROM tasks WHERE id = ?1", &child)
            .as_deref(),
        Some(t.as_str())
    );
    assert_eq!(
        b.text("SELECT subject_id FROM tasks WHERE id = ?1", &u)
            .as_deref(),
        Some(sp.as_str())
    );
    assert_eq!(
        b.text("SELECT description FROM tasks WHERE id = ?1", &t)
            .as_deref(),
        Some("Note **importante**")
    );

    // The pulled group stays a group (protocol 3): no folder of its own; its project got
    // its folder on B, in B's app folder.
    let root = b.docs.path().join(workspace::FOLDER_NAME);
    assert_eq!(
        b.text(
            "SELECT CAST(is_group AS TEXT) FROM subjects WHERE id = ?1",
            &p
        )
        .as_deref(),
        Some("1")
    );
    assert!(!root.join("Globex Labs").exists());
    assert_eq!(
        b.text("SELECT root_path FROM subjects WHERE id = ?1", &p),
        None
    );
    assert!(root.join("Site web").is_dir());
    assert_eq!(
        b.text("SELECT root_path FROM subjects WHERE id = ?1", &sp),
        Some(root.join("Site web").to_string_lossy().into_owned())
    );
    // A's folder (none) is its own: local-only columns never travel.
    assert_eq!(
        a.text("SELECT root_path FROM subjects WHERE id = ?1", &p),
        None
    );
}

#[tokio::test]
async fn edits_and_completion_keep_local_only_columns() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    let p = a.project("Perso", None);
    let s = a.section(&p, "Maison");
    let t = a.task("Peindre", Some(&p), Some(&s));
    a.link(&server).await;
    b.link(&server).await;
    converge(&a, &b).await;

    // B gives the task and the section folders of its own, and a terminal with a journal.
    {
        let conn = b.conn();
        conn.execute(
            "UPDATE tasks SET workdir_override = '/tmp/b-only' WHERE id = ?1",
            [&t],
        )
        .expect("workdir");
        conn.execute("UPDATE sections SET subpath = 'b/only' WHERE id = ?1", [&s])
            .expect("subpath");
        conn.execute(
            "UPDATE subjects SET root_path = '/tmp/b-project' WHERE id = ?1",
            [&p],
        )
        .expect("root");
        terminals::insert(
            &conn,
            &terminals::NewTerminal {
                id: "term-b",
                task_id: &t,
                kind: crate::model::TerminalKind::Shell,
                command: None,
                cwd: "/tmp",
                opened_at: &db::now_utc(),
            },
            None,
        )
        .expect("terminal");
    }
    assert_eq!(b.pending(), 0, "local-only columns record nothing");

    // A edits the task, the section and the project; B completes another field.
    a.retitle(&t, "Peindre le salon");
    sections::update(
        &a.conn(),
        &crate::model::UpdateSectionInput {
            id: s.clone(),
            name: Some("Maison & jardin".into()),
            subpath: None,
        },
    )
    .expect("rename section");
    converge(&a, &b).await;
    assert_eq!(b.title(&t).as_deref(), Some("Peindre le salon"));
    assert_eq!(
        b.text("SELECT workdir_override FROM tasks WHERE id = ?1", &t)
            .as_deref(),
        Some("/tmp/b-only")
    );
    assert_eq!(
        b.text("SELECT subpath FROM sections WHERE id = ?1", &s)
            .as_deref(),
        Some("b/only")
    );
    assert_eq!(
        b.text("SELECT root_path FROM subjects WHERE id = ?1", &p)
            .as_deref(),
        Some("/tmp/b-project")
    );
    assert!(
        b.exists("terminals", "term-b"),
        "the UPSERT keeps terminals"
    );
    assert_eq!(
        a.text("SELECT workdir_override FROM tasks WHERE id = ?1", &t),
        None
    );

    // B completes the task: A sees it completed and closes nothing of its own.
    tasks::set_completed(
        &b.conn(),
        &SetCompletedInput {
            id: t.clone(),
            completed: true,
        },
    )
    .expect("complete");
    converge(&a, &b).await;
    assert!(a
        .text("SELECT completed_at FROM tasks WHERE id = ?1", &t)
        .is_some());
    assert!(a.hooks.closed.lock().expect("closed").contains(&t));
}

#[tokio::test]
async fn soft_delete_purge_and_section_delete_propagate() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    let p = a.project("Clients", None);
    let s = a.section(&p, "Devis");
    let in_section = a.task("Devis Durand", Some(&p), Some(&s));
    let loose = a.task("Appeler", Some(&p), None);
    let other = a.project("Vieux", None);
    let old_task = a.task("Archive", Some(&other), None);
    a.link(&server).await;
    b.link(&server).await;
    converge(&a, &b).await;

    // Soft delete: B sees the deletion stamp.
    tasks::delete(&a.conn(), &loose).expect("soft delete");
    converge(&a, &b).await;
    assert!(b
        .text("SELECT deleted_at FROM tasks WHERE id = ?1", &loose)
        .is_some());

    // Purge (24 h later): the tombstone removes the row on B.
    a.conn()
        .execute(
            "UPDATE tasks SET deleted_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1",
            [&loose],
        )
        .expect("backdate");
    crate::db::trash::purge(&a.conn(), chrono::Utc::now()).expect("purge");
    converge(&a, &b).await;
    assert!(!b.exists("tasks", &loose));

    // Section hard delete on B: its task stays, without section, on both.
    sections::delete(&b.conn(), &s).expect("delete section");
    converge(&a, &b).await;
    assert!(!a.exists("sections", &s));
    assert!(a.exists("tasks", &in_section));
    assert_eq!(
        a.text("SELECT section_id FROM tasks WHERE id = ?1", &in_section),
        None
    );

    // A whole project deleted and purged on B: its tasks go with it on A.
    subjects::delete(&b.conn(), &other).expect("delete project");
    b.conn()
        .execute(
            "UPDATE subjects SET deleted_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1",
            [&other],
        )
        .expect("backdate");
    crate::db::trash::purge(&b.conn(), chrono::Utc::now()).expect("purge");
    converge(&a, &b).await;
    assert!(!a.exists("subjects", &other));
    assert!(!a.exists("tasks", &old_task));
}

#[tokio::test]
async fn the_last_writer_wins_and_an_older_edit_loses() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    let t = a.task("Original", None, None);
    a.link(&server).await;
    b.link(&server).await;
    converge(&a, &b).await;

    // A edits first, B later; B syncs first, then A's older push is refused.
    a.retitle(&t, "Version A");
    tick().await;
    b.retitle(&t, "Version B");
    b.sync().await;
    let report = a.sync().await;
    assert_eq!(report.accepted, 0, "A's older edit is refused");
    assert_eq!(a.title(&t).as_deref(), Some("Version B"));
    converge(&a, &b).await;

    // A edits first again but syncs first; B's newer edit still wins.
    a.retitle(&t, "Version A2");
    tick().await;
    b.retitle(&t, "Version B2");
    a.sync().await;
    assert_eq!(b.title(&t).as_deref(), Some("Version B2"));
    converge(&a, &b).await;
    assert_eq!(a.title(&t).as_deref(), Some("Version B2"));
}

#[tokio::test]
async fn a_clock_ahead_never_beats_a_later_edit_made_after_seeing_it() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    let t = a.task("Horloge", None, None);
    a.link(&server).await;
    b.link(&server).await;
    converge(&a, &b).await;

    // A's clock runs years ahead: its edit is stamped in 2099.
    a.conn()
        .execute(
            "UPDATE sync_guard SET last_stamp = '2099-01-01T00:00:00.000Z' WHERE id = 1",
            [],
        )
        .expect("skew");
    a.retitle(&t, "Depuis A (en avance)");
    converge(&a, &b).await;
    assert_eq!(b.title(&t).as_deref(), Some("Depuis A (en avance)"));

    // B (right clock) edits after seeing A's version: its stamp follows the known one.
    b.retitle(&t, "Depuis B, plus tard");
    converge(&a, &b).await;
    assert_eq!(a.title(&t).as_deref(), Some("Depuis B, plus tard"));
}

#[tokio::test]
async fn offline_edits_on_both_sides_are_kept_then_flushed() {
    let mut server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    let p = a.project("Voyage", None);
    let t1 = a.task("Billets", Some(&p), None);
    let t2 = a.task("Valise", Some(&p), None);
    a.link(&server).await;
    b.link(&server).await;
    converge(&a, &b).await;

    server.stop().await;
    a.retitle(&t1, "Billets de train");
    let xa = a.task("Hôtel", Some(&p), None);
    b.retitle(&t2, "Valise cabine");
    let yb = b.task("Passeport", Some(&p), None);
    assert!(matches!(a.run().await, Err(SyncError::Offline(_))));
    assert!(matches!(b.run().await, Err(SyncError::Offline(_))));
    assert_eq!(a.pending(), 2, "A's outbox is kept");
    assert_eq!(b.pending(), 2, "B's outbox is kept");
    assert_eq!(
        store::last_error(&a.conn()).expect("error"),
        None,
        "offline is not an error"
    );

    server.restart().await;
    converge(&a, &b).await;
    assert_eq!(a.title(&t2).as_deref(), Some("Valise cabine"));
    assert_eq!(b.title(&t1).as_deref(), Some("Billets de train"));
    assert!(a.exists("tasks", &yb));
    assert!(b.exists("tasks", &xa));
}

#[tokio::test]
async fn linking_two_macs_with_data_merges_both() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    let pa = a.project("Projet A", None);
    let ta = a.task("Tâche A", Some(&pa), None);
    let inbox_a = a.task("Sans projet A", None, None);
    let pb = b.project("Projet B", None);
    let spb = b.project("Sous B", Some(&pb));
    let tb = b.task("Tâche B", Some(&spb), None);
    // B already had a folder of its own for its project: kept.
    b.conn()
        .execute(
            "UPDATE subjects SET root_path = '/tmp/projet-b' WHERE id = ?1",
            [&pb],
        )
        .expect("root");

    a.link(&server).await;
    a.sync().await;
    b.link(&server).await;
    b.sync().await;
    converge(&a, &b).await;
    for id in [&pa, &pb, &spb] {
        assert!(a.exists("subjects", id) && b.exists("subjects", id));
    }
    for id in [&ta, &inbox_a, &tb] {
        assert!(a.exists("tasks", id) && b.exists("tasks", id));
    }
    // A created the folder of B's project (in B's group) in its own workspace.
    let root = a.docs.path().join(workspace::FOLDER_NAME);
    assert!(root.join("Sous B").is_dir());
    assert!(!root.join("Projet B").exists(), "a group has no folder");
    assert_eq!(
        b.text("SELECT root_path FROM subjects WHERE id = ?1", &pb)
            .as_deref(),
        Some("/tmp/projet-b")
    );
}

/// Copies the server database file (and its WAL, if any) to `to`.
fn copy_db(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("backup dir");
    for suffix in ["", "-wal"] {
        let src = PathBuf::from(format!("{}{suffix}", from.display()));
        let dst = to.join(format!("sync.sqlite3{suffix}"));
        if src.exists() {
            std::fs::copy(&src, &dst).expect("copy");
        } else if dst.exists() {
            std::fs::remove_file(&dst).expect("remove");
        }
    }
}

#[tokio::test]
async fn a_restored_server_is_rebuilt_from_both_macs() {
    let mut server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    let p = a.project("Sauvegarde", None);
    let t = a.task("Avant", Some(&p), None);
    a.link(&server).await;
    b.link(&server).await;
    converge(&a, &b).await;

    // Backup of the server (stopped, as the restore procedure does).
    server.stop().await;
    let backup = tempfile::tempdir().expect("backup");
    copy_db(&server.db_file(), backup.path());
    server.restart().await;

    // Work after the backup, on both Macs.
    a.retitle(&t, "Après (A)");
    let ta = a.task("Nouvelle A", Some(&p), None);
    let pb = b.project("Projet après", None);
    let tb = b.task("Nouvelle B", Some(&pb), None);
    converge(&a, &b).await;
    let expected = a.dump();

    // Restore: stop, put the old file back (no stale WAL), new epoch, start.
    server.stop().await;
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", server.db_file().display()));
    }
    copy_db(&backup.path().join("sync.sqlite3"), server.dir.path());
    reset_epoch(server.dir.path()).expect("reset epoch");
    server.restart().await;

    let report = a.sync().await;
    assert!(report.epoch_reset, "A noticed the new epoch");
    let report = b.sync().await;
    assert!(report.epoch_reset, "B noticed the new epoch");
    converge(&a, &b).await;
    assert_eq!(a.dump(), expected, "nothing lost, newest versions kept");
    assert_eq!(a.title(&t).as_deref(), Some("Après (A)"));
    assert!(b.exists("tasks", &ta) && a.exists("tasks", &tb));

    // A third device linked now gets the whole union from the rebuilt server.
    let c = Device::new();
    c.link(&server).await;
    c.sync().await;
    assert_eq!(c.dump(), expected);
}

#[tokio::test]
async fn a_linked_mac_pulls_before_its_purge() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    let revived = a.task("Ressuscitée", None, None);
    let gone = a.task("Oubliée", None, None);
    tasks::delete(&a.conn(), &revived).expect("delete");
    tasks::delete(&a.conn(), &gone).expect("delete");
    a.conn()
        .execute(
            "UPDATE tasks SET deleted_at = '2020-01-01T00:00:00.000Z' WHERE deleted_at IS NOT NULL",
            [],
        )
        .expect("backdate");
    a.link(&server).await;
    b.link(&server).await;
    converge(&a, &b).await;

    // While A is closed, B brings one task back from the trash.
    tasks::restore(&b.conn(), &revived).expect("restore");
    b.sync().await;

    // A starts linked: no purge at startup (lib.rs); the worker's first run pulls the
    // restore, then purges what is still old in the trash and pokes the tombstone out.
    assert!(store::is_linked(&a.conn()).expect("linked"));
    let service = SyncService::with_poke_delay(
        Arc::clone(&a.db),
        a.docs.path().to_path_buf(),
        SyncClient::new(),
        Arc::new(Hooks::default()),
        Arc::new(NoEvents),
        Duration::from_millis(10),
    );
    let status = service.run().await;
    assert_eq!(status.state, SyncState::Idle);
    assert!(a.exists("tasks", &revived), "the revived task survives");
    assert_eq!(
        a.text("SELECT deleted_at FROM tasks WHERE id = ?1", &revived),
        None
    );
    assert!(!a.exists("tasks", &gone), "the old deleted task is purged");
    assert_eq!(a.pending(), 1, "its tombstone waits for the poke");
    let status = service.run().await;
    assert_eq!(status.pending, 0);
    b.sync().await;
    assert!(!b.exists("tasks", &gone));
    converge(&a, &b).await;
}

#[tokio::test]
async fn a_revoked_mac_reports_unauthorized_and_keeps_its_outbox() {
    let server = Server::start().await;
    let a = Device::new();
    a.link(&server).await;
    a.sync().await;
    server
        .running
        .as_ref()
        .expect("running")
        .set_password(EMAIL, "un autre mot de passe long")
        .expect("new password revokes devices");
    let t = a.task("Hors ligne", None, None);
    assert_eq!(a.run().await, Err(SyncError::Unauthorized));
    assert!(store::is_linked(&a.conn()).expect("linked"), "stays linked");
    assert_eq!(a.pending(), 1);
    assert!(a.exists("tasks", &t));
}

#[tokio::test]
async fn tasks_pulled_pages_before_their_project_are_parked_then_applied() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    let p = a.project("Gros projet", None);
    let n = sync_proto::MAX_PULL_CHANGES + 100;
    {
        let conn = a.conn();
        for i in 0..n {
            tasks::create(
                &conn,
                &CreateTaskInput {
                    title: format!("Tâche {i}"),
                    description: None,
                    subject_id: Some(p.clone()),
                    section_id: None,
                    due_date: None,
                    due_time: None,
                },
            )
            .expect("task");
        }
    }
    a.link(&server).await;
    a.sync().await;
    // The project's new version goes last on the server: its tasks fill the first page.
    subjects::update(
        &a.conn(),
        &UpdateSubjectInput {
            id: p.clone(),
            name: Some("Gros projet renommé".into()),
            color: None,
            root_path: None,
            parent_id: None,
        },
    )
    .expect("rename");
    a.sync().await;

    b.link(&server).await;
    let report = b.sync().await;
    // Page 1 holds only tasks (their project is missing: parked), page 2 the project and
    // the rest: the parked rows are applied with it.
    assert_eq!(report.requests, 2, "two pages");
    assert_eq!(report.parked, 0, "nothing left parked at the end");
    let count: i64 = b
        .conn()
        .query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
        .expect("count");
    assert_eq!(count, i64::try_from(n).expect("n"));
    let parked: i64 = b
        .conn()
        .query_row("SELECT COUNT(*) FROM sync_parked", [], |r| r.get(0))
        .expect("parked");
    assert_eq!(parked, 0, "every parked row was applied");
    converge(&a, &b).await;
}

#[tokio::test]
async fn a_deleted_project_wins_over_a_task_added_meanwhile() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    let p = a.project("Abandonné", None);
    a.link(&server).await;
    b.link(&server).await;
    converge(&a, &b).await;

    subjects::delete(&a.conn(), &p).expect("delete project");
    let late = b.task("Ajoutée pendant ce temps", Some(&p), None);
    a.sync().await;
    b.sync().await;
    converge(&a, &b).await;
    let deleted_at = a.text("SELECT deleted_at FROM subjects WHERE id = ?1", &p);
    assert!(deleted_at.is_some());
    assert_eq!(
        a.text("SELECT deleted_at FROM tasks WHERE id = ?1", &late),
        deleted_at,
        "« la suppression gagne »: the task shares its project's deletion"
    );

    // Restoring the project on A brings the task back on both.
    subjects::restore(&a.conn(), &p).expect("restore");
    converge(&a, &b).await;
    assert_eq!(
        b.text("SELECT deleted_at FROM tasks WHERE id = ?1", &late),
        None
    );
}

#[tokio::test]
async fn an_edit_of_a_purged_row_loses_to_its_tombstone() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    let t = a.task("Bientôt purgée", None, None);
    a.link(&server).await;
    b.link(&server).await;
    converge(&a, &b).await;

    tasks::delete(&a.conn(), &t).expect("delete");
    a.conn()
        .execute(
            "UPDATE tasks SET deleted_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1",
            [&t],
        )
        .expect("backdate");
    crate::db::trash::purge(&a.conn(), chrono::Utc::now()).expect("purge");
    a.sync().await;
    // B, not synced yet, edits the task: the tombstone is final.
    tick().await;
    b.retitle(&t, "Modifiée trop tard");
    b.sync().await;
    assert!(!b.exists("tasks", &t));
    converge(&a, &b).await;
}

#[tokio::test]
async fn a_task_moved_into_a_section_deleted_elsewhere_ends_without_section() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    let p = a.project("Rangement", None);
    let s = a.section(&p, "Bientôt supprimée");
    let t = a.task("À ranger", Some(&p), None);
    a.link(&server).await;
    b.link(&server).await;
    converge(&a, &b).await;

    sections::delete(&b.conn(), &s).expect("delete section");
    b.sync().await;
    tasks::move_task(
        &a.conn(),
        &crate::model::MoveTaskInput {
            id: t.clone(),
            subject_id: Some(p.clone()),
            section_id: Some(s.clone()),
            index: None,
        },
    )
    .expect("move");
    converge(&a, &b).await;
    assert!(!a.exists("sections", &s));
    assert_eq!(
        a.text("SELECT section_id FROM tasks WHERE id = ?1", &t),
        None
    );
    // A third device sees the same: no task points to the missing section.
    let c = Device::new();
    c.link(&server).await;
    c.sync().await;
    assert_eq!(c.dump(), a.dump());
}

/// « Sans projet » movable: the position set on one Mac
/// reaches the other, the later move wins, and both show the same top-level order.
#[tokio::test]
async fn the_inbox_position_converges_between_two_macs() {
    use crate::db::top_level::{self, TopItem};
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    a.project("Alpha", None);
    a.project("Beta", None);
    a.link(&server).await;
    b.link(&server).await;
    converge(&a, &b).await;
    assert_eq!(top_level::inbox_index(&b.conn()).expect("index"), 2);

    top_level::reorder(&a.conn(), &TopItem::Inbox, 0).expect("first on A");
    converge(&a, &b).await;
    assert_eq!(top_level::inbox_index(&b.conn()).expect("index"), 0);

    // Both move it; B moves last and wins.
    top_level::reorder(&a.conn(), &TopItem::Inbox, 2).expect("last on A");
    tick().await;
    top_level::reorder(&b.conn(), &TopItem::Inbox, 1).expect("middle on B");
    converge(&a, &b).await;
    assert_eq!(top_level::inbox_index(&a.conn()).expect("index"), 1);
    assert_eq!(
        top_level::order(&a.conn()).expect("order"),
        top_level::order(&b.conn()).expect("order")
    );
}

/// Review point 2 (V2.7): two Macs create the default columns of the same project before
/// their first sync: one set of four columns in the end.
#[tokio::test]
async fn default_columns_made_on_two_macs_are_one_set() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    let p = a.project("Globex", None);
    a.link(&server).await;
    a.sync().await;
    b.link(&server).await;
    b.sync().await;
    // Both open the board offline, then sync.
    board_columns::ensure(&a.conn(), Some(&p)).expect("columns on A");
    board_columns::ensure(&b.conn(), Some(&p)).expect("columns on B");
    board_columns::ensure(&a.conn(), None).expect("inbox on A");
    board_columns::ensure(&b.conn(), None).expect("inbox on B");
    converge(&a, &b).await;
    for device in [&a, &b] {
        let n: i64 = device
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM board_columns WHERE subject_id = ?1",
                [&p],
                |r| r.get(0),
            )
            .expect("count");
        assert_eq!(n, 4);
        let inbox: i64 = device
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM board_columns WHERE subject_id IS NULL",
                [],
                |r| r.get(0),
            )
            .expect("count");
        assert_eq!(inbox, 4);
    }
}

/// A task in « À valider » with two time segments, a relation and an attachment reaches the
/// other Mac; local-only columns stay home; purging it there removes everything here.
#[tokio::test]
async fn a_task_with_column_time_relation_and_attachment_reaches_the_other_mac() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    workspace::ensure(&a.conn(), a.docs.path()).expect("A's folder");
    workspace::ensure(&b.conn(), b.docs.path()).expect("B's folder");
    let p = a.project("Globex", None);
    let t = a.task("Facturer", Some(&p), None);
    let u = a.task("Relancer", Some(&p), None);
    let review = {
        let conn = a.conn();
        let columns = board_columns::ensure(&conn, Some(&p)).expect("columns");
        assert_eq!(columns[2].name, "À valider");
        board_columns::move_task(&conn, &t, &columns[2].id).expect("move");
        db::test_support::claude_terminal(&conn, &t, "term", "sess", "claude");
        conn.execute_batch(&format!(
            "INSERT INTO time_segments (id, task_id, agent_session_id, source, started_at, \
               ended_at, stop_reason, created_at, updated_at) VALUES \
               ('seg-1', '{t}', 'sess', 'auto', '2026-10-10T09:00:00.000Z', \
                '2026-10-10T09:20:00.000Z', 'waiting', 'c', 'c'), \
               ('seg-2', '{t}', NULL, 'manual', '2026-10-10T10:00:00.000Z', \
                '2026-10-10T10:30:00.000Z', NULL, 'c', 'c');
             INSERT INTO task_relations (id, from_task_id, to_task_id, kind, created_at, \
               updated_at) VALUES ('rel', '{u}', '{t}', 'blocks', 'c', 'c');"
        ))
        .expect("segments and relation");
        columns[2].id.clone()
    };
    let original = a.docs.path().join("devis.pdf");
    std::fs::write(&original, b"%PDF").expect("file");
    attachments::add_files(
        &a.conn(),
        attachments::AttachmentOwner::Task(&t),
        &[original.to_string_lossy().into_owned()],
    )
    .expect("attach");

    a.link(&server).await;
    a.sync().await;
    b.link(&server).await;
    b.sync().await;
    converge(&a, &b).await;

    assert_eq!(
        b.text("SELECT board_column_id FROM tasks WHERE id = ?1", &t)
            .as_deref(),
        Some(review.as_str())
    );
    assert_eq!(
        b.text("SELECT name FROM board_columns WHERE id = ?1", &review)
            .as_deref(),
        Some("À valider")
    );
    let segments: i64 = b
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM time_segments WHERE task_id = ?1 AND agent_session_id IS NULL",
            [&t],
            |r| r.get(0),
        )
        .expect("segments");
    assert_eq!(segments, 2, "the session stays on A");
    assert!(b.exists("task_relations", "rel"));
    let stored = b
        .text("SELECT stored_path FROM attachments WHERE task_id = ?1", &t)
        .expect("attachment on B");
    assert!(
        stored.starts_with(&*b.docs.path().to_string_lossy()),
        "{stored}"
    );
    assert!(stored.ends_with("devis.pdf"));
    assert!(!Path::new(&stored).exists(), "no file is made on B");
    assert_eq!(
        a.text(
            "SELECT agent_session_id FROM time_segments WHERE id = ?1",
            "seg-1"
        )
        .as_deref(),
        Some("sess")
    );

    // B purges the task: A loses its segments, relation and attachment.
    b.conn()
        .execute("DELETE FROM tasks WHERE id = ?1", [&t])
        .expect("purge on B");
    converge(&a, &b).await;
    assert!(!a.exists("tasks", &t));
    for table in ["time_segments", "task_relations", "attachments"] {
        let n: i64 = a
            .conn()
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .expect("count");
        assert_eq!(n, 0, "{table} on A");
    }
}

#[tokio::test]
async fn page_round_trips_between_two_cores() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    let p = a.project("Globex", None);
    let t = a.task("Mails transactionnels", Some(&p), None);
    let (g, page, summary) = {
        let conn = a.conn();
        let g = notes::create_group(
            &conn,
            &CreateNoteGroupInput {
                subject_id: p.clone(),
                name: "Décisions".into(),
            },
        )
        .expect("group")
        .id;
        let page = notes::create_page(
            &conn,
            &CreateNotePageInput {
                subject_id: p.clone(),
                group_id: Some(g.clone()),
                title: "Style des mails".into(),
                body: "Style « Bleu nuit » : ==validé==.\n\n- [ ] relire".into(),
                kind: NoteKind::Page,
                source_task_id: None,
            },
        )
        .expect("page")
        .id;
        let summary = notes::create_page(
            &conn,
            &CreateNotePageInput {
                subject_id: p.clone(),
                group_id: None,
                title: "Résumé".into(),
                body: format!("Fait dans [[task:{t}|Mails]]."),
                kind: NoteKind::Summary,
                source_task_id: Some(t.clone()),
            },
        )
        .expect("summary")
        .id;
        notes::move_page(
            &conn,
            &MoveNotePageInput {
                id: summary.clone(),
                target: NoteTarget::Pinned,
                index: None,
            },
        )
        .expect("pin");
        (g, page, summary)
    };

    a.link(&server).await;
    a.sync().await;
    b.link(&server).await;
    b.sync().await;
    converge(&a, &b).await;
    assert_eq!(
        b.text("SELECT group_id FROM note_pages WHERE id = ?1", &page)
            .as_deref(),
        Some(g.as_str())
    );
    assert!(b
        .text("SELECT pinned_at FROM note_pages WHERE id = ?1", &summary)
        .is_some());
    assert_eq!(
        b.text(
            "SELECT source_task_id FROM note_pages WHERE id = ?1",
            &summary
        )
        .as_deref(),
        Some(t.as_str())
    );

    // B edits the page, A sees it.
    tick().await;
    notes::update_page(
        &b.conn(),
        &UpdateNotePageInput {
            id: page.clone(),
            title: None,
            body: Some("Style « Bleu nuit » pour **tous** les mails.".into()),
        },
    )
    .expect("edit on B");
    converge(&a, &b).await;
    assert_eq!(
        a.text("SELECT body FROM note_pages WHERE id = ?1", &page)
            .as_deref(),
        Some("Style « Bleu nuit » pour **tous** les mails.")
    );

    // A deletes the group: the page stays on both, without group.
    tick().await;
    notes::delete_group(&a.conn(), &g).expect("delete group");
    converge(&a, &b).await;
    assert!(!b.exists("note_groups", &g));
    assert_eq!(
        b.text("SELECT group_id FROM note_pages WHERE id = ?1", &page),
        None
    );

    // B deletes the page: A has it deleted too (restorable there for 24 h).
    tick().await;
    notes::delete_page(&b.conn(), &page).expect("delete page");
    converge(&a, &b).await;
    assert!(a
        .text("SELECT deleted_at FROM note_pages WHERE id = ?1", &page)
        .is_some());
}

/// Starts Claude at work on `task` on this device: a session, `working`, reconciled (the
/// chrono opens a segment). Returns the segment's id.
fn start_working(device: &Device, task: &str, n: u32) -> String {
    let conn = device.conn();
    let (term, sess) = (format!("term-{n}"), format!("sess-{n}"));
    db::test_support::claude_terminal(&conn, task, &term, &sess, &format!("claude-{n}"));
    let at = db::now_utc();
    db::test_support::set_session_state(&conn, &sess, "working", None, &at);
    time_segments::reconcile(&conn, task, &at).expect("reconcile");
    conn.query_row(
        "SELECT id FROM time_segments WHERE agent_session_id = ?1 AND ended_at IS NULL",
        [&sess],
        |r| r.get(0),
    )
    .expect("running segment")
}

fn segment_end(device: &Device, id: &str) -> Option<String> {
    device.text("SELECT ended_at FROM time_segments WHERE id = ?1", id)
}

/// A Mac never stops another Mac's running segment: not at startup (crash recovery), not
/// when reconciling, not when quitting. Both Macs at work on one task both keep running.
#[tokio::test]
async fn a_running_segment_of_another_mac_is_never_stopped_here() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    let t = a.task("Facturer", None, None);
    let seg_a = start_working(&a, &t, 1);
    a.link(&server).await;
    a.sync().await;
    b.link(&server).await;
    b.sync().await;
    assert!(b.exists("time_segments", &seg_a));
    assert_eq!(segment_end(&b, &seg_a), None);

    // B starts (a crash left nothing of its own), reconciles everything, then quits.
    {
        let conn = b.conn();
        let now = db::now_utc();
        time_segments::recover_after_crash(&conn, &now).expect("recover");
        time_segments::reconcile(&conn, &t, &now).expect("reconcile");
        time_segments::reconcile_all(&conn, &now).expect("reconcile all");
        time_segments::close_all(&conn, &now, crate::model::ChronoStop::AppClosed).expect("quit");
    }
    assert_eq!(b.pending(), 0, "nothing of A's segment to push");
    converge(&a, &b).await;
    assert_eq!(segment_end(&a, &seg_a), None, "A's chrono still runs");
    assert_eq!(segment_end(&b, &seg_a), None);

    // B works on the same task too: both segments run on both Macs.
    tick().await;
    let seg_b = start_working(&b, &t, 2);
    converge(&a, &b).await;
    for device in [&a, &b] {
        assert_eq!(segment_end(device, &seg_a), None);
        assert_eq!(segment_end(device, &seg_b), None);
    }
    // Each Mac stops only its own.
    {
        let conn = a.conn();
        time_segments::close_all(&conn, &db::now_utc(), crate::model::ChronoStop::AppClosed)
            .expect("A quits");
    }
    converge(&a, &b).await;
    for device in [&a, &b] {
        assert!(segment_end(device, &seg_a).is_some());
        assert_eq!(segment_end(device, &seg_b), None);
    }
}

/// « Arrêter » from another device (docs/SYNC.md § 0.8): B stops A's running segment by hand;
/// A accepts it (no reason, nothing sent back) and opens a new segment at Claude's next turn.
/// B can then remove the stopped time, on both Macs.
#[tokio::test]
async fn another_mac_stops_a_running_segment_by_hand() {
    let server = Server::start().await;
    let (a, b) = (Device::new(), Device::new());
    let t = a.task("Facturer", None, None);
    let seg_a = start_working(&a, &t, 1);
    a.link(&server).await;
    a.sync().await;
    b.link(&server).await;
    b.sync().await;
    tick().await;
    time_segments::stop(&b.conn(), &seg_a, &db::now_utc()).expect("stop on B");
    converge(&a, &b).await;
    for device in [&a, &b] {
        assert!(segment_end(device, &seg_a).is_some());
        assert_eq!(
            device
                .text(
                    "SELECT COALESCE(stop_reason, '-') FROM time_segments WHERE id = ?1",
                    &seg_a
                )
                .as_deref(),
            Some("-")
        );
    }
    assert_eq!(
        a.text(
            "SELECT agent_session_id FROM time_segments WHERE id = ?1",
            &seg_a
        )
        .as_deref(),
        Some("sess-1"),
        "the session stays local"
    );
    assert_eq!(a.pending(), 0);
    // Claude's next turn on A: a new segment, which B sees running.
    tick().await;
    {
        let conn = a.conn();
        let at = db::now_utc();
        db::test_support::set_session_state(&conn, "sess-1", "waiting", None, &at);
        time_segments::reconcile(&conn, &t, &at).expect("reconcile");
        db::test_support::set_session_state(&conn, "sess-1", "working", None, &at);
        time_segments::reconcile(&conn, &t, &at).expect("reconcile");
    }
    let seg_new = a
        .text(
            "SELECT id FROM time_segments WHERE task_id = ?1 AND ended_at IS NULL",
            &t,
        )
        .expect("a new segment on A");
    assert_ne!(seg_new, seg_a);
    converge(&a, &b).await;
    assert!(b.exists("time_segments", &seg_new));
    assert_eq!(segment_end(&b, &seg_new), None);
    // B removes the stopped time: gone on A too.
    time_segments::delete(&b.conn(), &seg_a, &db::now_utc()).expect("remove on B");
    converge(&a, &b).await;
    assert!(a
        .text("SELECT deleted_at FROM time_segments WHERE id = ?1", &seg_a)
        .is_some());
}

/// Default columns created late on a device that never pulled the board lose to a real edit
/// made elsewhere (they go out at the epoch stamp).
#[tokio::test]
async fn late_default_columns_never_undo_a_rename() {
    let server = Server::start().await;
    let (a, c) = (Device::new(), Device::new());
    let p = a.project("Globex", None);
    a.link(&server).await;
    a.sync().await;
    c.link(&server).await;
    c.sync().await;
    assert!(c.exists("subjects", &p));
    // A opens the board, renames « À valider », syncs.
    let review = board_columns::default_id(Some(&p), 2);
    board_columns::ensure(&a.conn(), Some(&p)).expect("columns on A");
    board_columns::rename(&a.conn(), &review, "Chez le client").expect("rename");
    a.sync().await;
    // C, offline since, opens the same board later, then syncs.
    tick().await;
    board_columns::ensure(&c.conn(), Some(&p)).expect("columns on C");
    converge(&a, &c).await;
    let name = "SELECT name FROM board_columns WHERE id = ?1";
    assert_eq!(a.text(name, &review).as_deref(), Some("Chez le client"));
    assert_eq!(c.text(name, &review).as_deref(), Some("Chez le client"));
    let d = Device::new();
    d.link(&server).await;
    d.sync().await;
    assert_eq!(
        d.text(name, &review).as_deref(),
        Some("Chez le client"),
        "server"
    );
}

// ---------------------------------------------------------------------------
// Accounts (V2.7 task 7)
// ---------------------------------------------------------------------------

const NEW_EMAIL: &str = "nouveau@example.com";

fn local_keys(device: &Device) -> Vec<String> {
    local_keys_of(&device.conn())
}

/// `entity|id` of every record the server holds for the account of `email`, sorted.
fn server_keys(server: &Server, email: &str) -> Vec<String> {
    let conn =
        Connection::open_with_flags(server.db_file(), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("server db");
    let mut stmt = conn
        .prepare(
            "SELECT r.entity || '|' || r.id FROM records r JOIN accounts a \
             ON a.id = r.account_id WHERE a.email = ?1 ORDER BY 1",
        )
        .expect("prepare");
    let keys = stmt
        .query_map([email], |r| r.get::<_, String>(0))
        .expect("query")
        .collect::<Result<Vec<_>, _>>()
        .expect("keys");
    keys
}

fn kind(result: AppResult<()>) -> ErrorKind {
    result.expect_err("an error").kind()
}

#[tokio::test]
async fn a_signup_links_and_the_first_sync_sends_everything() {
    let server = Server::start().await;
    let a = Device::new();
    let p = a.project("Perso", None);
    let t = a.task("Acheter du pain", Some(&p), None);

    engine::signup(
        &a.db,
        &a.client,
        &server.url,
        " Nouveau@Example.com ",
        PASSWORD,
    )
    .await
    .expect("signup");
    assert!(store::is_linked(&a.conn()).expect("linked"));
    assert_eq!(
        store::account(&a.conn()).expect("account"),
        Some(AccountInfo {
            email: NEW_EMAIL.into(),
            // Signed up: the address is still to confirm (a link went by mail).
            email_verified: false,
        })
    );
    let queued = a.pending();
    assert_eq!(queued as usize, local_keys(&a).len(), "every row is queued");

    let report = a.sync().await;
    assert_eq!(report.pushed, queued as usize);
    assert_eq!(a.pending(), 0);
    assert_eq!(server_keys(&server, NEW_EMAIL), local_keys(&a));
    assert_eq!(a.sync().await.pushed, 0, "a second sync sends nothing");

    // The other account of the server sees none of it.
    let other = Device::new();
    other.link(&server).await;
    other.sync().await;
    assert!(!other.exists("tasks", &t));
}

#[tokio::test]
async fn a_signed_up_address_is_confirmed_from_the_mailed_link() {
    let server = Server::start().await;
    let a = Device::new();
    engine::signup(&a.db, &a.client, &server.url, NEW_EMAIL, PASSWORD)
        .await
        .expect("signup");
    let running = server.running.as_ref().expect("running");
    let wait = Duration::from_secs(5);
    assert_eq!(
        running
            .mailer()
            .wait_for_mails_to(NEW_EMAIL, 1, wait)
            .await
            .len(),
        1
    );

    // « Renvoyer le mail »: a second link, the first one no longer works.
    engine::resend_confirmation(&a.db, &a.client)
        .await
        .expect("resend");
    let mails = running.mailer().wait_for_mails_to(NEW_EMAIL, 2, wait).await;
    assert_eq!(mails.len(), 2);
    let link = taido_sync_server::mail::confirm_token_in(&mails[1].1).expect("link");
    let confirmed = reqwest::Client::new()
        .post(format!("{}/confirmer", server.url))
        .body(format!("t={link}"))
        .send()
        .await
        .expect("confirm");
    assert_eq!(confirmed.status().as_u16(), 200);

    engine::refresh_account(&a.db, &a.client).await;
    assert!(
        store::account(&a.conn())
            .expect("account")
            .expect("linked")
            .email_verified
    );
    // Then the welcome mail.
    let mails = running.mailer().wait_for_mails_to(NEW_EMAIL, 3, wait).await;
    assert_eq!(mails[2].0, taido_sync_server::mail::WELCOME_SUBJECT);
    // Confirmed: no more links are sent.
    engine::resend_confirmation(&a.db, &a.client)
        .await
        .expect("resend");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(running.mailer().mails_to(NEW_EMAIL).len(), 3);
}

/// Review point 5: the V2 database was copied from V1 and may still hold what V1's server
/// taught it (cursor, epoch, known versions, parked rows). Logging in to a new account sends
/// exactly the Mac's rows, none lost, none doubled, and a second sync sends nothing.
#[tokio::test]
async fn a_database_from_v1_logs_in_to_a_new_account_and_sends_exactly_its_rows() {
    let server = Server::start().await;
    let a = Device::new();
    let p = a.project("Summit Events", None);
    let s = a.section(&p, "Export");
    let t = a.task("Export PDF", Some(&p), Some(&s));
    let later = a.task("Relancer", None, None);
    {
        let conn = a.conn();
        conn.execute("DELETE FROM sync_outbox", [])
            .expect("V1's outbox was sent");
        store::set_cursor(&conn, 4242).expect("cursor");
        store::set_epoch(&conn, "epoch-of-the-v1-server").expect("epoch");
        let v1_stamp = "2026-09-01T10:00:00.000Z";
        for key in local_keys_of(&conn) {
            let (entity, id) = key.split_once('|').expect("key");
            store::set_known(&conn, entity, id, v1_stamp).expect("known");
        }
        // A row of V1's server waiting for its project: here, it would be applied at the
        // first pull and never reach the new account.
        let mut data = crate::sync::rows::task(&conn, &t)
            .expect("row")
            .expect("task");
        data.title = "Tâche du serveur V1".into();
        let parked = sync_proto::Change::Task(sync_proto::Versioned {
            id: "v1-task".into(),
            updated_at: v1_stamp.into(),
            device_id: "v1-phone".into(),
            data: Some(data),
        });
        conn.execute(
            "INSERT INTO sync_parked (entity, id, change) VALUES ('task', 'v1-task', ?1)",
            [serde_json::to_string(&parked).expect("json")],
        )
        .expect("parked");
    }
    // A real edit made after the copy: its outbox entry is kept as it is.
    tick().await;
    a.retitle(&later, "Relancer le client");
    assert_eq!(a.pending(), 1);

    a.link(&server).await;
    {
        let conn = a.conn();
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).expect("count") };
        assert_eq!(count("SELECT COUNT(*) FROM sync_known"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM sync_parked"), 0);
        assert_eq!(store::cursor(&conn).expect("cursor"), 0);
        let link = store::link(&conn).expect("link").expect("linked");
        assert_ne!(link.server_epoch, "epoch-of-the-v1-server");
    }

    let report = a.sync().await;
    assert_eq!(
        report.applied, 0,
        "nothing comes back from the empty account"
    );
    assert!(!a.exists("tasks", "v1-task"));
    assert_eq!(a.pending(), 0);
    assert_eq!(server_keys(&server, EMAIL), local_keys(&a));
    assert_eq!(a.title(&later).as_deref(), Some("Relancer le client"));
    let again = a.sync().await;
    assert_eq!(again.pushed, 0, "a second sync sends nothing");
    assert_eq!(again.applied, 0);

    // A second Mac on the account gets exactly the same rows.
    let b = Device::new();
    b.link(&server).await;
    converge(&a, &b).await;
    assert_eq!(server_keys(&server, EMAIL), local_keys(&a));
}

/// `entity|id` of every row the Mac syncs (live or soft-deleted), sorted.
fn local_keys_of(conn: &Connection) -> Vec<String> {
    let mut keys = Vec::new();
    for (entity, table, key) in [
        ("subject", "subjects", "id"),
        ("section", "sections", "id"),
        ("task", "tasks", "id"),
        ("setting", "synced_settings", "key"),
        ("board_column", "board_columns", "id"),
        ("time_segment", "time_segments", "id"),
        ("relation", "task_relations", "id"),
        ("attachment", "attachments WHERE task_id IS NOT NULL", "id"),
        ("note_group", "note_groups", "id"),
        ("note_page", "note_pages", "id"),
        (
            "note_attachment",
            "attachments WHERE note_page_id IS NOT NULL",
            "id",
        ),
    ] {
        let mut stmt = conn
            .prepare(&format!("SELECT {key} FROM {table}"))
            .expect("prepare");
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .expect("query");
        for id in ids {
            keys.push(format!("{entity}|{}", id.expect("id")));
        }
    }
    keys.sort();
    keys
}

#[tokio::test]
async fn a_forgotten_password_is_reset_with_the_mailed_code_then_logs_in() {
    let server = Server::start().await;
    let running = server.running.as_ref().expect("running");
    let a = Device::new();
    engine::forgot_password(&a.client, &server.url, EMAIL)
        .await
        .expect("forgot");
    let code = running
        .wait_for_code(EMAIL, 1, Duration::from_secs(5))
        .await
        .expect("mailed code");
    let new_password = "un tout nouveau mot de passe";
    let wrong = if code == "000000" { "111111" } else { "000000" };
    assert_eq!(
        kind(engine::reset_password(&a.client, &server.url, EMAIL, wrong, new_password).await),
        ErrorKind::SyncInvalidCode
    );
    engine::reset_password(&a.client, &server.url, EMAIL, &code, new_password)
        .await
        .expect("reset");

    assert_eq!(
        kind(engine::login(&a.db, &a.client, &server.url, EMAIL, PASSWORD).await),
        ErrorKind::SyncAuth,
        "the old password no longer works"
    );
    engine::login(&a.db, &a.client, &server.url, EMAIL, new_password)
        .await
        .expect("login with the new password");
    assert_eq!(
        store::account(&a.conn()).expect("account").map(|a| a.email),
        Some(EMAIL.to_string())
    );
}

#[tokio::test]
async fn every_account_error_has_its_kind() {
    let server = Server::start().await;
    let a = Device::new();
    let (db, client, url) = (&a.db, &a.client, server.url.as_str());

    assert_eq!(
        kind(engine::signup(db, client, url, EMAIL, PASSWORD).await),
        ErrorKind::SyncEmailTaken
    );
    assert_eq!(
        kind(engine::signup(db, client, url, NEW_EMAIL, "court").await),
        ErrorKind::SyncWeakPassword
    );
    assert_eq!(
        kind(engine::signup(db, client, url, "pas-une-adresse", PASSWORD).await),
        ErrorKind::SyncBadEmail
    );
    assert_eq!(
        kind(engine::login(db, client, url, EMAIL, "pas le bon mot de passe").await),
        ErrorKind::SyncAuth
    );
    assert_eq!(
        kind(engine::login(db, client, url, NEW_EMAIL, PASSWORD).await),
        ErrorKind::SyncAuth,
        "an unknown address gets the same answer"
    );
    assert_eq!(
        kind(engine::reset_password(client, url, EMAIL, "123456", PASSWORD).await),
        ErrorKind::SyncInvalidCode
    );
    assert_eq!(
        kind(engine::reset_password(client, url, EMAIL, "123456", "court").await),
        ErrorKind::SyncWeakPassword
    );
    assert_eq!(
        kind(engine::forgot_password(client, url, "pas-une-adresse").await),
        ErrorKind::SyncBadEmail
    );
    // Three codes per address, then « too many attempts ».
    for _ in 0..3 {
        engine::forgot_password(client, url, "limite@example.com")
            .await
            .expect("forgot");
    }
    assert_eq!(
        kind(engine::forgot_password(client, url, "limite@example.com").await),
        ErrorKind::SyncRateLimited
    );
    assert_eq!(
        kind(engine::login(db, client, "ftp://example.com", EMAIL, PASSWORD).await),
        ErrorKind::Invalid
    );

    // Nothing listens on this port any more.
    let closed = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        format!("http://{}", listener.local_addr().expect("addr"))
    };
    assert_eq!(
        kind(engine::login(db, client, &closed, EMAIL, PASSWORD).await),
        ErrorKind::SyncOffline
    );
    assert_eq!(
        kind(engine::forgot_password(client, &closed, EMAIL).await),
        ErrorKind::SyncOffline
    );

    // A server without e-mail sending.
    let dir = tempfile::tempdir().expect("server dir");
    let bound = taido_sync_server::bind(&taido_sync_server::Config {
        bind: "127.0.0.1:0".into(),
        data_dir: dir.path().to_path_buf(),
        static_dir: None,
    })
    .await
    .expect("bind");
    let no_mail = format!("http://{}", bound.local_addr().expect("addr"));
    let serving = tokio::spawn(bound.run(std::future::pending()));
    assert_eq!(
        kind(engine::forgot_password(client, &no_mail, EMAIL).await),
        ErrorKind::SyncMailUnavailable
    );
    serving.abort();

    assert!(
        !store::is_linked(&a.conn()).expect("linked"),
        "still unlinked"
    );
    assert_eq!(a.pending(), 0, "nothing queued by a failed link");
}

#[tokio::test]
async fn the_account_is_cached_refreshed_after_each_sync_and_forgotten_at_unlink() {
    let server = Server::start().await;
    let a = Device::new();
    let service = SyncService::with_poke_delay(
        Arc::clone(&a.db),
        a.docs.path().to_path_buf(),
        SyncClient::new(),
        Arc::new(Hooks::default()),
        Arc::new(NoEvents),
        Duration::from_millis(10),
    );
    assert_eq!(service.account().expect("account"), None);
    let status = service
        .login(&AccountInput {
            server_url: format!("{}/", server.url),
            email: EMAIL.into(),
            password: PASSWORD.into(),
        })
        .await
        .expect("login");
    assert_ne!(status.state, SyncState::Unlinked);
    assert_eq!(
        service.account().expect("account"),
        Some(AccountInfo {
            email: EMAIL.into(),
            email_verified: true,
        })
    );

    let status = service.run().await;
    assert_eq!(status.state, SyncState::Idle);
    assert_eq!(
        service.account().expect("account").map(|a| a.email),
        Some(EMAIL.to_string())
    );

    service.unlink().await.expect("unlink");
    assert_eq!(service.account().expect("account"), None);
    assert_eq!(
        store::account(&a.conn()).expect("account"),
        None,
        "nothing kept"
    );
}

/// `entity|id` of the outbox, sorted.
fn outbox_keys(device: &Device) -> Vec<String> {
    let conn = device.conn();
    let mut stmt = conn
        .prepare("SELECT entity || '|' || id || '|' || seq FROM sync_outbox ORDER BY 1")
        .expect("prepare");
    let keys = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .expect("query")
        .collect::<Result<Vec<_>, _>>()
        .expect("keys");
    keys
}

fn is_already_linked(result: AppResult<()>) -> bool {
    matches!(result, Err(crate::error::AppError::Invalid(m)) if m == engine::ALREADY_LINKED)
}

#[tokio::test]
async fn a_linked_mac_never_joins_another_account() {
    let server = Server::start().await;
    let running = server.running.as_ref().expect("running");
    running
        .create_account(NEW_EMAIL, PASSWORD)
        .expect("account B");
    let a = Device::new();
    let p = a.project("Données de A", None);
    a.task("Tâche de A", Some(&p), None);
    a.link(&server).await;
    a.sync().await;
    // A pending edit, to check the outbox is left alone.
    a.task("Pas encore envoyée", None, None);
    let link_before = store::link(&a.conn()).expect("link");
    let account_before = store::account(&a.conn()).expect("account");
    let cursor_before = store::cursor(&a.conn()).expect("cursor");
    let outbox_before = outbox_keys(&a);
    let known_before: i64 = a
        .conn()
        .query_row("SELECT COUNT(*) FROM sync_known", [], |r| r.get(0))
        .expect("known");

    assert!(is_already_linked(
        engine::login(&a.db, &a.client, &server.url, NEW_EMAIL, PASSWORD).await
    ));
    assert!(is_already_linked(
        engine::signup(&a.db, &a.client, &server.url, "autre@example.com", PASSWORD).await
    ));
    assert!(
        is_already_linked(engine::signup(&a.db, &a.client, &server.url, EMAIL, PASSWORD).await),
        "no signup while linked, even with the same address"
    );

    assert_eq!(store::link(&a.conn()).expect("link"), link_before);
    assert_eq!(store::account(&a.conn()).expect("account"), account_before);
    assert_eq!(store::cursor(&a.conn()).expect("cursor"), cursor_before);
    assert_eq!(outbox_keys(&a), outbox_before);
    let known_after: i64 = a
        .conn()
        .query_row("SELECT COUNT(*) FROM sync_known", [], |r| r.get(0))
        .expect("known");
    assert_eq!(known_after, known_before);
    assert!(
        server_keys(&server, NEW_EMAIL).is_empty(),
        "nothing reached B"
    );
    assert!(server_keys(&server, "autre@example.com").is_empty());
}

#[tokio::test]
async fn a_linked_mac_logs_in_again_to_its_own_account() {
    let server = Server::start().await;
    let a = Device::new();
    a.task("Tâche", None, None);
    a.link(&server).await;
    a.sync().await;
    let old_token = store::link(&a.conn()).expect("link").expect("linked").token;
    // Same address, other case and spaces: a re-login after a refused token.
    engine::login(
        &a.db,
        &a.client,
        &server.url,
        "  User@Example.COM ",
        PASSWORD,
    )
    .await
    .expect("re-login");
    let link = store::link(&a.conn()).expect("link").expect("linked");
    assert_ne!(link.token, old_token);
    a.sync().await;
    assert_eq!(a.pending(), 0);
    assert_eq!(server_keys(&server, EMAIL), local_keys(&a));

    // After « Se déconnecter », another account is allowed.
    engine::unlink(&a.db, &a.client).await.expect("unlink");
    engine::signup(&a.db, &a.client, &server.url, NEW_EMAIL, PASSWORD)
        .await
        .expect("signup after unlink");
}
