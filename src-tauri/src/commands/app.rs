//! App-level commands.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::agents::claude_check::CHECK_TIMEOUT;
use crate::app_state::AppState;
use crate::commands::data::notify;
use crate::commands::terminals::blocking;
use crate::db::settings;
use crate::error::{AppError, AppResult};
use crate::events::DataScope;
use crate::model::{
    Agent, AgentStatus, AppStatus, Editor, NoteHit, OpenPathInput, OpenWith, SettingsPatch, TaskHit,
};
use crate::views::search;

/// Native folder picker. Async so the blocking dialog never runs on the main thread.
#[tauri::command]
#[specta::specta]
pub async fn pick_folder(app: AppHandle, title: Option<String>) -> AppResult<Option<String>> {
    let mut dialog = app.dialog().file();
    if let Some(title) = title {
        dialog = dialog.set_title(title);
    }
    let picked = dialog.blocking_pick_folder();
    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned()))
}

/// Native file picker, several files (Taido « parcourir » of the attachments).
#[tauri::command]
#[specta::specta]
pub async fn pick_files(app: AppHandle, title: Option<String>) -> AppResult<Vec<String>> {
    let mut dialog = app.dialog().file();
    if let Some(title) = title {
        dialog = dialog.set_title(title);
    }
    Ok(dialog
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect())
}

/// « Exporter les temps (CSV) »: asks where to save, writes the segments of the
/// last `days` days. Returns the file written, `None` when cancelled.
#[tauri::command]
#[specta::specta]
pub async fn export_time_csv(
    app: AppHandle,
    state: State<'_, AppState>,
    days: u32,
    file_name: String,
) -> AppResult<Option<String>> {
    let csv = {
        let conn = state.db.lock()?;
        crate::views::portfolio::time_csv(&conn, days, chrono::Local::now())?
    };
    let Some(target) = app
        .dialog()
        .file()
        .set_file_name(file_name)
        .add_filter("CSV", &["csv"])
        .blocking_save_file()
        .and_then(|p| p.into_path().ok())
    else {
        return Ok(None);
    };
    std::fs::write(&target, csv)?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

/// « Télécharger » (2026-10-10): copies an attachment's file into the Downloads folder under a
/// free name (never over a file) and returns the copy's path. A file not on this Mac yet is
/// downloaded from the server first. `not_found`, `file_not_here` (not here, no account),
/// `file_not_on_server`, `sync_offline`, `sync_auth` (token refused), `sync_server`,
/// `disk_full`, `file_write_failed`, `downloads_denied` (macOS privacy), `internal`.
//
// (Plain comment.) The folder is Tauri 2's `PathResolver::download_dir` (`$HOME/Downloads` on
// macOS), verified in tauri 2.12.1.
#[tauri::command]
#[specta::specta]
pub async fn download_attachment(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<String> {
    let downloads = app
        .path()
        .download_dir()
        .map_err(|e| AppError::Internal(format!("downloads folder: {e}")))?;
    let copy = state.sync.download_attachment(&id, &downloads).await?;
    Ok(copy.to_string_lossy().into_owned())
}

/// Shows a file selected in the Finder: the copy « Télécharger » just made. `not_found` when
/// it is not there any more, `invalid` for a relative path.
#[tauri::command]
#[specta::specta]
pub async fn reveal_path(app: AppHandle, path: String) -> AppResult<()> {
    let path = checked_path(&path)?;
    app.opener().reveal_item_in_dir(path)?;
    Ok(())
}

/// Shows an attachment selected in the Finder (or the Explorer).
#[tauri::command]
#[specta::specta]
pub async fn reveal_attachment(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    let (_, path) = crate::db::attachments::get(&*state.db.lock()?, &id)?;
    let path = checked_path(&path)?;
    app.opener().reveal_item_in_dir(path)?;
    Ok(())
}

/// Opens a folder (or file) with the file manager, VS Code or the terminal.
/// The file manager **opens** the folder itself, unlike "reveal", which shows it selected
/// in its parent (bug #11). `not_found` when the path does not exist.
//
// (Plain comment: doc comments end up in `src/bindings.ts`.) The editor is the one picked in
// « Ouvrir dans » (2026-10-11), remembered as the last used, or else the last used; an editor
// that is not installed fails as `internal` (`open -a` exits with an error).
#[tauri::command]
#[specta::specta]
pub async fn open_path(
    app: AppHandle,
    state: State<'_, AppState>,
    input: OpenPathInput,
) -> AppResult<()> {
    let path = checked_path(&input.path)?;
    let with = input.with.unwrap_or_default();
    let editor = match (with, input.editor) {
        (OpenWith::Editor, Some(editor)) => {
            let conn = state.db.lock()?;
            if settings::get(&conn)?.editor != editor {
                settings::update(
                    &conn,
                    &SettingsPatch {
                        editor: Some(editor),
                        ..Default::default()
                    },
                )?;
                notify(&app, &conn, &[DataScope::Settings], None);
            }
            editor
        }
        (OpenWith::Editor, None) => settings::get(&*state.db.lock()?)?.editor,
        (OpenWith::Finder | OpenWith::Terminal, _) => Editor::default(),
    };
    if Platform::CURRENT == Platform::Windows {
        return open_on_windows(&app, &state, &path, with, editor);
    }
    app.opener()
        .open_path(path, program(with, editor, Platform::CURRENT))?;
    Ok(())
}

/// Windows: an editor through the full path of its launcher (`code.cmd` is not found by name
/// alone), the terminal as a new PowerShell window in the folder.
fn open_on_windows(
    app: &AppHandle,
    state: &State<'_, AppState>,
    path: &str,
    with: OpenWith,
    editor: Editor,
) -> AppResult<()> {
    match with {
        OpenWith::Finder => app.opener().open_path(path, None::<&str>)?,
        OpenWith::Editor => {
            let dirs = path_dirs();
            let found = launcher(&dirs, editor, Platform::Windows)
                .ok_or_else(|| AppError::Internal(format!("{editor:?} is not installed")))?;
            app.opener()
                .open_path(path, Some(found.to_string_lossy().into_owned()))?;
        }
        OpenWith::Terminal => {
            let shell = crate::env::terminal_shell(&state.terminals.env().vars);
            let mut command = std::process::Command::new(shell);
            command.arg("-NoLogo").current_dir(path);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
                command.creation_flags(CREATE_NEW_CONSOLE);
            }
            command
                .spawn()
                .map_err(|e| AppError::Internal(format!("cannot open a terminal: {e}")))?;
        }
    }
    Ok(())
}

/// The folders of the app's `PATH`.
fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default()
}

