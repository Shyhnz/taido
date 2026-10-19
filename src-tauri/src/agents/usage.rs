//! How full a conversation's context is (the tab's gauge, 2026-10-11): read from the
//! end of the agent's own transcript, whose path every hook payload carries
//! (`transcript_path`). Nothing is sent anywhere and no token is spent.
//!
//! - Claude Code writes one JSON line per message; an assistant line holds `message.model`
//!   and `message.usage`. The context in use is what the last request sent: `input_tokens +
//!   cache_creation_input_tokens + cache_read_input_tokens`. The window is not written down:
//!   it comes from the model (`context_limit`).
//! - Codex writes `event_msg` lines of type `token_count` with `info.last_token_usage`,
//!   `info.model_context_window` and `rate_limits.primary.used_percent`; its model is in the
//!   `turn_context` lines.
//!
//! Both formats are recognised line by line, so the agent of the session does not matter.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde_json::Value;

use crate::model::ContextUsage;

/// Only the end of the transcript is read: the last usage is always near it, and a long
/// session's file runs into megabytes.
const TAIL_BYTES: u64 = 512 * 1024;

/// Window of Claude models released before the 1M context (Haiku 4.5, Sonnet 4.5…).
const CLAUDE_SMALL: u32 = 200_000;
const CLAUDE_LARGE: u32 = 1_000_000;

/// Context of the conversation whose transcript is at `path`; `None` when the file cannot
/// be read or holds no usage yet. `model_hint` is the hook's `model`, used when the
/// transcript does not name one.
pub fn read(path: &Path, model_hint: Option<&str>) -> Option<ContextUsage> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    // A tail starting mid-line: its first, partial line is not JSON and is skipped.
    from_lines(text.lines(), model_hint)
}

/// The last usage found in `lines` (oldest first).
pub fn from_lines<'a>(
    lines: impl DoubleEndedIterator<Item = &'a str>,
    model_hint: Option<&str>,
) -> Option<ContextUsage> {
    let mut found: Option<Found> = None;
    let mut codex_model: Option<String> = None;
    for line in lines.rev() {
        if !line.contains("usage") && !line.contains("turn_context") {
            continue;
        }
        let Ok(json) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if found.is_none() {
            found = claude_line(&json).or_else(|| codex_line(&json));
            if matches!(found, Some(Found::Claude { .. })) {
                break;
            }
        } else if let Some(model) = codex_turn_model(&json) {
            codex_model = Some(model);
            break;
        }
    }
    match found? {
        Found::Claude { used, model } => {
            let model = model.or_else(|| model_hint.map(str::to_string));
            let limit = context_limit(model.as_deref().unwrap_or_default(), used);
            Some(usage(used, limit, model, None))
        }
        Found::Codex { used, limit, plan } => {
            let model = codex_model.or_else(|| model_hint.map(str::to_string));
            Some(usage(used, limit.max(used), model, plan))
        }
    }
}

enum Found {
    Claude {
        used: u32,
        model: Option<String>,
    },
    Codex {
        used: u32,
        limit: u32,
        plan: Option<f64>,
    },
}

