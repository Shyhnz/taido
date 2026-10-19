//! Tolerant decoding of hook payloads into state machine events.
//!
//! Field names checked against the real payloads of `fixtures/hooks/`:
//! `StopFailure.error`, `SessionEnd.reason`, `Notification.notification_type`. Unknown
//! fields are ignored; unknown events (`MessageDisplay`, future ones) decode to no event.

use serde_json::Value;

use crate::model::JournalKind;
use crate::state::machine::Event;

/// Name under which an agent's MCP `initialize` is recorded: the agent is ready (Codex sends
/// `SessionStart` only with the first message).
pub const AGENT_READY: &str = "AgentReady";

/// A decoded hook.
#[derive(Debug, Clone, PartialEq)]
pub struct Hook {
    /// `session_id` of the payload: the conversation it belongs to.
    pub session_id: Option<String>,
    /// `None` for events the state machine ignores.
    pub event: Option<Event>,
    /// What the session trace keeps of it: the user's message, Claude's reply,
    /// an error, a compaction.
    pub trace: Option<(JournalKind, String)>,
    /// The agent's transcript of the conversation (`transcript_path`): the context gauge
    /// reads it (`agents::usage`).
    pub transcript_path: Option<String>,
    /// The model, when the payload names it (Claude's `SessionStart`, every Codex hook).
    pub model: Option<String>,
}

