mod agents;
mod app_state;
mod ask;
mod commands;
mod db;
mod env;
mod error;
mod events;
mod hooks;
mod i18n;
mod mcp;
mod model;
mod notify;
mod paths;
mod pty;
mod session_service;
mod state;
mod summarizer;
mod sync;
mod terminal_service;
mod views;
mod voice;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;
#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_specta::{collect_commands, collect_events, Builder, ErrorHandlingMode, Event};

use crate::app_state::AppState;
use crate::events::{
    CountsChanged, DataChanged, DataScope, NotificationOpened, QuitRequested, TerminalExited,
};
use crate::model::TerminalInfo;
use crate::notify::Notifier;
use crate::pty::{ExitHook, PtyManager, DEFAULT_BUFFER_BYTES};
use crate::session_service::{Flush, FlushSink, SessionService, Timing};
use crate::terminal_service::TerminalService;

/// Menu item replacing the predefined « Quit »: ⌘Q goes through the UI's confirmation.
#[cfg(target_os = "macos")]
const QUIT_MENU_ID: &str = "app-quit";

/// Tauri-specta builder: the single list of commands and events exposed to the UI.
fn specta_builder() -> Builder<tauri::Wry> {
    use commands::{app, data, sync, terminals, voice};
    Builder::<tauri::Wry>::new()
        .error_handling(ErrorHandlingMode::Throw)
        .commands(collect_commands![
            data::list_subjects,
            data::create_subject,
            data::update_subject,
            data::delete_subject,
            data::restore_subject,
            data::reorder_subject,
            data::get_inbox_index,
            data::reorder_inbox,
            data::create_section,
            data::update_section,
            data::delete_section,
            data::reorder_section,
            data::notebook,
            data::get_note_page,
            data::create_note_group,
            data::update_note_group,
            data::delete_note_group,
            data::reorder_note_group,
            data::create_note_page,
            data::update_note_page,
            data::move_note_page,
            data::pin_note_page,
            data::duplicate_note_page,
            data::delete_note_page,
            data::restore_note_page,
            data::note_page_backlinks,
            data::task_note_mentions,
            data::list_note_attachments,
            data::add_note_attachments,
            data::add_note_attachment_data,
            data::delete_note_attachment,
            data::copy_note_attachment,
            data::prune_note_images,
            data::attachment_info,
            data::get_view,
            data::get_counts,
            data::get_task,
            data::create_task,
            data::update_task,
            data::set_task_due,
            data::set_task_workdir_override,
            data::set_task_completed,
            data::set_task_priority,
            data::delete_task,
            data::restore_task,
            data::reschedule_overdue,
            data::duplicate_task,
            data::move_task,
            data::add_subtask,
            data::update_subtask,
            data::toggle_subtask,
            data::delete_subtask,
            data::reorder_subtask,
            data::add_note,
            data::list_journal,
            data::get_settings,
            data::update_settings,
            app::pick_folder,
            app::open_path,
            app::installed_editors,
            data::relation_candidates,
            app::search_tasks,
            app::search_notes,
            app::check_agent,
            app::installed_agents,
            app::get_app_status,
            app::set_open_task,
            terminals::open_terminal,
            terminals::list_terminals,
            terminals::write_terminal,
            terminals::resize_terminal,
            terminals::detach_terminal,
            terminals::close_terminal,
            terminals::set_task_folder,
            terminals::quit_app,
            terminals::interrupt_agent,
            terminals::get_hook_events,
            terminals::list_task_sessions,
            terminals::get_session_exchanges,
            terminals::resume_session,
            terminals::rename_session,
            data::add_manual_time,
            data::get_board,
            data::get_dashboard,
            data::get_portfolio,
            app::export_time_csv,
            data::add_attachments,
            data::add_attachment_data,
            data::delete_attachment,
            data::attachment_preview,
            data::add_relation,
            data::delete_relation,
            app::pick_files,
            app::download_attachment,
            app::reveal_path,
            app::reveal_attachment,
            data::group_projects,
            data::ungroup_projects,
            data::dissolve_group,
            data::move_task_to_column,
            data::create_board_column,
            data::rename_board_column,
            data::move_board_column,
            data::delete_board_column,
            data::delete_time_segment,
            data::stop_time_segment,
            sync::sync_status,
            sync::sync_now,
            sync::sync_signup,
            sync::sync_login,
            sync::sync_forgot_password,
            sync::sync_resend_confirmation,
            sync::sync_reset_password,
            sync::sync_account,
            sync::sync_unlink,
            sync::sync_set_interval,
            voice::voice_status,
            voice::voice_download_model,
            voice::voice_start,
            voice::voice_stop,
            voice::voice_cancel,
            voice::voice_open_mic_settings,
            commands::ask::ask_overview,
            commands::ask::ask_thread,
            commands::ask::ask_project,
            commands::ask::open_ask_terminal,
            commands::ask::ask_stop,
            commands::ask::ask_save_note,
            commands::ask::ask_make_task,
            commands::ask::ask_file_path,
        ])
        .events(collect_events![
            events::DataChanged,
            events::CountsChanged,
            events::TerminalExited,
            events::QuitRequested,
            events::TaskStateChanged,
            events::SyncChanged,
            events::NotificationOpened,
            events::VoiceChanged,
            events::VoiceLevel,
            events::AskUpdated
        ])
        // Returned by `attach_terminal`, which is outside the generated commands.
        .typ::<model::TerminalSize>()
}