/// The conventions « Ouvrir dans » follows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Platform {
    /// App bundles, `open -a`.
    Mac,
    /// Launchers `<name>.exe` or `<name>.cmd` on `PATH`.
    Windows,
    /// A launcher `<name>` on `PATH`.
    Other,
}

impl Platform {
    const CURRENT: Platform = if cfg!(target_os = "macos") {
        Platform::Mac
    } else if cfg!(windows) {
        Platform::Windows
    } else {
        Platform::Other
    };
}

/// Editors « Ouvrir dans » knows, in the order of its list.
const EDITORS: [Editor; 5] = [
    Editor::Vscode,
    Editor::Cursor,
    Editor::Zed,
    Editor::Windsurf,
    Editor::Sublime,
];

/// « Ouvrir dans » (2026-10-11): the editors installed here, so that the menu never offers one
/// that would fail.
//
// macOS: the app bundle in /Applications, ~/Applications or /Applications/Setapp (where
// GitHub Desktop also looks first). Elsewhere: the command line launcher on PATH.
#[tauri::command]
#[specta::specta]
pub async fn installed_editors() -> AppResult<Vec<Editor>> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let dirs: Vec<PathBuf> = if Platform::CURRENT == Platform::Mac {
        let mut dirs = vec![
            PathBuf::from("/Applications"),
            PathBuf::from("/Applications/Setapp"),
        ];
        if let Some(home) = home {
            dirs.push(home.join("Applications"));
        }
        dirs
    } else {
        path_dirs()
    };
    Ok(installed_in(&dirs, Platform::CURRENT))
}

/// The editors found in `dirs` ([`launcher`]).
fn installed_in(dirs: &[PathBuf], platform: Platform) -> Vec<Editor> {
    EDITORS
        .into_iter()
        .filter(|&editor| launcher(dirs, editor, platform).is_some())
        .collect()
}

/// Where `editor` is in `dirs`: `<App>.app` on macOS, `<name>.exe` then `<name>.cmd` on
/// Windows, the launcher `<name>` elsewhere.
fn launcher(dirs: &[PathBuf], editor: Editor, platform: Platform) -> Option<PathBuf> {
    let program = editor_program(editor, platform == Platform::Mac);
    let names: Vec<String> = match platform {
        Platform::Mac => vec![format!("{program}.app")],
        Platform::Windows => vec![format!("{program}.exe"), format!("{program}.cmd")],
        Platform::Other => vec![program.to_string()],
    };
    dirs.iter()
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .find(|p| {
            if platform == Platform::Mac {
                p.is_dir()
            } else {
                p.is_file()
            }
        })
}