fn int(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn clamp(n: u64) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// A main-conversation assistant message of Claude Code with its usage.
fn claude_line(json: &Value) -> Option<Found> {
    if json.get("type").and_then(Value::as_str) != Some("assistant")
        || json.get("isSidechain").and_then(Value::as_bool) == Some(true)
    {
        return None;
    }
    let message = json.get("message")?;
    let model = message.get("model").and_then(Value::as_str);
    // Claude Code's own placeholder messages (errors, interruptions) carry zero usage.
    if model == Some("<synthetic>") {
        return None;
    }
    let u = message.get("usage")?;
    let used = int(u, "input_tokens")
        + int(u, "cache_creation_input_tokens")
        + int(u, "cache_read_input_tokens");
    if used == 0 {
        return None;
    }
    Some(Found::Claude {
        used: clamp(used),
        model: model.map(str::to_string),
    })
}

/// A Codex `token_count` event with its usage.
fn codex_line(json: &Value) -> Option<Found> {
    let payload = json.get("payload")?;
    if payload.get("type").and_then(Value::as_str) != Some("token_count") {
        return None;
    }
    let info = payload.get("info")?;
    let last = info.get("last_token_usage")?;
    let used = int(last, "total_tokens").max(int(last, "input_tokens"));
    let limit = int(info, "model_context_window");
    if used == 0 || limit == 0 {
        return None;
    }
    let plan = payload
        .pointer("/rate_limits/primary/used_percent")
        .and_then(Value::as_f64);
    Some(Found::Codex {
        used: clamp(used),
        limit: clamp(limit),
        plan,
    })
}

fn codex_turn_model(json: &Value) -> Option<String> {
    if json.get("type").and_then(Value::as_str) != Some("turn_context") {
        return None;
    }
    json.pointer("/payload/model")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Window of a Claude model (docs: every model since the 4.6 generation has 1M tokens; Haiku
/// 4.5 and older ones 200k). `[1m]` asks for the large window explicitly; an alias (`opus`)
/// or an unknown name is a current model. A session already past the window found is on the
/// large one (a plan or a setting Taido cannot see).
pub fn context_limit(model: &str, used: u32) -> u32 {
    let m = model.to_ascii_lowercase();
    let small = !m.contains("[1m]")
        && matches!(claude_version(&m), Some((major, minor)) if major < 4 || (major == 4 && minor < 6));
    let limit = if small { CLAUDE_SMALL } else { CLAUDE_LARGE };
    if used > limit {
        CLAUDE_LARGE.max(used)
    } else {
        limit
    }
}

/// (major, minor) of `claude-<family>-<major>[-<minor>]` or of the older
/// `claude-<major>-<minor>-<family>`.
fn claude_version(model: &str) -> Option<(u32, u32)> {
    let rest = model.split('[').next()?.strip_prefix("claude-")?;
    // Dated snapshots (`-20251001`) are longer than two digits.
    let mut parts = rest
        .split('-')
        .filter(|p| p.len() <= 2 && p.chars().all(|c| c.is_ascii_digit()));
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    Some((major, minor))
}

fn usage(used: u32, limit: u32, model: Option<String>, plan: Option<f64>) -> ContextUsage {
    let percent = if limit == 0 {
        0
    } else {
        ((u64::from(used) * 100 + u64::from(limit) / 2) / u64::from(limit)).min(100) as u8
    };
    ContextUsage {
        used,
        limit,
        percent,
        model: model.as_deref().map(model_label),
        plan_percent: plan.map(|p| p.clamp(0.0, 100.0).round() as u8),
    }
}

/// « Opus 5.5 » for `claude-opus-5-5`; other names are kept as they are.
pub fn model_label(model: &str) -> String {
    let base = model.split('[').next().unwrap_or(model);
    let Some(rest) = base.strip_prefix("claude-") else {
        // A Claude alias (`opus`) reads as a name; other tools' ids are kept.
        return if base.contains('-') {
            base.to_string()
        } else {
            capitalize(base)
        };
    };
    let mut parts = rest.split('-');
    let Some(family) = parts.next() else {
        return model.to_string();
    };
    // A dated snapshot (`-20251001`) is not part of the version.
    let version: Vec<&str> = parts
        .take_while(|p| p.len() <= 2 && p.chars().all(|c| c.is_ascii_digit()))
        .collect();
    let mut label = capitalize(family);
    if !version.is_empty() {
        label.push(' ');
        label.push_str(&version.join("."));
    }
    label
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLAUDE: &str = r#"{"type":"user","message":{"role":"user","content":"x"}}
{"type":"assistant","message":{"model":"claude-opus-5-5","usage":{"input_tokens":2,"cache_creation_input_tokens":1048,"cache_read_input_tokens":148342,"output_tokens":280}}}
{"type":"assistant","isSidechain":true,"message":{"model":"claude-haiku-5-5","usage":{"input_tokens":900000}}}
{"type":"assistant","message":{"model":"<synthetic>","usage":{"input_tokens":0}}}
{"type":"user","message":{"role":"user","content":"y"}}"#;

    const CODEX: &str = r#"{"type":"turn_context","payload":{"model":"gpt-6-luna"}}
{"type":"event_msg","payload":{"type":"token_count","info":null}}
{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":18307,"cached_input_tokens":11008,"output_tokens":16,"total_tokens":18323},"model_context_window":258400},"rate_limits":{"primary":{"used_percent":2.0}}}}
{"type":"event_msg","payload":{"type":"agent_message","message":"OK"}}"#;

    #[test]
    fn reads_the_last_main_claude_message() {
        let u = from_lines(CLAUDE.lines(), None).expect("usage");
        assert_eq!(u.used, 149_392);
        assert_eq!(u.limit, 1_000_000);
        assert_eq!(u.percent, 15);
        assert_eq!(u.model.as_deref(), Some("Opus 5.5"));
        assert_eq!(u.plan_percent, None);
    }

    #[test]
    fn reads_codex_token_counts() {
        let u = from_lines(CODEX.lines(), Some("ignored")).expect("usage");
        assert_eq!(u.used, 18_323);
        assert_eq!(u.limit, 258_400);
        assert_eq!(u.percent, 7);
        assert_eq!(u.model.as_deref(), Some("gpt-6-luna"));
        assert_eq!(u.plan_percent, Some(2));
    }

    #[test]
    fn nothing_without_usage() {
        assert_eq!(from_lines("{}\nnot json\n".lines(), None), None);
        assert_eq!(from_lines(std::iter::empty(), None), None);
    }

    #[test]
    fn claude_windows() {
        assert_eq!(context_limit("claude-opus-5-5", 10), 1_000_000);
        assert_eq!(context_limit("claude-haiku-4-5", 10), 200_000);
        assert_eq!(context_limit("claude-sonnet-4-5", 10), 200_000);
        assert_eq!(context_limit("claude-sonnet-4-5[1m]", 10), 1_000_000);
        assert_eq!(context_limit("claude-haiku-4-5-20251001", 10), 200_000);
        assert_eq!(context_limit("claude-sonnet-4-6", 10), 1_000_000);
        assert_eq!(context_limit("", 10), 1_000_000);
        assert_eq!(context_limit("claude-3-5-sonnet-20241022", 10), 200_000);
        assert_eq!(context_limit("opus", 10), 1_000_000);
        // Past the window found: the large one.
        assert_eq!(context_limit("claude-haiku-4-5", 250_000), 1_000_000);
    }

    #[test]
    fn model_labels() {
        assert_eq!(model_label("claude-opus-5-5"), "Opus 5.5");
        assert_eq!(model_label("claude-opus-5"), "Opus 5");
        assert_eq!(model_label("claude-sonnet-4-5[1m]"), "Sonnet 4.5");
        assert_eq!(model_label("claude-haiku-4-5-20251001"), "Haiku 4.5");
        assert_eq!(model_label("claude-fable-5-1"), "Fable 5.1");
        assert_eq!(model_label("opus"), "Opus");
        assert_eq!(model_label("gpt-6-luna"), "gpt-6-luna");
    }

    #[test]
    fn reads_the_tail_of_a_file() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, CLAUDE).expect("write");
        assert_eq!(read(&path, None).map(|u| u.used), Some(149_392));
        assert_eq!(read(&dir.path().join("missing"), None), None);
    }
}