/// Records every 30 s that the app is alive, so that the next launch stops the
/// chronos a crash left running at the last beat. Ends with the database.
fn start_heartbeat(db: std::sync::Weak<Mutex<rusqlite::Connection>>) {
    let spawned = std::thread::Builder::new()
        .name("chrono-heartbeat".into())
        .spawn(move || loop {
            let Some(db) = db.upgrade() else { return };
            match db.lock() {
                Ok(conn) => {
                    if let Err(e) = db::time_segments::beat(&conn, &db::now_utc()) {
                        log::warn!("chrono heartbeat failed: {e}");
                    }
                }
                Err(e) => log::warn!("chrono heartbeat: database lock poisoned: {e}"),
            }
            drop(db);
            std::thread::sleep(std::time::Duration::from_secs(
                db::time_segments::HEARTBEAT_SECS,
            ));
        });
    if let Err(e) = spawned {
        log::warn!("cannot start the chrono heartbeat: {e}");
    }
}

/// Commands outside tauri-specta (raw-bytes channel, see `commands/terminals.rs`).
fn raw_handler(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool =
        tauri::generate_handler![commands::terminals::attach_terminal];
    handler(invoke)
}

/// Writes `src/bindings.ts`. Run by `cargo test export_bindings` and on every debug start.
pub fn export_bindings() -> Result<(), String> {
    specta_builder()
        .export(
            specta_typescript::Typescript::default()
                .header("// @ts-nocheck\n// Generated by tauri-specta. Do not edit.\n"),
            concat!(env!("CARGO_MANIFEST_DIR"), "/../src/bindings.ts"),
        )
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = specta_builder();
    #[cfg(debug_assertions)]
    if let Err(e) = export_bindings() {
        eprintln!("failed to export TypeScript bindings: {e}");
    }

    let app_builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    // Windows notifications go through Tauri's plugin (see notify/windows.rs).
    #[cfg(windows)]
    let app_builder = app_builder.plugin(tauri_plugin_notification::init());
    let app_builder = app_builder.invoke_handler({
        // `attach_terminal` takes a raw-bytes channel that specta cannot describe: it is
        // routed outside the generated handler (see commands/terminals.rs).
        let typed = builder.invoke_handler();
        move |invoke: tauri::ipc::Invoke<tauri::Wry>| {
            if invoke.message.command() == "attach_terminal" {
                raw_handler(invoke)
            } else {
                typed(invoke)
            }
        }
    });
    // The macOS menu bar. Windows gets none: a menu would sit inside the window.
    #[cfg(target_os = "macos")]
    let app_builder = app_builder
        .menu(|app| app_menu(app, i18n::Language::En))
        .on_menu_event(|app, event| {
            if event.id() == QUIT_MENU_ID {
                request_quit(app);
            }
        });
    app_builder
        .on_window_event(|window, event| match event {
            // Closing the window keeps the app and its sessions running; the Dock
            // icon brings it back. Windows has no Dock: closing quits, through the same
            // confirmation as ⌘Q.
            WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                api.prevent_close();
                if cfg!(target_os = "macos") {
                    if let Err(e) = window.hide() {
                        log::warn!("cannot hide the window: {e}");
                    }
                } else {
                    request_quit(window.app_handle());
                }
            }
            // No notification for the open task while the window has the focus.
            WindowEvent::Focused(focused) if window.label() == "main" => {
                if let Some(state) = window.try_state::<AppState>() {
                    state.notifier.set_focused(*focused);
                }
            }
            _ => {}
        })
        .setup(move |app| {
            builder.mount_events(app);
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join(db::v1_upgrade::DB_FILE);
            // Taido V2 replaces V1 in place: a V1 database is saved, unlinked, migrated.
            let conn = db::v1_upgrade::open(&db_path)?;
            sync::check_triggers(&conn);
            // Chronos a crash left running stop at the last heartbeat.
            match db::time_segments::recover_after_crash(&conn, &db::now_utc()) {
                Ok(0) => {}
                Ok(n) => log::warn!("stopped {n} chrono segments left running by a crash"),
                Err(e) => log::warn!("stopping crashed chrono segments failed: {e}"),
            }
            match db::terminals::close_orphans(&conn) {
                Ok(0) => {}
                Ok(n) => log::warn!("closed {n} terminals left open by a crash"),
                Err(e) => log::warn!("closing orphan terminals failed: {e}"),
            }
            match db::terminals::settle_stale_sessions(&conn) {
                Ok(0) => {}
                Ok(n) => log::warn!("settled {n} sessions left live without an open terminal"),
                Err(e) => log::warn!("settling stale sessions failed: {e}"),
            }
            // The app's folder goes in the home folder (`~/Taido`), outside the folders macOS
            // protects (Documents, Desktop, Downloads): no permission prompt.
            let home = app
                .path()
                .home_dir()
                .unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap_or_default()));
            match db::workspace::ensure(&conn, &home) {
                Ok(0) => {}
                Ok(n) => log::info!("created the folders of {n} projects"),
                Err(e) => log::warn!("preparing the app's folder failed: {e}"),
            }
            if let Err(e) = db::terminals::purge_hook_events(&conn, chrono::Utc::now()) {
                log::warn!("purge of hook events failed: {e}");
            }
            // Linked: the sync worker purges after its first successful run, so that a row
            // revived on another device while the Mac was closed is pulled first (§ 3.2).
            let linked = sync::store::is_linked(&conn).unwrap_or_else(|e| {
                log::warn!("cannot read the sync link: {e}");
                false
            });
            if !linked {
                match db::trash::purge_rows(&conn, chrono::Utc::now()) {
                    Ok((p, files)) => {
                        log::info!(
                            "purged {} deleted subjects, {} deleted tasks and {} deleted note pages",
                            p.subjects,
                            p.tasks,
                            p.pages
                        );
                        // Hashed before removal (an edited copy stays): off the setup thread.
                        if !files.is_empty() {
                            tauri::async_runtime::spawn_blocking(move || {
                                let n = db::attachments::remove_freed(&files);
                                log::info!("purge: removed {n} files of purged attachments");
                            });
                        }
                    }
                    Err(e) => log::warn!("purge of deleted rows failed: {e}"),
                }
            }
            let backups = data_dir.join("backups");
            backup_now(&conn, &backups);
            // The language the core words its texts in; a change applies at the next launch
            // (hook settings) or at once (menu bar, see `update_settings`).
            let lang = i18n::current_language(&conn);
            #[cfg(target_os = "macos")]
            if let Err(e) = app_menu(app.handle(), lang).and_then(|m| app.set_menu(m)) {
                log::warn!("cannot set the menu bar: {e}");
            }
            let db = Arc::new(Mutex::new(conn));
            start_heartbeat(Arc::downgrade(&db));
            let notifier = Arc::new(start_notifier(app.handle()));
            let sessions = Arc::new(SessionService::new(
                Arc::clone(&db),
                task_state_sink(app.handle().clone(), Arc::clone(&notifier)),
                Timing::default(),
            ));
            let (terminals, hooks_port) =
                start_terminals(app.handle(), &data_dir, lang, Arc::clone(&sessions))?;
            let summarizer = Arc::new(start_summarizer(
                app.handle(),
                Arc::clone(&db),
                std::env::temp_dir().join("todo-agents-recaps"),
            ));
            let sync_service = sync::service::SyncService::new(
                Arc::clone(&db),
                home,
                sync::client::SyncClient::new(),
                Arc::new(sync::AppHooks(app.handle().clone())),
                Arc::new(sync::AppEvents(app.handle().clone())),
            );
            app.manage(commands::voice::start_voice(app.handle(), &data_dir));
            app.manage(AppState {
                db,
                terminals,
                sessions: Arc::clone(&sessions),
                hooks_port,
                summarizer: Arc::clone(&summarizer),
                sync: Arc::clone(&sync_service),
                notifier,
                asks: Arc::new(ask::run::Asks::default()),
            });
            // Off until an account is linked; never blocks the window.
            tauri::async_runtime::spawn(sync_service.worker());
            // `/clear` or `/resume` in Claude: the tab follows its new conversation.
            let reattach_app = app.handle().clone();
            sessions.set_reattach_hook(Arc::new(move |terminal_id, session_id| {
                if let Some(state) = reattach_app.try_state::<AppState>() {
                    state
                        .terminals
                        .pty
                        .set_agent_session(terminal_id, Some(session_id));
                    // The conversation that left the tab is history: recap it.
                    if let Some(info) = state.terminals.pty.info(terminal_id) {
                        state.summarizer.request(Some(&info.task_id));
                    }
                }
            }));
            spawn_hourly_backup(app.handle().clone(), backups);
            // Resolve the login-shell environment (up to 3 s) before the first terminal.
            let prewarm = app.handle().clone();
            std::thread::spawn(move || {
                if let Some(state) = prewarm.try_state::<AppState>() {
                    let env = state.terminals.env();
                    log::info!(
                        "terminal environment from {}: PATH={}",
                        if env.from_login_shell {
                            "login shell"
                        } else {
                            "fallback"
                        },
                        env.path()
                    );
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_main_window(app),
            // Last line of defence (⌘Q confirmed already ran this; Dock « Quitter », logout):
            // no process may outlive the app.
            RunEvent::Exit => {
                if let Some(state) = app.try_state::<AppState>() {
                    state.asks.stop_all();
                    state.terminals.shutdown(&state.db);
                }
            }
            _ => {}
        });
}

