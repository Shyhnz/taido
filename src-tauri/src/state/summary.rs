//! Texts derived from Claude's messages and tools: question detection, the
//! Done sentence, tool and permission summaries, error lines. French, already truncated.

use std::path::Path;

use serde_json::Value;

use crate::i18n::{activity, Language};

/// Question line shown for Waiting(Question).
pub const QUESTION_MAX: usize = 160;
/// « Claude a fini · {première phrase} ».
pub const DONE_MAX: usize = 120;
/// `SessionSummary.last_reply`.
pub const REPLY_MAX: usize = 160;
/// « Commande : {commande} ».
pub const COMMAND_MAX: usize = 60;
/// Claude's last message as stored.
pub const LAST_MESSAGE_MAX: usize = 500;
/// File paths keep their end (the file name) within this length.
const PATH_MAX: usize = 60;
/// Sub-agent descriptions and unknown tool names.
const NAME_MAX: usize = 60;

/// Truncates to `max` characters, ending with an ellipsis when cut.
pub fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(max.saturating_sub(1)).collect();
    cut.truncate(cut.trim_end().len());
    cut.push('…');
    cut
}

/// Keeps the last `max` characters, starting with an ellipsis when cut (paths).
fn truncate_start(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let tail: String = text.chars().skip(count - (max - 1)).collect();
    format!("…{tail}")
}

/// Lines of a markdown message without fenced code blocks, emphasis or inline-code marks.
fn plain_lines(message: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut in_fence = false;
    for line in message.lines() {
        let start = line.trim_start();
        if start.starts_with("```") || start.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if !in_fence {
            lines.push(strip_markdown(line));
        }
    }
    lines
}

/// Removes emphasis (`*`, `**`, `__`, `~~`, `_word_`), inline-code backticks and leading
/// heading or quote markers; trims the line (non-breaking spaces included).
fn strip_markdown(line: &str) -> String {
    let line = line.trim().trim_start_matches(['#', '>']).trim_start();
    let line = line
        .replace("**", "")
        .replace("__", "")
        .replace("~~", "")
        .replace(['`', '*'], "");
    // A single `_` is emphasis only at a word boundary (`_mot_`), not inside `snake_case`.
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    for (i, &c) in chars.iter().enumerate() {
        if c == '_' {
            let before = i > 0 && chars[i - 1].is_alphanumeric();
            let after = chars.get(i + 1).is_some_and(|n| n.is_alphanumeric());
            if !(before && after) {
                continue;
            }
        }
        out.push(c);
    }
    out.trim().to_string()
}

/// The question Claude ends its turn with, if any: the last non-empty line of
/// the message, once code blocks and emphasis are removed, ending with « ? » (a non-breaking
/// space before it is fine). 160 characters max.
pub fn question(message: &str) -> Option<String> {
    let lines = plain_lines(message);
    let last = lines.iter().rev().find(|l| !l.is_empty())?;
    (last.ends_with('?') || last.ends_with('？')).then(|| truncate(last, QUESTION_MAX))
}

/// First sentence of the message, for « Claude a fini · … ». 120 characters max.
pub fn done_text(message: &str) -> Option<String> {
    first_sentence_text(message, DONE_MAX)
}

/// First sentence of Claude's last reply, for the one-line recap of a session in « Sessions
/// Claude ». 160 characters max.
pub fn reply_text(message: &str) -> Option<String> {
    first_sentence_text(message, REPLY_MAX)
}

/// First sentence of the first non-empty line, once code blocks and emphasis are removed.
fn first_sentence_text(message: &str, max: usize) -> Option<String> {
    let lines = plain_lines(message);
    let first = lines.iter().find(|l| !l.is_empty())?;
    Some(truncate(first_sentence(first), max))
}

/// Text up to the first `.`, `!`, `?` or `…` followed by a space (or the whole text).
fn first_sentence(text: &str) -> &str {
    let mut chars = text.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if matches!(c, '.' | '!' | '?' | '…') {
            if let Some((_, next)) = chars.peek() {
                if next.is_whitespace() {
                    return &text[..i + c.len_utf8()];
                }
            }
        }
    }
    text
}

/// Errors that stop the work until the user acts: they notify.
pub fn is_blocking_error(kind: &str) -> bool {
    matches!(
        kind,
        "authentication_failed"
            | "billing_error"
            | "account_on_hold"
            | "oauth_org_not_allowed"
            | "rate_limit"
    )
}

/// Activity of a Working session, from `PreToolUse`.
pub fn activity(lang: Language, tool_name: &str, input: &Value, cwd: Option<&str>) -> String {
    summary(lang, tool_name, input, cwd, false)
}

/// Summary of a permission request: as the activity, with the domain for web
/// tools.
pub fn permission(lang: Language, tool_name: &str, input: &Value, cwd: Option<&str>) -> String {
    summary(lang, tool_name, input, cwd, true)
}