/// Absolute and existing; returns the trimmed path.
fn checked_path(path: &str) -> AppResult<String> {
    let path = path.trim();
    if !Path::new(path).is_absolute() {
        return Err(AppError::Invalid(format!(
            "path to open must be absolute: {path}"
        )));
    }
    if !Path::new(path).exists() {
        return Err(AppError::NotFound(format!("path {path}")));
    }
    Ok(path.to_string())
}

/// Program passed to the opener: `open -a <app> -- <path>` on macOS, `<program> <path>`
/// elsewhere (verified in the `open` crate 5.4.4 that tauri-plugin-opener 2.7.0 calls);
/// `None` = default handler, i.e. the file manager for a folder.
fn program(with: OpenWith, editor: Editor, platform: Platform) -> Option<&'static str> {
    let macos = platform == Platform::Mac;
    match with {
        OpenWith::Finder => None,
        OpenWith::Editor => Some(editor_program(editor, macos)),
        OpenWith::Terminal if macos => Some("Terminal"),
        // Windows opens a terminal itself (`open_on_windows`); elsewhere the file manager.
        OpenWith::Terminal => None,
    }
}

/// Application name on macOS (`open -a`), command line launcher elsewhere.
fn editor_program(editor: Editor, macos: bool) -> &'static str {
    match (editor, macos) {
        (Editor::Vscode, true) => "Visual Studio Code",
        (Editor::Vscode, false) => "code",
        (Editor::Cursor, true) => "Cursor",
        (Editor::Cursor, false) => "cursor",
        (Editor::Zed, true) => "Zed",
        (Editor::Zed, false) => "zed",
        (Editor::Windsurf, true) => "Windsurf",
        (Editor::Windsurf, false) => "windsurf",
        (Editor::Sublime, true) => "Sublime Text",
        (Editor::Sublime, false) => "subl",
    }
}

/// ⌘K: tasks whose title or project matches `query` (fuzzy, case and accent insensitive),
/// open tasks first, 20 at most.
//
// Rules in `views::search`: live tasks, every query word in the title, project or section,
// ranked by where it matches, then most recently updated.
#[tauri::command]
#[specta::specta]
pub async fn search_tasks(state: State<'_, AppState>, query: String) -> AppResult<Vec<TaskHit>> {
    let conn = state.db.lock()?;
    search::search(&conn, &query)
}

/// ⌘K: the notebook pages matching `query` (title, text or project name), after the tasks.
/// With `subject_id`, the search field of that project's notebook: its pages only, all of
/// them, read whole.
#[tauri::command]
#[specta::specta]
pub async fn search_notes(
    state: State<'_, AppState>,
    query: String,
    subject_id: Option<String>,
) -> AppResult<Vec<NoteHit>> {
    let conn = state.db.lock()?;
    search::search_pages(&conn, &query, subject_id.as_deref())
}

/// Agent check (Claude Code: `claude -v`, `claude auth status`; Codex: `codex --version`,
/// `codex login status`): before the first launch, in the settings and the first-launch
/// guide. Blocking work runs off the main thread.
//
// Same binary as a launch (`TerminalService::check_agent`).
#[tauri::command]
#[specta::specta]
pub async fn check_agent(app: AppHandle, agent: Agent) -> AppResult<AgentStatus> {
    blocking(&app, move |state| {
        state.terminals.check_agent(&state.db, agent, CHECK_TIMEOUT)
    })
    .await
}

/// The agents installed on this computer (binary found, nothing run): the « + » menu of a task
/// offers only these.
#[tauri::command]
#[specta::specta]
pub async fn installed_agents(app: AppHandle) -> AppResult<Vec<Agent>> {
    blocking(&app, move |state| {
        state.terminals.installed_agents(&state.db)
    })
    .await
}

/// The task whose panel is open, `null` when none: no notification for it while
/// the window has the focus, and its notification leaves the notification center (9.6).
#[tauri::command]
#[specta::specta]
pub async fn set_open_task(state: State<'_, AppState>, task_id: Option<String>) -> AppResult<()> {
    state.notifier.set_open_task(task_id);
    Ok(())
}