/// macOS menu bar: the predefined items, except « Quitter » which asks the UI first.
#[cfg(target_os = "macos")]
pub(crate) fn app_menu(
    app: &AppHandle,
    lang: i18n::Language,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let quit = MenuItemBuilder::with_id(QUIT_MENU_ID, i18n::menu::quit(lang))
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let app_submenu = SubmenuBuilder::new(app, "Taido")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit)
        .build()?;
    let edit = SubmenuBuilder::new(app, i18n::menu::edit(lang))
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let window = SubmenuBuilder::new(app, i18n::menu::window(lang))
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;
    MenuBuilder::new(app)
        .items(&[&app_submenu, &edit, &window])
        .build()
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// ⌘Q: the window comes forward and the UI confirms when terminals run, then calls
/// `quit_app`.
fn request_quit(app: &AppHandle) {
    show_main_window(app);
    if let Err(e) = (QuitRequested {}).emit(app) {
        log::warn!("cannot emit quit_requested, quitting directly: {e}");
        if let Some(state) = app.try_state::<AppState>() {
            state.terminals.shutdown(&state.db);
        }
        app.exit(0);
    }
}

/// Emits a batch of task states: `task_state_changed` for each task, then
/// `data_changed` (the rows, and the subjects whose dot may have changed) and
/// `counts_changed`; then shows its notifications.
fn task_state_sink(app: AppHandle, notifier: Arc<Notifier>) -> FlushSink {
    Arc::new(move |flush: Flush| {
        for notice in flush.notices {
            notifier.notify(notice);
        }
        let task_ids: Vec<String> = flush.changes.iter().map(|c| c.task_id.clone()).collect();
        for change in flush.changes {
            if let Err(e) = change.emit(&app) {
                log::warn!("cannot emit task_state_changed: {e}");
            }
        }
        let changed = DataChanged {
            scopes: vec![DataScope::Tasks, DataScope::Subjects],
            task_ids: Some(task_ids),
        };
        if let Err(e) = changed.emit(&app) {
            log::warn!("cannot emit data_changed: {e}");
        }
        if let Some(counts) = flush.counts {
            if let Err(e) = (CountsChanged { counts }).emit(&app) {
                log::warn!("cannot emit counts_changed: {e}");
            }
        }
    })
}

