# Contributing to Taido

Thanks for helping. Taido is a Tauri 2 app: a Rust core and a React UI. Read `CLAUDE.md` for the architecture in one page.

## Before you start

For anything bigger than a small fix, open an issue first so we can agree on the approach. It saves you a rewrite.

## Setup

You need Node.js, pnpm, the Rust toolchain (rustup) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```sh
pnpm install
pnpm tauri dev
```

To work on the UI alone, `pnpm dev` runs it in a browser with a mock backend and demo data.

## Checks

Run everything before you open a pull request:

```sh
pnpm check
```

It runs Biome, the TypeScript check, Vitest, the fake agent tests, rustfmt, clippy (warnings are errors) and the Rust tests of the core, the sync protocol and the sync server, then builds the phone app and runs a phone to server test. `pnpm lint:fix` fixes formatting.

## Rules

- **Tests never use a real agent.** They use `tools/fake-claude` and `tools/fake-codex`, which cost no tokens.
- **Code, comments and commit messages are in English.** Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
- **Every UI string exists in English and French.** Add it to both `src/i18n/en.ts` and `src/i18n/fr.ts`. The TypeScript check fails if the two tables differ.
- **Business logic lives in the Rust core.** The UI renders view models and sends commands.
- **No `unwrap()` in production paths** of the Rust core.
- **Spawn processes with argument arrays**, never by building a shell command from user text.
- Do not touch the user's `~/.claude` or `~/.codex` settings, or a task's working folder. Agents are configured through command line flags only.

## Pull requests

Keep them focused: one change, with tests. Describe what changed and why, and fill in the template.