/// Diagnostic tab of the settings.
#[tauri::command]
#[specta::specta]
pub async fn get_app_status(app: AppHandle) -> AppResult<AppStatus> {
    let app_version = app.package_info().version.to_string();
    let dir = |d: tauri::Result<std::path::PathBuf>| -> AppResult<String> {
        d.map(|p| p.to_string_lossy().into_owned())
            .map_err(|e| AppError::Internal(format!("app directory: {e}")))
    };
    let log_dir = dir(app.path().app_log_dir())?;
    let data_dir = dir(app.path().app_data_dir())?;
    blocking(&app, move |state| {
        let claude = state
            .terminals
            .check_agent(&state.db, Agent::Claude, CHECK_TIMEOUT)?;
        let env = state.terminals.env();
        Ok(AppStatus {
            app_version,
            claude,
            hooks_port: state.hooks_port,
            env_path: env.path().to_string(),
            env_from_login_shell: env.from_login_shell,
            log_dir,
            data_dir,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_editors_are_the_apps_or_launchers_found() {
        let apps = tempfile::tempdir().expect("tempdir");
        let user_apps = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(apps.path().join("Zed.app")).expect("zed");
        std::fs::create_dir(user_apps.path().join("Visual Studio Code.app")).expect("code");
        // A file named like a bundle is not an app; a folder is not a launcher.
        std::fs::write(apps.path().join("Cursor.app"), "").expect("cursor");
        std::fs::create_dir(apps.path().join("subl")).expect("subl dir");
        let dirs = [apps.path().to_path_buf(), user_apps.path().to_path_buf()];
        assert_eq!(
            installed_in(&dirs, Platform::Mac),
            vec![Editor::Vscode, Editor::Zed]
        );
        assert_eq!(installed_in(&dirs, Platform::Other), vec![]);
        std::fs::write(apps.path().join("windsurf"), "").expect("windsurf");
        assert_eq!(installed_in(&dirs, Platform::Other), vec![Editor::Windsurf]);
        assert_eq!(installed_in(&[], Platform::Mac), vec![]);
    }

    #[test]
    fn windows_editors_are_found_through_their_launchers() {
        let dir = tempfile::tempdir().expect("tempdir");
        let code_bin = dir.path().join("Microsoft VS Code").join("bin");
        let zed_bin = dir.path().join("Zed").join("bin");
        std::fs::create_dir_all(&code_bin).expect("mkdir");
        std::fs::create_dir_all(&zed_bin).expect("mkdir");
        std::fs::write(code_bin.join("code.cmd"), "@echo off").expect("code");
        std::fs::write(zed_bin.join("zed.exe"), "").expect("zed");
        // A bare name is not a Windows launcher.
        std::fs::write(code_bin.join("cursor"), "").expect("cursor");
        let dirs = [code_bin.clone(), zed_bin.clone()];
        assert_eq!(
            installed_in(&dirs, Platform::Windows),
            vec![Editor::Vscode, Editor::Zed]
        );
        assert_eq!(
            launcher(&dirs, Editor::Vscode, Platform::Windows),
            Some(code_bin.join("code.cmd"))
        );
        assert_eq!(
            launcher(&dirs, Editor::Zed, Platform::Windows),
            Some(zed_bin.join("zed.exe"))
        );
        assert_eq!(launcher(&dirs, Editor::Cursor, Platform::Windows), None);
    }

    #[test]
    fn checked_path_rules() {
        let dir = tempfile::tempdir().expect("tempdir");
        let existing = dir.path().to_string_lossy().into_owned();
        assert_eq!(
            checked_path(&format!(" {existing} ")).expect("ok"),
            existing
        );
        assert!(matches!(
            checked_path("relative/dir"),
            Err(AppError::Invalid(_))
        ));
        assert!(matches!(
            checked_path(&format!("{existing}/missing")),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn finder_uses_the_default_handler() {
        for platform in [Platform::Mac, Platform::Windows, Platform::Other] {
            assert_eq!(program(OpenWith::Finder, Editor::Zed, platform), None);
        }
        assert_eq!(
            program(OpenWith::Terminal, Editor::Zed, Platform::Mac),
            Some("Terminal")
        );
    }

    #[test]
    fn the_editor_of_the_settings_is_opened() {
        let cases = [
            (Editor::Vscode, "Visual Studio Code", "code"),
            (Editor::Cursor, "Cursor", "cursor"),
            (Editor::Zed, "Zed", "zed"),
            (Editor::Windsurf, "Windsurf", "windsurf"),
            (Editor::Sublime, "Sublime Text", "subl"),
        ];
        for (editor, macos_app, command) in cases {
            assert_eq!(
                program(OpenWith::Editor, editor, Platform::Mac),
                Some(macos_app)
            );
            assert_eq!(
                program(OpenWith::Editor, editor, Platform::Other),
                Some(command)
            );
        }
        assert_eq!(Editor::default(), Editor::Vscode);
    }
}
