//! Reading the agent's output, one JSON line at a time: Claude Code's `--output-format
//! stream-json` and Codex's `exec --json` (real runs in `fixtures/ask/`). The Taido tools are
//! reported by the MCP server itself (titles resolved); here only the file tools and the end.

use serde_json::Value;

use super::{AskStep, RawAnswer};
use crate::model::Agent;

/// What one line says.
#[derive(Debug, Clone, PartialEq)]
pub enum Line {
    /// The agent uses one of its own file tools.
    Step(AskStep),
    /// The final answer.
    Answer(RawAnswer),
    /// The agent stopped on an error (its message).
    Failed(String),
    Other,
}

pub fn parse(agent: Agent, line: &str) -> Line {
    let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
        return Line::Other;
    };
    match agent {
        Agent::Claude => claude(&v),
        Agent::Codex => codex(&v),
    }
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn claude(v: &Value) -> Line {
    match str_of(v, "type") {
        "assistant" => {
            let content = v
                .pointer("/message/content")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for c in content {
                if str_of(&c, "type") != "tool_use" {
                    continue;
                }
                let input = c.get("input").cloned().unwrap_or(Value::Null);
                let step = match str_of(&c, "name") {
                    "Read" => AskStep::ReadFile {
                        path: str_of(&input, "file_path").to_string(),
                    },
                    "Grep" => AskStep::SearchFiles {
                        pattern: str_of(&input, "pattern").to_string(),
                    },
                    "Glob" => AskStep::SearchFiles {
                        pattern: str_of(&input, "pattern").to_string(),
                    },
                    _ => continue,
                };
                return Line::Step(step);
            }
            Line::Other
        }
        "result" => {
            if v.get("is_error").and_then(Value::as_bool) == Some(true)
                || str_of(v, "subtype") != "success"
            {
                let msg = str_of(v, "result");
                return Line::Failed(if msg.is_empty() {
                    str_of(v, "subtype").to_string()
                } else {
                    msg.to_string()
                });
            }
            if let Some(answer) = v
                .get("structured_output")
                .and_then(|s| serde_json::from_value::<RawAnswer>(s.clone()).ok())
            {
                return Line::Answer(answer);
            }
            Line::Answer(answer_from_text(str_of(v, "result")))
        }
        _ => Line::Other,
    }
}

fn codex(v: &Value) -> Line {
    match str_of(v, "type") {
        "item.started" => {
            let item = v.get("item").cloned().unwrap_or(Value::Null);
            if str_of(&item, "type") == "command_execution" {
                return Line::Step(AskStep::RunCommand {
                    command: inner_command(str_of(&item, "command")),
                });
            }
            Line::Other
        }
        "item.completed" => {
            let item = v.get("item").cloned().unwrap_or(Value::Null);
            if str_of(&item, "type") == "agent_message" {
                return Line::Answer(answer_from_text(str_of(&item, "text")));
            }
            Line::Other
        }
        "turn.failed" => Line::Failed(
            v.pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("turn failed")
                .to_string(),
        ),
        "error" => Line::Failed(str_of(v, "message").to_string()),
        _ => Line::Other,
    }
}

/// `/bin/zsh -lc 'cat a.txt'` → `cat a.txt`.
fn inner_command(command: &str) -> String {
    for shell in ["-lc ", "-c "] {
        if let Some(at) = command.find(shell) {
            let rest = command[at + shell.len()..].trim();
            return rest
                .strip_prefix('\'')
                .and_then(|r| r.strip_suffix('\''))
                .unwrap_or(rest)
                .to_string();
        }
    }
    command.to_string()
}

/// The answer's JSON, maybe inside a ```json fence or after some text; otherwise the text
/// itself as an answer without sources.
pub fn answer_from_text(text: &str) -> RawAnswer {
    let trimmed = text.trim();
    if let Ok(a) = serde_json::from_str::<RawAnswer>(trimmed) {
        return a;
    }
    if let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}')) {
        if start < end {
            if let Ok(a) = serde_json::from_str::<RawAnswer>(&trimmed[start..=end]) {
                return a;
            }
        }
    }
    RawAnswer {
        answer: trimmed.to_string(),
        sources: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/ask/");
        std::fs::read_to_string(format!("{path}{name}")).expect("fixture")
    }

    fn lines(agent: Agent, text: &str) -> Vec<Line> {
        text.lines()
            .map(|l| parse(agent, l))
            .filter(|l| *l != Line::Other)
            .collect()
    }

    #[test]
    fn claude_real_stream() {
        let got = lines(Agent::Claude, &fixture("claude-stream.jsonl"));
        assert_eq!(got.len(), 2, "{got:?}");
        assert!(
            matches!(&got[0], Line::Step(AskStep::ReadFile { path }) if path.ends_with("a.txt"))
        );
        let Line::Answer(a) = &got[1] else {
            panic!("{got:?}")
        };
        assert_eq!(a.sources.len(), 1);
        assert_eq!(a.sources[0].kind, "file");
        assert_eq!(a.sources[0].quote, "Le prix pilote est de 25 euros.");
    }

    #[test]
    fn codex_real_stream() {
        let got = lines(Agent::Codex, &fixture("codex-stream.jsonl"));
        assert_eq!(
            got[0],
            Line::Step(AskStep::RunCommand {
                command: "cat a.txt".into()
            })
        );
        let Line::Answer(a) = got.last().expect("answer") else {
            panic!("{got:?}")
        };
        assert_eq!(a.answer, "25 €");
        assert_eq!(a.sources[0].reference, "a.txt");
    }

    #[test]
    fn claude_error_result() {
        let l = r#"{"type":"result","subtype":"error_max_turns","is_error":true,"result":""}"#;
        assert_eq!(
            parse(Agent::Claude, l),
            Line::Failed("error_max_turns".into())
        );
    }

    #[test]
    fn text_answers() {
        let fenced = "Voici :\n```json\n{\"answer\":\"Oui\",\"sources\":[]}\n```";
        assert_eq!(answer_from_text(fenced).answer, "Oui");
        let plain = answer_from_text("Je n'ai rien trouvé.");
        assert_eq!(plain.answer, "Je n'ai rien trouvé.");
        assert!(plain.sources.is_empty());
    }
}
