use super::*;
use crate::db::open_in_memory;
use crate::db::test_support::task;
use crate::model::CreateSubjectInput;

fn project(conn: &Connection, name: &str, parent: Option<&str>) -> crate::model::Subject {
    subjects::create(
        conn,
        &CreateSubjectInput {
            name: name.into(),
            color: None,
            root_path: None,
            parent_id: parent.map(str::to_string),
        },
    )
    .expect("create")
}

#[test]
fn the_app_folder_holds_every_project_and_the_tasks_without_project() {
    let conn = open_in_memory().expect("db");
    let docs = tempfile::tempdir().expect("documents");
    // Projects created before the first launch (no app folder yet) get theirs at startup.
    let globex = project(&conn, "Globex", None);
    // A group has no folder; its projects get theirs in the app's folder.
    let group = project(&conn, "Clients", None);
    conn.execute(
        "UPDATE subjects SET is_group = 1 WHERE id = ?1",
        [&group.id],
    )
    .expect("group");
    let hooli = project(&conn, "Hooli", Some(&group.id));
    assert_eq!(globex.root_path, None);
    assert_eq!(ensure(&conn, docs.path()).expect("startup"), 2);
    let root = docs.path().join(FOLDER_NAME);
    assert!(root.join(NO_PROJECT_FOLDER).is_dir());
    let get = |id: &str| subjects::get(&conn, id).expect("get").root_path;
    assert_eq!(
        get(&globex.id).as_deref(),
        Some(&*root.join("Globex").to_string_lossy())
    );
    assert_eq!(
        get(&hooli.id).as_deref(),
        Some(&*root.join("Hooli").to_string_lossy())
    );
    assert_eq!(get(&group.id), None);
    // New projects get theirs at once; a name taken by another project gets « (2) ».
    let other = project(&conn, "Globex", None);
    assert_eq!(
        other.root_path.as_deref(),
        Some(&*root.join("Globex (2)").to_string_lossy())
    );
    // Tasks without project work in « Sans projet ».
    let t = task(&conn, "Inbox", None, None);
    let detail = crate::db::tasks::detail(&conn, &t).expect("detail");
    assert_eq!(
        detail.workdir.map(|w| w.path),
        Some(root.join(NO_PROJECT_FOLDER).to_string_lossy().into_owned())
    );
    // Running it again changes nothing, and nothing but folders was written.
    assert_eq!(ensure(&conn, docs.path()).expect("again"), 0);
    let files = walk(&root);
    assert!(files.is_empty(), "files written: {files:?}");
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).expect("read").flatten() {
        let p = entry.path();
        if p.is_dir() {
            out.extend(walk(&p));
        } else {
            out.push(p);
        }
    }
    out
}

/// Migration 0009: every folder link made by hand is forgotten (nothing deleted on disk),
/// then the startup gives every project its folder in the app's folder.
#[test]
fn hand_made_folder_links_are_reset_then_rebuilt() {
    let conn = open_in_memory().expect("db");
    let docs = tempfile::tempdir().expect("documents");
    let own = tempfile::tempdir().expect("own folder");
    let p = project(&conn, "Acme Studio", None);
    conn.execute(
        "UPDATE subjects SET root_path = ?2 WHERE id = ?1",
        params![p.id, own.path().to_string_lossy()],
    )
    .expect("link");
    let t = task(&conn, "T", Some(&p.id), None);
    conn.execute(
        "UPDATE tasks SET workdir_override = '/somewhere' WHERE id = ?1",
        [&t],
    )
    .expect("override");
    conn.execute_batch(include_str!(
        "../../../migrations/0009_reset_folder_links.sql"
    ))
    .expect("reset");
    assert!(own.path().is_dir(), "nothing deleted on disk");
    ensure(&conn, docs.path()).expect("startup");
    let detail = crate::db::tasks::detail(&conn, &t).expect("detail");
    assert_eq!(
        detail.workdir.map(|w| w.path),
        Some(
            docs.path()
                .join(FOLDER_NAME)
                .join("Acme Studio")
                .to_string_lossy()
                .into_owned()
        )
    );
}
/// One project whose folder cannot be made does not stop the others.
#[test]
fn ensure_continues_after_a_failing_project() {
    let conn = open_in_memory().expect("db");
    let docs = tempfile::tempdir().expect("documents");
    let root = docs.path().join(FOLDER_NAME);
    std::fs::create_dir_all(&root).expect("root");
    // A file where the first project's folder would go.
    std::fs::write(root.join("Bad"), b"").expect("file");
    settings::set_workspace_root(&conn, &root.to_string_lossy()).expect("root setting");
    conn.execute_batch(
        "INSERT INTO subjects (id, name, color, position, created_at, updated_at) VALUES \
         ('bad', 'Bad', 'teal', 1, 't', 't'), ('good', 'Good', 'teal', 2, 't', 't');",
    )
    .expect("seed");
    assert_eq!(ensure(&conn, docs.path()).expect("ensure"), 1);
    let get = |id: &str| subjects::get(&conn, id).expect("get").root_path;
    assert_eq!(get("bad"), None);
    assert_eq!(
        get("good").as_deref(),
        Some(&*root.join("Good").to_string_lossy())
    );
}
/// A very long name (typed on the phone) gives a folder of at most 200 bytes.
#[test]
fn a_long_project_name_gives_a_short_folder() {
    let conn = open_in_memory().expect("db");
    let docs = tempfile::tempdir().expect("documents");
    ensure(&conn, docs.path()).expect("first launch");
    let name = "é".repeat(150);
    let created = project(&conn, &name, None);
    let path = PathBuf::from(created.root_path.expect("folder"));
    assert!(path.is_dir());
    let folder = path
        .file_name()
        .and_then(|n| n.to_str())
        .expect("file name")
        .to_string();
    assert!(folder.len() <= 200, "{} bytes", folder.len());
    assert_eq!(folder, "é".repeat(100));
    assert_eq!(subjects::folder_name(&"a".repeat(300)).len(), 200);
}