/// System notifications: macOS's own in the installed app (they say which one was clicked),
/// Tauri's plugin on Windows, none elsewhere. Called from `setup`, on the main thread.
fn start_notifier(app: &AppHandle) -> Notifier {
    #[cfg(target_os = "macos")]
    {
        let clicked = app.clone();
        let on_click: notify::macos::ClickHook =
            Arc::new(move |task_id| notification_clicked(&clicked, task_id));
        if let Some(banner) = notify::macos::banner(app, on_click) {
            return Notifier::new(Some(Arc::new(banner)));
        }
    }
    #[cfg(windows)]
    {
        let clicked = app.clone();
        let on_click: notify::windows::ClickHook =
            Arc::new(move |task_id| notification_clicked(&clicked, task_id));
        Notifier::new(Some(Arc::new(notify::windows::banner(app, on_click))))
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Notifier::new(None)
    }
}

/// A notification was clicked: the window comes forward and the UI opens the task on the
/// terminal of the session.
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
fn notification_clicked(app: &AppHandle, task_id: String) {
    show_main_window(app);
    let terminal_id = app
        .try_state::<AppState>()
        .and_then(|state| state.notifier.clicked(&task_id));
    if let Err(e) = (NotificationOpened {
        task_id,
        terminal_id,
    })
    .emit(app)
    {
        log::warn!("cannot emit notification_opened: {e}");
    }
}

