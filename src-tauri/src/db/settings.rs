//! Settings stored as key/value JSON rows.

use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::db::synced_settings;
use crate::error::{AppError, AppResult};
use crate::model::{ColorTheme, Settings, SettingsPatch, Theme};

pub const PANEL_WIDTH_MIN: u32 = 360;
pub const PANEL_WIDTH_MAX: u32 = 1000;

const THEME: &str = "theme";
const COLOR_THEME: &str = "color_theme";
const SYNC_THEME: &str = "sync_theme";
const PANEL_WIDTH: &str = "panel_width";
const SHOW_COMPLETED: &str = "show_completed";
const EDITOR: &str = "editor";
const CLAUDE_PATH: &str = "claude_path";
const SUMMARIZE_SESSIONS: &str = "summarize_sessions";
const NOTIFICATIONS: &str = "notifications";
const WORKSPACE_ROOT: &str = "workspace_root";
const TUTORIAL: &str = "tutorial";
pub(crate) const CHRONO_COUNTS_WAITING: &str = "chrono_counts_waiting";
const DEFAULT_AGENT: &str = "default_agent";
const CODEX_PATH: &str = "codex_path";
const AGENT_CHOSEN: &str = "agent_chosen";
const VOICE_SPACE_HOLD: &str = "voice_space_hold";

/// The synced setting `appearance` (sync_proto::SETTING_APPEARANCE).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, serde::Deserialize)]
struct Appearance {
    theme: Theme,
    color: ColorTheme,
}

/// The shared theme; `None` when missing or unreadable (e.g. a colour of a later version).
fn shared_appearance(conn: &Connection) -> AppResult<Option<Appearance>> {
    Ok(
        synced_settings::get(conn, sync_proto::SETTING_APPEARANCE)?.and_then(|v| {
            serde_json::from_value(v)
                .map_err(|e| log::warn!("ignoring unreadable shared appearance: {e}"))
                .ok()
        }),
    )
}

/// Stored values, defaults for missing or unreadable keys. With « Même thème sur tous mes
/// appareils », theme and colour are the shared ones when there are some.
pub fn get(conn: &Connection) -> AppResult<Settings> {
    let defaults = Settings::default();
    let sync_theme = read(conn, SYNC_THEME)?.unwrap_or(defaults.sync_theme);
    let shared = if sync_theme {
        shared_appearance(conn)?
    } else {
        None
    };
    Ok(Settings {
        theme: match shared {
            Some(a) => a.theme,
            None => read(conn, THEME)?.unwrap_or(defaults.theme),
        },
        color_theme: match shared {
            Some(a) => a.color,
            None => read(conn, COLOR_THEME)?.unwrap_or(defaults.color_theme),
        },
        sync_theme,
        panel_width: read(conn, PANEL_WIDTH)?
            .map(clamp_panel_width)
            .unwrap_or(defaults.panel_width),
        show_completed: read(conn, SHOW_COMPLETED)?.unwrap_or(defaults.show_completed),
        editor: read(conn, EDITOR)?.unwrap_or(defaults.editor),
        claude_path: read::<Option<String>>(conn, CLAUDE_PATH)?.flatten(),
        summarize_sessions: read(conn, SUMMARIZE_SESSIONS)?.unwrap_or(defaults.summarize_sessions),
        notifications: read(conn, NOTIFICATIONS)?.unwrap_or(defaults.notifications),
        workspace_root: read::<Option<String>>(conn, WORKSPACE_ROOT)?.flatten(),
        tutorial: read(conn, TUTORIAL)?.unwrap_or_default(),
        chrono_counts_waiting: read(conn, CHRONO_COUNTS_WAITING)?
            .unwrap_or(defaults.chrono_counts_waiting),
        default_agent: read(conn, DEFAULT_AGENT)?.unwrap_or(defaults.default_agent),
        codex_path: read::<Option<String>>(conn, CODEX_PATH)?.flatten(),
        agent_chosen: read(conn, AGENT_CHOSEN)?.unwrap_or(defaults.agent_chosen),
        voice_space_hold: read(conn, VOICE_SPACE_HOLD)?.unwrap_or(defaults.voice_space_hold),
    })
}

