//! Texts the core produces for the user, in the user's language (`Settings.language`, English
//! while unset). Texts only Claude or Codex read (MCP tool descriptions, prompts, context
//! files) are English constants elsewhere and never go through here.

use std::path::Path;

use rusqlite::Connection;

pub use crate::model::Language;

/// The user's language; English while none is chosen (or when the setting cannot be read).
pub fn current_language(conn: &Connection) -> Language {
    crate::db::settings::language(conn).unwrap_or_default()
}

/// `fr` or `en` text, as the language says.
fn pick<'a>(lang: Language, en: &'a str, fr: &'a str) -> &'a str {
    match lang {
        Language::En => en,
        Language::Fr => fr,
    }
}

/// Name of the language, for the instructions that tell an agent which language to answer in.
pub fn language_name(lang: Language) -> &'static str {
    pick(lang, "English", "French")
}

// -- Notifications and session lines ---------------------------------------------------------

/// « Claude is waiting for you » (`name` is the agent's name).
pub fn agent_waiting(lang: Language, name: &str) -> String {
    match lang {
        Language::En => format!("{name} is waiting for you"),
        Language::Fr => format!("{name} attend ta réponse"),
    }
}

/// « Claude is done ».
pub fn agent_done(lang: Language, name: &str) -> String {
    match lang {
        Language::En => format!("{name} is done"),
        Language::Fr => format!("{name} a fini"),
    }
}

pub fn session_stopped(lang: Language) -> &'static str {
    pick(lang, "Session stopped", "Session arrêtée")
}

/// Line of an Error session, from `StopFailure.error` (same labels as `agentErrorLabel` in
/// `src/i18n`).
pub fn error_text(lang: Language, kind: Option<&str>) -> String {
    match (kind.map(str::trim), kind) {
        (Some("rate_limit"), _) => pick(lang, "Usage limit reached", "Limite d'usage atteinte"),
        (Some("overloaded"), _) => pick(
            lang,
            "Servers overloaded, try again",
            "Serveurs surchargés, réessaie",
        ),
        (Some("authentication_failed"), _) => pick(
            lang,
            "Claude Code is signed out",
            "Claude Code n'est plus connecté",
        ),
        (Some("billing_error"), _) => pick(lang, "Billing problem", "Problème de facturation"),
        (Some(other), _) if !other.is_empty() => {
            return match lang {
                Language::En => format!("Error: {other}"),
                Language::Fr => format!("Erreur : {other}"),
            };
        }
        _ => pick(lang, "Error", "Erreur"),
    }
    .to_string()
}

/// Shown by Claude Code while Taido holds a permission request.
pub fn permission_status(lang: Language, app: &str) -> String {
    match lang {
        Language::En => format!("Waiting for your reply in {app}…"),
        Language::Fr => format!("En attente de ta réponse dans {app}…"),
    }
}

/// Activity of a session, from the tool it runs (`state::summary`).
pub mod activity {
    use super::{pick, Language};

    pub fn command(lang: Language) -> &'static str {
        pick(lang, "Command", "Commande")
    }

    /// « Command: ls », `detail` already shortened.
    pub fn command_with(lang: Language, detail: &str) -> String {
        match lang {
            Language::En => format!("Command: {detail}"),
            Language::Fr => format!("Commande : {detail}"),
        }
    }

    pub fn edit(lang: Language) -> &'static str {
        pick(lang, "Editing", "Édition")
    }

    pub fn read(lang: Language) -> &'static str {
        pick(lang, "Reading", "Lecture")
    }

    pub fn code_search(lang: Language) -> &'static str {
        pick(lang, "Searching the code", "Recherche dans le code")
    }

    pub fn web_search(lang: Language) -> &'static str {
        pick(lang, "Web search", "Recherche web")
    }

    pub fn sub_agent(lang: Language) -> &'static str {
        pick(lang, "Sub-agent", "Sous-agent")
    }

    pub fn sub_agent_with(lang: Language, detail: &str) -> String {
        match lang {
            Language::En => format!("Sub-agent: {detail}"),
            Language::Fr => format!("Sous-agent : {detail}"),
        }
    }

    /// « Tool github » for an MCP server's tool.
    pub fn mcp_tool(lang: Language, server: &str) -> String {
        match lang {
            Language::En => format!("Tool {server}"),
            Language::Fr => format!("Outil {server}"),
        }
    }
}

// -- Menu bar --------------------------------------------------------------------------------

/// The macOS menu bar (Windows has none).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub mod menu {
    use super::{pick, Language};

    pub fn quit(lang: Language) -> &'static str {
        pick(lang, "Quit Taido", "Quitter Taido")
    }

    pub fn edit(lang: Language) -> &'static str {
        pick(lang, "Edit", "Édition")
    }

    pub fn window(lang: Language) -> &'static str {
        pick(lang, "Window", "Fenêtre")
    }
}

