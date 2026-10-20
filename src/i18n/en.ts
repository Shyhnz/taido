/**
 * Every UI string in English: short, friendly, second person, sentence case (like Todoist).
 * Same keys and same function signatures as `fr.ts`, which the tests check.
 *
 * Vocabulary: « Projet » is a Project (`subject` in the code), « Sans projet » the Inbox, « Carnet »
 * the Notebook, « Journal » the Activity. "Folder" only ever means a folder on disk.
 */

import type { Agent, ChronoStop, ErrorKind, Ring } from "../bindings";
import {
  agentInstallCommand,
  agentLoginCommand,
  agentName,
  agentProduct,
  mapTexts,
  toCodex,
} from "./fr";
import type { Strings } from "./index";

/** "1 task", "3 tasks". */
const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** "3 tasks", "1 task", "No tasks". */
const taskCount = (n: number) =>
  n === 0 ? "No tasks" : plural(n, "task", "tasks");

/** "s" after a count that is not 1. */
const s = (n: number) => (n === 1 ? "" : "s");

/** What an account keeps on the server: one text for the computer and the phone. */
const ACCOUNT_PRIVACY =
  "Your account keeps your projects, sections, tasks, Kanban columns, time spent, links between tasks and attachments (names and files). It never keeps your folders, terminals, Claude sessions or activity.";

/** Readable errors of Claude Code, by `StopFailure.error` type. */
const AGENT_ERRORS: Record<string, string> = {
  rate_limit: "Usage limit reached",
  overloaded: "Servers overloaded, try again",
  authentication_failed: "Claude Code is signed out",
  billing_error: "Billing problem",
};

/**
 * "Usage limit reached" for `rate_limit`, "Error: model_not_found" for another type; a text
 * that is not a type is kept as is.
 */
function agentErrorLabel(kind: string | null): string {
  if (!kind) return "Error";
  const known = AGENT_ERRORS[kind];
  if (known) return known;
  return /^[a-z0-9_]+$/.test(kind) ? `Error: ${kind}` : kind;
}