/// Writes the fields present in the patch; the panel width is clamped to 360–1000.
pub fn update(conn: &Connection, patch: &SettingsPatch) -> AppResult<Settings> {
    let tx = conn.unchecked_transaction()?;
    if patch.theme.is_some() || patch.color_theme.is_some() || patch.sync_theme.is_some() {
        // The theme shown stays the same when the switch changes: turned off, the shared theme
        // becomes this device's; turned on, this device's theme goes to the others (Todoist).
        let shown = get(&tx)?;
        let appearance = Appearance {
            theme: patch.theme.unwrap_or(shown.theme),
            color: patch.color_theme.unwrap_or(shown.color_theme),
        };
        let sync_theme = patch.sync_theme.unwrap_or(shown.sync_theme);
        write(&tx, THEME, &appearance.theme)?;
        write(&tx, COLOR_THEME, &appearance.color)?;
        write(&tx, SYNC_THEME, &sync_theme)?;
        if sync_theme {
            let value = serde_json::to_value(appearance)
                .map_err(|e| AppError::Internal(format!("cannot serialize appearance: {e}")))?;
            synced_settings::set(&tx, sync_proto::SETTING_APPEARANCE, &value)?;
        }
    }
    if let Some(width) = patch.panel_width {
        write(&tx, PANEL_WIDTH, &clamp_panel_width(width))?;
    }
    if let Some(show) = patch.show_completed {
        write(&tx, SHOW_COMPLETED, &show)?;
    }
    if let Some(on) = patch.summarize_sessions {
        write(&tx, SUMMARIZE_SESSIONS, &on)?;
    }
    if let Some(on) = patch.notifications {
        write(&tx, NOTIFICATIONS, &on)?;
    }
    if let Some(on) = patch.voice_space_hold {
        write(&tx, VOICE_SPACE_HOLD, &on)?;
    }
    if let Some(editor) = patch.editor {
        write(&tx, EDITOR, &editor)?;
    }
    if let Some(tutorial) = &patch.tutorial {
        write(&tx, TUTORIAL, tutorial)?;
    }
    if let Some(on) = patch.chrono_counts_waiting {
        write(&tx, CHRONO_COUNTS_WAITING, &on)?;
        // Running segments follow the new rule at once.
        crate::db::time_segments::reconcile_all(&tx, &crate::db::now_utc())?;
    }
    if let Some(agent) = patch.default_agent {
        write(&tx, DEFAULT_AGENT, &agent)?;
    }
    if let Some(chosen) = patch.agent_chosen {
        write(&tx, AGENT_CHOSEN, &chosen)?;
    }
    if let Some(path) = patch.claude_path.as_deref() {
        write(&tx, CLAUDE_PATH, &binary_path("claude", path)?)?;
    }
    if let Some(path) = patch.codex_path.as_deref() {
        write(&tx, CODEX_PATH, &binary_path("codex", path)?)?;
    }
    tx.commit()?;
    get(conn)
}

/// An explicit agent binary: absolute, or `""` for the automatic detection (`None`).
fn binary_path(agent: &str, path: &str) -> AppResult<Option<String>> {
    let path = path.trim();
    if path.is_empty() {
        Ok(None)
    } else if std::path::Path::new(path).is_absolute() {
        Ok(Some(path.to_string()))
    } else {
        Err(AppError::Invalid(format!(
            "{agent} path must be absolute: {path}"
        )))
    }
}

/// Records the app's folder (set at startup, see `db::workspace`).
pub fn set_workspace_root(conn: &Connection, path: &str) -> AppResult<()> {
    write(conn, WORKSPACE_ROOT, &Some(path.to_string()))
}

pub fn clamp_panel_width(width: u32) -> u32 {
    width.clamp(PANEL_WIDTH_MIN, PANEL_WIDTH_MAX)
}

/// Reads one JSON value; `None` when missing or unreadable (logged).
pub(crate) fn read<T: DeserializeOwned>(conn: &Connection, key: &str) -> AppResult<Option<T>> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(raw.and_then(|v| match serde_json::from_str(&v) {
        Ok(value) => Some(value),
        Err(e) => {
            log::warn!("ignoring unreadable setting {key}: {e}");
            None
        }
    }))
}

