<div align="center">

<a name="readme-top"></a>

<img src="docs/brand/icon.svg" alt="Taido logo" width="112" height="112">

<h1>Taido</h1>

<p><strong>The to-do list where every task runs its own Claude Code and Codex.</strong><br>
See at a glance which agent is working, which one waits for you, and which one is done.</p>

<p>
  <a href="https://github.com/Shyhnz/taido/releases/latest"><img src="https://img.shields.io/github/v/release/Shyhnz/taido?style=flat-square&label=release&color=2f6fed" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows-lightgrey?style=flat-square&label=platforms" alt="macOS and Windows">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square" alt="AGPL-3.0 license"></a>
  <img src="https://img.shields.io/badge/data-100%25%20local-2ea44f?style=flat-square" alt="100% local data">
</p>

<p>
  <a href="https://github.com/Shyhnz/taido/releases/latest"><strong>Download</strong></a> ·
  <a href="#features"><strong>Features</strong></a> ·
  <a href="#getting-started"><strong>Getting started</strong></a> ·
  <a href="docs/SELF-HOSTING.md"><strong>Sync &amp; phone</strong></a> ·
  <a href="CONTRIBUTING.md"><strong>Contributing</strong></a>
</p>

</div>

https://github.com/user-attachments/assets/a501dc60-132a-4089-8cfc-81d7e00cefab

## Why Taido

You run Claude Code on three tasks at once. One is waiting for a permission, one finished ten minutes ago, one is still working. To find out which, you cycle through terminal windows.

Taido puts each agent inside the task it works on. Every task gets its own folder, terminals, notes and timer, and a **status ring** that tells you what its agent is doing. You look at your list, not at your terminals.

<p align="center">
  <img src="docs/images/today.png" alt="Today view: a list of tasks, each with a status ring" width="100%">
</p>

| Ring | Means |
| --- | --- |
| Working | The agent is busy. Leave it alone. |
| Waiting for you | It needs a permission or an answer. Taido notifies you. |
| Done | It finished its turn. Review the result. |
| Error / stopped | Something went wrong in the session. |

The ring is driven by the agents' own hooks, not by guessing from terminal output.

## Features

### A task is a workspace

<img src="docs/images/task-terminal.png" alt="A task open with a Claude Code terminal next to its notes and subtasks" width="100%">

- **Claude Code, Codex, shells and commands** in the task's own folder. Several terminals per task, side by side.
- **Sessions you can resume.** Close the app, come back tomorrow, pick the conversation up where it stopped. Past conversations stay in the task's history.
- **Context gauge.** A thin line under each agent tab shows how full its context is.
- **Voice dictation.** Hold Space to talk to the agent instead of typing (macOS).
- **Focus mode.** One task, full screen, nothing else.

### A to-do app first

<img src="docs/images/kanban.png" alt="Kanban board of a project" width="100%">

- **Today, Upcoming and Inbox**, with a calendar you can drag tasks across.
- **Kanban board** per project, with sections.
- **Quick add** in one line: `Fix login tomorrow 5pm #web !1 >claude` sets the project, date and priority, and starts Claude.
- **Subtasks, priorities, due dates, links between tasks.**
- **Light and dark themes**, with eight colour palettes.

### Notes the agents can read and write

<img src="docs/images/notebook.png" alt="Project notebook with pages and groups" width="100%">

- **A notebook per project**: pages, groups, links to tasks. Keep access notes, decisions and links in one place.
- **Agents write back.** Claude Code gets tools to add tasks, subtasks and notes to Taido while it works.
- **Timer and CSV export.** Track the time spent on each task and export it.

### Yours, on your machine

- **Local first.** Everything lives in a SQLite file on your computer. No account, no cloud, no telemetry.
- **Optional sync and phone app.** Run the sync server on your own machine or VPS and use Taido on your phone. See [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).
- **English and French.**
- **Open source**, AGPL-3.0.

<div align="right"><a href="#readme-top">Back to top ↑</a></div>

## Getting started

<p>
  <a href="https://github.com/Shyhnz/taido/releases/latest"><img src="https://img.shields.io/badge/Download%20for-macOS-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS"></a>
  <a href="https://github.com/Shyhnz/taido/releases/latest"><img src="https://img.shields.io/badge/Download%20for-Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download for Windows"></a>
</p>

1. **Install Taido.** On macOS, open `Taido_<version>_universal.dmg` and drag Taido to Applications. On Windows 10/11 (x64), run `Taido_<version>_x64-setup.exe`.
2. **Install an agent.** Taido drives [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) and [Codex](https://github.com/openai/codex), it does not replace them. Install at least one and log in. Without them you still get tasks, notes, timer and shell terminals.
3. **Create a task, pick a folder, start Claude.**

<details>
<summary><strong>First launch on macOS</strong> (the app is not notarized yet)</summary>
<br>

1. Open Taido from Applications. macOS says it cannot verify the app. Click **Done**.
2. Open **System Settings > Privacy & Security**, scroll down and click **Open Anyway** next to Taido.
3. Confirm with your password. The app opens, and it will not ask again.

</details>

<details>
<summary><strong>First launch on Windows</strong> (the installer is not signed yet)</summary>
<br>

1. Windows SmartScreen shows "Windows protected your PC". Click **More info**, then **Run anyway**.
2. Follow the installer. Taido then opens from the Start menu like any other app.

If you installed Claude Code or Codex with npm or pnpm, make sure Node.js is installed too.

</details>

## Sync and phone

Sync is optional and runs on a server you own. The sync server and the phone app are in this repository. See [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) for Docker and manual setup. A hosted option is coming soon.

## Build from source

You need [Node.js](https://nodejs.org), [pnpm](https://pnpm.io) and the [Rust toolchain](https://rustup.rs), plus the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your system.

```sh
pnpm install
pnpm tauri dev     # run the app in development
pnpm check         # lint, type checks and all tests
pnpm tauri build   # build an installer
```

<details>
<summary><strong>How it works</strong></summary>
<br>

Taido is a [Tauri 2](https://tauri.app) app. A Rust core owns all the logic and data (SQLite); the React interface only displays what the core sends.

When you start Claude Code or Codex in a task, the core launches it in a real terminal with its own settings passed on the command line. It never edits your `~/.claude` files or your project folders. The agent reports its state back to the core through hooks on a local, token-protected server, and the core turns that into the task's ring.

</details>

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first. To report a security problem, see [SECURITY.md](SECURITY.md).

## Known limitations

- Windows: voice dictation and the menu bar icon are not available yet. "Open in Terminal" opens PowerShell.
- Builds are not signed or notarized, so your system asks for confirmation on first launch.

## License

[AGPL-3.0-or-later](LICENSE). Copyright 2026 NUOPS.

<div align="center">
<br>
<sub>Made by Shyhn. If Taido saves you a few window switches, a ⭐ helps others find it.</sub>
</div>