/// Binds the hook server (its events go to the session service, its MCP tools to the
/// database), writes `claude-hooks.json` and `claude-mcp.json` for its port, and builds the
/// terminal service whose exits update the database and notify the UI. Returns the service
/// and the hook server's port.
fn start_terminals(
    app: &AppHandle,
    data_dir: &Path,
    lang: i18n::Language,
    sessions: Arc<SessionService>,
) -> Result<(TerminalService, u16), Box<dyn std::error::Error>> {
    let server = hooks::HookServer::bind()?;
    let port = server.port;
    let hooks_file = data_dir.join(terminal_service::HOOKS_FILE);
    let settings =
        serde_json::to_string_pretty(&crate::agents::claude::hooks_settings(lang, server.port))?;
    crate::agents::claude::write_private(&hooks_file, &settings)?;
    let mcp_file = data_dir.join(terminal_service::MCP_FILE);
    let mcp_config = serde_json::to_string_pretty(&crate::agents::claude::mcp_config(server.port))?;
    crate::agents::claude::write_private(&mcp_file, &mcp_config)?;
    // « Demander au projet »: Claude's MCP config and Codex's answer schema.
    let ask_mcp = serde_json::to_string_pretty(&ask::mcp_config(server.port))?;
    crate::agents::claude::write_private(&data_dir.join(ask::MCP_FILE), &ask_mcp)?;
    let schema = serde_json::to_string_pretty(&ask::answer_schema())?;
    crate::agents::claude::write_private(&data_dir.join(ask::SCHEMA_FILE), &schema)?;
    log::info!("hook and MCP server on 127.0.0.1:{}", server.port);

    let token = server.token.clone();
    let recorder: hooks::Recorder = Arc::new(move |terminal_id, event, payload| {
        sessions.on_hook(terminal_id, event, payload);
    });
    let tools_app = app.clone();
    let tools: mcp::ToolRunner =
        Arc::new(move |terminal_id, name, args| run_mcp_tool(&tools_app, terminal_id, name, args));
    let ask_app = app.clone();
    let ask_tools: mcp::ToolRunner =
        Arc::new(move |ask_id, name, args| run_ask_tool(&ask_app, ask_id, name, args));
    tauri::async_runtime::spawn(async move {
        if let Err(e) = server.serve(recorder, tools, ask_tools).await {
            log::error!("hook server stopped: {e}");
        }
    });

    let exit_app = app.clone();
    let on_exit: ExitHook = Arc::new(move |info: &TerminalInfo| terminal_exited(&exit_app, info));
    let service = TerminalService::new(
        PtyManager::new(DEFAULT_BUFFER_BYTES, on_exit),
        data_dir.to_path_buf(),
        token,
        port,
        terminal_service::AgentOverrides::from_env(),
    );
    Ok((service, port))
}