/// Writes one JSON value.
pub(crate) fn write<T: Serialize>(conn: &Connection, key: &str, value: &T) -> AppResult<()> {
    let json = serde_json::to_string(value)
        .map_err(|e| AppError::Internal(format!("cannot serialize setting {key}: {e}")))?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, json],
    )?;
    Ok(())
}

/// Removes one key (no-op when missing).
pub(crate) fn remove(conn: &Connection, key: &str) -> AppResult<()> {
    conn.execute("DELETE FROM settings WHERE key = ?1", [key])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::model::{Tutorial, TutorialStatus};

    #[test]
    fn defaults() {
        let conn = open_in_memory().expect("db");
        let s = get(&conn).expect("get");
        assert_eq!(
            s,
            Settings {
                theme: Theme::System,
                color_theme: ColorTheme::Taido,
                sync_theme: true,
                panel_width: 460,
                show_completed: false,
                editor: crate::model::Editor::Vscode,
                claude_path: None,
                summarize_sessions: true,
                notifications: true,
                workspace_root: None,
                tutorial: Tutorial::default(),
                chrono_counts_waiting: false,
                default_agent: crate::model::Agent::Claude,
                codex_path: None,
                agent_chosen: false,
                voice_space_hold: true,
            }
        );
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn patch_is_partial_and_persisted() {
        let conn = open_in_memory().expect("db");
        let s = update(
            &conn,
            &SettingsPatch {
                theme: Some(Theme::Dark),
                ..Default::default()
            },
        )
        .expect("update");
        assert_eq!(s.theme, Theme::Dark);
        assert_eq!(s.panel_width, 460);
        let s = update(
            &conn,
            &SettingsPatch {
                show_completed: Some(true),
                panel_width: Some(800),
                ..Default::default()
            },
        )
        .expect("update");
        assert_eq!(
            s,
            Settings {
                theme: Theme::Dark,
                color_theme: ColorTheme::Taido,
                sync_theme: true,
                panel_width: 800,
                show_completed: true,
                editor: crate::model::Editor::Vscode,
                claude_path: None,
                summarize_sessions: true,
                notifications: true,
                workspace_root: None,
                tutorial: Tutorial::default(),
                chrono_counts_waiting: false,
                default_agent: crate::model::Agent::Claude,
                codex_path: None,
                agent_chosen: false,
                voice_space_hold: true,
            }
        );
        assert_eq!(get(&conn).expect("get"), s);
        let raw: String = conn
            .query_row("SELECT value FROM settings WHERE key = 'theme'", [], |r| {
                r.get(0)
            })
            .expect("raw");
        assert_eq!(raw, "\"dark\"");
    }

    #[test]
    fn tutorial_progress_is_kept_whole() {
        let conn = open_in_memory().expect("db");
        assert_eq!(
            get(&conn).expect("get").tutorial.status,
            TutorialStatus::NotStarted
        );
        let progress = Tutorial {
            status: TutorialStatus::InProgress,
            step: Some("open".into()),
            subject_id: Some("s1".into()),
            task_id: Some("t1".into()),
        };
        let s = update(
            &conn,
            &SettingsPatch {
                tutorial: Some(progress.clone()),
                ..Default::default()
            },
        )
        .expect("update");
        assert_eq!(s.tutorial, progress);
        // Another field leaves it alone; a new value replaces it whole.
        update(
            &conn,
            &SettingsPatch {
                theme: Some(Theme::Dark),
                ..Default::default()
            },
        )
        .expect("update");
        assert_eq!(get(&conn).expect("get").tutorial, progress);
        let done = Tutorial {
            status: TutorialStatus::Done,
            ..Default::default()
        };
        update(
            &conn,
            &SettingsPatch {
                tutorial: Some(done.clone()),
                ..Default::default()
            },
        )
        .expect("update");
        assert_eq!(get(&conn).expect("get").tutorial, done);
        let raw: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'tutorial'",
                [],
                |r| r.get(0),
            )
            .expect("raw");
        assert_eq!(
            raw,
            r#"{"status":"done","step":null,"subjectId":null,"taskId":null}"#
        );
    }

    #[test]
    fn unreadable_tutorial_falls_back_to_not_started() {
        let conn = open_in_memory().expect("db");
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('tutorial', '\"oops\"')",
            [],
        )
        .expect("insert");
        assert_eq!(get(&conn).expect("get").tutorial, Tutorial::default());
    }

    #[test]
    fn panel_width_is_clamped() {
        let cases = [
            (0, 360),
            (359, 360),
            (360, 360),
            (460, 460),
            (1000, 1000),
            (5000, 1000),
        ];
        let conn = open_in_memory().expect("db");
        for (input, expected) in cases {
            let s = update(
                &conn,
                &SettingsPatch {
                    panel_width: Some(input),
                    ..Default::default()
                },
            )
            .expect("update");
            assert_eq!(s.panel_width, expected, "{input}");
        }
    }

    #[test]
    fn unreadable_values_fall_back_to_defaults() {
        let conn = open_in_memory().expect("db");
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('theme', 'not json'), ('panel_width', '20')",
            [],
        )
        .expect("insert");
        let s = get(&conn).expect("get");
        assert_eq!(s.theme, Theme::System);
        assert_eq!(s.panel_width, 360);
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('editor', '\"emacs\"'), \
             ('claude_path', '42')",
            [],
        )
        .expect("insert");
        let s = get(&conn).expect("get");
        assert_eq!(s.editor, crate::model::Editor::Vscode);
        assert_eq!(s.claude_path, None);
    }

    #[test]
    fn editor_is_stored_by_name() {
        use crate::model::Editor;
        let conn = open_in_memory().expect("db");
        let cases = [
            (Editor::Cursor, "\"cursor\""),
            (Editor::Zed, "\"zed\""),
            (Editor::Windsurf, "\"windsurf\""),
            (Editor::Sublime, "\"sublime\""),
            (Editor::Vscode, "\"vscode\""),
        ];
        for (editor, raw) in cases {
            let s = update(
                &conn,
                &SettingsPatch {
                    editor: Some(editor),
                    ..Default::default()
                },
            )
            .expect("update");
            assert_eq!(s.editor, editor);
            let stored: String = conn
                .query_row("SELECT value FROM settings WHERE key = 'editor'", [], |r| {
                    r.get(0)
                })
                .expect("raw");
            assert_eq!(stored, raw);
        }
    }

    #[test]
    fn claude_path_is_absolute_trimmed_or_cleared() {
        let conn = open_in_memory().expect("db");
        let set = |path: Option<&str>| {
            update(
                &conn,
                &SettingsPatch {
                    claude_path: path.map(String::from),
                    ..Default::default()
                },
            )
        };
        let cases: [(Option<&str>, Option<&str>); 5] = [
            (
                Some("  /opt/claude/bin/claude "),
                Some("/opt/claude/bin/claude"),
            ),
            // Absent from the patch: unchanged.
            (None, Some("/opt/claude/bin/claude")),
            (Some(""), None),
            (Some("/usr/local/bin/claude"), Some("/usr/local/bin/claude")),
            (Some("   "), None),
        ];
        for (input, expected) in cases {
            let s = set(input).expect("update");
            assert_eq!(s.claude_path.as_deref(), expected, "{input:?}");
            assert_eq!(get(&conn).expect("get").claude_path.as_deref(), expected);
        }
        set(Some("/usr/bin/claude")).expect("update");
        assert!(matches!(set(Some("bin/claude")), Err(AppError::Invalid(_))));
        // A refused patch changes nothing.
        assert_eq!(
            get(&conn).expect("get").claude_path.as_deref(),
            Some("/usr/bin/claude")
        );
    }

    #[test]
    fn default_agent_and_codex_path() {
        use crate::model::Agent;
        let conn = open_in_memory().expect("db");
        let s = get(&conn).expect("get");
        assert_eq!(s.default_agent, Agent::Claude);
        assert_eq!(s.codex_path, None);
        assert!(!s.agent_chosen);
        let s = update(
            &conn,
            &SettingsPatch {
                default_agent: Some(Agent::Codex),
                codex_path: Some(" /opt/homebrew/bin/codex ".into()),
                agent_chosen: Some(true),
                ..Default::default()
            },
        )
        .expect("update");
        assert_eq!(s.default_agent, Agent::Codex);
        assert_eq!(s.codex_path.as_deref(), Some("/opt/homebrew/bin/codex"));
        assert!(s.agent_chosen);
        let s = update(
            &conn,
            &SettingsPatch {
                codex_path: Some(String::new()),
                ..Default::default()
            },
        )
        .expect("clear");
        assert_eq!(s.codex_path, None);
        assert!(update(
            &conn,
            &SettingsPatch {
                codex_path: Some("codex".into()),
                ..Default::default()
            },
        )
        .is_err());
    }

    #[test]
    fn an_unknown_default_agent_reads_as_claude() {
        let conn = open_in_memory().expect("db");
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('default_agent', '\"cursor\"')",
            [],
        )
        .expect("insert");
        assert_eq!(
            get(&conn).expect("get").default_agent,
            crate::model::Agent::Claude
        );
    }

    fn shared(conn: &Connection) -> Option<serde_json::Value> {
        synced_settings::get(conn, sync_proto::SETTING_APPEARANCE).expect("shared")
    }

    fn set_theme(conn: &Connection, patch: SettingsPatch) -> Settings {
        update(conn, &patch).expect("update")
    }

    #[test]
    fn theme_and_colour_are_shared_while_the_switch_is_on() {
        let conn = open_in_memory().expect("db");
        assert_eq!(shared(&conn), None);
        let s = set_theme(
            &conn,
            SettingsPatch {
                color_theme: Some(ColorTheme::Lavender),
                ..Default::default()
            },
        );
        assert_eq!(
            (s.theme, s.color_theme, s.sync_theme),
            (Theme::System, ColorTheme::Lavender, true)
        );
        assert_eq!(
            shared(&conn),
            Some(serde_json::json!({"theme": "system", "color": "lavender"}))
        );
        // Another device changes the shared theme: shown here.
        synced_settings::set(
            &conn,
            sync_proto::SETTING_APPEARANCE,
            &serde_json::json!({"theme": "dark", "color": "sage"}),
        )
        .expect("set");
        let s = get(&conn).expect("get");
        assert_eq!((s.theme, s.color_theme), (Theme::Dark, ColorTheme::Sage));
    }

    #[test]
    fn switch_off_keeps_the_theme_and_stops_sharing() {
        let conn = open_in_memory().expect("db");
        synced_settings::set(
            &conn,
            sync_proto::SETTING_APPEARANCE,
            &serde_json::json!({"theme": "dark", "color": "cocoa"}),
        )
        .expect("set");
        let s = set_theme(
            &conn,
            SettingsPatch {
                sync_theme: Some(false),
                ..Default::default()
            },
        );
        assert_eq!(
            (s.theme, s.color_theme, s.sync_theme),
            (Theme::Dark, ColorTheme::Cocoa, false)
        );
        set_theme(
            &conn,
            SettingsPatch {
                color_theme: Some(ColorTheme::Plum),
                ..Default::default()
            },
        );
        // Neither written nor read while off.
        assert_eq!(
            shared(&conn),
            Some(serde_json::json!({"theme": "dark", "color": "cocoa"}))
        );
        synced_settings::set(
            &conn,
            sync_proto::SETTING_APPEARANCE,
            &serde_json::json!({"theme": "light", "color": "sage"}),
        )
        .expect("set");
        let s = get(&conn).expect("get");
        assert_eq!((s.theme, s.color_theme), (Theme::Dark, ColorTheme::Plum));
        // Turned on again: this device's theme goes to the others.
        let s = set_theme(
            &conn,
            SettingsPatch {
                sync_theme: Some(true),
                ..Default::default()
            },
        );
        assert_eq!((s.theme, s.color_theme), (Theme::Dark, ColorTheme::Plum));
        assert_eq!(
            shared(&conn),
            Some(serde_json::json!({"theme": "dark", "color": "plum"}))
        );
    }

    #[test]
    fn an_unreadable_shared_theme_is_ignored() {
        let conn = open_in_memory().expect("db");
        set_theme(
            &conn,
            SettingsPatch {
                color_theme: Some(ColorTheme::Lagoon),
                ..Default::default()
            },
        );
        // A colour added by a later version.
        synced_settings::set(
            &conn,
            sync_proto::SETTING_APPEARANCE,
            &serde_json::json!({"theme": "dark", "color": "neon"}),
        )
        .expect("set");
        let s = get(&conn).expect("get");
        assert_eq!(
            (s.theme, s.color_theme),
            (Theme::System, ColorTheme::Lagoon)
        );
    }
}