/// Decodes `payload` as the event `name` (`hook_event_name`). Never fails: a payload that is
/// not a JSON object decodes without session and fields.
pub fn decode(name: &str, payload: &str) -> Hook {
    let json: Value = serde_json::from_str(payload).unwrap_or(Value::Null);
    let text = |key: &str| {
        json.get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|v| !v.is_empty())
    };
    let tool = || {
        (
            text("tool_name").unwrap_or_default(),
            json.get("tool_input").cloned().unwrap_or(Value::Null),
            text("cwd"),
        )
    };
    let event = match name {
        "SessionStart" => Some(Event::SessionStart {
            session_id: text("session_id"),
            source: text("source"),
        }),
        AGENT_READY => Some(Event::SessionStart {
            session_id: None,
            source: Some("startup".into()),
        }),
        "UserPromptSubmit" => Some(Event::UserPromptSubmit),
        // Codex: Escape in its terminal (Claude's is seen as typed text).
        "Interrupt" => Some(Event::Interrupt),
        "PreToolUse" => {
            let (tool_name, tool_input, cwd) = tool();
            Some(Event::PreToolUse {
                tool_name,
                tool_input,
                cwd,
            })
        }
        "PostToolUse" => {
            let (tool_name, tool_input, cwd) = tool();
            Some(Event::PostToolUse {
                tool_name,
                tool_input,
                cwd,
            })
        }
        "PostToolUseFailure" => {
            let (tool_name, tool_input, cwd) = tool();
            Some(Event::PostToolUseFailure {
                tool_name,
                tool_input,
                cwd,
            })
        }
        "PermissionRequest" => {
            let (tool_name, tool_input, cwd) = tool();
            Some(Event::PermissionRequest {
                tool_name,
                tool_input,
                cwd,
            })
        }
        "Notification" => Some(Event::Notification {
            notification_type: text("notification_type"),
        }),
        "Stop" => Some(Event::Stop {
            last_assistant_message: text("last_assistant_message"),
        }),
        "StopFailure" => Some(Event::StopFailure {
            error: text("error"),
        }),
        "SessionEnd" => Some(Event::SessionEnd {
            reason: text("reason"),
        }),
        _ => None,
    };
    let trace = match name {
        "UserPromptSubmit" => text("prompt").map(|t| (JournalKind::Prompt, t)),
        "Stop" => text("last_assistant_message").map(|t| (JournalKind::TurnEnded, t)),
        "StopFailure" => Some((
            JournalKind::Error,
            text("error").unwrap_or_else(|| "unknown".into()),
        )),
        "SessionStart" if text("source").as_deref() == Some("compact") => {
            Some((JournalKind::Compacted, String::new()))
        }
        _ => None,
    };
    Hook {
        session_id: text("session_id"),
        event,
        trace,
        transcript_path: text("transcript_path"),
        model: text("model"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::test_fixture;

    fn decoded(file: &str) -> Hook {
        let payload = test_fixture(file);
        let json: Value = serde_json::from_str(&payload).expect("json");
        let name = json["hook_event_name"].as_str().expect("name").to_string();
        decode(&name, &payload)
    }

    #[test]
    fn keeps_the_transcript_and_the_model() {
        let h = decoded("SessionStart-startup.json");
        assert!(h
            .transcript_path
            .as_deref()
            .is_some_and(|p| p.ends_with("f91558df-7993-4183-badd-bbeeeef25427.jsonl")));
        assert_eq!(h.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(decoded("Stop.json").model, None);
    }

    #[test]
    fn decodes_the_real_payloads() {
        let h = decoded("SessionStart-startup.json");
        assert_eq!(
            h.session_id.as_deref(),
            Some("f91558df-7993-4183-badd-bbeeeef25427")
        );
        assert_eq!(
            h.event,
            Some(Event::SessionStart {
                session_id: Some("f91558df-7993-4183-badd-bbeeeef25427".into()),
                source: Some("startup".into()),
            })
        );
        assert_eq!(
            decoded("UserPromptSubmit.json").event,
            Some(Event::UserPromptSubmit)
        );
        match decoded("PreToolUse-Bash.json").event {
            Some(Event::PreToolUse {
                tool_name,
                tool_input,
                cwd,
            }) => {
                assert_eq!(tool_name, "Bash");
                assert_eq!(tool_input["command"], "echo spike1 > /dev/null");
                assert_eq!(
                    cwd.as_deref(),
                    Some("/Users/user/todo-agents/sandbox/projet-test")
                );
            }
            other => panic!("unexpected {other:?}"),
        }
        match decoded("PostToolUse-Bash.json").event {
            Some(Event::PostToolUse {
                tool_name,
                tool_input,
                cwd,
            }) => {
                assert_eq!(tool_name, "Bash");
                assert_eq!(tool_input["command"], "echo spike1 > /dev/null");
                assert!(cwd.is_some());
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(matches!(
            decoded("PermissionRequest-Bash.json").event,
            Some(Event::PermissionRequest { tool_name, .. }) if tool_name == "Bash"
        ));
        assert_eq!(
            decoded("Notification-permission_prompt.json").event,
            Some(Event::Notification {
                notification_type: Some("permission_prompt".into())
            })
        );
        assert_eq!(
            decoded("Stop-question.json").event,
            Some(Event::Stop {
                last_assistant_message: Some("Tu veux un café ?".into())
            })
        );
        assert_eq!(
            decoded("SessionEnd-prompt_input_exit.json").event,
            Some(Event::SessionEnd {
                reason: Some("prompt_input_exit".into())
            })
        );
        assert_eq!(decoded("MessageDisplay.json").event, None);
    }

    #[test]
    fn decoding_is_tolerant() {
        assert_eq!(
            decode("StopFailure", r#"{"error":"rate_limit","extra":[1,2]}"#).event,
            Some(Event::StopFailure {
                error: Some("rate_limit".into())
            })
        );
        let h = decode("Stop", "not json");
        assert_eq!(h.session_id, None);
        assert_eq!(
            h.event,
            Some(Event::Stop {
                last_assistant_message: None
            })
        );
        assert!(matches!(
            decode("PostToolUseFailure", r#"{"tool_name":"Bash","tool_input":{"command":"x"}}"#)
                .event,
            Some(Event::PostToolUseFailure { tool_name, tool_input, cwd: None })
                if tool_name == "Bash" && tool_input["command"] == "x"
        ));
        assert_eq!(decode("Future", "{}").event, None);
        assert_eq!(decode("unknown", "{}").event, None);
        match decode("PreToolUse", r#"{"tool_name": 3}"#).event {
            Some(Event::PreToolUse {
                tool_name,
                tool_input,
                cwd,
            }) => {
                assert_eq!(tool_name, "");
                assert_eq!(tool_input, Value::Null);
                assert_eq!(cwd, None);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn keeps_the_trace_of_prompts_replies_errors_and_compactions() {
        let prompt = decoded("UserPromptSubmit.json").trace.expect("prompt");
        assert_eq!(prompt.0, JournalKind::Prompt);
        assert!(!prompt.1.is_empty());
        let reply = decoded("Stop.json").trace.expect("reply");
        assert_eq!(reply.0, JournalKind::TurnEnded);
        assert_eq!(
            decode("StopFailure", r#"{"error":"rate_limit"}"#).trace,
            Some((JournalKind::Error, "rate_limit".into()))
        );
        assert_eq!(
            decoded("SessionStart-compact.json").trace,
            Some((JournalKind::Compacted, String::new()))
        );
        assert_eq!(decoded("SessionStart-startup.json").trace, None);
        assert_eq!(decoded("PreToolUse-Bash.json").trace, None);
    }
}
