# Taido

Desktop to-do app (Tauri 2, macOS first) where each task is a workspace hosting terminals: Claude Code, Codex, shells, commands.
The Rust core tracks agent sessions through their HTTP hooks and derives a status ring per task.
The React UI only renders view models from the core and sends commands.
Data is 100 % local (SQLite). Sync with your own server is optional (`docs/SYNC.md`).
Licence: AGPL-3.0-or-later (`LICENSE`, `NOTICE`).

## Commands

| Purpose | Command |
| --- | --- |
| Install | `pnpm install` |
| Dev app | `pnpm tauri dev` |
| All checks | `pnpm check` (Biome, tsc, Vitest, fake-claude, then rustfmt / clippy `-D warnings` / cargo test of src-tauri, crates/sync-proto and sync-server, mobile build, phone ↔ server e2e) |
| Mobile web app | `pnpm dev:mobile` / `pnpm build:mobile` (→ `mobile/dist`) |
| Sync server | `cd sync-server && cargo run -- serve` (see `sync-server/README.md`) |
| TS lint / fix | `pnpm lint` / `pnpm lint:fix` |
| TS tests | `pnpm test` |
| Rust tests | `cd src-tauri && cargo test` |
| Build | `pnpm tauri build` |

Rust toolchain via rustup; package manager pnpm.

## Architecture

```text
src/                 React 19 + TS strict + Vite (UI only, strings in src/i18n/, English default and French)
src-tauri/src/       Rust core
  db/ pty/ agents/ hooks/ state/ views/ notify/ commands/ sync/ env.rs   (agents/ = Claude Code and Codex)
tools/fake-claude/   fake `claude` binary for tests (no tokens)
tools/fake-codex/    fake `codex` binary for tests (no tokens)
crates/sync-proto/   sync wire protocol shared by core and server (TS mirror: src/lib/sync-proto.ts)
sync-server/         optional sync server (axum + SQLite, accounts by e-mail), serves the PWA; Docker files
mobile/ src/mobile/  installable web app for Android (same React UI, IndexedDB backend)
fixtures/hooks/      real hook payloads captured from Claude Code
docs/                SYNC.md (sync protocol and mobile app), brand/ (icons)
```

UI ↔ core: Tauri commands (invoke) + events; terminal output streamed as raw bytes over Tauri channels.
Claude Code ↔ core: HTTP hooks and an MCP server (`POST /mcp`, tools that add tasks, subtasks and note text) on an axum server on 127.0.0.1 (random port + token), configured via `--settings` and `--mcp-config`.

## Rules

- Verify every API (Tauri 2, plugins, xterm.js, Claude Code hooks) in current official docs before using it; never invent signatures. Note the versions you relied on in the commit message.
- Never touch `~/.claude/settings.json`, `~/.claude.json`, or any task working folder (no `.claude/`, no `TASK.md`). Configure Claude Code only via CLI flags.
- Automated tests use `fake-claude`, never real Claude. Real Claude only for spikes/demo, with tiny prompts ("Réponds juste OK").
- All business logic lives in the Rust core; the UI renders view models.
- Test folders: temp dirs, or `./sandbox/` (git-ignored). No telemetry; the only network use is the opt-in sync account and the one-time dictation-model download.
- Code, identifiers, comments, commits in English (Conventional Commits); UI in French.
- Spawn processes with argument arrays, never by concatenating user text into a shell command (except "command" terminals).
- No `unwrap()` in production paths.
- Product ambiguity → propose 2 options and ask. Technical ambiguity → take the simplest option and say so in the commit message. Unspecified UI detail → do as Todoist.

## Glossary (UI français → code)

Projet `subject` · Section `section` · Tâche `task` · Sous-tâche `subtask` · Sans projet `inbox` ·
Terminal `terminal` (one process launch) · Session d'agent `agent_session` (one Claude conversation, `session_id`) ·
Rond d'état `TaskRing`/`ring` · Deuxième ligne `line` · Journal `journal` · Aujourd'hui `today` ·
Claude attend `waiting` · Ajout rapide `quick_add` · Mode focus `focus_mode` · Carnet `notebook` · Page `note_page` · Groupe `note_group`.
"Dossier" in the UI means only the on-disk folder of a project (`root_path`, optional).