fn set_language(conn: &Connection, value: Option<&str>) {
    conn.execute("DELETE FROM settings WHERE key = 'language'", [])
        .expect("clear");
    if let Some(v) = value {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('language', ?1)",
            [format!("\"{v}\"")],
        )
        .expect("set");
    }
}

#[test]
fn the_inbox_folder_is_named_in_the_language_of_its_creation_and_then_kept() {
    let conn = open_in_memory().expect("db");
    let docs = tempfile::tempdir().expect("documents");
    // First launch: no language yet, so the folder waits for its first use.
    set_language(&conn, None);
    ensure(&conn, docs.path()).expect("startup");
    let root = docs.path().join(FOLDER_NAME);
    assert!(!root.join("Inbox").exists() && !root.join(NO_PROJECT_FOLDER).exists());
    // The language is chosen, then the folder is made in it.
    set_language(&conn, Some("fr"));
    let folder = no_project_folder(&conn).expect("folder").expect("root");
    assert_eq!(Path::new(&folder), root.join("Sans projet"));
    assert!(Path::new(&folder).is_dir());
    // Switching language never renames or duplicates it.
    set_language(&conn, Some("en"));
    assert_eq!(no_project_folder(&conn).expect("folder"), Some(folder));
    assert!(!root.join("Inbox").exists());
    // A new install in English gets « Inbox ».
    let fresh = open_in_memory().expect("db");
    set_language(&fresh, Some("en"));
    let other = tempfile::tempdir().expect("documents");
    ensure(&fresh, other.path()).expect("startup");
    assert!(other.path().join(FOLDER_NAME).join("Inbox").is_dir());
}

/// A French first launch: the task views are built while the window has not yet told the core
/// its language, and building them must not make the English folder.
#[test]
fn a_task_view_before_the_language_is_chosen_never_makes_the_inbox_folder() {
    let conn = open_in_memory().expect("db");
    let docs = tempfile::tempdir().expect("documents");
    set_language(&conn, None);
    ensure(&conn, docs.path()).expect("startup");
    let root = docs.path().join(FOLDER_NAME);
    // A view-model load reaches the folder of a task without project (the path is given...).
    let early = no_project_folder(&conn).expect("folder").expect("root");
    assert!(!Path::new(&early).exists(), "no folder is made yet");
    assert!(!root.join("Inbox").exists() && !root.join("Sans projet").exists());
    // ... then the window writes its language (French), and the folder is made in it.
    set_language(&conn, Some("fr"));
    let folder = no_project_folder(&conn).expect("folder").expect("root");
    assert_eq!(Path::new(&folder), root.join("Sans projet"));
    assert!(Path::new(&folder).is_dir());
    assert!(!root.join("Inbox").exists());
}