/// Name of this computer in the account's device list on the server.
pub fn device_name(lang: Language) -> &'static str {
    pick(lang, "Computer", "Ordinateur")
}

// -- Default data ----------------------------------------------------------------------------

/// Columns of a new Kanban board: the same words as the interface (`board` in `src/i18n`).
/// The last one is the done column. They are the user's data from then on (renamable).
pub fn default_columns(lang: Language) -> [&'static str; 4] {
    match lang {
        Language::En => ["To do", "In progress", "To review", "Done"],
        Language::Fr => ["À faire", "En cours", "À valider", "Terminé"],
    }
}

/// Name of a new group of projects or notes left unnamed.
pub fn new_group(lang: Language) -> &'static str {
    pick(lang, "New group", "Nouveau groupe")
}

/// Suffix of a duplicated page's title.
pub fn copy_suffix(lang: Language) -> &'static str {
    pick(lang, " (copy)", " (copie)")
}

/// Name of the « Task summaries » section of a notebook, in the messages that mention it.
pub fn task_summaries(lang: Language) -> &'static str {
    pick(lang, "Task summaries", "Résumés de tâches")
}

pub fn trashed_project(lang: Language) -> &'static str {
    pick(
        lang,
        "This page's project is in the trash.",
        "Le projet de cette page est dans la corbeille.",
    )
}

// -- Folders on disk -------------------------------------------------------------------------

/// A folder the app makes in the user's app folder, named in both languages.
pub struct FolderNames {
    pub en: &'static str,
    pub fr: &'static str,
}

/// Folder of the tasks without project.
pub const NO_PROJECT: FolderNames = FolderNames {
    en: "Inbox",
    fr: "Sans projet",
};

/// Folder of the attachments.
pub const ATTACHMENTS: FolderNames = FolderNames {
    en: "Attachments",
    fr: "Pièces jointes",
};

/// The name of a folder under `root`. A folder that already exists keeps its name whatever the
/// language is now (the files in it must not move); the one of the current language wins when
/// both exist; with none, the current language names the new one.
pub fn folder_name(root: &Path, lang: Language, names: FolderNames) -> &'static str {
    let (own, other) = match lang {
        Language::En => (names.en, names.fr),
        Language::Fr => (names.fr, names.en),
    };
    if !root.join(own).exists() && root.join(other).exists() {
        other
    } else {
        own
    }
}

// -- Time export (CSV) -----------------------------------------------------------------------

pub mod export {
    use super::{pick, Language};

    /// Field separator: `;` where Excel expects it (French), `,` otherwise.
    pub fn separator(lang: Language) -> char {
        match lang {
            Language::En => ',',
            Language::Fr => ';',
        }
    }

    /// First line, UTF-8 BOM included.
    pub fn csv_header(lang: Language) -> String {
        let columns = match lang {
            Language::En => [
                "Project",
                "Task",
                "Start",
                "End",
                "Duration",
                "Duration (min)",
                "Source",
                "Stop reason",
                "Note",
            ],
            Language::Fr => [
                "Projet",
                "Tâche",
                "Début",
                "Fin",
                "Durée",
                "Durée (min)",
                "Source",
                "Raison d'arrêt",
                "Note",
            ],
        };
        format!("\u{feff}{}\r\n", columns.join(&separator(lang).to_string()))
    }

    pub fn no_project(lang: Language) -> &'static str {
        pick(lang, "Inbox", "Sans projet")
    }

    pub fn running(lang: Language) -> &'static str {
        pick(lang, "running", "en cours")
    }

    pub fn by_hand(lang: Language) -> &'static str {
        pick(lang, "by hand", "à la main")
    }

    pub fn session_closed(lang: Language) -> &'static str {
        pick(lang, "session closed", "session fermée")
    }

    pub fn task_done(lang: Language) -> &'static str {
        pick(lang, "task completed", "tâche terminée")
    }

    pub fn app_closed(lang: Language) -> &'static str {
        pick(lang, "Taido closed", "Taido fermé")
    }

    pub fn waiting(lang: Language) -> &'static str {
        pick(lang, "waiting for you", "attend ta réponse")
    }
}

// -- Ask the project -------------------------------------------------------------------------

pub mod ask {
    use super::{pick, Language};

    /// Name of the Claude Code session of a project's questions.
    pub fn session_name(lang: Language, project: &str) -> String {
        format!(
            "{} · {project}",
            pick(lang, "Ask the project", "Demander au projet")
        )
    }