/// One MCP tool call of a Claude session (`crate::mcp`): the tool on the database, then the
/// same `data_changed` / sync poke as the UI's commands.
fn run_mcp_tool(
    app: &AppHandle,
    terminal_id: Option<&str>,
    name: &str,
    args: &serde_json::Value,
) -> mcp::ToolResult {
    let Some(state) = app.try_state::<AppState>() else {
        return mcp::ToolResult::error("Taido is still starting: try again in a moment.");
    };
    let conn = match state.db.lock() {
        Ok(conn) => conn,
        Err(e) => {
            log::warn!("MCP tool {name}: database lock poisoned: {e}");
            return mcp::ToolResult::error("Taido's database is unavailable.");
        }
    };
    let outcome = mcp::tools::run(&conn, terminal_id, name, args);
    // A trace of every call, for « Claude says it added it but I don't see it ».
    let terminal = terminal_id.unwrap_or("-");
    if outcome.result.is_error {
        log::info!(
            "MCP {name} (terminal {terminal}): refused: {}",
            outcome.result.text
        );
    } else {
        log::info!(
            "MCP {name} (terminal {terminal}): ok, changed {:?}",
            outcome.changed
        );
    }
    if !outcome.changed.is_empty() {
        commands::data::notify(
            app,
            &conn,
            commands::data::TASK_SCOPES,
            Some(outcome.changed),
        );
    }
    if outcome.notes {
        commands::data::notify(app, &conn, &[DataScope::Notes], None);
    }
    outcome.result
}

/// One MCP tool call of a running question (`crate::ask`): read only, within its project;
/// what it reads is shown in the panel.
fn run_ask_tool(
    app: &AppHandle,
    ask_id: Option<&str>,
    name: &str,
    args: &serde_json::Value,
) -> mcp::ToolResult {
    let Some(state) = app.try_state::<AppState>() else {
        return mcp::ToolResult::error("Taido is still starting: try again in a moment.");
    };
    let Some((scope, emit)) = ask_id.and_then(|id| state.asks.get(id)) else {
        return mcp::ToolResult::error("This question is over: nothing to read.");
    };
    let (result, step) = match state.db.lock() {
        Ok(conn) => ask::tools::run(&conn, &scope, name, args),
        Err(e) => {
            log::warn!("ask tool {name}: database lock poisoned: {e}");
            return mcp::ToolResult::error("Taido's database is unavailable.");
        }
    };
    if result.is_error {
        log::info!("ask tool {name}: refused: {}", result.text);
    }
    if let Some(step) = step {
        emit(ask::AskUpdate::Step { step });
    }
    result
}