const en: Strings = {
  appName: "Taido",

  common: {
    cancel: "Cancel",
    save: "Save",
    delete: "Delete",
    close: "Close",
    add: "Add",
    create: "Create",
    rename: "Rename",
    retry: "Try again",
    none: "None",
    noneMasc: "None",
    more: "More actions",
    loading: "Loading…",
    tasks: taskCount,
    quote: (text: string) => `“${text}”`,
  },

  errors: {
    kind: {
      not_found: "This item no longer exists.",
      invalid: "This value isn't valid.",
      no_folder: "Choose a folder for this task first.",
      folder_missing: "Folder not found.",
      claude_missing:
        "Can't find Claude Code. Install it or set its path in Settings.",
      codex_missing:
        "Can't find Codex. Install it or set its path in Settings.",
      internal: "Something went wrong. Try again.",
      sync_auth: "Wrong email or password.",
      sync_rate_limited: "Too many attempts. Wait a few minutes.",
      sync_email_taken: "An account already exists with this email.",
      sync_weak_password: "Password too short (at least 10 characters).",
      sync_bad_email: "Invalid email address.",
      sync_invalid_code: "Wrong or expired code.",
      sync_mail_unavailable: "The server can't send emails.",
      sync_signups_closed: "Sign-ups are closed on this server.",
      sync_offline: "Can't reach the server.",
      sync_server: "The server returned an error.",
      file_not_here: "This file isn't on this device.",
      file_not_on_server:
        "This file hasn't reached your account yet. Try again later.",
      downloads_denied:
        "Taido can't access Downloads. Allow it in System Settings › Privacy & Security › Files and Folders › Taido › Downloads Folder.",
      disk_full: "Not enough space on this device for this file.",
      file_write_failed: "Couldn't write the file on this device.",
      mic_denied:
        "Taido can't access the microphone. Allow it in System Settings › Privacy & Security › Microphone.",
      voice_unavailable: "Dictation isn't available right now.",
    },
    unknown: "Something went wrong. Try again.",
    action: {
      createTask: "Couldn't add the task.",
      updateTask: "Couldn't save the task.",
      completeTask: "Couldn't complete the task.",
      deleteTask: "Couldn't delete the task.",
      moveTask: "Couldn't move the task.",
      duplicateTask: "Couldn't duplicate the task.",
      closeTerminal: "Couldn't close the terminal.",
      createSubject: "Couldn't create the project.",
      updateSubject: "Couldn't update the project.",
      deleteSubject: "Couldn't delete the project.",
      reorder: "Couldn't move the item.",
      createSection: "Couldn't create the section.",
      updateSection: "Couldn't update the section.",
      deleteSection: "Couldn't delete the section.",
      subtask: "Couldn't save the subtask.",
      note: "Couldn't add the note.",
      settings: "Couldn't save the setting.",
      loadView: "Couldn't show this list.",
      loadSubjects: "Projects unavailable.",
      createColumn: "Couldn't add the column.",
    },
    withAction: (action: string, kind: ErrorKind | null) =>
      kind === "not_found"
        ? `${action} This item no longer exists.`
        : kind === "invalid"
          ? `${action} Check what you typed.`
          : kind === "no_folder" ||
              kind === "folder_missing" ||
              kind === "claude_missing" ||
              kind === "codex_missing"
            ? `${action} ${en.errors.kind[kind]}`
            : `${action} Try again.`,
  },

  sidebar: {
    search: "Search",
    searchRow: "Search",
    upcoming: "Upcoming",
    newTask: "New task",
    navLabel: "Navigation",
    today: "Today",
    noProject: "Inbox",
    projects: "Projects",
    newProject: "New project",
    firstProject: "Create your first project",
    projectsUnavailable: "Projects unavailable",
    settings: "Settings",
    collapse: "Hide sidebar",
    expand: "Show sidebar",
    projectMenu: (name: string) => `Actions for project ${name}`,
    waitingCount: (n: number, agent: Agent) =>
      n > 1
        ? `${n} tasks where ${agentName(agent)} is waiting`
        : `1 task where ${agentName(agent)} is waiting`,
    announce: {
      movedUp: (name: string) => `Project “${name}” moved up`,
      movedDown: (name: string) => `Project “${name}” moved down`,
      inboxMovedUp: "Inbox moved up",
      inboxMovedDown: "Inbox moved down",
    },
  },

  theme: {
    light: "Light",
    dark: "Dark",
    system: "System",
  },

  colorTheme: {
    taido: "Taido",
    slate: "Slate",
    graphite: "Graphite",
    blueberry: "Blueberry",
    lavender: "Lavender",
    plum: "Plum",
    raspberry: "Raspberry",
    cocoa: "Cocoa",
    sage: "Sage",
    lagoon: "Lagoon",
  },

  subject: {
    pickFolderTitle: "Choose the project's folder",
    menuRename: "Rename",
    menuColor: "Color",
    menuAddSection: "Add section",
    menuLinkFolder: "Link to a folder…",
    menuOpenFolder: "Open folder",
    menuDelete: "Delete",
    deleteTitle: (name: string) => `Delete “${name}”?`,
    deleteMessage: (n: number) =>
      n === 0
        ? "This project has no open tasks. Its completed tasks will be deleted too."
        : `Its ${plural(n, "open task", "open tasks")} and its completed tasks will be deleted.`,
    deleteConfirm: "Delete project",
    colors: {
      violet: "Violet",
      teal: "Teal",
      pink: "Pink",
      gray: "Gray",
      blue: "Blue",
      indigo: "Indigo",
      brown: "Brown",
      slate: "Slate",
    },
  },

  section: {
    add: "Add section",
    nameLabel: "Section name",
    namePlaceholder: "Section name",
    subpathLabel: "Subfolder (optional)",
    subpathPlaceholder: "E.g. etl",
    menu: (name: string) => `Actions for section ${name}`,
    menuRename: "Rename",
    menuSubpath: "Subfolder…",
    menuDelete: "Delete",
    renameTitle: "Rename section",
    subpathTitle: "Section subfolder",
    subpathHelp: "Relative to the project's folder. Leave empty for none.",
    deleteTitle: (name: string) => `Delete section “${name}”?`,
    deleteMessage: "Its tasks stay in the project, outside any section.",
    deleteConfirm: "Delete section",
  },

  views: {
    completed: "Completed",
    todaySubtitle: (date: string, n: number) =>
      n === 0 ? date : `${date} · ${taskCount(n)}`,
    countSubtitle: (n: number) => (n === 0 ? "" : taskCount(n)),
    groups: {
      claudeWaiting: (agent: Agent) => `${agentName(agent)} is waiting`,
      overdue: "Overdue",
      today: "Today",
      postponeToToday: "Reschedule to today",
    },
    empty: {
      noProjectTitle: "All clear",
      noProjectText: "Tasks without a project show up here.",
      todayTitle: "Nothing planned for today",
      todayText: "Enjoy, or add a task for the day.",
      subjectTitle: "This project is empty",
      subjectText: "Add your first task.",
    },
    firstLaunch: {
      title: "Start with a project",
      text: "One project per client or job, for example “Acme Corp” or “Personal”. Your tasks live inside.",
      action: "Create a project",
    },
    loadError: "Couldn't show this list.",
    unknownSubject: "This project no longer exists",
  },

  addTask: {
    row: "Add…",
    titlePlaceholder: "Task name",
    descriptionPlaceholder: "Note",
    submit: "Add",
    dialogTitle: "New task",
    destination: "Destination",
    dueToday: "Today",
    hint: "↵ add · Esc close",
  },

  quickAdd: {
    titleLabel: "Task name",
    titlePlaceholder: "Call Paul tomorrow 5pm #project",
    descriptionLabel: "Description",
    help: "#project · /section · @date · tomorrow 5pm · !2 · >claude · >codex",
    helpMobile: "#project · /section · @date · !2",
    priority: (n: number) => `Priority ${n}`,
    submit: "Add",
    submitAndLaunch: "Add and launch",
    cancelHint: "Esc",
    submitHint: "Enter · ⌥Enter to add and keep going",
    chips: "What adding will do",
    agentOnAdd: (agent: Agent) => `${agentProduct(agent)}, opened on add`,
    agentShell: "Shell",
    remove: (label: string) => `Remove: ${label}`,
    unknownProject: "Project not found",
    createProject: (name: string) => `Create “${name}”?`,
    projectCreated: (name: string) => `Project “${name}” created`,
    suggestions: "Projects and sections",
  },

  ring: {
    markDone: (state: string | null) =>
      state ? `Complete · ${state}` : "Complete",
    reopen: "Reopen",
    state: (ring: Ring, agent: Agent): string =>
      (
        ({
          human: "To do",
          completed: "Completed",
          starting: `Starting ${agentProduct(agent)}`,
          working: `${agentName(agent)} is working`,
          waiting: `${agentName(agent)} is waiting for you`,
          done: `${agentName(agent)} is done`,
          idle: "Session open, ready",
          paused: "Session paused",
          error: "Error",
          crashed: "Session stopped",
        }) satisfies Record<Ring, string>
      )[ring],
  },

  line: {
    description: (text: string | null) => text ?? "",
    completed: (when: string | null) =>
      when ? `Completed ${when}` : "Completed",
    waiting_permission: (_: string | null, agent: Agent) =>
      `${agentName(agent)} is waiting for you`,
    waiting_question: (_: string | null, agent: Agent) =>
      `${agentName(agent)} is waiting for you`,
    waiting_input: (_: string | null, agent: Agent) =>
      `${agentName(agent)} is waiting for you`,
    error: (text: string | null) => agentErrorLabel(text),
    crashed: () => "Session stopped",
    done: (_: string | null, agent: Agent) => `${agentName(agent)} is done`,
    working: (_: string | null, agent: Agent) =>
      `${agentName(agent)} is working`,
    starting: (_: string | null, agent: Agent) =>
      `Starting ${agentProduct(agent)}…`,
    idle: () => "Session open, ready",
    paused: (when: string | null) => (when ? `Paused · ${when}` : "Paused"),
  },

  row: {
    sessions: (n: number) => plural(n, "session", "sessions"),
    subtasks: (done: number, total: number) => `${done}/${total}`,
    subtasksLabel: (done: number, total: number) =>
      `${done} of ${total} subtask${s(total)} done`,
    hasNote: "Has a note",
    dueLabel: (label: string) => `Due: ${label}`,
    overdue: "Overdue",
    dragHandle: "Drag to move",
    menuOpen: "Open",
    menuLaunchAgent: (agent: Agent) => `Launch ${agentProduct(agent)}`,
    menuOpenShell: "Open a shell",
    menuMove: "Move to…",
    menuFile: "Move to project…",
    menuDue: "Due date…",
    menuDelete: "Delete",
    deleteTitle: (title: string) => `Delete “${title}”?`,
    deleteMessage: "The task, its subtasks and its history will be deleted.",
    deleteConfirm: "Delete task",
  },

  toast: {
    completed: "Task completed",
    undo: "Undo",
    see: "View",
    deleted: "Task deleted",
    subjectDeleted: (name: string) => `Project “${name}” deleted`,
    duplicated: "Task duplicated",
    moved: (where: string) => `Moved to ${where}`,
    added: (where: string) => `Added to ${where}`,
  },

  move: {
    title: "Move to…",
    fileTitle: "Move to project…",
    noProject: "Inbox",
  },

  due: {
    title: "Due date",
    date: "Date",
    time: "Time (optional)",
    today: "Today",
    tomorrow: "Tomorrow",
    yesterday: "Yesterday",
    pick: "Pick a date…",
    clear: "None",
    none: "None",
  },

  panel: {
    label: "Task panel",
    focusMode: "Focus mode",
    openIn: "Open in…",
    more: "More task actions",
    duplicate: "Duplicate",
    delete: "Delete",
    close: "Close panel",
    resize: "Resize panel",
    titleLabel: "Task title",
    descriptionPlaceholder: "Add a note",
    terminals: "Terminals",
    noTerminal: "No terminal yet. Any task can have one.",
    launchAgentHere: (agent: Agent) => `Launch ${agentProduct(agent)} here`,
    openShell: "Open a shell",
    subtasks: "Subtasks",
    addSubtask: "Add subtask",
    subtaskPlaceholder: "New subtask",
    subtaskLabel: "Subtask text",
    deleteSubtask: "Delete subtask",
    dragSubtask: "Drag to reorder",
    journal: "History",
    emptyJournal: "Nothing yet.",
    loading: "Loading…",
    notFound: "This task no longer exists.",
    noProject: "Inbox",
    move: "Move to…",
    location: (where: string) => `Project: ${where}. Change`,
    locationMenu: "Move to project…",
    dueEmpty: "Due date",
    dueChip: (label: string) => `Due: ${label}. Change`,
    dueOverdue: "overdue",
    noteTitle: "Note",
    showHistory: "Show history",
    hideHistory: "Hide history",
    technicalDetails: "Technical details",
  },

  attrs: {
    folder: "Folder",
    folderInherited: {
      section: "same as the section",
      subject: "same as the project",
      task: "specific to the task",
    },
    folderMissing: "Folder not found",
    folderNone: "None",
    folderPick: "Choose the task's folder",
    folderReset: "Use the project's folder",
    gitBranch: "Git branch",
    terminals: "Terminals",
    state: "Status",
  },
  voice: {
    dictate: "Dictate",
    dictateHint: (spaceHold: boolean) =>
      spaceHold ? "Dictate (or hold Space)" : "Dictate",
    stop: "Stop and write the text",
    listening: "Listening…",
    cancelHint: "Esc to cancel",
    transcribing: "Transcribing…",
    heardNothing: "I didn't hear anything.",
    setupTitle: "Talk to your AI",
    setupBody: (size: string) =>
      `Speak instead of typing: your voice is transcribed on this device and nothing is sent online. First, download the transcription model (${size}, just once).`,
    setupLanguages:
      "English, French, Spanish, German, Italian and 20 other European languages.",
    download: "Download",
    downloading: (percent: number) => `Downloading… ${percent}%`,
    retry: "Try again",
    failed: "The download failed. Check your connection and try again.",
    ready: "All set. Click the mic or hold Space to talk.",
    readyNoSpace: "All set. Click the mic to talk.",
    micDenied: "Taido can't access the microphone.",
    openMicSettings: "Open microphone settings",
  },
  terminals: {
    session: "Session",
    tabs: "Task terminals",
    agent: (agent: Agent) => agentProduct(agent),
    shell: "Shell",
    exited: "Exited",
    add: "New terminal",
    addAgent: (agent: Agent) => `${agentProduct(agent)}…`,
    quickActions: "Launch a terminal or open the folder",
    addShell: "Shell",
    addCommand: "Command…",
    close: (label: string) => `Close ${label}`,
    context: {
      label: (agent: Agent, percent: number) =>
        `${agentName(agent)}'s memory: ${percent}% used`,
      of: (limit: string) => `of ${limit}`,
      left: "Left",
      plan: "Plan",
      planUsed: (percent: number) => `${percent}% used`,
      nearlyFull: (agent: Agent) =>
        `${agentName(agent)} will soon summarize the conversation to free up space.`,
    },
    view: (label: string) => `Terminal ${label}`,
    resize: "Resize terminal",
    paneSelect: (n: number) => `Terminal in pane ${n}`,
    launchAgent: (agent: Agent) => `Launch ${agentProduct(agent)}`,
    openShell: "Open a shell",
    runCommand: "Run a command…",
    launch: "Launch",
    commandTitle: "Run a command",
    commandLabel: "Command",
    commandPlaceholder: "npm run dev",
    openError: "Couldn't open the terminal.",
    pickFolderTitle: "Choose the folder to work in for this task",
    folderMissingTitle: "Folder not found",
    folderMissingMessage: (path: string | null) =>
      path
        ? `The folder ${path} no longer exists. Choose another one to launch the terminal.`
        : "The task's folder no longer exists. Choose another one to launch the terminal.",
    chooseFolder: "Choose a folder",
    closeClaudeTitle: (agent: Agent) =>
      `Close the ${agentName(agent)} session?`,
    closeClaudeMessage: (agent: Agent) =>
      `${agentProduct(agent)} will stop in this terminal. You can resume the conversation later.`,
    closeClaudeConfirm: "Close session",
    stopSessionsTitle: (n: number) =>
      n > 1
        ? `${n} sessions are running on this task`
        : "A session is running on this task",
    completeMessage: "Completing the task closes its terminals.",
    completeConfirm: "Complete task",
    deleteMessage: "Deleting the task closes its terminals.",
    deleteConfirm: "Delete task",
    quitTitle: "Quit?",
    quitSessions: (n: number) =>
      n > 1
        ? `${n} sessions are still running. Quitting pauses them.`
        : "1 session is still running. Quitting pauses it.",
    quitTerminals: (n: number) =>
      n > 1
        ? `${n} terminals are still running. Quitting stops them.`
        : "1 terminal is still running. Quitting stops it.",
    quitConfirm: "Quit",
    fullWidth: "Focus mode",
    leaveFullWidth: "Leave focus mode",
    swapPanes: "Swap panes",
    resizePanes: "Pane width",
    resetPanes: "Drag to adjust the width · double-click: default width",
    resizePaneRows: "Pane height",
    resetPaneRows: "Drag to adjust the height · double-click: default height",
    panePlace: {
      left: "left",
      right: "right",
      topLeft: "top left",
      topRight: "top right",
      bottomLeft: "bottom left",
      bottomRight: "bottom right",
    },
    paneMenu: (place: string) => `Terminal in the ${place} pane`,
    inOtherPane: "other pane",
    hiddenTerminals: (n: number) =>
      n > 1 ? `${n} more terminals` : "1 more terminal",
    toFocusedPane: "in the active pane",
    noTerminal: "No terminal for this task",
    editTitle: "Edit title",
    waitingShort: (agent: Agent) => `${agentName(agent)} is waiting`,
    waitingBar: (agent: Agent) => `${agentName(agent)} is waiting for you`,
    sessionEnded: "Session ended",
    processEnded: (code: number | null) =>
      code === null ? "Exited" : `Exited · code ${code}`,
    relaunch: "Relaunch",
    closeTab: "Close",
    claudeNumbered: (n: number, agent: Agent) => `${agentProduct(agent)} ${n}`,
    claudeNamed: (recap: string, agent: Agent) =>
      `${agentName(agent)} · ${recap}`,
    resetHeight: "Double-click: default height",
    noteAndSubtasks: "Note and subtasks",
    leavesFocus: "leaves focus",
    due: "Due date…",
    openInFinder: "Open in Finder",
    openIn: "Open in",
    finder: "Finder",
    terminal: "Terminal",
    openInError: "Couldn't open the folder.",
  },

  diagnostic: {
    title: "Session events",
    subtitle: "Newest first, 200 at most.",
    refresh: "Refresh",
    loading: "Loading events…",
    empty:
      "No events yet. Launch a session on a task and its events will show up here.",
    error: "Couldn't read the events.",
    noTerminal: "no terminal",
    terminal: (id: string) => `Terminal ${id}`,
    payload: "Payload",
    count: (n: number) => (n === 1 ? "1 event" : `${n} events`),
  },
  editors: {
    vscode: "VS Code",
    cursor: "Cursor",
    zed: "Zed",
    windsurf: "Windsurf",
    sublime: "Sublime Text",
  },

  search: {
    title: "Search",
    open: "Search (⌘K)",
    label: "Search for a task or a note",
    placeholder: "Go to a task, project or note…",
    results: "Results",
    hint: "Type the name of a task, project or note.",
    loading: "Searching…",
    none: (query: string) => `No tasks or notes match “${query}”.`,
    error: "Search failed.",
    noProject: "Inbox",
    where: (project: string, section: string | null) =>
      section ? `${project} › ${section}` : project,
    completed: "completed",
    noteWhere: (project: string) => `Note · ${project}`,
    footer: "↑↓ select · ↵ open · Esc close",
  },

  settings: {
    workspace: "App folder",
    workspaceHelp:
      "Each project gets its own folder here, created automatically (sub-projects go inside their project's). Inbox tasks share a folder of their own.",
    title: "Settings",
    open: "Settings (⌘,)",
    tabs: {
      general: "General",
      theme: "Theme",
      sync: "Sync",
      account: "Account",
      agents: "Agents",
      diagnostic: "Diagnostics",
    },
    tabsLabel: "Settings sections",
    language: "Language / Langue",
    languageHelp: "Taido reloads to apply it.",
    theme: "Appearance",
    themeHelp: "“System” follows this computer's light or dark setting.",
    themeHelpMobile: "“System” follows your phone's light or dark setting.",
    color: "Color",
    colorHelp: "Each color has a light and a dark version.",
    syncTheme: "Same theme on all my devices",
    syncThemeHelp:
      "With your account, all your devices use the theme chosen on any of them. When off, this device keeps its own.",
    syncThemeHelpMobile:
      "With your account, all your devices use the theme chosen on any of them. When off, this phone keeps its own.",
    defaultAgent: "Default AI",
    defaultAgentHelp:
      "⌘T and the “Launch” button open this AI. The other one stays in a task's + menu.",
    agentReady: (version: string | null) =>
      version ? `Ready · ${version}` : "Ready",
    agentLoggedOutShort: "Signed out",
    agentMissingShort: "Not installed",
    agentCheckingShort: "Checking…",
    agentPath: (agent: Agent) =>
      `Path to the ${agent === "codex" ? "codex" : "claude"} program`,
    claudePathPlaceholder: "Automatic",
    claudePathHelp:
      "Leave empty to find it automatically (shell PATH, usual locations).",
    agentPathInvalid: (agent: Agent) =>
      `Enter an absolute path, for example /opt/homebrew/bin/${agent === "codex" ? "codex" : "claude"}.`,
    claudePathSaved: "Path saved.",
    claudePathCleared: "Automatic detection restored.",
    claudeCheck: "Check",
    agentCheckLabel: (agent: Agent) => `Check ${agentProduct(agent)}`,
    claudeChecking: "Checking…",
    agentCheckError: (agent: Agent) => `Couldn't check ${agentProduct(agent)}.`,
    claudeProgram: "Program",
    claudeNotFound: "Not found",
    agentInstall: (agent: Agent) =>
      `To install it: ${agentInstallCommand(agent)}`,
    claudeVersion: "Version",
    claudeLogin: "Sign-in",
    claudeLoggedIn: "Signed in",
    agentLoggedOut: (agent: Agent) =>
      `Signed out. Run ${agentLoginCommand(agent)} in a terminal and sign in.`,
    claudeLoginUnknown: "Unknown",
    voiceSpaceHold: "Hold Space to dictate",
    voiceSpaceHoldHelp:
      "In a Claude or Codex terminal, a long press on Space listens to your voice and writes the text. A short press types a space. The mic button always works.",
    summarize: "Summarize finished sessions automatically",
    summarizeHelp:
      "One sentence per finished session, a few hundred tokens from your subscription.",
    notify: (agent: Agent) =>
      `Notify me when ${agentName(agent)} is done or waiting for me`,
    notifyHelp:
      "A quiet notification, no sound, unless the task is already in front of you. A click takes you to the session.",
    unknown: "Unknown",
    appVersion: "App version",
    hooksPort: "Hooks port",
    envPath: "Resolved PATH",
    envFallback: "Fallback PATH: couldn't read the login shell.",
    logDir: "Logs folder",
    dataDir: "Data folder",
    openFolder: "Open",
    openFolderLabel: (what: string) =>
      `Open the ${what.toLowerCase()} in Finder`,
    statusLoading: "Loading…",
    statusError: "Couldn't read the app's status.",
  },
  claudeCheck: {
    missingTitle: (agent: Agent) => `Can't find ${agentProduct(agent)}`,
    missingText: (agent: Agent) =>
      `The app can't find the ${agent === "codex" ? "codex" : "claude"} program. Install ${agentProduct(agent)} (for example with ${agentInstallCommand(agent)}), then try again.`,
    missingSettings:
      "If it's already installed somewhere else, set its path in Settings › Agents.",
    loggedOutTitle: (agent: Agent) => `${agentProduct(agent)} is signed out`,
    loggedOutText: (agent: Agent) =>
      `Run ${agentLoginCommand(agent)} in a terminal and sign in, then try again.`,
    found: (version: string | null, path: string | null) =>
      [version && `Version ${version}`, path].filter(Boolean).join(" · "),
    retry: "Try again",
    checking: "Checking…",
    stillMissing: "Still not found.",
    stillLoggedOut: "Still signed out.",
    openSettings: "Open settings",
  },

  tutorial: {
    label: "Getting started",
    agent: {
      title: "Which AI do you work with?",
      text: "Taido launches it in each task and tells you how it's doing. You can change it in Settings › Agents.",
      choices: "AI",
      copy: "Copy",
      copied: "Copied",
      checkAgain: "Check again",
      checkFailed: "Couldn't check",
      next: "Continue",
      later: "I'll choose later",
    },
    stepOf: (n: number, total: number) => `Step ${n} of ${total}`,
    skip: "Skip this step",
    quit: "Leave the guide",
    left: "You can replay the guide in Settings › General.",
    welcome: {
      title: (app: string) => `Welcome to ${app}`,
      text: "Here, each task has its own workspace, where Claude Code can run. A colored dot tells you how it's doing, without opening the task.",
      examples: [
        "Fix the login bug",
        "Prepare the client demo",
        "Update the docs",
      ],
      ask: "Take a 3-minute tour?",
      start: "Let's go",
      decline: "No thanks",
    },
    project: {
      title: "Your first project",
      text: "One project per client or job. Type a name, for example “Personal”, then press Enter.",
    },
    task: {
      title: "A task",
      text: "Type “Try Claude” as the task name, then press Enter. If the field is closed, click “Add…” first.",
    },
    open: {
      title: "Open it",
      text: "Click your task: this is its workspace. Claude will run in it.",
    },
    claude: {
      title: "Launch Claude and talk to it",
      checking: "Checking that Claude Code is ready…",
      ready: "Claude Code is ready. Click “Launch Claude Code” (or ⌘T).",
      missing:
        "Claude Code isn't installed on this device. Install it (for example with npm install -g @anthropic-ai/claude-code), then try again.",
      notLoggedIn:
        "Claude Code is signed out. Run claude in a terminal and sign in, then try again.",
      retry: "Try again",
      skipPart: "Skip this part",
    },
    talk: {
      title: "Launch Claude and talk to it",
      ask: "Type this in the terminal, then press Enter:",
      prompt: "Create a hello.txt file that says hello",
      copy: "Copy",
      copied: "Copied",
      watch: "Then watch the dot next to the task's title.",
      working:
        "Orange: Claude is working. You can go elsewhere, it keeps going on its own.",
      waiting:
        "Red: Claude is waiting for you. Answer it in the terminal. The first time, it asks whether it may work in this folder: choose “Yes”, then press Enter.",
      done: "Green: Claude is done. You see it at a glance in the list, without opening the task.",
      noRed: "If it asks you a question, the dot turns red.",
      error:
        "Claude ran into a problem: check the terminal. You can carry on with the guide.",
      next: "Continue",
    },
    kanban: {
      title: "Switch to Kanban",
      text: (title: string | null, target: string) =>
        title
          ? `At the top of the project, click “Kanban”, then drag “${title}” to the “${target}” column.`
          : `At the top of the project, click “Kanban”, then drag your task to the “${target}” column.`,
      already: (column: string) =>
        `Your task is already in “${column}”: Claude put it there when it started.`,
      fallbackTarget: "In progress",
      hint: "You can rename and add columns: it's your board.",
    },
    file: {
      title: "An attachment",
      text: "Open your task and drag a file from Finder into “Attachments” (an image, a PDF…). Claude can read it.",
    },
    quickAdd: {
      title: "Quick add ⌘N",
      text: (project: string | null) =>
        project
          ? `Press ⌘N and type: Call the client tomorrow #${project}, then press Enter.`
          : "Press ⌘N and type: Call the client tomorrow, then press Enter.",
      hint: "“#project” files the task, “tomorrow” gives it a date.",
    },
    complete: {
      title: "Check it off",
      text: (title: string | null) =>
        title
          ? `Click the circle of “${title}” to complete it, then confirm: its terminal closes, but the Claude session stays in the history and you can resume it.`
          : "Click a task's circle to complete it.",
    },
    account: {
      title: "Create your account",
      text: "With an account, you get your projects, your time and your files on your phone and on the web.",
      linked:
        "Your account is linked: your projects follow you on your phone and on the web.",
      open: "Create my account",
      later: "Not now",
      next: "Continue",
    },
    done: {
      title: "That's the tour",
      text: "Shortcuts worth keeping handy:",
      shortcuts: [
        ["⌘N", "Quick add"],
        ["⌘K", "Search"],
        ["⌘T", "Launch Claude in the open task"],
        ["⌘1 · ⌘2 · ⌘3", "To do · Today · Upcoming"],
        ["M", "Hide sidebar"],
        ["⌘,", "Settings"],
      ],
      more: {
        title: "Also worth a look",
        items: [
          "Dashboard: a project's numbers, next to List and Kanban.",
          "Portfolio: all your projects, one row each, in the sidebar.",
          "@ in quick add: “@friday” gives the task a date.",
        ],
      },
      finish: "Finish",
    },
    replayLegend: "Getting started",
    replayHelp: "Take the tour of the app again, step by step.",
    replay: "Replay the guide",
  },

  journal: {
    created: "Task created",
    completed: "Task completed",
    reopened: "Task reopened",
    note: "Note",
    session_started: "Session started",
    prompt: "Prompt",
    turn_ended: "Turn ended",
    waiting: "Waiting",
    error: "Error",
    session_ended: "Session ended",
    crashed: "Session stopped",
    resumed: "Session resumed",
    cleared: "Conversation cleared",
    compacted: "Conversation compacted",
  },

  sessions: {
    title: "Past conversations",
    titleCount: (n: number) => `Past conversations (${n})`,
    running: "running",
    crashed: "stopped unexpectedly",
    noMessage: "Conversation with no messages",
    resume: "Resume",
    resumeLabel: (start: string) => `Resume the session from ${start}`,
    goToTab: "Go to tab",
    goToTabLabel: (start: string) =>
      `Go to the tab of the session from ${start}`,
    notResumable: "Nothing to resume: no messages",
    showDetail: (start: string) =>
      `Show the exchanges of the session from ${start}`,
    exchanges: (n: number) => (n === 1 ? "1 exchange" : `${n} exchanges`),
    loading: "Loading exchanges…",
    empty: "No exchanges recorded.",
    loadError: "Couldn't load the exchanges.",
    retry: "Try again",
    you: "You",
    agent: (agent: Agent) => agentName(agent),
    resumed: "Conversation resumed",
    cleared: "Conversation cleared (/clear)",
    compacted: "Context compacted",
    showMore: "Show more",
    showLess: "Show less",
    resumeError: "Couldn't resume the session.",
    durationUnderMinute: "under 1 min",
    durationMinutes: (n: number) => `${n} min`,
    durationHours: (h: number, m: number) =>
      `${h}h ${String(m).padStart(2, "0")}m`,
    aiSummary: (agent: Agent) => `Summary by ${agentName(agent)}`,
    rename: "Rename session",
    renameLabel: (start: string) => `Name of the session from ${start}`,
    renameHint: "Enter to save, Esc to cancel, empty for the automatic summary",
    renameError: "Couldn't rename the session.",
  },

  dates: {
    justNow: "just now",
    minutesAgo: (n: number) => `${n} min ago`,
    hoursAgo: (n: number) => `${n}h ago`,
    yesterdayAt: (time: string) => `yesterday ${time}`,
    todayAt: (time: string) => `today ${time}`,
    today: "Today",
    tomorrow: "Tomorrow",
    yesterday: "Yesterday",
  },

  shortcuts: {
    dialogClose: "Close window",
    enter: "Enter",
    escape: "Esc",
  },

  projectNav: {
    newPlaceholder: "Project name",
    newLabel: "New project name",
    newHint: "↵ create · Esc cancel",
    renameLabel: (name: string) => `New name for project ${name}`,
    loading: "Loading projects",
    restoreError: "Couldn't restore the project.",
  },

  list: {
    label: (view: string) => `Tasks · ${view}`,
    more: (title: string) => `Actions for task ${title}`,
    file: "Move to project…",
    fileLabel: (title: string) => `Move “${title}” to a project`,
    hasNote: "Has a note",
    sectionCount: (n: number) => taskCount(n),
    retry: "Try again",
    loading: "Loading list",
    rescheduled: (n: number) =>
      n > 1 ? `${n} tasks rescheduled to today` : "Task rescheduled to today",
    announce: {
      reopened: (title: string) => `“${title}” reopened`,
      movedUp: (title: string) => `“${title}” moved up`,
      movedDown: (title: string) => `“${title}” moved down`,
      added: (title: string) => `“${title}” added`,
    },
  },

  editor: {
    destination: (where: string) => `Destination: ${where}. Change`,
    due: (label: string) => `Due: ${label}. Change`,
    noDue: "Due date",
    projectMenu: "Choose destination",
  },

  datePicker: {
    label: "Choose the due date",
    today: "Today",
    tomorrow: "Tomorrow",
    nextMonday: "Next Monday",
    previousMonth: "Previous month",
    nextMonth: "Next month",
    isToday: "today",
    time: "Time",
    timePlaceholder: "Add a time",
    timeHelp: "For example 5pm or 9:30am. Enter to confirm.",
    timeInvalid: "Time not recognized. Try 5pm or 9:30am.",
    clearTime: "Remove time",
    clear: "Remove due date",
  },

  app: {
    notifications: "Notifications",
    reopened: "Task reopened",
    openFolderError: "Couldn't open the folder.",
  },

  priorityRing: {
    name: (n: number) => `Priority ${n}`,
    markDone: (n: number) => (n < 4 ? `Complete · Priority ${n}` : "Complete"),
    reopen: "Reopen",
    menu: (n: number) => `Priority ${n}`,
  },
  nesting: {
    expand: (title: string) => `Show subtasks of “${title}”`,
    collapse: (title: string) => `Hide subtasks of “${title}”`,
    childrenLabel: (title: string) => `Subtasks of “${title}”`,
  },
  upcoming: {
    title: "Upcoming",
    monthPicker: (month: string) => `${month}, pick a date`,
    previousWeek: "Previous week",
    nextWeek: "Next week",
    today: "Today",
    weekLabel: "Days of the week",
    dayButton: (label: string, count: number) =>
      count === 0 ? label : `${label}, ${taskCount(count)}`,
    dayTitle: (date: string, relative: string | null, weekday: string) =>
      relative ? `${date} · ${relative} · ${weekday}` : `${date} · ${weekday}`,
    nothingPlanned: "Nothing planned",
    addOnDay: (day: string) => `Add a task: ${day}`,
    modeLabel: "View",
    list: "List",
    calendar: "Calendar",
    previousMonth: "Previous month",
    nextMonth: "Next month",
    weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    more: (n: number) => `+ ${n} more`,
    openDay: (label: string, count: number) =>
      count === 0
        ? `${label}, show the list`
        : `${label}, ${taskCount(count)}, show the list`,
    lateOn: (title: string) => `${title}, overdue`,
    selectDay: (label: string, count: number) =>
      count === 0 ? label : `${label}, ${taskCount(count)}`,
    seeInList: "See in list",
    dragHint: "Long-press a task to drag it to another day.",
    movedTo: (day: string) => `Moved to ${day}`,
  },
  panelBis: {
    backToParent: (title: string) => `Back to “${title}”`,
    locationFromParent: "Same as the parent task",
    priority: "Priority",
    priorityShort: (p: number) => `P${p}`,
    priorityName: (p: number) => `Priority ${p}`,
    priorityChip: (p: number) => `Priority: P${p}. Change`,
    priorityMenuItem: "Priority…",
    openSubtask: (text: string) => `Open subtask “${text}”`,
    renameSubtask: "Rename subtask",
    subtaskDue: (label: string) => `Due: ${label}`,
    showSessions: "Show sessions",
    hideSessions: "Hide sessions",
    recap: (prompt: string, reply: string | null) =>
      reply ? `${prompt} → ${reply}` : prompt,
  },
  subProjects: {
    path: (parent: string, name: string) => `${parent} › ${name}`,
    hide: (name: string) => `Hide sub-projects of “${name}”`,
    show: (name: string) => `Show sub-projects of “${name}”`,
    menuAdd: "Add sub-project",
    menuMove: "Move to…",
    moveMenuLabel: (name: string) => `Move “${name}” to…`,
    topLevel: "None (top-level project)",
    moveError: "Couldn't move the project.",
    moved: (name: string, parent: string | null) =>
      parent
        ? `“${name}” is now in “${parent}”`
        : `“${name}” is now a top-level project`,
    newLabel: (parent: string) => `New sub-project name in ${parent}`,
    newPlaceholder: "Sub-project name",
    folderHint: "Created in the parent project's folder once it has one",
    pickFolderTitle:
      "Choose the sub-project's folder (the parent project's folder if empty)",
    deleteChildren: (n: number) =>
      n > 1
        ? `Its ${n} sub-projects and their tasks will be deleted too.`
        : "Its sub-project and its tasks will be deleted too.",
    listLabel: "Sub-projects",
    link: (name: string, n: number) =>
      n === 0 ? `Open ${name}` : `Open ${name}, ${taskCount(n)}`,
  },
  groups: {
    menuLabel: (name: string) => `Options for group “${name}”`,
    toggle: (name: string, open: boolean) =>
      open ? `Collapse group “${name}”` : `Expand group “${name}”`,
    rename: "Rename group",
    color: "Color",
    dissolve: "Ungroup",
    dissolved: (name: string) => `Group “${name}” removed, its projects stay`,
    addTo: "Add to a group",
    addToLabel: (n: number) =>
      n > 1 ? `Add the ${n} projects to a group` : "Add the project to a group",
    newGroup: "New group",
    into: (name: string) => `${name}`,
    remove: "Remove from group",
    selection: (n: number) =>
      n === 1 ? "1 project selected" : `${n} projects selected`,
    renameLabel: (name: string) => `Name of group “${name}”`,
    error: "Couldn't change the group.",
  },
  all: {
    title: "To do",
    openProject: (name: string) => `Open project ${name}`,
    emptyTitle: "Nothing to do",
    emptyText: "All the open tasks of your projects show up here.",
  },

  dnd: {
    instructions:
      "To move this item, press Space or Enter, move it with the arrow keys, then press Space or Enter again to drop it, or Esc to cancel.",
    pickedUp: (name: string) => `Picked up “${name}”`,
    over: (name: string) => `Over “${name}”`,
    droppedOn: (name: string) => `Dropped on “${name}”`,
    dropped: "Dropped",
    cancelled: "Move cancelled",
  },

  sync: {
    tab: "Sync",
    /** Name of the phone in the server's device list. */
    phoneDeviceName: "Phone",
    loading: "Loading…",
    loadError: "Couldn't read the sync status.",
    intro: "Sync your projects and tasks with your phone, through your server.",
    introMobile:
      "Sign in to your account to get the projects and tasks from your computer.",
    privacy: ACCOUNT_PRIVACY,
    serverUrl: "Server address",
    serverUrlPlaceholder: "https://sync.example.com",
    email: "Email address",
    emailPlaceholder: "you@example.com",
    password: "Password",
    signupOnMac: "Create your account from your computer.",
    forgotOnMac:
      "To change your password, use “Forgot password” on your computer.",
    link: "Sign in",
    linking: "Signing in…",
    linkedTo: (url: string) => `Connected to ${url}`,
    linkedToast: "Signed in. First sync in progress…",
    reconnectHelp:
      "The server no longer recognizes this device. Sign in again to resume syncing.",
    reconnect: "Sign in again",
    reconnectedToast: "Signed in again. Syncing…",
    interval: "Sync every",
    intervalOption: (minutes: number) =>
      minutes === 60 ? "1 hour" : `${minutes} min`,
    intervalHelp:
      "Also at startup, shortly after each change, and when you click “Sync”.",
    syncNow: "Sync",
    state: {
      unlinked: "Sync off",
      idle: "Up to date",
      syncing: "Syncing…",
      offline: "Offline",
      error: "Sync error",
    },
    lastSync: (relative: string) => `Last sync: ${relative}`,
    never: "Never synced",
    pending: (n: number) =>
      n > 1 ? `${n} changes to send` : "1 change to send",
    buttonLabel: (state: string, detail: string | null) =>
      detail ? `Sync · ${state} · ${detail}` : `Sync · ${state}`,
    error: {
      unauthorized: "Sign-in refused: sign in again in Settings.",
      server: "The server returned an error. Trying again at the next sync.",
      unsupported_protocol:
        "The server runs a different version: update the app.",
      internal: "Something went wrong while syncing.",
      deletions_held:
        "Lots of items disappeared from this phone: sync is waiting for you to confirm.",
    },
    accountError: {
      sync_auth: "Wrong email or password.",
      sync_rate_limited: "Too many attempts. Wait a few minutes and try again.",
      sync_email_taken:
        "An account already exists with this email. Sign in instead.",
      sync_weak_password: "The password must be at least 10 characters.",
      sync_bad_email: "This email address isn't valid.",
      sync_invalid_code: "Wrong or expired code. Ask for a new one.",
      sync_mail_unavailable:
        "The server can't send emails right now. Try again later.",
      sync_signups_closed:
        "Sign-ups are closed on this server. Ask the person who runs it for an account.",
      sync_offline: "Can't reach the server. Check your connection.",
      sync_server: "The server returned an error. Try again later.",
      invalid: "Enter a server address that starts with https://.",
      alreadyLinked: "Sign out first to switch accounts.",
      notOnPhone:
        "Create your account or change your password from your computer.",
    },
  },
  mobile: {
    menu: "Menu",
    closeMenu: "Close menu",
    back: "Back",
    settings: "Settings",
    linkFirst: "Sign in to your account to get your projects and tasks.",
    offlineBanner:
      "Offline: your changes will be sent when you're back online.",
    updateReady: "A new version is ready.",
    reload: "Reload",
    storageError:
      "Couldn't save on this phone. Free up some space and try again.",
    deletionsHeld: (n: number) =>
      `${n} items disappeared from this phone. Delete them on your other devices too?`,
    deletionsHeldConfirm: "Delete everywhere",
    deletionsHeldRestore: "Put them back",
    otherPage:
      "The app is already open somewhere else (the installed app or a Chrome tab).",
    otherPageHelp:
      "Only one page can use it at a time, so your changes don't get overwritten.",
    useHere: "Use here",
    pageTakenOver:
      "The app was opened somewhere else. This page is paused so your changes don't get overwritten.",
    installHelp: "To install it: Chrome's ⋮ menu › “Add to Home screen”.",
  },
  account: {
    start: {
      signup: "Create an account",
      login: "I already have an account",
    },
    intro:
      "An account lets you get your projects and tasks on all your devices.",
    privacy: ACCOUNT_PRIVACY,
    title: {
      signup: "Create an account",
      login: "Sign in",
      forgot: "Forgot password",
      reset: "Choose a new password",
    },
    email: "Email address",
    emailPlaceholder: "you@example.com",
    password: "Password",
    newPassword: "New password",
    passwordRule: "At least 10 characters.",
    showPassword: "Show password",
    hidePassword: "Hide password",
    code: "Code from the email",
    forgotHelp:
      "Enter your email: we'll send you a code to choose a new password.",
    codeSent: (email: string) =>
      `We sent a code to ${email}. It's valid for 30 minutes.`,
    newCode: "Send a new code",
    forgotLink: "Forgot password?",
    unconfirmed: "Email not confirmed yet",
    unconfirmedHelp: "Open the link in the “Confirm your address” message.",
    resend: "Resend the email",
    resentToast: (email: string) => `Email sent to ${email}.`,
    toLogin: "I already have an account",
    toSignup: "Create an account",
    back: "Back",
    serverUrl: "Server address",
    serverUrlPlaceholder: "https://sync.example.com",
    serverHelp: "The address of the sync server you use.",
    serverRequired: "Enter the address of your sync server.",
    submit: {
      signup: "Create my account",
      login: "Sign in",
      forgot: "Send the code",
      reset: "Change password",
    },
    busy: {
      signup: "Creating…",
      login: "Signing in…",
      forgot: "Sending…",
      reset: "Changing…",
    },
    signedUpToast: "Account created. First sync in progress…",
    loggedInToast: "Signed in. Syncing…",
    resetToast: "Password changed. You're signed in.",
    resetThenLogin: "Password changed. Sign in.",
    mergeTitle: "Merge with this account?",
    mergeText: (email: string) =>
      `This device already has projects. They'll be added to the account ${email}.`,
    merge: "Merge",
    server: (url: string) => `Server: ${url}`,
    syncNow: "Sync now",
    logout: "Sign out",
    loggingOut: "Syncing before you go…",
    logoutTitle: "Sign out of your account?",
    logoutText:
      "Your projects and tasks stay on this device. Syncing stops until you sign in again.",
    logoutPendingTitle: "Changes not sent yet",
    logoutPending: (n: number) =>
      n > 1
        ? `${n} changes haven't been sent to your account yet. They stay on this device and will be sent next time you sign in.`
        : "1 change hasn't been sent to your account yet. It stays on this device and will be sent next time you sign in.",
    logoutFailed:
      "Sync couldn't run: some changes may not have been sent to your account. They stay on this device and will be sent next time you sign in.",
    logoutAnyway: "Sign out anyway",
    loggedOutToast: "Signed out. Your projects stay on this device.",
    phone: {
      mergeText: (email: string) =>
        `This phone already has projects. They'll be added to the account ${email}.`,
      logoutText:
        "Your projects and tasks stay on this phone. Syncing stops until you sign in again.",
      logoutPending: (n: number) =>
        n > 1
          ? `${n} changes haven't been sent to your account yet. They stay on this phone and will be sent next time you sign in.`
          : "1 change hasn't been sent to your account yet. It stays on this phone and will be sent next time you sign in.",
      logoutFailed:
        "Sync couldn't run: some changes may not have been sent to your account. They stay on this phone and will be sent next time you sign in.",
      loggedOutToast: "Signed out. Your projects stay on this phone.",
    },
  },

  board: {
    tabs: "Project view",
    list: "List",
    board: "Kanban",
    hint: (first: string, second: string, agent: Agent) =>
      `Launching ${agentName(agent)} on a task in “${first}” moves it to “${second}”.`,
    columnLabel: (name: string, n: number) => `${name}, ${n} task${s(n)}`,
    more: (n: number) => `+ ${n} more`,
    addTask: "+ Task",
    addColumn: "+ Column",
    newColumnPlaceholder: "Column name",
    columnMenu: (name: string) => `Options for column “${name}”`,
    rename: "Rename",
    moveLeft: "Move left",
    moveRight: "Move right",
    delete: "Delete column",
    deleteTitle: (name: string) => `Delete column “${name}”?`,
    deleteMessage: (first: string) =>
      `Its tasks go back to “${first}”. No task is deleted.`,
    empty: "No tasks",
    loading: "Loading Kanban…",
    error: "Couldn't load the Kanban board.",
    retry: "Try again",
    dragLabel: (title: string) => `Move “${title}”`,
    notReady: "Columns arrive with the first sync. Check back in a moment.",
    notReadyError:
      "Couldn't add the column: the Kanban board is waiting for the first sync.",
    columnsNav: "Kanban columns",
    columnTab: (name: string, n: number) => `${name}, ${n} task${s(n)}`,
    moveTo: "Move to…",
    moveToLabel: (title: string) => `Move “${title}” to…`,
  },

  portfolio: {
    title: "Portfolio",
    subtitle: "All your projects, one row each.",
    export: "Export time (CSV)",
    exported: (path: string) => `Time exported: ${path}`,
    downloaded: (fileName: string) => `Time exported: ${fileName} downloaded`,
    fileName: (date: string, days: number) => `taido-time-${days}d-${date}.csv`,
    open: "Open tasks",
    done: (days: number) => `Completed (${days}d)`,
    overdue: "Overdue",
    time: (days: number) => `Time (${days}d)`,
    table: "Projects",
    cols: {
      project: "Project",
      open: "Open",
      done: (days: number) => `Completed ${days}d`,
      overdue: "Overdue",
      blocked: "Blocked",
      next: "Next due task",
      sessions: "Sessions",
      time: (days: number) => `Time ${days}d`,
      last: "Last activity",
    },
    sortBy: (col: string) => `Sort by ${col}`,
    noDated: "no dated task",
    running: (n: number) => `${n} session${s(n)} running`,
    waiting: (n: number) => `${n} session${s(n)} waiting for you`,
    noSession: "none",
    inactive: (n: number) => `inactive ${n}d`,
    never: "never",
    openDashboard: (name: string) => `Open the dashboard of ${name}`,
    empty: "No projects yet.",
    footnote:
      "Sorted by default by the nearest next due task. Click a project to open its dashboard.",
    loading: "Loading portfolio…",
    error: "Couldn't load the portfolio.",
  },

  dashboard: {
    tab: "Dashboard",
    period: "Period",
    days: (n: number) => (n === 1 ? "1 day" : `${n} days`),
    open: "Open",
    withSubtasks: (n: number) =>
      n === 0 ? "no subtasks" : `including ${n} subtask${s(n)}`,
    openDelta: (n: number, days: number) =>
      n === 0
        ? `steady over ${days}d`
        : `${n > 0 ? "+" : "−"}${Math.abs(n)} over ${days}d`,
    done: "Completed",
    doneBefore: (n: number) => `${n} in the previous period`,
    overdue: "Overdue",
    overdueHint: "past due date",
    blocked: "Blocked",
    blockedHint: (relation: number, waiting: number) =>
      `${relation} by a task · ${waiting} waiting for you`,
    blockedHintWeb: (relation: number) => `${relation} by a task`,
    time: "Time spent",
    perDone: (time: string) => `avg. ${time} per completed task`,
    noneDone: "no completed task",
    oldest: "Oldest open",
    oldestValue: (days: number) => `${days}d`,
    noOpen: "none",
    timeByDay: "Time per day",
    auto: (agent: Agent) => `${agentName(agent)} sessions (auto)`,
    manual: "added by hand",
    dayTip: (date: string, auto: string, manual: string, agent: Agent) =>
      `${date} · ${agentName(agent)} ${auto} · by hand ${manual}`,
    upcoming: "Next tasks on the calendar",
    undated: (n: number) =>
      n === 0
        ? "every open task has a date"
        : `${n} open task${s(n)} without a date`,
    noUpcoming: "No upcoming due dates",
    lateOrBlocked: "Overdue and blocked",
    late: (days: number) => `${days}d late`,
    blockedBy: (title: string) => `by: ${title}`,
    waiting: "waiting for you",
    nothingLate: "Nothing overdue or blocked",
    lingering: "Lingering tasks",
    age: (days: number) => (days === 0 ? "opened today" : `open for ${days}d`),
    timeByTask: (days: number) => `Time per task (${days}d)`,
    noTime: "No time in this period",
    loading: "Loading dashboard…",
    error: "Couldn't load the dashboard.",
    retry: "Try again",
    strip: "Project numbers",
    stripOpen: (n: number) => `${n} open`,
    stripDone: (n: number) => `${n} completed (7d)`,
    stripLate: (n: number) => `${n} overdue`,
    stripBlocked: (n: number) => `${n} blocked`,
    stripTime: (time: string) => `${time} this week`,
    stripOpenDashboard: "Open dashboard",
  },

  attachments: {
    title: "Attachments",
    hint: (agent: Agent) =>
      `copied to the task's folder, readable by ${agentName(agent)}`,
    drop: "Drop files here, paste a screenshot (⌘V), or",
    browse: "browse",
    pickTitle: "Attach files",
    download: "Download",
    downloaded: "Saved to Downloads",
    downloadError: {
      sync_offline:
        "This file isn't on this device yet and the server can't be reached.",
      sync_server:
        "The server returned an error during the download. Try again later.",
    },
    reveal: "Show in Finder",
    delete: "Remove",
    deleteTitle: (name: string) => `Remove “${name}”?`,
    removeOne: (name: string) => `Remove “${name}”`,
    deleteMessage:
      "It's removed from all your devices, and its copy in the task's folder is deleted. The original file stays where it is.",
    missing: "file not found",
    remote: {
      local_only: "On this device only",
      uploading: "Uploading…",
      to_download: "Not downloaded",
      downloading: "Downloading…",
      too_large: "Too large for the server",
      quota_full: "Account storage full",
    },
    web: {
      drop: "Drop files here, paste an image, or",
      adding: "Adding…",
      localOnly: "On this device only",
      deleteMessage: "It's removed from all your devices.",
      error: {
        unlinked: "Sign in to your account to download this file.",
        not_on_server:
          "This file hasn't reached your account yet. Try again later.",
        offline: "No connection: the file couldn't be downloaded.",
        corrupt: "The file received is damaged. Try again.",
        storage: "Not enough space on this device to keep this file.",
        not_found: "This file no longer exists.",
      },
    },
    added: (n: number, title: string) =>
      n > 1
        ? `${n} files attached to “${title}”`
        : `File attached to “${title}”`,
    rowCount: (n: number) => `${n} attachment${s(n)}`,
    pasted: (date: string) => `screenshot-${date}.png`,
    menu: (name: string) => `Options for “${name}”`,
    size: (bytes: number) =>
      bytes < 1024
        ? `${bytes} B`
        : bytes < 1024 * 1024
          ? `${Math.round(bytes / 1024)} KB`
          : `${(bytes / 1024 / 1024).toFixed(1)} MB`,
  },
  relations: {
    title: "Links",
    blocks: "Blocks",
    blockedBy: "Blocked by",
    related: "Related to",
    none: "none",
    add: "+ Link a task",
    menu: "Link a task",
    kind: "Link type",
    search: "Search, or browse below…",
    searchLabel: "Search for a task (all projects)",
    noResult: "No tasks found",
    loading: "Loading…",
    filters: "Filters",
    filter: {
      all: "All",
      recent: "Recent",
      project: "This project",
      waiting: "Waiting for you",
      done: "Completed",
    },
    recentGroup: "Recently changed",
    alreadyLinked: "already linked",
    showSubtasks: (n: number, title: string) =>
      n === 1
        ? `Show 1 subtask of “${title}”`
        : `Show the ${n} subtasks of “${title}”`,
    hideSubtasks: (title: string) => `Hide subtasks of “${title}”`,
    groupLabel: (project: string, n: number) => `${project}, ${n} task${s(n)}`,
    hints: {
      move: "select",
      subtasks: "subtasks",
      pick: "link",
      kind: "link type",
      close: "close",
    },
    remove: (title: string) => `Remove the link with “${title}”`,
    done: "completed",
    open: "to do",
    noProject: "Inbox",
    rowBlocks: (n: number) => `blocks ${n} task${s(n)}`,
    rowBlockedBy: (title: string, n = 1) =>
      n > 1 ? `blocked by: ${title} and ${n - 1} more` : `blocked by: ${title}`,
    rowRelated: (n: number) => `related to ${n} task${s(n)}`,
    warnTitle: "This task is blocked",
    warnMessage: (titles: string, agent: Agent) =>
      `It's still waiting on: ${titles}. You can launch ${agentName(agent)} anyway.`,
    warnConfirm: "Launch anyway",
  },

  folds: {
    addLabel: "Add:",
    add: {
      subtasks: "Subtask",
      attachments: "File",
      relations: "Link",
      chrono: "Time",
    },
    files: (n: number) => `${n} file${s(n)}`,
    blocks: (n: number) => `blocks ${n}`,
    blockedBy: (n: number) => `blocked by ${n}`,
    related: (n: number) => `related to ${n}`,
    blockedByChip: (n: number) => `Blocked by ${n}`,
    blockedByChipLabel: (n: number) =>
      `Blocked by ${n} unfinished task${s(n)}. See links`,
    chronoRunning: "running",
    chronoPaused: "paused",
    technical: "Folder and branch",
    journalCount: (n: number) => `${n} event${s(n)}`,
    showNote: "Show the whole note",
    hideNote: "Collapse the note",
    showAllSegments: (n: number) => `See all activity (${n})`,
    showFewerSegments: "Show less",
  },

  ask: {
    button: "Ask the project",
    title: "Ask the project",
    close: "Close",
    resize: "Resize the questions panel",
    newConversation: "New conversation",
    opening: "Opening Claude Code…",
    ended: "The conversation with Claude Code has ended.",
    restart: "New conversation",
    failedToOpen: "Claude Code couldn't open.",
    retry: "Try again",
    openError: "Couldn't open Claude Code.",
  },
  notes: {
    tab: "Notes",
    listLabel: "Notebook pages",
    search: "Search notes",
    clearSearch: "Clear search",
    noMatch: (query: string) => `No page contains “${query}”.`,
    searchFailed: "Search isn't available right now.",
    searchRetry: "Try again",
    pinned: "Pinned",
    pinnedEmptyWide: "Drag a page here to pin it",
    pinnedEmptyPhone: "No pinned pages",
    summaries: "Task summaries",
    ungrouped: "No group",
    newPage: "New page",
    newGroup: "New group",
    groupName: "Group name",
    groupMenu: (name: string) => `Actions for group ${name}`,
    newPageHere: "New page here",
    pageCount: (n: number) => (n === 1 ? "1 page" : `${n} pages`),
    toggleGroup: (name: string, open: boolean) =>
      open ? `Collapse ${name}` : `Expand ${name}`,
    rename: "Rename",
    renameGroup: "Rename group",
    deleteGroupTitle: (name: string) => `Delete group “${name}”?`,
    deleteGroupText: "The pages stay in the notebook, without a group.",
    pageMenu: (title: string) => `Actions for page ${title}`,
    pin: "Pin",
    unpin: "Unpin",
    moveTo: "Move to…",
    moveToLabel: (title: string) => `Move “${title}” to`,
    duplicate: "Duplicate",
    deleted: "Page deleted",
    deletedElsewhere: "This page was deleted on another device",
    untitled: "Untitled",
    titleLabel: "Page title",
    pageLabel: "Notebook page",
    summaryBadge: "Summary",
    summaryLine: (date: string) => `Summary · ${date}`,
    modified: (date: string) => `Edited ${date}`,
    back: "Notes",
    backLabel: "Back to notes",
    emptyTitle: "No notes in this project",
    emptyText:
      "Write down what you'll want to find later: logins, decisions, links…",
    emptyClaude:
      "Claude can write here too: ask it to “put this in the project notes”.",
    loadError: "Couldn't show the notes.",
    pageError: "Couldn't open this page.",
    noPageOpen: "Pick a page or create one.",
    mentionedIn: "Mentioned in",
    mentionedInNotes: "Mentioned in notes",
    mentionPage: "Page",
    mentionTask: "Task",
    editor: {
      bodyLabel: "Page text",
      placeholder: "Write here… “[[” to link a page or a task",
      toolbar: "Formatting",
      bold: "Bold",
      italic: "Italic",
      underline: "Underline",
      strike: "Strikethrough",
      highlight: "Highlight",
      heading1: "Heading 1",
      heading2: "Heading 2",
      heading: "Heading",
      headingNow: (level: 0 | 1 | 2) =>
        `Heading (${level === 0 ? "normal text" : `Heading ${level}`}). Change the level`,
      bulletList: "Bulleted list",
      orderedList: "Numbered list",
      taskList: "Checkbox",
      quote: "Quote",
      code: "Code",
      link: "Web link",
      linkUrl: "Link address",
      linkUrlHint: "Empty to remove the link",
      wikiLink: "Link a page or a task",
      undo: "Undo",
      more: "More styles",
      hideKeyboard: "Hide keyboard",
      linkSuggest: "Project pages and tasks",
      linkNone: "No page or task matches",
      linkPages: "Pages",
      linkTasks: "Tasks",
      linkDead: (label: string) => `${label} (not found)`,
      tooLong:
        "Page too long: it's no longer being saved. Shorten it or split it into several pages.",
      draftConflict:
        "This page was changed somewhere else. Your too-long text stayed on this device: which one do you want to keep?",
      draftResume: "Resume my draft",
      draftKeepCurrent: "Keep the current version",
      draftDropped: "Too-long draft discarded",
      draftKept:
        "Page too long: your text is kept on this device. Shorten it to save it.",
    },
    image: {
      add: "Add an image",
      pickTitle: "Choose images",
      adding: "Adding the image…",
      label: (name: string | null, width: number) =>
        `Image${name ? ` ${name}` : ""}, ${width}%. Change the size`,
      resize: "Resize image",
      sizes: "Image size",
      size: (width: number) => `${width}%`,
      remove: "Remove",
      removed: "Image removed",
      downloading: "Image downloading",
      missing: "Image not found",
      unsupportedFormat: "Image format not supported",
      open: "Open",
      onlyImages: "Only images can go in a page",
      addError: "Couldn't add the image.",
    },
    errors: {
      createPage: "Couldn't create the page.",
      updatePage: "Couldn't save the page.",
      movePage: "Couldn't move the page.",
      deletePage: "Couldn't delete the page.",
      createGroup: "Couldn't create the group.",
      updateGroup: "Couldn't rename the group.",
      deleteGroup: "Couldn't delete the group.",
    },
  },

  chrono: {
    title: "Timer",
    runningLabel: (time: string) => `Timer: ${time}, running`,
    pausedLabel: (time: string) => `Timer: ${time}, paused`,
    running: (agent: Agent) =>
      `${agentName(agent)} is working, the timer is running`,
    never: (agent: Agent) =>
      `The timer starts on its own when ${agentName(agent)} works on this task.`,
    paused: (reason: ChronoStop, agent: Agent): string =>
      ({
        waiting: `Paused: ${agentName(agent)} is waiting for you, it restarts when you answer`,
        turn_ended: `Paused: ${agentName(agent)} is done, it restarts with your next message`,
        session_closed: "Paused: session closed",
        task_done: "Stopped: task completed",
        app_closed: "Paused: Taido was closed",
      })[reason],
    pausedByHand: (agent: Agent) =>
      `Stopped by hand: it restarts on ${agentName(agent)}'s next turn`,
    eventTurnEnded: (agent: Agent) => `paused: ${agentName(agent)} is done`,
    event: {
      started: "started",
      waiting: "paused: waiting for you",
      turn_ended: "paused: turn ended",
      session_closed: "paused: session closed",
      task_done: "stopped: task completed",
      app_closed: "paused: Taido closed",
      manual: "added by hand",
      running: "running",
      stoppedByHand: "stopped by hand",
    },
    journal: "Activity",
    addManual: "+ Add time by hand",
    manualMinutes: "Duration (minutes)",
    manualNote: "Note (optional)",
    manualNotePlaceholder: "Meeting, call, invoice…",
    manualAdd: "Add",
    manualCancel: "Cancel",
    manualInvalid: "Enter a duration from 1 to 1440 minutes.",
    deleteSegment: "Remove this time",
    stop: "Stop",
    stopped: "Timer stopped.",
    settingWaiting: "Count time spent waiting for you in the timer",
    settingWaitingHint: (agent: Agent) =>
      `By default, the timer pauses when ${agentName(agent)} is waiting for you.`,
  },
};

/** Codex's own steps where Claude's would be wrong. */
const CODEX_TUTORIAL = (() => {
  const guide = mapTexts(en.tutorial, toCodex);
  return {
    ...guide,
    claude: {
      ...guide.claude,
      missing: `Codex isn't installed on this device. Install it (for example with ${agentInstallCommand("codex")}), then try again.`,
      notLoggedIn: `Codex is signed out. Run ${agentLoginCommand("codex")} in a terminal, then try again.`,
    },
    talk: {
      ...guide.talk,
      waiting:
        "Red: Codex is waiting for you. Answer it in the terminal. The first time, it asks whether it can trust the folder, then Taido's signals: choose “Trust and continue”, then “Trust all and continue” (down arrow, then Enter).",
    },
  };
})();

/** The guide's texts for the agent chosen at the first launch. */
const tutorialTexts = (agent: Agent): Strings["tutorial"] =>
  agent === "codex" ? CODEX_TUTORIAL : en.tutorial;

export { en };

/** The per-language helpers of this file, for the switch in `index.ts`. */
export const enHelpers = {
  agentName,
  agentProduct,
  agentInstallCommand,
  agentLoginCommand,
  agentErrorLabel,
  tutorialTexts,
};