    /// What the agent answers when the project holds nothing about the question.
    pub fn nothing_found(lang: Language) -> &'static str {
        pick(
            lang,
            "I found nothing in the project about this.",
            "Je n'ai rien trouvé dans le projet à ce sujet.",
        )
    }

    /// Source line of a conversation of a task, in the markdown of an answer.
    pub fn conversation_of(lang: Language, link: &str) -> String {
        match lang {
            Language::En => format!("Conversation from {link}"),
            Language::Fr => format!("Conversation de {link}"),
        }
    }

    /// Source line of an earlier question.
    pub fn earlier_question(lang: Language, label: &str) -> String {
        match lang {
            Language::En => format!("Question “{label}”"),
            Language::Fr => format!("Question « {label} »"),
        }
    }

    /// A quote after its source: `- source: “quote”`.
    pub fn quoted(lang: Language, source: &str, quote: &str) -> String {
        match lang {
            Language::En => format!("{source}: “{quote}”"),
            Language::Fr => format!("{source} : « {quote} »"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::model::SettingsPatch;

    #[test]
    fn unset_language_means_english() {
        let conn = open_in_memory().expect("db");
        conn.execute("DELETE FROM settings WHERE key = 'language'", [])
            .expect("clear");
        assert_eq!(current_language(&conn), Language::En);
    }

    #[test]
    fn the_stored_language_is_used() {
        let conn = open_in_memory().expect("db");
        crate::db::settings::update(
            &conn,
            &SettingsPatch {
                language: Some(Language::En),
                ..Default::default()
            },
        )
        .expect("set");
        assert_eq!(current_language(&conn), Language::En);
        crate::db::settings::update(
            &conn,
            &SettingsPatch {
                language: Some(Language::Fr),
                ..Default::default()
            },
        )
        .expect("set");
        assert_eq!(current_language(&conn), Language::Fr);
    }

    #[test]
    fn notification_texts_follow_the_language() {
        assert_eq!(
            agent_waiting(Language::En, "Claude"),
            "Claude is waiting for you"
        );
        assert_eq!(
            agent_waiting(Language::Fr, "Claude"),
            "Claude attend ta réponse"
        );
        assert_eq!(agent_done(Language::En, "Codex"), "Codex is done");
        assert_eq!(agent_done(Language::Fr, "Codex"), "Codex a fini");
        assert_eq!(session_stopped(Language::En), "Session stopped");
        assert_eq!(session_stopped(Language::Fr), "Session arrêtée");
    }

    #[test]
    fn error_texts_follow_the_language() {
        assert_eq!(
            error_text(Language::En, Some("rate_limit")),
            "Usage limit reached"
        );
        assert_eq!(
            error_text(Language::Fr, Some("rate_limit")),
            "Limite d'usage atteinte"
        );
        assert_eq!(error_text(Language::En, Some("model_x")), "Error: model_x");
        assert_eq!(
            error_text(Language::Fr, Some("model_x")),
            "Erreur : model_x"
        );
        assert_eq!(error_text(Language::En, None), "Error");
        assert_eq!(error_text(Language::Fr, Some("  ")), "Erreur");
    }

    #[test]
    fn the_computer_is_named_in_the_language() {
        assert_eq!(device_name(Language::En), "Computer");
        assert_eq!(device_name(Language::Fr), "Ordinateur");
    }

    #[test]
    fn default_board_columns_use_the_ui_vocabulary() {
        assert_eq!(
            default_columns(Language::En),
            ["To do", "In progress", "To review", "Done"]
        );
        assert_eq!(
            default_columns(Language::Fr),
            ["À faire", "En cours", "À valider", "Terminé"]
        );
    }

    #[test]
    fn the_folder_keeps_the_name_it_already_has() {
        let dir = tempfile::tempdir().expect("dir");
        // Nothing on disk: the current language names it.
        assert_eq!(folder_name(dir.path(), Language::En, NO_PROJECT), "Inbox");
        assert_eq!(
            folder_name(dir.path(), Language::Fr, NO_PROJECT),
            "Sans projet"
        );
        // A folder made in French stays, whatever the language is now.
        std::fs::create_dir(dir.path().join("Sans projet")).expect("mkdir");
        assert_eq!(
            folder_name(dir.path(), Language::En, NO_PROJECT),
            "Sans projet"
        );
        // The same the other way round.
        let other = tempfile::tempdir().expect("dir");
        std::fs::create_dir(other.path().join("Inbox")).expect("mkdir");
        assert_eq!(folder_name(other.path(), Language::Fr, NO_PROJECT), "Inbox");
        // The current language wins when both exist.
        std::fs::create_dir(dir.path().join("Inbox")).expect("mkdir");
        assert_eq!(folder_name(dir.path(), Language::En, NO_PROJECT), "Inbox");
    }
}