/// A terminal's process exited: database and session state (Paused or Crashed), then
/// `terminal_exited` and `data_changed`.
fn terminal_exited(app: &AppHandle, info: &TerminalInfo) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    // « Demander au projet »: no row, no session; its tools stop answering.
    if ask::terminal::subject_of(&info.task_id).is_some() {
        state.asks.forget_terminal(&info.id);
        let event = TerminalExited {
            terminal_id: info.id.clone(),
            task_id: info.task_id.clone(),
            exit_code: info.exit_code,
            clean: true,
        };
        if let Err(e) = event.emit(app) {
            log::warn!("cannot emit terminal_exited: {e}");
        }
        match state.db.lock() {
            Ok(conn) => commands::data::notify(app, &conn, &[DataScope::Terminals], None),
            Err(e) => log::warn!("terminal {} exited, database lock poisoned: {e}", info.id),
        }
        return;
    }
    let by_user = match state.sessions.exited(info) {
        Ok(by_user) => by_user,
        Err(e) => {
            log::warn!("cannot record the exit of terminal {}: {e}", info.id);
            false
        }
    };
    let conn = match state.db.lock() {
        Ok(conn) => conn,
        Err(e) => {
            log::warn!("terminal {} exited, database lock poisoned: {e}", info.id);
            return;
        }
    };
    let event = TerminalExited {
        terminal_id: info.id.clone(),
        task_id: info.task_id.clone(),
        exit_code: info.exit_code,
        clean: by_user || info.exit_code == Some(0),
    };
    if let Err(e) = event.emit(app) {
        log::warn!("cannot emit terminal_exited: {e}");
    }
    commands::data::notify(
        app,
        &conn,
        &[DataScope::Terminals, DataScope::Tasks],
        Some(vec![info.task_id.clone()]),
    );
    drop(conn);
    // An ended Claude session gets its recap (option 4).
    if info.agent_session_id.is_some() {
        state.summarizer.request(Some(&info.task_id));
    }
}

/// The session recap thread: the binary and environment of a launch, and a refresh of the
/// task once a recap is stored.
fn start_summarizer(
    app: &AppHandle,
    db: Arc<Mutex<Connection>>,
    cwd: PathBuf,
) -> summarizer::Summarizer {
    let claude_app = app.clone();
    let done_app = app.clone();
    summarizer::Summarizer::start(summarizer::Deps {
        db,
        agent: Arc::new(move |conn, agent| {
            let state = claude_app.try_state::<AppState>()?;
            // `fake-claude` would answer anything: no recap in that setup.
            if state.terminals.uses_dev_override() {
                return None;
            }
            let env = state.terminals.env().vars.clone();
            let bin = state.terminals.agent_binary(conn, &env, agent).ok()?;
            Some((bin, env))
        }),
        on_done: Arc::new(move |task_id| {
            let changed = DataChanged {
                scopes: vec![DataScope::Tasks, DataScope::Journal],
                task_ids: Some(vec![task_id.to_string()]),
            };
            if let Err(e) = changed.emit(&done_app) {
                log::warn!("cannot emit data_changed for a recap: {e}");
            }
        }),
        cwd,
    })
}

/// How often the daily backup is checked (bug #14: not only at startup).
const BACKUP_CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// Writes today's backup unless it exists; failures are logged, never fatal.
fn backup_now(conn: &Connection, dir: &Path) {
    let today = chrono::Local::now().date_naive();
    match db::backup::daily(conn, dir, today) {
        Ok(Some(path)) => log::info!("database backed up to {}", path.display()),
        Ok(None) => log::debug!("today's database backup already exists"),
        Err(e) => log::warn!("daily database backup failed: {e}"),
    }
}

/// Checks the daily backup every hour, so that an app left open for days still gets one
/// backup per day. The lock is held only for the `VACUUM INTO`.
fn spawn_hourly_backup(app: AppHandle, dir: PathBuf) {
    let spawned = std::thread::Builder::new()
        .name("daily-backup".into())
        .spawn(move || loop {
            std::thread::sleep(BACKUP_CHECK_INTERVAL);
            let state = app.state::<AppState>();
            let locked = state.db.lock();
            match locked {
                Ok(conn) => backup_now(&conn, &dir),
                Err(e) => log::warn!("backup skipped, database lock poisoned: {e}"),
            };
        });
    if let Err(e) = spawned {
        log::warn!("cannot start the backup thread: {e}");
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn export_bindings() {
        super::export_bindings().expect("export bindings");
    }
}