fn summary(
    lang: Language,
    tool_name: &str,
    input: &Value,
    cwd: Option<&str>,
    permission: bool,
) -> String {
    let field = |key: &str| {
        input
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
    };
    match tool_name {
        "Bash" => match field("command") {
            Some(cmd) => activity::command_with(lang, &truncate(&one_line(cmd), COMMAND_MAX)),
            None => activity::command(lang).into(),
        },
        "Edit" | "MultiEdit" | "Write" => with_file(activity::edit(lang), field("file_path"), cwd),
        "Read" => with_file(activity::read(lang), field("file_path"), cwd),
        "Grep" | "Glob" => activity::code_search(lang).into(),
        "WebFetch" | "WebSearch" => match field("url").and_then(domain).filter(|_| permission) {
            Some(domain) => format!("{} · {domain}", activity::web_search(lang)),
            None => activity::web_search(lang).into(),
        },
        "Task" | "Agent" => match field("description") {
            Some(d) => activity::sub_agent_with(lang, &truncate(&one_line(d), NAME_MAX)),
            None => activity::sub_agent(lang).into(),
        },
        name => match mcp_server(name) {
            Some(server) => activity::mcp_tool(lang, server),
            None => truncate(name, NAME_MAX),
        },
    }
}

/// Collapses whitespace runs (newlines included) into single spaces.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// « Édition src/app.ts »: the path relative to the session's folder when inside it.
fn with_file(verb: &str, path: Option<&str>, cwd: Option<&str>) -> String {
    let Some(path) = path else {
        return verb.to_string();
    };
    let shown = cwd
        .and_then(|cwd| Path::new(path).strip_prefix(cwd).ok())
        .map(|rel| rel.to_string_lossy().into_owned())
        .filter(|rel| !rel.is_empty())
        .unwrap_or_else(|| path.to_string());
    format!("{verb} {}", truncate_start(&shown, PATH_MAX))
}

/// Host of a URL (`https://user@docs.rs:443/x` → `docs.rs:443`), lowercase.
fn domain(url: &str) -> Option<String> {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?.to_lowercase();
    (!host.is_empty()).then_some(host)
}

