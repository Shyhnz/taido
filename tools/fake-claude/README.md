# fake-claude

A fake `claude` binary for tests: no tokens spent. Dependency-free Node script
(Node >= 20). Point the app at it with `TAIDO_CLAUDE_BIN=tools/fake-claude/fake-claude`.

Tests: `node --test tools/fake-claude/test`.

## Options

`--session-id <id>`, `--resume <id>`, `--settings <file or JSON>`, `--name <title>`,
`--permission-mode <mode>`, `--append-system-prompt-file <file>` (ignored),
`--mcp-config <file>` (the app's MCP server, used by `/mcp`), a positional prompt (starts the
first turn), and `--script <file>` (see below). Other flags are ignored.

Environment:

- `TAIDO_FAKE_SPEED` (float, default 1) divides every delay (turn steps, Stop,
  permission reminder, `/wait`). Hook timeouts are not scaled.
- `TAIDO_FAKE_DEBUG=1` logs each hook result on stderr.

## Output

Kept for compatibility (Rust tests rely on them): `fake-claude started`, one `ARG:<arg>`
line per argument, `CWD:<cwd>`, `TERMINAL:<$TAIDO_TERMINAL_ID>`, `TOKEN:set|unset`,
`NESTED:yes|no` (`CLAUDECODE` set or not), `READY`, then `GOT:<line>` for each ordinary
line. Added: `SESSION:<session_id>` after `READY` and after `/clear`, `DECISION:<body>` when
a `PermissionRequest` hook answers, `Interrupted` after Escape.

## Hooks

The `--settings` hooks are sent like Claude Code does, with payloads shaped like
`fixtures/hooks/*.json`:

- `http`: POST JSON to `url`; `$VAR` / `${VAR}` in `headers` take the environment value
  when `VAR` is in `allowedEnvVars`, an empty string otherwise; `timeout` in seconds
  (600 when absent).
- `command`: `/bin/sh -c <command>`, the payload on stdin (the app's `SessionStart` curl
  relay).
- Matchers: absent, `""` or `"*"` match everything; otherwise exact name or regex. They
  apply to `tool_name` (tool events), `source` (SessionStart), `reason` (SessionEnd),
  `notification_type` (Notification) and `error` (StopFailure).
- Failures and timeouts are ignored (non-blocking). Hooks of an event run in parallel and
  are awaited before the next step.

At start: `SessionStart(startup)`, or `SessionStart(resume)` with `--resume`.

## Line commands

| Line | Behaviour |
| --- | --- |
| ordinary text (`Oui`, `Non`…) | `GOT:<line>`, `UserPromptSubmit`, then `PreToolUse`/`PostToolUse` (Bash `echo step N`) every 500 ms, `Stop` after 3 s (`OK, c'est fait.`) |
| `/p` | `PreToolUse`, then `PermissionRequest`; the dialog (`Do you want to proceed?`) shows at once. A hook decision `allow` → `PostToolUse`, `Stop`; `deny` → `Stop`; `{}` → the terminal answers. A typed `1`/`2`/`y`/`yes`/`oui`/empty line allows, `3`/`n`/`no`/`non` rejects (no hook); a typed answer also wins while the request is still held. Any other input after `{}` closes the dialog like Escape and is then handled normally. After 6 s without an answer: `Notification(permission_prompt)` |
| `/q` | `Stop` with `Tu veux un café ?` |
| `/e` | `StopFailure` (`error: rate_limit`) |
| `/n` | `Notification(idle_prompt)` |
| `/clear` | `SessionEnd(clear)`, then `SessionStart(clear)` with a new `session_id` |
| `/mcp <tool> [json]` | Calls a tool of the first `--mcp-config` server like Claude Code 2.1.289: `initialize`, `notifications/initialized`, `tools/call`, `${VAR}` headers from the environment. Prints `MCP:<response body>` or `MCP-ERROR:<reason>` |
| `/x` | exit code 1, no `SessionEnd` (crash) |
| `/exit`, `exit`, Ctrl+D, end of stdin | `SessionEnd(prompt_input_exit)`, exit 0 |
| Escape alone (`0x1b`) | interrupts the running turn or dialog, no hook, prints `Interrupted` |

Lines typed during a turn are queued until it ends, like Claude Code. Closing the terminal
(SIGHUP, or stdin closing in a PTY) sends `SessionEnd(other)`; SIGTERM exits without hooks.

Input: in a TTY, raw mode (echo, Enter, backspace, Escape, Ctrl+D, Ctrl+C interrupts or
clears the line, arrow keys ignored); otherwise lines from stdin (a line holding only
`0x1b` is Escape).

## Script mode

`--script <file>`: one command per line, fed in order, then exit 0 (stdin unused). Extras:

- `/wait <ms>`: waits until every previous line is being handled, then `<ms>` (scaled by
  the speed). Use it before Escape, or before the terminal answer to a `/p` when the hook
  decision must arrive first.
- `/esc` (or a line holding only `0x1b`): Escape, at that moment.

Example: `Bonjour`, `/wait 1200`, `/esc`, `/exit` interrupts the turn after two tool steps.