/// `mcp__github__create_issue` → `github`.
fn mcp_server(tool_name: &str) -> Option<&str> {
    let rest = tool_name.strip_prefix("mcp__")?;
    let server = rest.split("__").next()?;
    (!server.is_empty()).then_some(server)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::hooks::test_fixture;

    fn fixture_field(name: &str, field: &str) -> Value {
        let v: Value = serde_json::from_str(&test_fixture(name)).expect("json");
        v.get(field).cloned().expect("field")
    }

    fn fixture_text(name: &str, field: &str) -> String {
        fixture_field(name, field)
            .as_str()
            .expect("string")
            .to_string()
    }

    #[test]
    fn questions_from_real_messages() {
        assert_eq!(
            question(&fixture_text(
                "Stop-question.json",
                "last_assistant_message"
            ))
            .as_deref(),
            Some("Tu veux un café ?")
        );
        assert_eq!(
            question(&fixture_text("Stop.json", "last_assistant_message")),
            None
        );
        assert_eq!(
            question(&fixture_text(
                "Stop-after-deny.json",
                "last_assistant_message"
            )),
            None
        );
    }

    #[test]
    fn question_detection_rules() {
        let cases: &[(&str, Option<&str>)] = &[
            ("Tu veux un café ?", Some("Tu veux un café ?")),
            ("On continue\u{a0}?", Some("On continue\u{a0}?")),
            (
                "On continue\u{202f}?   \n\n  ",
                Some("On continue\u{202f}?"),
            ),
            ("Je lance ?\nC'est fait.", None),
            ("Voici :\n```rust\nlet x = a?;\n```", None),
            (
                "Je propose ceci.\n```\nfoo\n```\n**On y va ?**",
                Some("On y va ?"),
            ),
            (
                "Tu préfères `snake_case` ou _camelCase_ ?",
                Some("Tu préfères snake_case ou camelCase ?"),
            ),
            ("## Prêt à fusionner ?", Some("Prêt à fusionner ?")),
            ("", None),
            ("   ", None),
        ];
        for (message, expected) in cases {
            assert_eq!(question(message).as_deref(), *expected, "{message:?}");
        }
        let long = format!("{} ?", "mot ".repeat(100));
        let q = question(&long).expect("question");
        assert_eq!(q.chars().count(), QUESTION_MAX);
        assert!(q.ends_with('…'));
    }

    #[test]
    fn done_text_is_the_first_sentence() {
        assert_eq!(
            done_text(&fixture_text("Stop.json", "last_assistant_message")).as_deref(),
            Some("OK")
        );
        let deny = done_text(&fixture_text(
            "Stop-after-deny.json",
            "last_assistant_message",
        ))
        .expect("text");
        assert!(deny.starts_with("Je n'ai pas pu créer spike-2.txt : un hook a refusé"));
        assert!(deny.chars().count() <= DONE_MAX);
        let cases: &[(&str, Option<&str>)] = &[
            ("C'est fait. Les tests passent.", Some("C'est fait.")),
            ("Fait ! Ensuite on verra.", Some("Fait !")),
            (
                "Version 2.1.288 installée",
                Some("Version 2.1.288 installée"),
            ),
            ("\n\n**Terminé.** Rien d'autre.", Some("Terminé.")),
            (
                "```\ncode\n```\nRésultat prêt… Voilà.",
                Some("Résultat prêt…"),
            ),
            ("", None),
        ];
        for (message, expected) in cases {
            assert_eq!(done_text(message).as_deref(), *expected, "{message:?}");
        }
        let long = "a".repeat(300);
        assert_eq!(done_text(&long).expect("text").chars().count(), DONE_MAX);
    }

    #[test]
    fn tool_summaries_from_real_payloads() {
        let input = fixture_field("PreToolUse-Bash.json", "tool_input");
        assert_eq!(
            activity(Language::Fr, "Bash", &input, None),
            "Commande : echo spike1 > /dev/null"
        );
        let input = fixture_field("PermissionRequest-Bash.json", "tool_input");
        assert_eq!(
            permission(Language::Fr, "Bash", &input, None),
            "Commande : touch spike-1.txt"
        );
    }

    #[test]
    fn tool_summary_rules() {
        let cwd = Some("/Users/me/app");
        let cases: Vec<(&str, Value, &str, &str)> = vec![
            (
                "Bash",
                json!({"command": format!("npm test -- --watch=false {}", "x".repeat(80))}),
                "",
                "",
            ),
            (
                "Bash",
                json!({"command": "cd web &&\n  npm   run build"}),
                "Commande : cd web && npm run build",
                "Commande : cd web && npm run build",
            ),
            ("Bash", json!({}), "Commande", "Commande"),
            (
                "Edit",
                json!({"file_path": "/Users/me/app/src/main.rs"}),
                "Édition src/main.rs",
                "Édition src/main.rs",
            ),
            (
                "MultiEdit",
                json!({"file_path": "/elsewhere/notes.md"}),
                "Édition /elsewhere/notes.md",
                "Édition /elsewhere/notes.md",
            ),
            (
                "Write",
                json!({"file_path": "/Users/me/app/README.md"}),
                "Édition README.md",
                "Édition README.md",
            ),
            (
                "Read",
                json!({"file_path": "/Users/me/app/Cargo.toml"}),
                "Lecture Cargo.toml",
                "Lecture Cargo.toml",
            ),
            (
                "Grep",
                json!({"pattern": "fn"}),
                "Recherche dans le code",
                "Recherche dans le code",
            ),
            (
                "Glob",
                json!({"pattern": "**/*.rs"}),
                "Recherche dans le code",
                "Recherche dans le code",
            ),
            (
                "WebFetch",
                json!({"url": "https://User@Docs.rs:443/axum?x=1", "prompt": "p"}),
                "Recherche web",
                "Recherche web · docs.rs:443",
            ),
            (
                "WebSearch",
                json!({"query": "tauri 2 channels"}),
                "Recherche web",
                "Recherche web",
            ),
            (
                "mcp__github__create_issue",
                json!({}),
                "Outil github",
                "Outil github",
            ),
            (
                "Task",
                json!({"description": "Explore the codebase"}),
                "Sous-agent : Explore the codebase",
                "Sous-agent : Explore the codebase",
            ),
            ("Agent", json!({}), "Sous-agent", "Sous-agent"),
            ("NotebookEdit", json!({}), "NotebookEdit", "NotebookEdit"),
        ];
        for (tool, input, act, perm) in cases {
            if act.is_empty() {
                let a = activity(Language::Fr, tool, &input, cwd);
                assert!(a.starts_with("Commande : npm test"), "{a}");
                assert_eq!(a.chars().count(), "Commande : ".len() + COMMAND_MAX);
                assert!(a.ends_with('…'));
                continue;
            }
            assert_eq!(
                activity(Language::Fr, tool, &input, cwd),
                act,
                "{tool} activity"
            );
            assert_eq!(
                permission(Language::Fr, tool, &input, cwd),
                perm,
                "{tool} permission"
            );
        }
        let deep = format!("/Users/me/app/{}/file.rs", "dir/".repeat(30));
        let s = activity(Language::Fr, "Edit", &json!({ "file_path": deep }), cwd);
        assert!(s.starts_with("Édition …") && s.ends_with("/file.rs"), "{s}");
    }

    #[test]
    fn blocking_errors() {
        assert!(is_blocking_error("rate_limit") && !is_blocking_error("overloaded"));
    }
}
