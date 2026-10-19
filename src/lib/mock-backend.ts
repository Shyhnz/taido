/**
 * In-memory implementation of every core command, used outside Tauri (browser `pnpm dev`)
 * and by the tests. It mirrors the rules of the Rust core: rings come
 * from the simulated Claude sessions (src/lib/mock-sessions.ts), Today = open tasks due today
 * or overdue, or whose ring is active, grouped as "Claude attend", "En retard", then the rest,
 * project views list loose tasks first then every section,
 * projects may have no folder and get the next palette color, deletions are soft (restorable),
 * positions are recomputed from indexes, the journal records creation, completion, reopening
 * and notes, and every mutation emits `data-changed` + `counts-changed`.
 *
 * A subtask is a child task (`parentId`, one level), with its own priority,
 * due date, terminals and sessions; the parent's ring takes the most critical state of the
 * task and its children. Lists show children under their parent (`TaskRow.children`); date
 * views (Today, Prochainement) also show a matching child on its own when its parent is not
 * listed. « Prochainement » lists one group per day, overdue tasks first.
 */

import { addDays } from "date-fns";
import type {
  AccountInfo,
  AccountInput,
  AddAttachmentDataInput,
  AddAttachmentsInput,
  AddManualTimeInput,
  AddNoteAttachmentDataInput,
  AddNoteAttachmentsInput,
  AddNoteInput,
  AddRelationInput,
  AddSubtaskInput,
  AddTarget,
  Agent,
  AgentStatus,
  AppStatus,
  AskEntry,
  AskInput,
  AskOverview,
  AskStarted,
  AskUpdated,
  AttachmentInfo,
  Board,
  BoardColumn,
  CopyNoteAttachmentInput,
  Counts,
  CountsChanged,
  CreateBoardColumnInput,
  CreateNoteGroupInput,
  CreateNotePageInput,
  CreateSectionInput,
  CreateSubjectInput,
  CreateTaskInput,
  Dashboard,
  DataChanged,
  DataScope,
  Due,
  Editor,
  ErrorPayload,
  Exchange,
  ForgotInput,
  GetViewInput,
  GroupOrder,
  GroupProjectsInput,
  HookEventLog,
  JournalEntry,
  JournalKind,
  MoveBoardColumnInput,
  MoveNotePageInput,
  MoveTaskInput,
  MoveToColumnInput,
  NoteAttachment,
  NotebookView,
  NoteGroup,
  NoteHit,
  NoteLinkRef,
  NotePage,
  NotificationOpened,
  OpenPathInput,
  OpenTerminalInput,
  PinNotePageInput,
  Portfolio,
  PortfolioRow,
  PruneNoteImagesInput,
  QuitRequested,
  RelationCandidate,
  RelationCandidates,
  RenameBoardColumnInput,
  RenameSessionInput,
  ReorderInput,
  ResetInput,
  ResizeTerminalInput,
  ResumeSessionInput,
  Ring,
  Section,
  SessionSummary,
  SetCompletedInput,
  SetDueInput,
  SetPriorityInput,
  SetTaskFolderInput,
  Settings,
  SettingsPatch,
  SetWorkdirOverrideInput,
  Subject,
  SubjectColor,
  SubjectDot,
  SubjectTag,
  Subtask,
  SyncChanged,
  SyncStatus,
  TaskDetail,
  TaskGroup,
  TaskHit,
  TaskLine,
  TaskRow,
  TaskStateChanged,
  TerminalExited,
  TerminalInfo,
  UpdateNoteGroupInput,
  UpdateNotePageInput,
  UpdateSectionInput,
  UpdateSubjectInput,
  UpdateSubtaskInput,
  UpdateTaskInput,
  ViewModel,
  VoiceChanged,
  VoiceLevel,
  VoiceStatus,
  Workdir,
  WriteTerminalInput,
} from "../bindings";
import { parseLocalDate, toLocalDateString } from "./dates";
import { SUBJECT_COLORS } from "./format";
import { askMarkdown, MockAsk } from "./mock-ask";
import { MockBoard } from "./mock-board";
import { MAX_MANUAL_MINUTES, MockChrono } from "./mock-chrono";
import { mockDashboard } from "./mock-dashboard";
import { isPageImage, type LinkedTask, MockLinks } from "./mock-links";
import { MockNotes, type NotePageRec } from "./mock-notes";
import { appendPosition, byPosition, MIN_GAP, placeAt } from "./mock-order";
import { seedMockData } from "./mock-seed";
import {
  deriveRing,
  isActiveToday,
  isClaudeWaiting,
  MockAgents,
  ringUrgency,
  type SessionRec,
  sessionLine,
} from "./mock-sessions";
import { MockSync } from "./mock-sync";
import { MockTerminals } from "./mock-terminals";
import { timeCsv } from "./mock-time-csv";
import { MockVoice } from "./mock-voice";
import {
  EPOCH_STAMP,
  SETTING_APPEARANCE,
  SETTING_INBOX_POSITION,
} from "./sync-proto";
import { COLOR_THEMES, THEMES } from "./theme";
import type { WebAttachmentFiles } from "./web-files";

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface SubjectRec {
  id: string;
  name: string;
  color: SubjectColor;
  /** Folder on disk, optional (D5); a sub-project without one uses its parent's. */
  rootPath: string | null;
  /** Set on a sub-project (one level only). */
  parentId: string | null;
  /** Among the projects of the same level (top level, or the same parent). */
  position: number;
  createdAt: string;
  updatedAt: string;
  /** Soft delete (restorable). */
  deletedAt: string | null;
  /**
   * Taido V2.2 bis: a group only gathers projects in the sidebar (no task, no section, no
   * folder). Optional: data saved before it (the phone) reads as a project.
   */
  isGroup?: boolean;
}

export interface SectionRec {
  id: string;
  subjectId: string;
  name: string;
  subpath: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRec {
  id: string;
  /** Set on a subtask (one level); it shares its parent's place. */
  parentId: string | null;
  /** 1 to 4 (by design: 2 yellow, 3 orange, 4 red outline). */
  priority: number;
  subjectId: string | null;
  sectionId: string | null;
  title: string;
  description: string;
  dueDate: string | null;
  dueTime: string | null;
  workdirOverride: string | null;
  completedAt: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
  /** Soft delete; a deleted project stamps its tasks with the same instant. */
  deletedAt: string | null;
  /**
   * Taido V2.7: the Kanban column as synced (`TaskData.board_column_id`); since V2.8 the
   * mock's board reads and moves it too (`MockBoard`). Optional: absent reads as none.
   */
  boardColumnId?: string | null;
}

interface JournalRec extends JournalEntry {
  seq: number;
}

export interface MockState {
  subjects: SubjectRec[];
  sections: SectionRec[];
  tasks: TaskRec[];
  journal: JournalRec[];
  settings: Settings;
  /**
   * Shared settings synced between devices (core `synced_settings`, docs/SYNC.md § 2.1), by
   * key: any JSON value. First key: `inbox_position` (« Sans projet » among the projects).
   */
  syncedSettings: Record<string, unknown>;
  /** Claude Code as the simulated core finds it; tests change it to simulate failures. */
  claude: MockClaude;
  /** Codex on this simulated Mac (same shape as Claude's). */
  codex: MockClaude;
}

/**
 * An item of the top level (core `top_level::TopItem`): a top-level project or « Sans
 * projet ».
 */
export type TopItem = { kind: "subject"; rec: SubjectRec } | { kind: "inbox" };

/** An item of the top-level order with its position (`null`: inbox never placed). */
interface PlacedTopItem {
  item: TopItem;
  position: number | null;
}

const sameTopItem = (a: TopItem, b: TopItem): boolean =>
  a.kind === "inbox"
    ? b.kind === "inbox"
    : b.kind === "subject" && a.rec.id === b.rec.id;

export interface MockClaude {
  /** The binary is found (else `check_claude` gives no path, launches fail `claude_missing`). */
  found: boolean;
  /** `claude auth status` → `loggedIn`; `null` when it could not be read. */
  loggedIn: boolean | null;
}

export const MOCK_CLAUDE_PATH = "/opt/homebrew/bin/claude";
export const MOCK_CLAUDE_VERSION = "2.1.288 (simulé)";
export const MOCK_CODEX_PATH = "/opt/homebrew/bin/codex";
export const MOCK_CODEX_VERSION = "0.162.1 (simulé)";

/** A readable shared theme (synced setting `appearance`); a later version's colour is not. */
function isAppearance(
  v: unknown,
): v is { theme: Settings["theme"]; color: Settings["colorTheme"] } {
  if (typeof v !== "object" || v === null) return false;
  const { theme, color } = v as Record<string, unknown>;
  return (
    THEMES.includes(theme as Settings["theme"]) &&
    COLOR_THEMES.includes(color as Settings["colorTheme"])
  );
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  colorTheme: "taido",
  syncTheme: true,
  panelWidth: 460,
  showCompleted: false,
  editor: "vscode",
  claudePath: null,
  summarizeSessions: true,
  notifications: true,
  workspaceRoot: "/Users/user/Todo",
  // The core starts at `not_started`; the mock plays an app already toured, so the tests and
  // `pnpm dev` open on their data. Guide tests and `/?premier-lancement` set it back.
  tutorial: {
    status: "done",
    step: null,
    subjectId: null,
    taskId: null,
  },
  chronoCountsWaiting: false,
  defaultAgent: "claude",
  codexPath: null,
  agentChosen: true,
  voiceSpaceHold: true,
};

/** Cards the done column shows (core `views::board::DONE_SHOWN`). */
export const BOARD_DONE_SHOWN = 3;

export const MOCK_PICKED_FOLDER = "/Users/user/Projets/nouveau-projet";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Same shape as a Tauri event delivered to `listen` callbacks. */
export interface MockEvent<T> {
  event: string;
  id: number;
  payload: T;
}

type Listener<T> = (event: MockEvent<T>) => void;

class MockEventChannel<T> {
  private listeners = new Set<Listener<T>>();
  private nextId = 1;

  constructor(private readonly name: string) {}

  listen = (cb: Listener<T>): Promise<() => void> => {
    this.listeners.add(cb);
    return Promise.resolve(() => {
      this.listeners.delete(cb);
    });
  };

  once = (cb: Listener<T>): Promise<() => void> => {
    const wrapped: Listener<T> = (e) => {
      this.listeners.delete(wrapped);
      cb(e);
    };
    return this.listen(wrapped);
  };

  emit = (payload: T): Promise<void> => {
    const event = { event: this.name, id: this.nextId++, payload };
    for (const cb of [...this.listeners]) cb(event);
    return Promise.resolve();
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function invalid(message: string): ErrorPayload {
  return { kind: "invalid", message };
}

function notFound(what: string, id: string): ErrorPayload {
  return { kind: "not_found", message: `${what} introuvable : ${id}` };
}

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw invalid(`${field} ne peut pas être vide`);
  return trimmed;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const clone = <T>(value: T): T => structuredClone(value);

/** Absolute path or `null` for "no folder" (empty string), like the core. */
function optionalFolder(path: string | null): string | null {
  if (path === null) return null;
  const trimmed = path.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith("/")) {
    throw invalid(`Le dossier doit être un chemin absolu : ${trimmed}`);
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export interface MockBackendOptions {
  /** Clock used for timestamps and the Today view (tests pin it). */
  now?: () => Date;
  /** Fill with the demo data inspired by the wireframes (default true). */
  seed?: boolean;
}

export class MockBackend {
  state: MockState;
  now: () => Date;
  private seq = 0;
  /** What `installed_editors` finds on this pretend Mac; tests change it. */
  installedEditorsHere: Editor[] = ["vscode", "cursor"];

  readonly events = {
    countsChanged: new MockEventChannel<CountsChanged>("counts-changed"),
    dataChanged: new MockEventChannel<DataChanged>("data-changed"),
    terminalExited: new MockEventChannel<TerminalExited>("terminal-exited"),
    quitRequested: new MockEventChannel<QuitRequested>("quit-requested"),
    taskStateChanged: new MockEventChannel<TaskStateChanged>(
      "task-state-changed",
    ),
    syncChanged: new MockEventChannel<SyncChanged>("sync-changed"),
    /** Never emitted here (no system notification in a browser); tests emit it. */
    notificationOpened: new MockEventChannel<NotificationOpened>(
      "notification-opened",
    ),
    voiceChanged: new MockEventChannel<VoiceChanged>("voice-changed"),
    voiceLevel: new MockEventChannel<VoiceLevel>("voice-level"),
    askUpdated: new MockEventChannel<AskUpdated>("ask-updated"),
  };

  /** Simulated « Demander au projet » (src/lib/mock-ask.ts). */
  readonly ask = new MockAsk({
    pages: (subjectId) =>
      this.notes.pages.filter(
        (p) => p.subjectId === subjectId && p.deletedAt === null,
      ),
    hasFolder: (subjectId) =>
      this.effectiveRoot(this.subjectRec(subjectId)) !== null,
    agent: () => {
      const installed = (["claude", "codex"] as const).filter(
        (a) => (a === "codex" ? this.codexStatus() : this.claudeStatus()).path,
      );
      const preferred = this.state.settings.defaultAgent;
      return installed.includes(preferred) ? preferred : (installed[0] ?? null);
    },
    emit: (askId, update) =>
      void this.events.askUpdated.emit({ askId, update }),
    now: () => this.nowIso(),
    stepMs: import.meta.env?.MODE === "test" ? 0 : 500,
  });

  /** Simulated dictation (src/lib/mock-voice.ts). */
  readonly voice = new MockVoice(
    (status) => void this.events.voiceChanged.emit({ status }),
    (level) => void this.events.voiceLevel.emit({ level }),
    import.meta.env?.MODE === "test" ? 0 : 80,
  );

  /** Task whose panel is open, as `set_open_task` last said (the core's notifications). */
  openTaskId: string | null = null;

  /** Simulated sync. */
  readonly sync = new MockSync(
    () => this.nowIso(),
    (status) => void this.events.syncChanged.emit({ status }),
  );

  /** Simulated terminals (no process runs in a browser). */
  readonly terminals = new MockTerminals((info) => {
    this.agents.onExit(info);
    void this.events.terminalExited.emit({
      terminalId: info.id,
      taskId: info.taskId,
      exitCode: info.exitCode,
      clean: info.exitCode === 0,
    });
    this.changed(["terminals", "tasks"], [info.taskId]);
  });

  /** Simulated Claude sessions (every state). */
  readonly agents = new MockAgents({
    nowIso: () => this.nowIso(),
    terminals: this.terminals,
    changed: (taskId) => this.stateChanged(taskId),
    summarizeSessions: () => this.state.settings.summarizeSessions,
  });

  /** Simulated chrono (Taido V2.1, src/lib/mock-chrono.ts). */
  readonly chrono = new MockChrono(() => this.newId("seg"));

  /**
   * The web app's attachment files (src/mobile/files.ts, Taido V2.7 bis): set by the phone's
   * backend, `null` here (the Mac's mock has paths, not files).
   */
  webFiles: WebAttachmentFiles | null = null;

  /** Simulated attachments and relations (Taido V2.3, src/lib/mock-links.ts). */
  readonly links = new MockLinks(
    (prefix) => this.newId(prefix),
    () => this.sync.get().state !== "unlinked",
  );

  /** The project notebook. */
  readonly notes = new MockNotes({
    newId: (prefix) => this.newId(prefix),
    now: () => this.nowIso(),
    ensureProject: (id) => {
      if (this.subjectRec(id).isGroup) {
        throw invalid(`Le projet ${id} est un groupe : il n'a pas de notes`);
      }
    },
    taskLive: (id) =>
      this.state.tasks.some((t) => t.id === id && t.deletedAt === null),
    projectLive: (id) => this.noteSubjectTag(id) !== null,
  });

  /** Simulated kanban columns (Taido V2.2, src/lib/mock-board.ts). */
  readonly board = new MockBoard({
    newId: () => this.newId("col"),
    now: () => this.nowIso(),
  });

  constructor(options: MockBackendOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.state = this.emptyState();
    this.terminals.setClaudeHandlers({
      onClaudeLine: (info, line) => this.agents.onLine(info, line),
      onClaudeEscape: (info) => this.agents.onEscape(info),
    });
    if (options.seed ?? true) seedMockData(this);
  }

  /** Clears everything (tests), optionally re-seeding. */
  reset(options: MockBackendOptions = {}): void {
    if (options.now) this.now = options.now;
    this.seq = 0;
    this.state = this.emptyState();
    this.installedEditorsHere = ["vscode", "cursor"];
    this.openTaskId = null;
    this.terminals.reset();
    this.agents.reset();
    this.chrono.reset();
    this.board.reset();
    this.links.reset();
    this.notes.reset();
    this.sync.reset();
    this.voice.reset();
    this.ask.reset();
    if (options.seed ?? false) seedMockData(this);
  }

  /** Closes terminals the core stops itself (task checked or deleted): sessions pause. */
  private closeTaskTerminals(taskId: string): void {
    for (const info of this.terminals.closeTask(taskId)) {
      this.agents.onClosed(info);
    }
  }

  /**
   * Ring of a task and the session it comes from. A parent's ring takes the most
   * critical state of its own sessions and those of its live subtasks.
   */
  private ringOf(t: TaskRec): { ring: Ring; session: SessionRec | null } {
    const sessions = [
      ...this.agents.forTask(t.id),
      ...this.childrenOf(t.id).flatMap((c) => this.agents.forTask(c.id)),
    ];
    return deriveRing(t.completedAt !== null, sessions);
  }

  /** A task's own ring (its sessions only, its children's left out). */
  private ownRing(t: TaskRec): Ring {
    return deriveRing(t.completedAt !== null, this.agents.forTask(t.id)).ring;
  }

  /** Row line: Claude's state only. */
  private rowLine(t: TaskRec): TaskLine | null {
    const { ring, session } = this.ringOf(t);
    // A stopped session shows as a plain task: no row line.
    return session && ring !== "human" ? sessionLine(session) : null;
  }

  /**
   * Like the core: `task-state-changed`, then `data-changed` + `counts-changed`. A subtask's
   * change also changes its parent's ring.
   */
  private stateChanged(taskId: string): void {
    this.reconcileChrono(taskId);
    const t = this.state.tasks.find(
      (x) => x.id === taskId && x.deletedAt === null,
    );
    if (!t) return;
    const parent = this.parentOf(t);
    const touched = parent ? [t, parent] : [t];
    for (const x of touched) {
      void this.events.taskStateChanged.emit({
        taskId: x.id,
        subjectId: x.subjectId,
        ring: this.ringOf(x).ring,
        line: this.rowLine(x),
        at: this.nowIso(),
      });
    }
    // Like the core: the subject dot follows the rings.
    this.changed(
      ["tasks", "subjects"],
      touched.map((x) => x.id),
    );
  }

  /** A task as the relations show it (core `relations::of_task`). */
  private linkedTask = (id: string): LinkedTask | null => {
    const t = this.state.tasks.find((x) => x.id === id);
    if (!t) return null;
    return {
      id: t.id,
      title: t.title,
      parentTitle: t.parentId
        ? (this.state.tasks.find((p) => p.id === t.parentId)?.title ?? null)
        : null,
      project: t.subjectId
        ? (this.state.subjects.find((s) => s.id === t.subjectId)?.name ?? null)
        : null,
      completed: t.completedAt !== null,
      deleted: t.deletedAt !== null,
    };
  };

  /** Folder of a task's attachments (core `attachments::folder_of`), simulated. */
  private attachmentFolder(t: TaskRec): string {
    const project = t.subjectId
      ? (this.state.subjects.find((s) => s.id === t.subjectId)?.name ??
        "Sans projet")
      : "Sans projet";
    const root = this.state.settings.workspaceRoot ?? "/Users/user/Taido";
    return `${root}/Pièces jointes/${project}/${t.title} (${t.id.slice(-6)})`;
  }

  /** Like the core's `time_segments::reconcile`: the chrono follows the task's own sessions. */
  private reconcileChrono(taskId: string): boolean {
    const t = this.state.tasks.find((x) => x.id === taskId);
    if (!t) return false;
    const sessions = this.agents
      .forTask(taskId)
      .slice()
      .sort((a, b) => b.since.localeCompare(a.since))
      .map((s) => ({ id: s.id, state: s.state }));
    return this.chrono.reconcile(
      taskId,
      {
        taskOpen: t.completedAt === null && t.deletedAt === null,
        sessions,
        countsWaiting: this.state.settings.chronoCountsWaiting,
      },
      this.nowIso(),
    );
  }

  private emptyState(): MockState {
    return {
      subjects: [],
      sections: [],
      tasks: [],
      journal: [],
      settings: clone(DEFAULT_SETTINGS),
      syncedSettings: {},
      claude: { found: true, loggedIn: true },
      codex: { found: true, loggedIn: true },
    };
  }

  newId(prefix: string): string {
    this.seq += 1;
    // A page, task or attachment id is 36 characters of `[0-9a-f-]` (a UUID's shape), so
    // that the `[[page:<id>]]`, `[[task:<id>]]` and `![[file:<id>]]` pointing at it parse;
    // the other ids are readable.
    if (prefix === "page" || prefix === "task" || prefix === "att") {
      return `00000000-0000-4000-8000-${this.seq.toString(16).padStart(12, "0")}`;
    }
    return `${prefix}-${this.seq.toString().padStart(4, "0")}`;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  /**
   * The CSV of « Exporter les temps » (Taido V2.8): the web app saves it as a download, where
   * the Mac's core writes a file (`exportTimeCsv`).
   */
  timeCsv(days: number): string {
    return timeCsv(
      this.chrono.segments,
      (taskId) => {
        const t = this.state.tasks.find(
          (x) => x.id === taskId && x.deletedAt === null,
        );
        if (!t) return null;
        const subject = t.subjectId
          ? this.state.subjects.find((x) => x.id === t.subjectId)
          : undefined;
        return { title: t.title, project: subject?.name ?? null };
      },
      days,
      this.now(),
    );
  }

  private today(): string {
    return toLocalDateString(this.now());
  }

  // --- lookups --------------------------------------------------------------

  /** Projects and tasks that are not soft-deleted. */
  private liveSubjects(): SubjectRec[] {
    return this.state.subjects.filter((s) => s.deletedAt === null);
  }

  /** Live projects of one level: top level when `parentId` is `null`, else its sub-projects. */
  private levelSubjects(parentId: string | null): SubjectRec[] {
    return this.liveSubjects()
      .filter((s) => s.parentId === parentId)
      .sort(byPosition);
  }

  /**
   * Live projects in sidebar order, like `list_subjects`: top-level projects
   * by position, each followed by its sub-projects by position.
   */
  private orderedSubjects(): SubjectRec[] {
    return this.levelSubjects(null).flatMap((p) => [
      p,
      ...this.levelSubjects(p.id),
    ]);
  }

  // --- top level: projects and « Sans projet » (core `db/top_level.rs`) ------------------
  //
  // « Sans projet » lives in the position space of the top-level projects; its position is
  // the synced setting `inbox_position`. An inbox position equal to a project's sorts the
  // inbox after it; an inbox never placed sorts last and is written only when it is moved,
  // or when a project is dropped past it; once placed, new projects go after everything.

  /**
   * The settings with, while « Même thème sur tous mes appareils » is on, the shared theme
   * (synced setting `appearance`) when it is readable, like the core's `settings::get`.
   */
  shownSettings(): Settings {
    const s = clone(this.state.settings);
    const shared = this.state.syncedSettings[SETTING_APPEARANCE];
    if (s.syncTheme && isAppearance(shared)) {
      s.theme = shared.theme;
      s.colorTheme = shared.color;
    }
    return s;
  }

  /** « Sans projet »'s position; `null` when never set or not a finite number. */
  inboxPosition(): number | null {
    const v = this.state.syncedSettings[SETTING_INBOX_POSITION];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }

  private setInboxPosition(position: number): void {
    this.state.syncedSettings[SETTING_INBOX_POSITION] = position;
  }

  /** Live top-level projects by (position, id), with the inbox at its place. */
  private placedTopLevel(): PlacedTopItem[] {
    const items: PlacedTopItem[] = this.levelSubjects(null).map((rec) => ({
      item: { kind: "subject", rec },
      position: rec.position,
    }));
    const inbox = this.inboxPosition();
    let at = items.length;
    if (inbox !== null) {
      at = items.findIndex((p) => p.position === null || p.position > inbox);
      if (at === -1) at = items.length;
    }
    items.splice(at, 0, { item: { kind: "inbox" }, position: inbox });
    return items;
  }

  /** The top-level order (core `top_level::order`). */
  topLevelOrder(): TopItem[] {
    return this.placedTopLevel().map((p) => p.item);
  }

  /** Index of « Sans projet » in the top-level order (core `top_level::inbox_index`). */
  inboxIndex(): number {
    return Math.max(
      0,
      this.topLevelOrder().findIndex((i) => i.kind === "inbox"),
    );
  }

  /**
   * Position after everything at the top level: max of every top-level project
   * (soft-deleted included) and of the inbox when placed, plus 1; 1 when empty (core
   * `top_level::append_position`).
   */
  private appendTopLevel(): number {
    const positions = this.state.subjects
      .filter((s) => s.parentId === null)
      .map((s) => s.position);
    const inbox = this.inboxPosition();
    if (inbox !== null) positions.push(inbox);
    return positions.length === 0 ? 1 : Math.max(...positions) + 1;
  }

  /**
   * Moves `moving` to `index` of the top-level order, the moved item excluded from the
   * siblings (past the end = last), like core `top_level::reorder`.
   */
  private placeTopLevel(moving: TopItem, index: number): void {
    const at = Math.max(0, Math.trunc(index));
    const items = this.placedTopLevel().filter(
      (p) => !sameTopItem(p.item, moving),
    );
    if (
      this.inboxPosition() === null &&
      moving.kind === "subject" &&
      at >= items.length
    ) {
      // Dropped past the inbox never placed (the last item): the inbox gets its place
      // first, so that the project lands after it.
      this.setInboxPosition(this.appendTopLevel());
    }
    const position = this.topLevelSlot(moving, at);
    if (moving.kind === "inbox") {
      this.setInboxPosition(position);
    } else {
      moving.rec.position = position;
      moving.rec.updatedAt = this.nowIso();
    }
  }

  /**
   * Position that puts `moving` at `index` among the other placed items (an inbox never
   * placed is left out: it stays last). Renumbers the level once when the gap is too small.
   */
  private topLevelSlot(moving: TopItem, index: number): number {
    for (let round = 0; round < 2; round += 1) {
      const real = this.placedTopLevel()
        .filter((p) => !sameTopItem(p.item, moving))
        .flatMap((p) => (p.position === null ? [] : [p.position]));
      if (index >= real.length) return this.appendTopLevel();
      const next = real[index];
      if (index === 0) return next - 1;
      const prev = real[index - 1];
      if (next - prev >= MIN_GAP) return prev + (next - prev) / 2;
      this.renumberTopLevel();
    }
    // After a renumbering every gap is at least 1: unreachable in practice.
    return this.appendTopLevel();
  }

  /**
   * Rewrites every top-level project (soft-deleted included) and the inbox when placed as
   * 1, 2, 3… in (position, inbox after ties, id) order.
   */
  private renumberTopLevel(): void {
    const items: {
      position: number;
      inbox: boolean;
      rec: SubjectRec | null;
    }[] = this.state.subjects
      .filter((s) => s.parentId === null)
      .map((rec) => ({ position: rec.position, inbox: false, rec }));
    const inbox = this.inboxPosition();
    if (inbox !== null) items.push({ position: inbox, inbox: true, rec: null });
    const id = (x: (typeof items)[number]) => x.rec?.id ?? "";
    items.sort(
      (a, b) =>
        a.position - b.position ||
        Number(a.inbox) - Number(b.inbox) ||
        (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0),
    );
    const at = this.nowIso();
    items.forEach((x, i) => {
      if (x.rec === null) {
        this.setInboxPosition(i + 1);
      } else {
        x.rec.position = i + 1;
        x.rec.updatedAt = at;
      }
    });
  }

  /** Position that puts a project last of a level: top level, or its parent's. */
  private appendSubject(parentId: string | null, excludeId?: string): number {
    if (parentId === null) return this.appendTopLevel();
    return appendPosition(
      this.state.subjects.filter(
        (s) => s.parentId === parentId && s.id !== excludeId,
      ),
    );
  }

  /** Rank of a project in the sidebar order (date views sort by it); deleted ones last. */
  private subjectRank(subjectId: string): number {
    const i = this.orderedSubjects().findIndex((s) => s.id === subjectId);
    return i === -1 ? Number.POSITIVE_INFINITY : i;
  }

  /** Folder of a project: its own, else its parent's for a sub-project. */
  private effectiveRoot(s: SubjectRec): string | null {
    if (s.rootPath !== null || s.parentId === null) return s.rootPath;
    const parent = this.state.subjects.find((p) => p.id === s.parentId);
    // A group is only visual (Taido V2.2 bis): its folder is never its projects'.
    return parent && !parent.isGroup ? parent.rootPath : null;
  }

  /** A project that can hold tasks and sections: not a group (Taido V2.2 bis). */
  private projectRec(id: string): SubjectRec {
    const s = this.subjectRec(id);
    if (s.isGroup) throw invalid("Un groupe ne contient pas de tâches");
    return s;
  }

  /** Top-level positions just after `group`, before the next top-level item. */
  private slotsAfter(group: SubjectRec, n: number): number[] {
    const after = [
      ...this.liveSubjects()
        .filter((s) => s.parentId === null && s.position > group.position)
        .map((s) => s.position),
      ...((this.inboxPosition() ?? -Infinity) > group.position
        ? [this.inboxPosition() as number]
        : []),
    ];
    const end = after.length > 0 ? Math.min(...after) : group.position + n + 1;
    const step = (end - group.position) / (n + 1);
    return Array.from({ length: n }, (_, i) => group.position + step * (i + 1));
  }

  /** Groups left without projects disappear, like Brave's. */
  private dropEmptyGroups(ids: Iterable<string>): void {
    const at = this.nowIso();
    for (const id of ids) {
      const g = this.state.subjects.find((s) => s.id === id);
      if (g?.isGroup && this.levelSubjects(g.id).length === 0) g.deletedAt = at;
    }
  }

  private liveTasks(): TaskRec[] {
    return this.state.tasks.filter((t) => t.deletedAt === null);
  }

  /**
   * What project lists, counts and dots are made of, like the core (`listed_open_sql`): live
   * tasks that are not subtasks, and the open subtasks of a completed task (shown nowhere
   * else).
   */
  private topTasks(): TaskRec[] {
    return this.liveTasks().filter(
      (t) =>
        t.parentId === null ||
        (t.completedAt === null && this.parentOf(t)?.completedAt != null),
    );
  }

  /**
   * Live subtasks of a task, like the core: open ones by position, then completed ones,
   * most recent first.
   */
  private childrenOf(taskId: string): TaskRec[] {
    const children = this.liveTasks().filter((t) => t.parentId === taskId);
    return [
      ...children.filter((c) => c.completedAt === null).sort(byPosition),
      ...children
        .filter((c) => c.completedAt !== null)
        .sort(
          (a, b) =>
            (b.completedAt ?? "").localeCompare(a.completedAt ?? "") ||
            a.id.localeCompare(b.id),
        ),
    ];
  }

  private parentOf(t: TaskRec): TaskRec | null {
    if (t.parentId === null) return null;
    return this.state.tasks.find((x) => x.id === t.parentId) ?? null;
  }

  /** Ids touched by a change of `t`: itself and its parent (counter, ring). */
  private withParent(t: TaskRec): string[] {
    return t.parentId === null ? [t.id] : [t.id, t.parentId];
  }

  /**
   * Ids a task mutation notifies, like the core's `task_mutation`: the task, its parent and
   * its children (their panels show its project, folder and title).
   */
  private withFamily(t: TaskRec): string[] {
    return [...this.withParent(t), ...this.childrenOf(t.id).map((c) => c.id)];
  }

  private subjectRec(id: string): SubjectRec {
    const s = this.state.subjects.find(
      (x) => x.id === id && x.deletedAt === null,
    );
    if (!s) throw notFound("Projet", id);
    return s;
  }

  private sectionRec(id: string): SectionRec {
    const s = this.state.sections.find((x) => x.id === id);
    if (!s) throw notFound("Section", id);
    return s;
  }

  private taskRec(id: string): TaskRec {
    const t = this.state.tasks.find((x) => x.id === id && x.deletedAt === null);
    if (!t) throw notFound("Tâche", id);
    return t;
  }

  /** A subtask is a live task with a parent. */
  private subtaskRec(id: string): TaskRec {
    const s = this.state.tasks.find(
      (x) => x.id === id && x.deletedAt === null && x.parentId !== null,
    );
    if (!s) throw notFound("Sous-tâche", id);
    return s;
  }

  private sectionsOf(subjectId: string): SectionRec[] {
    return this.state.sections
      .filter((s) => s.subjectId === subjectId)
      .sort(byPosition);
  }

  /** Open tasks sharing the place (subject, section) of a task. */
  private openSiblings(subjectId: string | null, sectionId: string | null) {
    return this.topTasks().filter(
      (t) =>
        t.parentId === null &&
        t.subjectId === subjectId &&
        t.sectionId === sectionId &&
        t.completedAt === null,
    );
  }

  private validatePlace(subjectId: string | null, sectionId: string | null) {
    if (subjectId !== null) this.projectRec(subjectId);
    if (sectionId !== null) {
      if (subjectId === null) {
        throw invalid("Une section exige un sujet");
      }
      const section = this.sectionRec(sectionId);
      if (section.subjectId !== subjectId) {
        throw invalid("La section n'appartient pas à ce sujet");
      }
    }
  }

  // --- builders -------------------------------------------------------------

  private toSection(s: SectionRec): Section {
    const openCount = this.topTasks().filter(
      (t) => t.sectionId === s.id && t.completedAt === null,
    ).length;
    return {
      id: s.id,
      subjectId: s.subjectId,
      name: s.name,
      subpath: s.subpath,
      position: s.position,
      openCount,
    };
  }

  private toSubject(s: SubjectRec): Subject {
    const openCount = this.topTasks().filter(
      (t) => t.subjectId === s.id && t.completedAt === null,
    ).length;
    return {
      id: s.id,
      name: s.name,
      color: s.color,
      rootPath: s.rootPath,
      position: s.position,
      sections: this.sectionsOf(s.id).map((x) => this.toSection(x)),
      openCount,
      dot: this.subjectDot(s),
      parentId: s.parentId,
      isGroup: s.isGroup ?? false,
    };
  }

  /**
   * Red if a task waits, else black for an error, else green for Done. A parent's
   * dot includes its sub-projects' tasks.
   */
  private subjectDot(s: SubjectRec): SubjectDot | null {
    const ids = new Set([s.id, ...this.levelSubjects(s.id).map((c) => c.id)]);
    const rings = new Set(
      this.topTasks()
        .filter(
          (t) =>
            t.subjectId !== null &&
            ids.has(t.subjectId) &&
            t.completedAt === null,
        )
        .map((t) => this.ringOf(t).ring),
    );
    if (rings.has("waiting")) return "waiting";
    if (rings.has("error") || rings.has("crashed")) return "error";
    if (rings.has("done")) return "done";
    return null;
  }

  private tag(subjectId: string | null): SubjectTag | null {
    if (subjectId === null) return null;
    const s = this.state.subjects.find((x) => x.id === subjectId);
    return s ? { id: s.id, name: s.name, color: s.color } : null;
  }

  private due(t: TaskRec): Due | null {
    if (t.dueDate === null) return null;
    return {
      date: t.dueDate,
      time: t.dueTime,
      overdue: t.dueDate < this.today(),
    };
  }

  /** Panel line (the list rows never show the description nor the completion). */
  private line(t: TaskRec): TaskLine | null {
    const { session } = this.ringOf(t);
    // The panel still tells when the last Claude session stopped.
    if (session) return sessionLine(session);
    if (t.completedAt !== null) {
      return {
        kind: "completed",
        agent: null,
        text: null,
        at: t.completedAt,
        tone: "faint",
      };
    }
    const first = t.description
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (!first) return null;
    const text = first.length > 120 ? `${first.slice(0, 119)}…` : first;
    return { kind: "description", agent: null, text, at: null, tone: "muted" };
  }

  private toRow(t: TaskRec, multiSubject: boolean): TaskRow {
    // A completed task carries its completed subtasks only: an open one is listed on its own.
    const subtasks = this.childrenOf(t.id).filter(
      (c) => t.completedAt === null || c.completedAt !== null,
    );
    return {
      id: t.id,
      title: t.title,
      subject: multiSubject ? this.tag(t.subjectId) : null,
      subjectId: t.subjectId,
      sectionId: t.sectionId,
      ring: this.ringOf(t).ring,
      // Reserved to Claude's state.
      line: this.rowLine(t),
      hasDescription: t.description.trim().length > 0,
      due: this.due(t),
      openTerminals: this.terminals.forTask(t.id).filter((x) => x.running)
        .length,
      subtasksDone: subtasks.filter((s) => s.completedAt !== null).length,
      subtasksTotal: subtasks.length,
      completedAt: t.completedAt,
      position: t.position,
      priority: t.priority,
      parentId: t.parentId,
      // One level only: a subtask's row has no children.
      children:
        t.parentId === null
          ? subtasks.map((c) => this.toRow(c, multiSubject))
          : [],
      chrono: this.chrono.chronoOf(t.id),
      attachmentCount: this.links.count(t.id),
      ...this.links.rowFacts(t.id, this.linkedTask),
    };
  }

  private workdir(t: TaskRec): Workdir | null {
    if (t.workdirOverride) {
      return { path: t.workdirOverride, source: "task", exists: true };
    }
    // A subtask works in its parent's folder.
    const parent = this.parentOf(t);
    if (parent) return this.workdir(parent);
    if (t.subjectId === null) return null;
    // A sub-project without folder works in its parent's.
    const rootPath = this.effectiveRoot(this.subjectRec(t.subjectId));
    if (rootPath === null) return null;
    const section = t.sectionId
      ? this.state.sections.find((s) => s.id === t.sectionId)
      : undefined;
    if (section?.subpath) {
      const root = rootPath.replace(/\/+$/, "");
      return {
        path: `${root}/${section.subpath}`,
        source: "section",
        exists: true,
      };
    }
    return { path: rootPath, source: "subject", exists: true };
  }

  private toDetail(t: TaskRec): TaskDetail {
    const section = t.sectionId
      ? this.state.sections.find((s) => s.id === t.sectionId)
      : undefined;
    const workdir = this.workdir(t);
    const { ring, session } = this.ringOf(t);
    const terminals = this.terminals.forTask(t.id);
    return {
      id: t.id,
      title: t.title,
      description: t.description,
      subject: this.tag(t.subjectId),
      section: section ? { id: section.id, name: section.name } : null,
      due: this.due(t),
      workdir,
      workdirOverride: t.workdirOverride,
      gitBranch: workdir ? "main" : null,
      ring,
      line: this.line(t),
      ringSince: session ? session.since : t.completedAt,
      subtasks: this.childrenOf(t.id).map((s) => this.toSubtask(s)),
      completedAt: t.completedAt,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      terminals,
      sessions: this.agents.views(terminals),
      priority: t.priority,
      parent: this.parentRef(t),
      time: this.chrono.timeOf(t.id),
      attachments: this.links.list(t.id),
      relations: this.links.of(t.id, this.linkedTask),
    };
  }

  private parentRef(t: TaskRec): { id: string; title: string } | null {
    const parent = this.parentOf(t);
    return parent ? { id: parent.id, title: parent.title } : null;
  }

  private toSubtask(s: TaskRec): Subtask {
    return {
      id: s.id,
      taskId: s.parentId ?? "",
      text: s.title,
      done: s.completedAt !== null,
      position: s.position,
      ring: this.ownRing(s),
      priority: s.priority,
      due: this.due(s),
      openTerminals: this.terminals.forTask(s.id).filter((x) => x.running)
        .length,
    };
  }

  private completedDesc(tasks: TaskRec[], multi: boolean): TaskRow[] {
    return tasks
      .filter((t) => t.completedAt !== null)
      .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
      .map((t) => this.toRow(t, multi));
  }

  /**
   * Open tasks of the Today view (due today or before, or with an active ring), sorted like
   * the core: ring urgency, due time, project order (no project first), then position.
   */
  private todayTasks(): TaskRec[] {
    const today = this.today();
    return this.datedTasks(
      (t) =>
        (t.dueDate !== null && t.dueDate <= today) ||
        // Its own Claude only: a child's Claude brings the child, not its parent.
        isActiveToday(this.ownRing(t)),
    ).sort(this.dateOrder);
  }

  /** Order of the date views: ring urgency, due time, project order, then position. */
  private dateOrder = (a: TaskRec, b: TaskRec): number => {
    const subjectPos = (t: TaskRec) =>
      t.subjectId === null
        ? Number.NEGATIVE_INFINITY
        : this.subjectRank(t.subjectId);
    const ua = ringUrgency(this.ringOf(a).ring);
    const ub = ringUrgency(this.ringOf(b).ring);
    if (ua !== ub) return ua - ub;
    const ta = a.dueTime ?? "99:99";
    const tb = b.dueTime ?? "99:99";
    if (ta !== tb) return ta.localeCompare(tb);
    const sa = subjectPos(a);
    const sb = subjectPos(b);
    if (sa !== sb) return sa - sb;
    return a.position - b.position || a.id.localeCompare(b.id);
  };

  /**
   * Open top-level tasks of a date view (Today, Prochainement) matching `match`, plus the
   * open subtasks matching on their own when their parent does not (core `dated`, like
   * Todoist); a subtask whose parent matches stays under it.
   */
  private datedTasks(match: (t: TaskRec) => boolean): TaskRec[] {
    return this.topTasks()
      .filter((t) => t.completedAt === null)
      .flatMap((t) =>
        match(t)
          ? [t]
          : this.childrenOf(t.id).filter(
              (c) => c.completedAt === null && match(c),
            ),
      );
  }

  /** Order within a day of « Prochainement » (core `day_order`): due time, project, position. */
  private dayOrder = (a: TaskRec, b: TaskRec): number => {
    const subjectPos = (t: TaskRec) =>
      t.subjectId === null
        ? Number.NEGATIVE_INFINITY
        : this.subjectRank(t.subjectId);
    const ta = a.dueTime ?? "99:99";
    const tb = b.dueTime ?? "99:99";
    if (ta !== tb) return ta.localeCompare(tb);
    const sa = subjectPos(a);
    const sb = subjectPos(b);
    if (sa !== sb) return sa - sb;
    return a.position - b.position || a.id.localeCompare(b.id);
  };

  // --- journal & events -----------------------------------------------------

  private journalAdd(taskId: string, kind: JournalKind, text = ""): JournalRec {
    this.seq += 1;
    const entry: JournalRec = {
      id: `journal-${this.seq.toString().padStart(4, "0")}`,
      taskId,
      agentSessionId: null,
      agent: null,
      kind,
      text,
      at: this.nowIso(),
      seq: this.seq,
    };
    this.state.journal.push(entry);
    return entry;
  }

  private changed(scopes: DataScope[], taskIds: string[] | null = null) {
    void this.events.dataChanged.emit({ scopes, taskIds });
    void this.events.countsChanged.emit({ counts: this.counts() });
  }

  /**
   * `data-changed` + `counts-changed` after records were changed from outside
   * the commands (the PWA applying pulled rows to `state`).
   */
  emitDataChanged(scopes: DataScope[], taskIds: string[] | null = null): void {
    this.changed(scopes, taskIds);
  }

  private counts(): Counts {
    const today = this.todayTasks();
    return {
      inbox: this.topTasks().filter(
        (t) => t.subjectId === null && t.completedAt === null,
      ).length,
      today: today.length,
      // A waiting subtask makes its parent wait: counted once, on the row that shows it.
      waiting: today.filter((t) => this.ringOf(t).ring === "waiting").length,
    };
  }

  // --- internal helpers used by the seed ------------------------------------

  insertSubject(
    rec: Omit<SubjectRec, "position" | "deletedAt" | "parentId"> &
      Partial<Pick<SubjectRec, "parentId" | "isGroup">>,
  ): SubjectRec {
    const parentId = rec.parentId ?? null;
    const subject = {
      ...rec,
      parentId,
      position: this.appendSubject(parentId),
      deletedAt: null,
    };
    this.state.subjects.push(subject);
    return subject;
  }

  insertSection(rec: Omit<SectionRec, "position">): SectionRec {
    const section = {
      ...rec,
      position: appendPosition(this.sectionsOf(rec.subjectId)),
    };
    this.state.sections.push(section);
    return section;
  }

  insertTask(
    rec: Omit<TaskRec, "position" | "deletedAt" | "parentId" | "priority"> &
      Partial<Pick<TaskRec, "parentId" | "priority">>,
  ): TaskRec {
    const parentId = rec.parentId ?? null;
    // Subtasks are numbered among their siblings, tasks among their place.
    const siblings = this.state.tasks.filter((t) =>
      parentId !== null
        ? t.parentId === parentId
        : t.parentId === null &&
          t.subjectId === rec.subjectId &&
          t.sectionId === rec.sectionId,
    );
    const position =
      siblings.reduce((max, t) => Math.max(max, t.position), 0) + 1;
    const task: TaskRec = {
      ...rec,
      parentId,
      priority: rec.priority ?? 1,
      position,
      deletedAt: null,
    };
    this.state.tasks.push(task);
    return task;
  }

  /** A subtask is a child task in its parent's place. */
  insertSubtask(
    taskId: string,
    text: string,
    done: boolean,
    at: string,
  ): TaskRec {
    const parent = this.taskRec(taskId);
    return this.insertTask({
      id: this.newId("task"),
      parentId: parent.id,
      subjectId: parent.subjectId,
      sectionId: parent.sectionId,
      title: text,
      description: "",
      dueDate: null,
      dueTime: null,
      workdirOverride: null,
      completedAt: done ? at : null,
      createdAt: at,
      updatedAt: at,
    });
  }

  insertJournal(taskId: string, kind: JournalKind, text: string, at: string) {
    const entry = this.journalAdd(taskId, kind, text);
    entry.at = at;
  }

  // -------------------------------------------------------------------------
  // Commands (same names and signatures as `commands` in src/bindings.ts)
  // -------------------------------------------------------------------------

  readonly commands = {
    /** Flat, in sidebar order: each top-level project followed by its sub-projects. */
    listSubjects: async (): Promise<Subject[]> =>
      clone(this.orderedSubjects().map((s) => this.toSubject(s))),

    createSubject: async (input: CreateSubjectInput): Promise<Subject> => {
      const name = requireText(input.name, "Le nom");
      const rootPath = optionalFolder(input.rootPath);
      if (input.color !== null && !SUBJECT_COLORS.includes(input.color)) {
        throw invalid(`Couleur inconnue : ${input.color}`);
      }
      // Like the core: no parent, or `""` (blank), means a top-level project.
      const parentRef = input.parentId?.trim();
      const parentId = parentRef ? this.parentFor(parentRef, null) : null;
      const at = this.nowIso();
      const subject: SubjectRec = {
        id: this.newId("subject"),
        name,
        color: input.color ?? this.nextColor(),
        // A project of a group gets no folder from the group (Taido V2.2 bis).
        rootPath,
        parentId,
        // Last of its level: after everything at the top level (« Sans projet » included
        // once placed), or among its parent's sub-projects.
        position: this.appendSubject(parentId),
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
      };
      this.state.subjects.push(subject);
      this.changed(["subjects"]);
      return clone(this.toSubject(subject));
    },

    updateSubject: async (input: UpdateSubjectInput): Promise<Subject> => {
      const s = this.subjectRec(input.id);
      if (input.name !== null) s.name = requireText(input.name, "Le nom");
      if (input.color !== null) {
        if (!SUBJECT_COLORS.includes(input.color)) {
          throw invalid(`Couleur inconnue : ${input.color}`);
        }
        s.color = input.color;
      }
      // `""` unlinks the folder.
      if (input.rootPath !== null) s.rootPath = optionalFolder(input.rootPath);
      // `""` makes it a top-level project, else the new parent.
      if (input.parentId !== null) {
        const parentId =
          input.parentId === "" ? null : this.parentFor(input.parentId, s);
        if (parentId !== s.parentId) {
          // Last of its new level (like the core: the level it left keeps its positions).
          s.position = this.appendSubject(parentId, s.id);
          s.parentId = parentId;
        }
      }
      s.updatedAt = this.nowIso();
      this.changed(["subjects", "tasks"]);
      return clone(this.toSubject(s));
    },

    /**
     * Soft delete: the project, its live sub-projects and all their live
     * tasks share the deletion instant.
     */
    deleteSubject: async (id: string): Promise<null> => {
      const s = this.subjectRec(id);
      const at = this.nowIso();
      const family = [s, ...this.levelSubjects(s.id)];
      const ids = new Set(family.map((x) => x.id));
      for (const x of family) x.deletedAt = at;
      for (const t of this.liveTasks()) {
        if (t.subjectId !== null && ids.has(t.subjectId)) {
          t.deletedAt = at;
          this.closeTaskTerminals(t.id);
        }
      }
      this.changed(["subjects", "tasks", "terminals"]);
      return null;
    },

    /**
     * Undoes `deleteSubject`: the project comes back with the sub-projects and tasks deleted
     * with it. A sub-project whose parent is still deleted cannot come back alone.
     */
    restoreSubject: async (id: string): Promise<Subject> => {
      const s = this.state.subjects.find(
        (x) => x.id === id && x.deletedAt !== null,
      );
      if (!s) throw notFound("Projet supprimé", id);
      // Core parity: when its parent has become a sub-project meanwhile, it comes back as a
      // top-level project, last (one level only).
      let promote = false;
      if (s.parentId !== null) {
        const parent = this.state.subjects.find((x) => x.id === s.parentId);
        if (!parent || parent.deletedAt !== null) {
          throw notFound("Projet parent", s.parentId);
        }
        promote = parent.parentId !== null;
      }
      const at = s.deletedAt;
      const family = [
        s,
        ...this.state.subjects.filter(
          (x) => x.parentId === s.id && x.deletedAt === at,
        ),
      ];
      const ids = new Set(family.map((x) => x.id));
      for (const t of this.state.tasks) {
        if (
          t.subjectId !== null &&
          ids.has(t.subjectId) &&
          t.deletedAt === at
        ) {
          t.deletedAt = null;
        }
      }
      for (const x of family) x.deletedAt = null;
      if (promote) {
        // Last of the top level (« Sans projet » included once placed).
        s.position = this.appendSubject(null, s.id);
        s.parentId = null;
      }
      this.changed(["subjects", "tasks"]);
      return clone(this.toSubject(s));
    },

    /**
     * Moves a project among its siblings. At the top level `index` counts « Sans projet »
     * (index in the top-level order, even when the sidebar hides it); a sub-project moves
     * among its parent's live sub-projects.
     */
    reorderSubject: async (input: ReorderInput): Promise<null> => {
      const s = this.subjectRec(input.id);
      if (s.parentId === null) {
        this.placeTopLevel({ kind: "subject", rec: s }, input.index);
      } else {
        placeAt(this.levelSubjects(s.parentId), s, input.index);
      }
      // Today sorts by project order.
      this.changed(["subjects", "tasks"]);
      return null;
    },

    /** Index of « Sans projet » among the top-level projects (core `get_inbox_index`). */
    getInboxIndex: async (): Promise<number> => this.inboxIndex(),

    /**
     * Moves « Sans projet » to `index` among the top-level projects (« Sans projet »
     * excluded from the siblings). Its position is a synced setting.
     */
    reorderInbox: async (index: number): Promise<null> => {
      this.placeTopLevel({ kind: "inbox" }, index);
      this.changed(["subjects", "tasks"]);
      return null;
    },

    createSection: async (input: CreateSectionInput): Promise<Section> => {
      this.projectRec(input.subjectId);
      const name = requireText(input.name, "Le nom");
      const subpath = input.subpath?.trim() ? input.subpath.trim() : null;
      const at = this.nowIso();
      const section: SectionRec = {
        id: this.newId("section"),
        subjectId: input.subjectId,
        name,
        subpath,
        position:
          this.sectionsOf(input.subjectId).reduce(
            (m, s) => Math.max(m, s.position),
            0,
          ) + 1,
        createdAt: at,
        updatedAt: at,
      };
      this.state.sections.push(section);
      this.changed(["subjects", "tasks"]);
      return clone(this.toSection(section));
    },

    updateSection: async (input: UpdateSectionInput): Promise<Section> => {
      const s = this.sectionRec(input.id);
      if (input.name !== null) s.name = requireText(input.name, "Le nom");
      if (input.subpath !== null) {
        const sub = input.subpath.trim();
        s.subpath = sub.length > 0 ? sub : null;
      }
      s.updatedAt = this.nowIso();
      this.changed(["subjects", "tasks"]);
      return clone(this.toSection(s));
    },

    deleteSection: async (id: string): Promise<null> => {
      const section = this.sectionRec(id);
      // Like the core: the section's tasks go after every task already outside sections
      // (deleted and completed ones included), keeping their order.
      const loose = this.state.tasks.filter(
        (t) =>
          t.parentId === null &&
          t.subjectId === section.subjectId &&
          t.sectionId === null,
      );
      const base =
        loose.length === 0 ? 1 : Math.max(...loose.map((t) => t.position)) + 1;
      const inSection = this.state.tasks.filter((t) => t.sectionId === id);
      const tops = inSection.filter((t) => t.parentId === null);
      const min = Math.min(...tops.map((t) => t.position));
      const moved: string[] = [];
      for (const t of inSection) {
        t.sectionId = null;
        // Subtasks keep their order among their siblings.
        if (t.parentId === null) t.position = base + t.position - min;
        moved.push(t.id);
      }
      this.state.sections = this.state.sections.filter((s) => s.id !== id);
      this.changed(["subjects", "tasks"], moved);
      return null;
    },

    reorderSection: async (input: ReorderInput): Promise<null> => {
      const s = this.sectionRec(input.id);
      placeAt(this.sectionsOf(s.subjectId), s, input.index);
      this.changed(["subjects", "tasks"]);
      return null;
    },

    getView: async (input: GetViewInput): Promise<ViewModel> =>
      clone(this.view(input)),

    // --- Taido V2.3: attachments and relations -----------------------------------

    addAttachments: async (input: AddAttachmentsInput): Promise<TaskDetail> => {
      const t = this.taskRec(input.taskId);
      for (const path of input.paths) {
        if (!path.startsWith("/")) throw invalid(`Pas un fichier : ${path}`);
        const name = path.split("/").pop() || "fichier";
        this.links.add(
          t.id,
          this.attachmentFolder(t),
          name,
          1024,
          this.nowIso(),
        );
      }
      this.changed(["tasks"], this.withParent(t));
      return clone(this.toDetail(t));
    },

    addAttachmentData: async (
      input: AddAttachmentDataInput,
    ): Promise<TaskDetail> => {
      const t = this.taskRec(input.taskId);
      if (!/^[A-Za-z0-9+/=\s]+$/.test(input.base64)) {
        throw invalid("Données collées illisibles");
      }
      const name = input.name.trim() || "capture.png";
      this.links.add(
        t.id,
        this.attachmentFolder(t),
        name,
        Math.floor((input.base64.length * 3) / 4),
        this.nowIso(),
        `data:image/png;base64,${input.base64.trim()}`,
      );
      this.changed(["tasks"], this.withParent(t));
      return clone(this.toDetail(t));
    },

    deleteAttachment: async (id: string): Promise<TaskDetail> => {
      const a = this.links.getTaskAttachment(id);
      a.deletedAt = this.nowIso();
      const t = this.taskRec(a.taskId);
      this.changed(["tasks"], this.withParent(t));
      return clone(this.toDetail(t));
    },

    attachmentPreview: async (id: string): Promise<string | null> => {
      const a = this.links.get(id);
      return a.isImage ? a.dataUrl : null;
    },

    /** « Télécharger » (Mac): a pretend copy in the Downloads folder (src/lib/mock-links.ts). */
    downloadAttachment: async (id: string): Promise<string> => {
      const fetched = !this.links.getTaskAttachment(id).exists;
      const copy = this.links.download(id);
      if (fetched) {
        this.changed(
          ["tasks"],
          this.withParent(this.taskRec(this.links.get(id).taskId)),
        );
      }
      return copy;
    },

    revealPath: async (_path: string): Promise<null> => null,

    revealAttachment: async (id: string): Promise<null> => {
      this.links.getTaskAttachment(id);
      return null;
    },

    pickFiles: async (_title: string | null): Promise<string[]> => [
      "/Users/user/Documents/maquette-export.png",
    ],

    addRelation: async (input: AddRelationInput): Promise<TaskDetail> => {
      const t = this.taskRec(input.taskId);
      const other = this.taskRec(input.otherId);
      this.links.addRelation(input, this.nowIso());
      this.changed(["tasks"], [...this.withParent(t), other.id]);
      return clone(this.toDetail(t));
    },

    deleteRelation: async (id: string): Promise<null> => {
      const [a, b] = this.links.deleteRelation(id, this.nowIso());
      this.changed(["tasks"], [a, b]);
      return null;
    },

    /** « Ajouter les projets à un groupe » (Taido V2.2 bis), like the core. */
    groupProjects: async (input: GroupProjectsInput): Promise<string> => {
      const projects = input.projectIds.map((id) => this.subjectRec(id));
      const first = projects[0];
      if (!first) throw invalid("Aucun projet à grouper");
      if (projects.some((p) => p.isGroup)) {
        throw invalid("Un groupe ne va pas dans un groupe");
      }
      let groupId: string;
      if (input.groupId) {
        const g = this.subjectRec(input.groupId);
        if (!g.isGroup) throw invalid("Ce n'est pas un groupe");
        groupId = g.id;
      } else {
        const at = this.nowIso();
        const place =
          first.parentId !== null
            ? this.subjectRec(first.parentId).position
            : first.position;
        const group: SubjectRec = {
          id: this.newId("subject"),
          name: input.name?.trim() || "Nouveau groupe",
          color: this.nextColor(),
          rootPath: null,
          parentId: null,
          position: place,
          createdAt: at,
          updatedAt: at,
          deletedAt: null,
          isGroup: true,
        };
        this.state.subjects.push(group);
        groupId = group.id;
      }
      const left = new Set<string>();
      for (const p of projects) {
        if (p.parentId === groupId) continue;
        if (p.parentId !== null) left.add(p.parentId);
        p.position = this.appendSubject(groupId, p.id);
        p.parentId = groupId;
        p.updatedAt = this.nowIso();
      }
      this.dropEmptyGroups(left);
      this.changed(["subjects"]);
      return groupId;
    },

    /** « Retirer du groupe »: right after their group, which goes when emptied. */
    ungroupProjects: async (projectIds: string[]): Promise<null> => {
      const byGroup = new Map<string, SubjectRec[]>();
      for (const id of projectIds) {
        const p = this.subjectRec(id);
        if (p.parentId === null) continue;
        byGroup.set(p.parentId, [...(byGroup.get(p.parentId) ?? []), p]);
      }
      for (const [groupId, projects] of byGroup) {
        const slots = this.slotsAfter(
          this.subjectRec(groupId),
          projects.length,
        );
        projects.forEach((p, i) => {
          p.parentId = null;
          p.position = slots[i];
          p.updatedAt = this.nowIso();
        });
      }
      this.dropEmptyGroups(byGroup.keys());
      this.changed(["subjects"]);
      return null;
    },

    /** « Dégrouper »: the group goes, its projects stay in its place. */
    dissolveGroup: async (id: string): Promise<null> => {
      const g = this.subjectRec(id);
      if (!g.isGroup) throw invalid("Ce n'est pas un groupe");
      const children = this.levelSubjects(g.id).map((s) => s.id);
      if (children.length === 0) {
        g.deletedAt = this.nowIso();
        this.changed(["subjects"]);
        return null;
      }
      return this.commands.ungroupProjects(children);
    },

    /** « Portefeuille » (Taido V2.6), like `views::portfolio`. */
    getPortfolio: async (days: number): Promise<Portfolio> => {
      const subjects = this.orderedSubjects().filter((s) => !s.isGroup);
      const rows: PortfolioRow[] = [];
      let subtasks = 0;
      for (const s of subjects) {
        const d = await this.commands.getDashboard(s.id, days);
        subtasks += d.openSubtasks;
        const tasks = this.liveTasks().filter((t) => t.subjectId === s.id);
        const sessions = tasks.flatMap((t) =>
          this.agents.forTask(t.id).filter((x) => x.terminalId !== null),
        );
        // A row re-sent at `EPOCH_STAMP` (a Mac linking its data, docs/SYNC.md § 2.6) carries
        // no real date: the creation and completion dates stand in for it.
        const stamps = [
          ...tasks.flatMap((t) => [t.updatedAt, t.createdAt, t.completedAt]),
          ...tasks.flatMap((t) =>
            this.chrono.segments
              .filter((x) => x.taskId === t.id && x.deletedAt === null)
              .map((x) => x.endedAt ?? x.startedAt),
          ),
        ]
          .filter((at): at is string => at !== null && at !== EPOCH_STAMP)
          .sort();
        const last = stamps.at(-1) ?? null;
        const idle = last
          ? Math.floor((this.now().getTime() - Date.parse(last)) / 86_400_000)
          : null;
        const late = d.lateOrBlocked
          .filter((t) => t.reason?.kind === "overdue")
          .sort((a, b) => (b.days ?? 0) - (a.days ?? 0));
        rows.push({
          subjectId: s.id,
          name: s.name,
          color: s.color,
          group: s.parentId
            ? (this.state.subjects.find((g) => g.id === s.parentId)?.name ??
              null)
            : null,
          open: d.open,
          done: d.done,
          overdue: d.overdue,
          blocked: d.blocked,
          next: late[0] ?? d.upcoming[0] ?? null,
          sessionsRunning: sessions.filter(
            (x) => x.state === "working" || x.state === "starting",
          ).length,
          sessionsWaiting: sessions.filter((x) => x.state === "waiting").length,
          seconds: d.seconds,
          lastActivity: last,
          inactiveDays: idle !== null && idle > 14 ? idle : null,
        });
      }
      return clone({
        days,
        open: rows.reduce((n, r) => n + r.open, 0),
        openSubtasks: subtasks,
        done: rows.reduce((n, r) => n + r.done, 0),
        overdue: rows.reduce((n, r) => n + r.overdue, 0),
        seconds: rows.reduce((n, r) => n + r.seconds, 0),
        rows,
      });
    },

    exportTimeCsv: async (
      _days: number,
      fileName: string,
    ): Promise<string | null> => `/Users/user/Documents/${fileName}`,

    /** Dashboard of a project (Taido V2.5), like `views::dashboard`. */
    getDashboard: async (
      subjectId: string | null,
      days: number,
    ): Promise<Dashboard> => {
      if (subjectId !== null) this.subjectRec(subjectId);
      const place = this.liveTasks().filter((t) => t.subjectId === subjectId);
      const top = place.filter((t) => t.parentId === null);
      const topOf = (t: TaskRec) => t.parentId ?? t.id;
      const now = this.now();
      const segments = place.flatMap((t) =>
        this.chrono.segments
          .filter((s) => s.taskId === t.id && s.deletedAt === null)
          .map((s) => ({
            taskId: topOf(t),
            manual: s.source === "manual",
            start: Date.parse(s.startedAt),
            end: s.endedAt ? Date.parse(s.endedAt) : now.getTime(),
          })),
      );
      return clone(
        mockDashboard(
          top.map((t) => ({
            id: t.id,
            title: t.title,
            due: this.due(t),
            dueDate: t.dueDate,
            dueTime: t.dueTime,
            completedAt: t.completedAt,
            createdAt: t.createdAt,
            blockedBy: this.links.rowFacts(t.id, this.linkedTask).blockedBy,
            waiting: this.agents
              .forTask(t.id)
              .some((s) => s.state === "waiting"),
          })),
          segments,
          days,
          now,
          place.filter((t) => t.parentId !== null && t.completedAt === null)
            .length,
        ),
      );
    },

    /** Kanban of a project (Taido V2.2), like `views::board`. */
    getBoard: async (subjectId: string | null): Promise<Board> => {
      if (subjectId !== null) this.subjectRec(subjectId);
      const view = this.view({
        kind: subjectId === null ? "inbox" : "subject",
        subjectId,
        from: null,
        days: null,
      });
      const recs = this.board.ensure(subjectId);
      // No column yet (a linked web app before its first pull): an empty board.
      if (recs.length === 0) return clone({ subjectId, columns: [] });
      const columnOf = new Map(
        this.state.tasks.map((t) => [t.id, t.boardColumnId ?? null]),
      );
      const columns: BoardColumn[] = recs.map((c) => ({
        id: c.id,
        name: c.name,
        isDone: c.isDone,
        cards: [],
        total: 0,
      }));
      for (const row of [
        ...view.groups.flatMap((g) => g.tasks),
        ...view.completed,
      ]) {
        const column =
          columns[
            this.board.indexOf(
              recs,
              columnOf.get(row.id),
              row.completedAt !== null,
            )
          ];
        column.total += 1;
        if (!column.isDone || column.cards.length < BOARD_DONE_SHOWN) {
          column.cards.push(row);
        }
      }
      return clone({ subjectId, columns });
    },

    moveTaskToColumn: async (input: MoveToColumnInput): Promise<null> => {
      const t = this.taskRec(input.taskId);
      const column = this.board.get(input.columnId);
      if (column.subjectId !== t.subjectId) {
        throw invalid("a card moves within its own project's board");
      }
      if (column.isDone) {
        await this.commands.setTaskCompleted({ id: t.id, completed: true });
        return null;
      }
      t.boardColumnId = column.id;
      t.updatedAt = this.nowIso();
      if (t.completedAt !== null) {
        await this.commands.setTaskCompleted({ id: t.id, completed: false });
      } else {
        this.changed(["tasks"], [t.id]);
      }
      return null;
    },

    createBoardColumn: async (
      input: CreateBoardColumnInput,
    ): Promise<string> => {
      const id = this.board.create(input.subjectId, input.name);
      this.changed(["tasks"]);
      return id;
    },

    renameBoardColumn: async (input: RenameBoardColumnInput): Promise<null> => {
      this.board.rename(input.id, input.name);
      this.changed(["tasks"]);
      return null;
    },

    moveBoardColumn: async (input: MoveBoardColumnInput): Promise<null> => {
      this.board.move(input.id, input.index);
      this.changed(["tasks"]);
      return null;
    },

    deleteBoardColumn: async (id: string): Promise<null> => {
      this.board.delete(id, this.state.tasks);
      this.changed(["tasks"]);
      return null;
    },

    getCounts: async (): Promise<Counts> => clone(this.counts()),

    getTask: async (id: string): Promise<TaskDetail> =>
      clone(this.toDetail(this.taskRec(id))),

    createTask: async (input: CreateTaskInput): Promise<TaskDetail> => {
      const title = requireText(input.title, "Le titre");
      this.validatePlace(input.subjectId, input.sectionId);
      this.validateDue(input.dueDate, input.dueTime);
      const at = this.nowIso();
      const task = this.insertTask({
        id: this.newId("task"),
        parentId: null,
        priority: 1,
        subjectId: input.subjectId,
        sectionId: input.sectionId,
        title,
        description: input.description ?? "",
        dueDate: input.dueDate,
        dueTime: input.dueDate ? input.dueTime : null,
        workdirOverride: null,
        completedAt: null,
        createdAt: at,
        updatedAt: at,
      });
      this.journalAdd(task.id, "created");
      this.changed(["tasks", "subjects", "journal"], [task.id]);
      return clone(this.toDetail(task));
    },

    updateTask: async (input: UpdateTaskInput): Promise<TaskDetail> => {
      const t = this.taskRec(input.id);
      // Like the core (`update_task_scopes`): the notebook too when its chips or a page's
      // « Mentionné dans » change.
      const links = (note: string) => note.includes("[[page:");
      const seen =
        input.title !== null ||
        (input.description !== null &&
          (links(input.description) || links(t.description)));
      if (input.title !== null) t.title = requireText(input.title, "Le titre");
      if (input.description !== null) t.description = input.description;
      t.updatedAt = this.nowIso();
      this.changed(seen ? ["tasks", "notes"] : ["tasks"], this.withFamily(t));
      return clone(this.toDetail(t));
    },

    setTaskDue: async (input: SetDueInput): Promise<TaskDetail> => {
      const t = this.taskRec(input.id);
      this.validateDue(input.date, input.time);
      t.dueDate = input.date;
      t.dueTime = input.date ? input.time : null;
      t.updatedAt = this.nowIso();
      this.changed(["tasks"], this.withFamily(t));
      return clone(this.toDetail(t));
    },

    setTaskWorkdirOverride: async (
      input: SetWorkdirOverrideInput,
    ): Promise<TaskDetail> => {
      const t = this.taskRec(input.id);
      t.workdirOverride =
        input.path !== null ? requireText(input.path, "Le dossier") : null;
      t.updatedAt = this.nowIso();
      this.changed(["tasks"], this.withFamily(t));
      return clone(this.toDetail(t));
    },

    setTaskCompleted: async (input: SetCompletedInput): Promise<TaskDetail> => {
      const t = this.taskRec(input.id);
      const isCompleted = t.completedAt !== null;
      const children = this.childrenOf(t.id);
      if (input.completed && !isCompleted) {
        t.completedAt = this.nowIso();
        this.journalAdd(t.id, "completed");
        this.closeTaskTerminals(t.id);
        // Like the core (and Todoist): its open subtasks are completed with it, their
        // terminals close.
        for (const c of children) {
          if (c.completedAt === null) {
            c.completedAt = t.completedAt;
            c.updatedAt = t.completedAt;
            this.journalAdd(c.id, "completed");
          }
          this.closeTaskTerminals(c.id);
        }
      } else if (!input.completed && isCompleted) {
        t.completedAt = null;
        this.journalAdd(t.id, "reopened");
      }
      for (const x of [t, ...children]) this.reconcileChrono(x.id);
      t.updatedAt = this.nowIso();
      this.changed(
        ["tasks", "subjects", "journal"],
        [...this.withParent(t), ...children.map((c) => c.id)],
      );
      return clone(this.toDetail(t));
    },

    /** Soft delete with its subtasks; `restoreTask` undoes it. */
    deleteTask: async (id: string): Promise<null> => {
      const t = this.taskRec(id);
      const at = this.nowIso();
      const children = this.childrenOf(t.id);
      for (const x of [t, ...children]) {
        x.deletedAt = at;
        this.closeTaskTerminals(x.id);
        this.reconcileChrono(x.id);
      }
      // `notes`: its `[[task:…]]` chips turn dead (core: `TASK_DELETE_SCOPES`).
      this.changed(
        ["tasks", "subjects", "journal", "terminals", "notes"],
        [...this.withParent(t), ...children.map((c) => c.id)],
      );
      return null;
    },

    restoreTask: async (id: string): Promise<TaskDetail> => {
      const t = this.state.tasks.find(
        (x) => x.id === id && x.deletedAt !== null,
      );
      if (!t) throw notFound("Tâche supprimée", id);
      if (t.subjectId !== null) this.subjectRec(t.subjectId);
      const parent = this.parentOf(t);
      if (parent && parent.deletedAt !== null) {
        throw notFound("Tâche parente", parent.id);
      }
      // Its subtasks deleted with it come back too.
      for (const x of this.state.tasks) {
        if (x.parentId === t.id && x.deletedAt === t.deletedAt) {
          x.deletedAt = null;
        }
      }
      t.deletedAt = null;
      this.changed(
        ["tasks", "subjects", "journal", "notes"],
        this.withFamily(t),
      );
      return clone(this.toDetail(t));
    },

    rescheduleOverdue: async (): Promise<number> => {
      const today = this.today();
      // Subtasks included, under a late parent or not (core parity).
      const late = this.liveTasks().filter(
        (t) =>
          t.completedAt === null && t.dueDate !== null && t.dueDate < today,
      );
      const at = this.nowIso();
      for (const t of late) {
        t.dueDate = today;
        t.updatedAt = at;
      }
      if (late.length > 0) {
        this.changed(
          ["tasks"],
          late.map((t) => t.id),
        );
      }
      return late.length;
    },

    duplicateTask: async (id: string): Promise<TaskDetail> => {
      const original = this.taskRec(id);
      const at = this.nowIso();
      const copy: TaskRec = {
        ...original,
        id: this.newId("task"),
        completedAt: null,
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
        // Like the core's copy: in the first column of its board.
        boardColumnId: null,
      };
      this.state.tasks.push(copy);
      // Right after the original among the tasks of the same place (or the same parent).
      const siblings = this.liveTasks()
        .filter((t) =>
          original.parentId !== null
            ? t.parentId === original.parentId && t.id !== copy.id
            : t.parentId === null &&
              t.subjectId === original.subjectId &&
              t.sectionId === original.sectionId &&
              t.id !== copy.id,
        )
        .sort(byPosition);
      const index = siblings.findIndex((t) => t.id === original.id) + 1;
      placeAt(siblings, copy, index);
      for (const child of this.childrenOf(original.id).sort(byPosition)) {
        const c = this.insertSubtask(
          copy.id,
          child.title,
          child.completedAt !== null,
          at,
        );
        c.description = child.description;
        c.dueDate = child.dueDate;
        c.dueTime = child.dueTime;
        c.priority = child.priority;
      }
      this.journalAdd(copy.id, "created");
      this.changed(["tasks", "subjects", "journal"], [copy.id]);
      return clone(this.toDetail(copy));
    },

    moveTask: async (input: MoveTaskInput): Promise<TaskDetail> => {
      const t = this.taskRec(input.id);
      // Like the core: a subtask moves with its parent, `reorderSubtask` orders it.
      if (t.parentId !== null) {
        throw invalid("Une sous-tâche se déplace avec sa tâche parente");
      }
      this.validatePlace(input.subjectId, input.sectionId);
      if (t.subjectId !== input.subjectId) t.workdirOverride = null;
      t.subjectId = input.subjectId;
      t.sectionId = input.sectionId;
      // Subtasks follow their task (same place, same folder).
      for (const c of this.childrenOf(t.id)) {
        c.subjectId = input.subjectId;
        c.sectionId = input.sectionId;
      }
      if (t.completedAt === null) {
        placeAt(
          this.openSiblings(input.subjectId, input.sectionId),
          t,
          input.index,
        );
      } else {
        t.position =
          this.liveTasks()
            .filter(
              (x) =>
                x.parentId === null &&
                x.subjectId === input.subjectId &&
                x.sectionId === input.sectionId &&
                x.id !== t.id,
            )
            .reduce((m, x) => Math.max(m, x.position), 0) + 1;
      }
      t.updatedAt = this.nowIso();
      this.changed(["tasks", "subjects"], this.withFamily(t));
      return clone(this.toDetail(t));
    },

    /** A child task in the parent's place; one level only. */
    addSubtask: async (input: AddSubtaskInput): Promise<Subtask> => {
      const parent = this.taskRec(input.taskId);
      if (parent.parentId !== null) {
        throw invalid("Une sous-tâche ne peut pas avoir de sous-tâches");
      }
      const text = requireText(input.text, "Le texte");
      const created = this.insertSubtask(parent.id, text, false, this.nowIso());
      this.journalAdd(created.id, "created");
      this.changed(["tasks", "journal"], [parent.id, created.id]);
      return clone(this.toSubtask(created));
    },

    updateSubtask: async (input: UpdateSubtaskInput): Promise<Subtask> => {
      const s = this.subtaskRec(input.id);
      s.title = requireText(input.text, "Le texte");
      s.updatedAt = this.nowIso();
      this.changed(["tasks"], this.withParent(s));
      return clone(this.toSubtask(s));
    },

    /** Checks or unchecks the child task, like `set_task_completed`. */
    toggleSubtask: async (id: string): Promise<Subtask> => {
      const s = this.subtaskRec(id);
      if (s.completedAt === null) {
        s.completedAt = this.nowIso();
        this.journalAdd(s.id, "completed");
        this.closeTaskTerminals(s.id);
      } else {
        s.completedAt = null;
        this.journalAdd(s.id, "reopened");
      }
      s.updatedAt = this.nowIso();
      this.changed(["tasks", "subjects", "journal"], this.withParent(s));
      return clone(this.toSubtask(s));
    },

    deleteSubtask: async (id: string): Promise<null> => {
      const s = this.subtaskRec(id);
      s.deletedAt = this.nowIso();
      this.closeTaskTerminals(s.id);
      this.changed(["tasks", "subjects", "terminals"], this.withParent(s));
      return null;
    },

    reorderSubtask: async (input: ReorderInput): Promise<null> => {
      const s = this.subtaskRec(input.id);
      // Among the open subtasks, like the core.
      const siblings = this.liveTasks()
        .filter((t) => t.parentId === s.parentId && t.completedAt === null)
        .sort(byPosition);
      placeAt(siblings, s, input.index);
      this.changed(["tasks"], this.withParent(s));
      return null;
    },

    addNote: async (input: AddNoteInput): Promise<JournalEntry> => {
      this.taskRec(input.taskId);
      const text = requireText(input.text, "La note");
      const entry = this.journalAdd(input.taskId, "note", text);
      this.changed(["journal"], [input.taskId]);
      const { seq: _seq, ...rest } = entry;
      return clone(rest);
    },

    listJournal: async (taskId: string): Promise<JournalEntry[]> => {
      this.taskRec(taskId);
      return clone(
        this.state.journal
          .filter((j) => j.taskId === taskId)
          .sort((a, b) => b.at.localeCompare(a.at) || b.seq - a.seq)
          .map(({ seq: _seq, ...rest }) => rest),
      );
    },

    getSettings: async (): Promise<Settings> => this.shownSettings(),

    updateSettings: async (patch: SettingsPatch): Promise<Settings> => {
      const s = this.state.settings;
      // Absent from patches built before the colour themes (persisted tests): unchanged.
      if (
        patch.theme != null ||
        patch.colorTheme != null ||
        patch.syncTheme != null
      ) {
        // Same rules as the core (db/settings.rs): the theme shown stays when the switch
        // changes, and goes to the shared setting while the switch is on.
        const shown = this.shownSettings();
        s.theme = patch.theme ?? shown.theme;
        s.colorTheme = patch.colorTheme ?? shown.colorTheme;
        s.syncTheme = patch.syncTheme ?? shown.syncTheme;
        if (s.syncTheme) {
          this.state.syncedSettings[SETTING_APPEARANCE] = {
            theme: s.theme,
            color: s.colorTheme,
          };
        }
      }
      if (patch.panelWidth !== null) {
        s.panelWidth = Math.round(
          Math.max(360, Math.min(1000, patch.panelWidth)),
        );
      }
      if (patch.showCompleted !== null) s.showCompleted = patch.showCompleted;
      if (patch.editor !== null) s.editor = patch.editor;
      if (patch.summarizeSessions !== null) {
        s.summarizeSessions = patch.summarizeSessions;
      }
      if (patch.notifications !== null) s.notifications = patch.notifications;
      // Absent from patches built before the guide (persisted tests): left unchanged.
      if (patch.tutorial != null) s.tutorial = clone(patch.tutorial);
      if (patch.chronoCountsWaiting != null) {
        s.chronoCountsWaiting = patch.chronoCountsWaiting;
        // Running segments follow the new rule at once.
        const ids = new Set([
          ...this.chrono.runningTaskIds(),
          ...this.liveTasks()
            .filter((t) => this.agents.forTask(t.id).length > 0)
            .map((t) => t.id),
        ]);
        const touched = [...ids].filter((id) => this.reconcileChrono(id));
        if (touched.length > 0) this.changed(["tasks"], touched);
      }
      if (patch.claudePath !== null) {
        const path = patch.claudePath.trim();
        if (path && !path.startsWith("/")) {
          throw invalid(`Le chemin doit être absolu : ${path}`);
        }
        s.claudePath = path || null;
      }
      if (patch.defaultAgent != null) s.defaultAgent = patch.defaultAgent;
      if (patch.agentChosen != null) s.agentChosen = patch.agentChosen;
      if (patch.voiceSpaceHold != null) s.voiceSpaceHold = patch.voiceSpaceHold;
      if (patch.codexPath != null) {
        const path = patch.codexPath.trim();
        if (path && !path.startsWith("/")) {
          throw invalid(`Le chemin doit être absolu : ${path}`);
        }
        s.codexPath = path || null;
      }
      void this.events.dataChanged.emit({
        scopes: ["settings"],
        taskIds: null,
      });
      return this.shownSettings();
    },

    pickFolder: async (_title: string | null): Promise<string | null> =>
      MOCK_PICKED_FOLDER,

    openTerminal: async (input: OpenTerminalInput): Promise<TerminalInfo> => {
      const t = this.taskRec(input.taskId);
      const workdir = this.workdir(t);
      if (workdir === null) {
        throw {
          kind: "no_folder",
          message: `no working folder for task ${t.id}`,
        };
      }
      if (input.kind === "agent") {
        const agent = input.agent ?? this.state.settings.defaultAgent;
        if (agent === "codex") {
          if (!this.state.codex.found) {
            throw { kind: "codex_missing", message: "codex binary not found" };
          }
        } else this.requireClaude();
      }
      const command =
        input.kind === "command" ? (input.command ?? "").trim() : null;
      if (input.kind === "command" && !command) {
        throw invalid("La commande ne peut pas être vide");
      }
      const id = this.newId("term");
      const info: TerminalInfo = {
        id,
        taskId: t.id,
        kind: input.kind,
        command,
        cwd: workdir.path,
        openedAt: this.nowIso(),
        running: true,
        exitCode: null,
        agentSessionId: input.kind === "agent" ? this.newId("session") : null,
        agent:
          input.kind === "agent"
            ? (input.agent ?? this.state.settings.defaultAgent)
            : null,
      };
      const banner =
        input.kind === "agent"
          ? `Claude Code (simulé) dans ${workdir.path}${
              input.initialPrompt?.trim()
                ? `\r\n> ${input.initialPrompt.trim().replace(/\n/g, "\r\n  ")}`
                : ""
            }`
          : input.kind === "command"
            ? `$ ${command}`
            : `Shell (simulé) dans ${workdir.path}`;
      const opened = this.terminals.open(
        info,
        { cols: input.cols, rows: input.rows },
        banner,
      );
      // Claude: the `agent_sessions` row starts in Starting.
      if (input.kind === "agent") {
        this.agents.start(opened);
        // Taido V2.2: Claude on a task « À faire » puts it « En cours », once.
        this.board.advanceOnClaude(t);
      }
      this.changed(["terminals", "tasks"], [t.id]);
      return opened;
    },

    listTerminals: async (): Promise<TerminalInfo[]> => this.terminals.list(),

    writeTerminal: async (input: WriteTerminalInput): Promise<null> => {
      this.terminals.write(input.terminalId, input.data);
      return null;
    },

    resizeTerminal: async (input: ResizeTerminalInput): Promise<null> => {
      this.terminals.resize(input.terminalId, {
        cols: input.cols,
        rows: input.rows,
      });
      return null;
    },

    detachTerminal: async (terminalId: string): Promise<null> => {
      this.terminals.detach(terminalId);
      return null;
    },

    closeTerminal: async (terminalId: string): Promise<null> => {
      const info = this.terminals.close(terminalId);
      if (info) {
        this.agents.onClosed(info);
        this.changed(["terminals", "tasks"], [info.taskId]);
      }
      return null;
    },

    /** Same levels as the core, without the existence check. */
    setTaskFolder: async (input: SetTaskFolderInput): Promise<TaskDetail> => {
      const t = this.taskRec(input.taskId);
      const path = optionalFolder(input.path);
      if (path === null) throw invalid("Le dossier ne peut pas être vide");
      const workdir = this.workdir(t);
      if (t.subjectId === null || workdir?.source === "task") {
        t.workdirOverride = path;
      } else if (workdir?.source === "section" && t.sectionId) {
        const root = this.effectiveRoot(this.subjectRec(t.subjectId)) ?? "";
        const prefix = `${root.replace(/\/+$/, "")}/`;
        const section = this.sectionRec(t.sectionId);
        if (path.startsWith(prefix))
          section.subpath = path.slice(prefix.length);
        else t.workdirOverride = path;
      } else {
        this.subjectRec(t.subjectId).rootPath = path;
      }
      t.updatedAt = this.nowIso();
      this.changed(["tasks", "subjects"], [t.id]);
      return clone(this.toDetail(t));
    },

    quitApp: async (): Promise<null> => null,

    /** Priority 1 to 4; other values are refused like the core. */
    addManualTime: async (input: AddManualTimeInput): Promise<TaskDetail> => {
      const t = this.taskRec(input.taskId);
      if (
        !Number.isInteger(input.minutes) ||
        input.minutes < 1 ||
        input.minutes > MAX_MANUAL_MINUTES
      ) {
        throw invalid(`Durée invalide : ${input.minutes} min`);
      }
      this.chrono.addManual(t.id, input.minutes, input.note, this.nowIso());
      this.changed(["tasks"], this.withParent(t));
      return clone(this.toDetail(t));
    },

    stopTimeSegment: async (id: string): Promise<TaskDetail> => {
      const segment = this.chrono.stop(id, this.nowIso());
      if (!segment) throw notFound("Temps", id);
      const t = this.taskRec(segment.taskId);
      this.changed(["tasks"], this.withParent(t));
      return clone(this.toDetail(t));
    },

    deleteTimeSegment: async (id: string): Promise<TaskDetail> => {
      const segment = this.chrono.delete(id, this.nowIso());
      if (!segment) throw notFound("Temps", id);
      const t = this.taskRec(segment.taskId);
      this.changed(["tasks"], this.withParent(t));
      return clone(this.toDetail(t));
    },

    setTaskPriority: async (input: SetPriorityInput): Promise<TaskDetail> => {
      const t = this.taskRec(input.id);
      if (!Number.isInteger(input.priority) || input.priority < 1) {
        throw invalid(`Priorité invalide : ${input.priority}`);
      }
      if (input.priority > 4) {
        throw invalid(`Priorité invalide : ${input.priority}`);
      }
      t.priority = input.priority;
      t.updatedAt = this.nowIso();
      this.changed(["tasks"], this.withFamily(t));
      return clone(this.toDetail(t));
    },

    /** « Interrompre »: the session goes Idle. */
    interruptAgent: async (agentSessionId: string): Promise<null> => {
      this.agents.interrupt(agentSessionId);
      return null;
    },

    /** History of a task's Claude sessions, newest first. */
    listTaskSessions: async (taskId: string): Promise<SessionSummary[]> => {
      this.taskRec(taskId);
      return this.agents.summaries(taskId);
    },

    /** What happened in a session, oldest first. */
    getSessionExchanges: async (agentSessionId: string): Promise<Exchange[]> =>
      this.agents.exchanges(agentSessionId),

    /**
     * « Reprendre »: a new simulated Claude terminal, the session reattached to it. Refused
     * (`invalid`) when it already runs in a tab or has no message, like the core.
     */
    renameSession: async (input: RenameSessionInput): Promise<null> => {
      this.agents.rename(input.agentSessionId, input.title);
      return null;
    },

    // Simulated sync and account (the PWA overrides the sync commands
    // with its real client).
    // Dictation.
    voiceStatus: async (): Promise<VoiceStatus> => this.voice.status(),
    voiceDownloadModel: async (): Promise<null> => this.voice.download(),
    voiceStart: async (terminalId: string): Promise<null> =>
      this.voice.start(terminalId),
    voiceStop: async (): Promise<string> => this.voice.stop(),
    voiceCancel: async (): Promise<null> => this.voice.cancel(),
    voiceOpenMicSettings: async (): Promise<null> => null,

    askOverview: async (subjectId: string): Promise<AskOverview> => {
      this.subjectRec(subjectId);
      return clone(this.ask.overview(subjectId));
    },
    openAskTerminal: async (
      subjectId: string,
      cols: number,
      rows: number,
    ): Promise<TerminalInfo> => {
      const subject = this.subjectRec(subjectId);
      const key = `ask:${subjectId}`;
      const open = this.terminals
        .forTask(key)
        .find((t: TerminalInfo) => t.running);
      if (open) return open;
      this.requireClaude();
      const cwd = this.effectiveRoot(subject) ?? "/mock/ask-empty";
      const opened = this.terminals.open(
        {
          id: this.newId("term"),
          taskId: key,
          kind: "agent",
          command: null,
          cwd,
          openedAt: this.nowIso(),
          running: true,
          exitCode: null,
          agentSessionId: null,
          agent: "claude",
        },
        { cols, rows },
        `Claude Code (simulé) dans ${cwd}`,
      );
      this.changed(["terminals"]);
      return opened;
    },
    askThread: async (threadId: string): Promise<AskEntry[]> =>
      this.ask.thread(threadId),
    askProject: async (input: AskInput): Promise<AskStarted> => {
      this.subjectRec(input.subjectId);
      return this.ask.ask(input);
    },
    askStop: async (askId: string): Promise<null> => {
      this.ask.stop(askId);
      return null;
    },
    askSaveNote: async (questionId: string): Promise<NotePage> => {
      const q = this.ask.question(questionId);
      const page = this.notes.createPage({
        subjectId: q.subjectId,
        groupId: null,
        title: q.question.slice(0, 120),
        body: askMarkdown(q),
        kind: "page",
        sourceTaskId: null,
      });
      this.changed(["notes"]);
      return clone(page);
    },
    askMakeTask: async (questionId: string): Promise<string> => {
      const q = this.ask.question(questionId);
      const task = await this.commands.createTask({
        title: q.question.slice(0, 120),
        description: askMarkdown(q),
        subjectId: q.subjectId,
        sectionId: null,
        dueDate: null,
        dueTime: null,
      });
      return task.id;
    },
    askFilePath: async (subjectId: string, path: string): Promise<string> => {
      const root = this.effectiveRoot(this.subjectRec(subjectId));
      if (root === null) throw notFound("Dossier", subjectId);
      return `${root}/${path}`;
    },

    syncStatus: async (): Promise<SyncStatus> => this.sync.get(),
    syncNow: async (): Promise<SyncStatus> => {
      const status = await this.sync.now();
      // V2.7 bis: the core's file job sends the attachments' files after a sync.
      if (status.state === "idle" && this.links.markSent()) {
        this.changed(["tasks"]);
      }
      return status;
    },
    syncSignup: async (input: AccountInput): Promise<SyncStatus> =>
      this.sync.signup(input),
    syncLogin: async (input: AccountInput): Promise<SyncStatus> =>
      this.sync.login(input),
    syncForgotPassword: async (input: ForgotInput): Promise<null> =>
      this.sync.forgotPassword(input),
    syncResetPassword: async (input: ResetInput): Promise<null> =>
      this.sync.resetPassword(input),
    syncAccount: async (): Promise<AccountInfo | null> => this.sync.account(),
    syncResendConfirmation: async (): Promise<null> =>
      this.sync.resendConfirmation(),
    syncUnlink: async (): Promise<SyncStatus> => this.sync.unlink(),
    syncSetInterval: async (minutes: number): Promise<SyncStatus> =>
      this.sync.setInterval(minutes),

    resumeSession: async (input: ResumeSessionInput): Promise<TerminalInfo> => {
      this.requireClaude();
      const session = this.agents.checkResumable(input.agentSessionId);
      const t = this.taskRec(session.taskId);
      const workdir = this.workdir(t);
      if (workdir === null) {
        throw {
          kind: "no_folder",
          message: `no working folder for task ${t.id}`,
        };
      }
      const info: TerminalInfo = {
        id: this.newId("term"),
        taskId: t.id,
        kind: "agent",
        command: null,
        cwd: workdir.path,
        openedAt: this.nowIso(),
        running: true,
        exitCode: null,
        agentSessionId: session.id,
        agent: "claude",
      };
      const opened = this.terminals.open(
        info,
        { cols: input.cols, rows: input.rows },
        `Claude Code (simulé) · conversation reprise dans ${workdir.path}`,
      );
      this.agents.resume(session.id, opened);
      this.board.advanceOnClaude(t);
      this.changed(["terminals", "tasks", "journal"], [t.id]);
      return opened;
    },

    searchTasks: async (query: string): Promise<TaskHit[]> =>
      clone(this.search(query)),

    // The project notebook: the Mac's
    // commands, with the same rules.
    notebook: async (subjectId: string): Promise<NotebookView> =>
      clone(this.notes.notebook(subjectId)),

    getNotePage: async (id: string): Promise<NotePage> =>
      clone(this.notes.getPage(id)),

    createNoteGroup: async (
      input: CreateNoteGroupInput,
    ): Promise<NoteGroup> => {
      const group = this.notes.createGroup(input.subjectId, input.name);
      this.changed(["notes"]);
      return clone(group);
    },

    updateNoteGroup: async (
      input: UpdateNoteGroupInput,
    ): Promise<NoteGroup> => {
      const before = this.notes.group(input.id).name;
      const group = this.notes.updateGroup(input.id, input.name);
      if (group.name !== before) this.changed(["notes"]);
      return clone(group);
    },

    /** Deleted for good; its pages go outside any group. */
    deleteNoteGroup: async (id: string): Promise<null> => {
      this.notes.deleteGroup(id);
      this.changed(["notes"]);
      return null;
    },

    reorderNoteGroup: async (input: ReorderInput): Promise<null> => {
      this.notes.reorderGroup(input.id, input.index);
      this.changed(["notes"]);
      return null;
    },

    createNotePage: async (input: CreateNotePageInput): Promise<NotePage> => {
      const page = this.notes.createPage(input);
      this.changed(["notes"]);
      return clone(page);
    },

    /** Nothing is written (nor told) when the title and the body are the current ones. */
    updateNotePage: async (input: UpdateNotePageInput): Promise<NotePage> => {
      const { page, changed } = this.notes.updatePage(
        input.id,
        input.title,
        input.body,
      );
      if (changed) this.changed(["notes"]);
      return clone(page);
    },

    moveNotePage: async (input: MoveNotePageInput): Promise<NotePage> => {
      const { page, changed } = this.notes.movePage(
        input.id,
        input.target,
        input.index,
      );
      if (changed) this.changed(["notes"]);
      return clone(page);
    },

    pinNotePage: async (input: PinNotePageInput): Promise<NotePage> => {
      const { page, changed } = this.notes.setPinned(input.id, input.pinned);
      if (changed) this.changed(["notes"]);
      return clone(page);
    },

    duplicateNotePage: async (id: string): Promise<NotePage> => {
      const page = this.notes.duplicatePage(id);
      this.changed(["notes"]);
      return clone(page);
    },

    /** Soft delete; `restoreNotePage` undoes it. */
    deleteNotePage: async (id: string): Promise<null> => {
      this.notes.deletePage(id);
      this.changed(["notes"]);
      return null;
    },

    restoreNotePage: async (id: string): Promise<NotePage> => {
      const page = this.notes.restorePage(id);
      this.changed(["notes"]);
      return clone(page);
    },

    notePageBacklinks: async (pageId: string): Promise<NoteLinkRef[]> => {
      this.notes.page(pageId);
      return clone(this.notes.backlinks(pageId, this.liveTasksByRecency()));
    },

    taskNoteMentions: async (taskId: string): Promise<NoteLinkRef[]> =>
      clone(this.notes.taskMentions(taskId)),

    listNoteAttachments: async (pageId: string): Promise<NoteAttachment[]> => {
      this.notes.page(pageId);
      return clone(this.links.listForPage(pageId));
    },

    addNoteAttachments: async (
      input: AddNoteAttachmentsInput,
    ): Promise<NoteAttachment[]> => {
      const page = this.notes.page(input.notePageId);
      const ids: string[] = [];
      for (const path of input.paths) {
        if (!isPageImage(path)) throw invalid(`Pas une image : ${path}`);
      }
      for (const path of input.paths) {
        if (!path.startsWith("/")) throw invalid(`Pas un fichier : ${path}`);
        const name = path.split("/").pop() || "fichier";
        ids.push(
          this.links.addForPage(
            page.id,
            this.noteImageFolder(page),
            name,
            1024,
            this.nowIso(),
          ).id,
        );
      }
      this.changed(["notes"]);
      return clone(
        this.links.listForPage(page.id).filter((a) => ids.includes(a.id)),
      );
    },

    addNoteAttachmentData: async (
      input: AddNoteAttachmentDataInput,
    ): Promise<NoteAttachment> => {
      const page = this.notes.page(input.notePageId);
      if (!/^[A-Za-z0-9+/=\s]+$/.test(input.base64)) {
        throw invalid("Données collées illisibles");
      }
      const name = input.name.trim() || "capture.png";
      if (!isPageImage(name)) throw invalid(`Pas une image : ${name}`);
      const rec = this.links.addForPage(
        page.id,
        this.noteImageFolder(page),
        name,
        Math.floor((input.base64.length * 3) / 4),
        this.nowIso(),
        `data:image/png;base64,${input.base64.trim()}`,
      );
      this.changed(["notes"]);
      const added = this.links
        .listForPage(page.id)
        .find((a) => a.id === rec.id);
      if (!added) throw notFound("Image", rec.id);
      return clone(added);
    },

    /** `attachments::copy_to_page`: another page's (or a task's) image, copied here. */
    copyNoteAttachment: async (
      input: CopyNoteAttachmentInput,
    ): Promise<NoteAttachment> => {
      const a = this.links.get(input.id);
      if (!isPageImage(a.fileName))
        throw invalid(`Pas une image : ${a.fileName}`);
      if (!a.exists) throw notFound("Fichier", a.id);
      const page = this.notes.page(input.toPageId);
      const rec = this.links.addForPage(
        page.id,
        this.noteImageFolder(page),
        a.fileName,
        a.size,
        this.nowIso(),
        a.dataUrl,
      );
      this.changed(["notes"]);
      const added = this.links
        .listForPage(page.id)
        .find((x) => x.id === rec.id);
      if (!added) throw notFound("Image", rec.id);
      return clone(added);
    },

    attachmentInfo: async (id: string): Promise<AttachmentInfo | null> =>
      clone(this.links.info(id)),

    /** `attachments::prune_page_images`: the page's images no live page shows any more. */
    pruneNoteImages: async (input: PruneNoteImagesInput): Promise<string[]> => {
      const gone: string[] = [];
      for (const id of input.candidateIds) {
        let rec: ReturnType<MockLinks["getPageImage"]>;
        try {
          rec = this.links.getPageImage(id);
        } catch {
          continue;
        }
        if (rec.notePageId !== input.pageId) continue;
        // A deleted page counts until it is purged (it can be restored with its images).
        const shown = this.notes.pages.some((p) =>
          p.body.includes(`file:${id}`),
        );
        if (shown) continue;
        rec.deletedAt = this.nowIso();
        gone.push(id);
      }
      if (gone.length > 0) this.changed(["notes"]);
      return gone;
    },

    deleteNoteAttachment: async (id: string): Promise<null> => {
      const a = this.links.getPageImage(id);
      a.deletedAt = this.nowIso();
      this.changed(["notes"]);
      return null;
    },

    /**
     * Pages matching every word (title, text without its Markdown, project name); with
     * `subjectId`, that notebook's own search (its pages only, all of them).
     */
    searchNotes: async (
      query: string,
      subjectId: string | null,
    ): Promise<NoteHit[]> =>
      clone(
        this.notes.search(query, (id) => this.noteSubjectTag(id), subjectId),
      ),

    relationCandidates: async (taskId: string): Promise<RelationCandidates> =>
      clone(this.relationCandidates(taskId)),

    checkAgent: async (agent: Agent): Promise<AgentStatus> =>
      agent === "codex" ? this.codexStatus() : this.claudeStatus(),

    installedAgents: async (): Promise<Agent[]> =>
      (["claude", "codex"] as const).filter(
        (a) => (a === "codex" ? this.codexStatus() : this.claudeStatus()).path,
      ),

    getAppStatus: async (): Promise<AppStatus> => ({
      appVersion: "0.1.0",
      claude: this.claudeStatus(),
      hooksPort: 49152,
      envPath: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      envFromLoginShell: true,
      logDir: "/Users/user/Library/Logs/todo-agents",
      dataDir: "/Users/user/Library/Application Support/todo-agents",
    }),

    setOpenTask: async (taskId: string | null): Promise<null> => {
      this.openTaskId = taskId;
      return null;
    },

    /** Simulated hook events, newest first (diagnostic panel). */
    getHookEvents: async (limit: number): Promise<HookEventLog[]> =>
      this.agents.hookEvents(limit),

    /** Validates like the core, opens nothing (no file manager in a browser). */
    openPath: async (input: OpenPathInput): Promise<null> => {
      if (!input.path.trim().startsWith("/")) {
        throw invalid(`Le chemin doit être absolu : ${input.path}`);
      }
      // The editor picked in « Ouvrir dans » becomes the last used, like the core.
      if (
        input.with === "editor" &&
        input.editor != null &&
        input.editor !== this.state.settings.editor
      ) {
        this.state.settings.editor = input.editor;
        void this.events.dataChanged.emit({
          scopes: ["settings"],
          taskIds: null,
        });
      }
      return null;
    },

    installedEditors: async (): Promise<Editor[]> => [
      ...this.installedEditorsHere,
    ],
  };

  /** What `check_claude` finds: the explicit path of the settings wins, like the core. */
  /** Folder of a page's images (core `attachments::owner_folder`), simulated. */
  private noteImageFolder(page: NotePageRec): string {
    const project =
      this.state.subjects.find((x) => x.id === page.subjectId)?.name ??
      "Sans projet";
    const root = this.state.settings.workspaceRoot ?? "/Users/user/Taido";
    return `${root}/Pièces jointes/${project}/Notes`;
  }

  /** Live tasks, most recently changed first (what the backlinks read: their note). */
  private liveTasksByRecency(): TaskRec[] {
    return this.liveTasks()
      .slice()
      .sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
  }

  /**
   * The tag of a project whose pages the search may offer: live, and a sub-project only when
   * its parent is live too.
   */
  private noteSubjectTag(id: string): SubjectTag | null {
    const s = this.state.subjects.find(
      (x) => x.id === id && x.deletedAt === null,
    );
    if (!s) return null;
    if (s.parentId !== null) {
      const parent = this.state.subjects.find((x) => x.id === s.parentId);
      if (!parent || parent.deletedAt !== null) return null;
    }
    return { id: s.id, name: s.name, color: s.color };
  }

  private claudeStatus(): AgentStatus {
    const c = this.state.claude;
    if (!c.found) return { path: null, version: null, loggedIn: null };
    return {
      path: this.state.settings.claudePath ?? MOCK_CLAUDE_PATH,
      version: MOCK_CLAUDE_VERSION,
      loggedIn: c.loggedIn,
    };
  }

  /** What `check_agent` finds for Codex. */
  private codexStatus(): AgentStatus {
    const c = this.state.codex;
    if (!c.found) return { path: null, version: null, loggedIn: null };
    return {
      path: this.state.settings.codexPath ?? MOCK_CODEX_PATH,
      version: MOCK_CODEX_VERSION,
      loggedIn: c.loggedIn,
    };
  }

  /** A Claude launch fails like the core's when the binary is not found. */
  private requireClaude(): void {
    if (!this.state.claude.found) {
      throw { kind: "claude_missing", message: "claude binary not found" };
    }
  }

  /** ⌘K: case and accent insensitive substring of title or
   * project, open tasks first, 20 at most. The core's fuzzy rules may differ slightly. */
  /**
   * « + Lier une tâche », like the core's `views::candidates`: every task but `taskId` and its
   * own subtasks, projects in sidebar order (« Sans projet » last), sections in order, open
   * before completed, each task followed by its subtasks; « Récentes » = open ones most
   * recently changed.
   */
  private relationCandidates(taskId: string): RelationCandidates {
    const live = this.liveTasks().filter(
      (t) => t.id !== taskId && t.parentId !== taskId,
    );
    const ids = new Set(live.map((t) => t.id));
    const byId = new Map(this.liveTasks().map((t) => [t.id, t]));
    const projectKey = (t: TaskRec): [number, number, number] => {
      if (t.subjectId === null) return [1, 0, 0];
      const s = this.subjectRec(t.subjectId);
      return s.parentId === null
        ? [0, s.position, Number.NEGATIVE_INFINITY]
        : [0, this.subjectRec(s.parentId).position, s.position];
    };
    const sectionPos = (t: TaskRec) =>
      t.sectionId === null
        ? Number.NEGATIVE_INFINITY
        : (this.state.sections.find((s) => s.id === t.sectionId)?.position ??
          Number.NEGATIVE_INFINITY);
    const order = (a: TaskRec, b: TaskRec) => {
      const [pa, pb] = [projectKey(a), projectKey(b)];
      return (
        pa[0] - pb[0] ||
        pa[1] - pb[1] ||
        pa[2] - pb[2] ||
        sectionPos(a) - sectionPos(b) ||
        Number(a.completedAt !== null) - Number(b.completedAt !== null) ||
        a.position - b.position ||
        a.id.localeCompare(b.id)
      );
    };
    // A subtask whose task is not listed (own task, or open child of a completed one) is
    // listed on its own.
    const tops = live
      .filter((t) => t.parentId === null || !ids.has(t.parentId))
      .sort(order);
    const children = (id: string) =>
      live
        .filter((t) => t.parentId === id)
        .sort(
          (a, b) =>
            Number(a.completedAt !== null) - Number(b.completedAt !== null) ||
            a.position - b.position,
        );
    const candidate = (t: TaskRec): RelationCandidate => {
      const s = t.subjectId === null ? null : this.subjectRec(t.subjectId);
      const section = t.sectionId
        ? this.state.sections.find((x) => x.id === t.sectionId)
        : undefined;
      return {
        id: t.id,
        title: t.title,
        parentId: t.parentId,
        parentTitle: t.parentId ? (byId.get(t.parentId)?.title ?? null) : null,
        subject: this.tag(t.subjectId),
        project:
          s === null
            ? null
            : s.parentId === null
              ? s.name
              : `${this.subjectRec(s.parentId).name} › ${s.name}`,
        section: section ? { id: section.id, name: section.name } : null,
        ring: this.ringOf(t).ring,
        completed: t.completedAt !== null,
        dueDate: t.dueDate,
      };
    };
    const tasks = tops.flatMap((t) => [
      candidate(t),
      ...children(t.id).map(candidate),
    ]);
    const recent = live
      .filter((t) => t.completedAt === null)
      .sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
      )
      .slice(0, 8)
      .map((t) => t.id);
    return { tasks, recent };
  }

  private search(query: string): TaskHit[] {
    const norm = (v: string) =>
      v
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
    // Like the core (simplified ranking): every word must be in the title, the project or the
    // section (and, for a sub-project, its parent's name: « globex devis »); open tasks first.
    const words = norm(query).split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const subjectText = (id: string | null) => {
      if (id === null) return "";
      const s = this.subjectRec(id);
      const parent =
        s.parentId === null ? "" : this.subjectRec(s.parentId).name;
      return `${s.name} ${parent}`;
    };
    return this.liveTasks()
      .filter((t) => {
        const subject = subjectText(t.subjectId);
        const section = t.sectionId
          ? (this.state.sections.find((s) => s.id === t.sectionId)?.name ?? "")
          : "";
        const haystack = norm(`${t.title} ${subject} ${section}`);
        return words.every((w) => haystack.includes(w));
      })
      .sort(
        (a, b) =>
          Number(a.completedAt !== null) - Number(b.completedAt !== null),
      )
      .slice(0, 20)
      .map((t) => {
        const section = t.sectionId
          ? this.state.sections.find((s) => s.id === t.sectionId)
          : undefined;
        return {
          id: t.id,
          title: t.title,
          subject: this.tag(t.subjectId),
          section: section ? { id: section.id, name: section.name } : null,
          ring: this.ringOf(t).ring,
          completed: t.completedAt !== null,
        };
      });
  }

  /**
   * Checks a parent for `subject` (`null` while creating), one level only:
   * a live top-level project other than itself, and `subject` must have no sub-projects.
   */
  /** Taido V2.2 bis: projects only go into a group, and a group into nothing. */
  private parentFor(parentId: string, subject: SubjectRec | null): string {
    const parent = this.subjectRec(parentId);
    if (!parent.isGroup) throw invalid("Un projet ne va que dans un groupe");
    if (subject?.isGroup) {
      throw invalid("Un groupe ne va pas dans un groupe");
    }
    return parent.id;
  }

  /** Palette color after the one of the last created project (deleted ones included). */
  private nextColor(): SubjectColor {
    const last = this.state.subjects.at(-1);
    if (!last) return SUBJECT_COLORS[0] ?? "violet";
    const i = SUBJECT_COLORS.indexOf(last.color);
    return SUBJECT_COLORS[(i + 1) % SUBJECT_COLORS.length] ?? "violet";
  }

  private validateDue(date: string | null, time: string | null) {
    if (date !== null && !DATE_RE.test(date)) {
      throw invalid(`Date invalide : ${date}`);
    }
    if (time !== null) {
      if (date === null) throw invalid("Une heure exige une date");
      if (!TIME_RE.test(time)) throw invalid(`Heure invalide : ${time}`);
    }
  }

  // --- views ----------------------------------------------------------------

  private view(input: GetViewInput): ViewModel {
    const today = this.today();
    const base = { kind: input.kind, subject: null, today };
    switch (input.kind) {
      // Taido V2.6: the screen reads `getPortfolio`.
      case "portfolio":
        return { ...base, groups: [], openCount: 0, completed: [] };
      case "upcoming":
        return this.upcoming(input, base);
      case "all":
        return this.allView(base);
      case "inbox": {
        const tasks = this.topTasks().filter((t) => t.subjectId === null);
        const open = tasks
          .filter((t) => t.completedAt === null)
          .sort(byPosition);
        const groups: TaskGroup[] = [
          {
            key: { type: "inbox" },
            showHeader: false,
            tasks: open.map((t) => this.toRow(t, false)),
            addTarget: {
              subjectId: null,
              sectionId: null,
              dueToday: false,
            },
          },
        ];
        return {
          ...base,
          groups,
          openCount: open.length,
          completed: this.completedDesc(tasks, false),
        };
      }
      case "today": {
        const open = this.todayTasks();
        const waiting = open.filter((t) =>
          isClaudeWaiting(this.ringOf(t).ring),
        );
        const overdue = open
          .filter(
            (t) =>
              !waiting.includes(t) && t.dueDate !== null && t.dueDate < today,
          )
          .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""));
        const rest = open.filter(
          (t) => !waiting.includes(t) && !overdue.includes(t),
        );
        const completedToday = this.topTasks().filter(
          (t) =>
            t.completedAt !== null &&
            toLocalDateString(new Date(t.completedAt)) === today,
        );
        const restTarget: AddTarget = {
          subjectId: null,
          sectionId: null,
          dueToday: true,
        };
        // "Claude attend" and "En retard" exist only when not empty (core parity).
        const groups: TaskGroup[] = [];
        if (waiting.length > 0) {
          groups.push({
            key: { type: "today_waiting" },
            showHeader: true,
            tasks: waiting.map((t) => this.toRow(t, true)),
            addTarget: null,
          });
        }
        if (overdue.length > 0) {
          groups.push({
            key: { type: "today_overdue" },
            showHeader: true,
            tasks: overdue.map((t) => this.toRow(t, true)),
            addTarget: null,
          });
        }
        groups.push({
          key: { type: "today_rest" },
          showHeader: groups.length > 0,
          tasks: rest.map((t) => this.toRow(t, true)),
          addTarget: restTarget,
        });
        return {
          ...base,
          groups,
          openCount: open.length,
          completed: this.completedDesc(completedToday, true),
        };
      }
      case "subject": {
        if (input.subjectId === null) {
          throw invalid("La vue Projet exige un projet");
        }
        const subject = this.subjectRec(input.subjectId);
        const tasks = this.topTasks().filter((t) => t.subjectId === subject.id);
        const open = tasks
          .filter((t) => t.completedAt === null)
          .sort(byPosition);
        const sections = this.sectionsOf(subject.id);
        // Loose tasks first, without header and always present (the add row).
        const groups: TaskGroup[] = [
          {
            key: { type: "no_section" },
            showHeader: false,
            tasks: open
              .filter((t) => t.sectionId === null)
              .map((t) => this.toRow(t, false)),
            addTarget: {
              subjectId: subject.id,
              sectionId: null,
              dueToday: false,
            },
          },
        ];
        for (const section of sections) {
          groups.push({
            key: {
              type: "section",
              id: section.id,
              name: section.name,
              subpath: section.subpath,
            },
            showHeader: true,
            tasks: open
              .filter((t) => t.sectionId === section.id)
              .map((t) => this.toRow(t, false)),
            addTarget: {
              subjectId: subject.id,
              sectionId: section.id,
              dueToday: false,
            },
          });
        }
        return {
          ...base,
          subject: this.toSubject(subject),
          groups,
          openCount: open.length,
          completed: this.completedDesc(tasks, false),
        };
      }
    }
  }

  /**
   * « À faire »: every open top-level task, one `Project` group per project
   * that has some (sidebar order: each top-level project followed by its sub-projects), the
   * `NoProject` group at « Sans projet »'s place among the top-level projects (last until
   * moved). Within a project: tasks outside sections first, then section by section, in
   * position order. Each group adds to its project and carries its `order` (index in its
   * level, core `all_view`); `completed` is empty (like Upcoming).
   */
  private allView(
    base: Pick<ViewModel, "kind" | "subject" | "today">,
  ): ViewModel {
    const open = this.topTasks().filter((t) => t.completedAt === null);
    const groups: TaskGroup[] = [];
    const inboxIndex = this.inboxIndex();
    let loose: TaskRec[] | null = open
      .filter((t) => t.subjectId === null)
      .sort(byPosition);
    const pushInbox = () => {
      if (loose !== null && loose.length > 0) {
        groups.push({
          key: { type: "no_project" },
          showHeader: true,
          tasks: loose.map((t) => this.toRow(t, false)),
          addTarget: { subjectId: null, sectionId: null, dueToday: false },
          order: { parentId: null, index: inboxIndex },
        });
      }
      loose = null;
    };
    // Top-level projects passed (shown or not), and whether « Sans projet »'s slot was.
    let topSeen = 0;
    let inboxPassed = false;
    const childrenSeen = new Map<string, number>();
    for (const s of this.orderedSubjects()) {
      let order: GroupOrder;
      if (s.parentId === null) {
        if (!inboxPassed && topSeen === inboxIndex) {
          pushInbox();
          inboxPassed = true;
        }
        order = { parentId: null, index: topSeen + (inboxPassed ? 1 : 0) };
        topSeen += 1;
      } else {
        const seen = childrenSeen.get(s.parentId) ?? 0;
        childrenSeen.set(s.parentId, seen + 1);
        order = { parentId: s.parentId, index: seen };
      }
      const sectionRank = new Map(
        this.sectionsOf(s.id).map((x, i) => [x.id, i]),
      );
      const rank = (t: TaskRec) =>
        t.sectionId === null ? -1 : (sectionRank.get(t.sectionId) ?? 0);
      const tasks = open
        .filter((t) => t.subjectId === s.id)
        .sort((a, b) => rank(a) - rank(b) || byPosition(a, b));
      if (tasks.length === 0) continue;
      const parent =
        s.parentId === null
          ? undefined
          : this.state.subjects.find((p) => p.id === s.parentId);
      groups.push({
        key: {
          type: "project",
          id: s.id,
          name: s.name,
          color: s.color,
          parent_name: parent?.name ?? null,
        },
        showHeader: true,
        tasks: tasks.map((t) => this.toRow(t, false)),
        addTarget: { subjectId: s.id, sectionId: null, dueToday: false },
        order,
      });
    }
    pushInbox();
    const openCount = groups.reduce((n, g) => n + g.tasks.length, 0);
    return { ...base, groups, openCount, completed: [] };
  }

  /**
   * « Prochainement »: one `Day` group per day from `from` (today
   * by default) for `days` days (7 by default, clamped to 1–62), each with its dated add row;
   * days before today show no task. Overdue tasks come first, in « En retard », when the
   * range starts today or before. A dated subtask shows on its own day unless its parent is
   * in the same group (`datedTasks`, core parity).
   */
  private upcoming(
    input: GetViewInput,
    base: Pick<ViewModel, "kind" | "subject" | "today">,
  ): ViewModel {
    const today = base.today;
    const from = input.from ?? today;
    if (!DATE_RE.test(from)) throw invalid(`Date invalide : ${from}`);
    // Clamped to 1–62 like the core, rather than refused.
    const days = Math.min(62, Math.max(1, Math.trunc(input.days ?? 7)));
    const start = parseLocalDate(from);
    const groups: TaskGroup[] = [];
    let openCount = 0;
    if (from <= today) {
      const overdue = this.datedTasks(
        (t) => t.dueDate !== null && t.dueDate < today,
      ).sort(
        (a, b) =>
          (a.dueDate ?? "").localeCompare(b.dueDate ?? "") ||
          this.dayOrder(a, b),
      );
      if (overdue.length > 0) {
        openCount += overdue.length;
        groups.push({
          key: { type: "today_overdue" },
          showHeader: true,
          tasks: overdue.map((t) => this.toRow(t, true)),
          addTarget: null,
        });
      }
    }
    for (let i = 0; i < days; i += 1) {
      const date = toLocalDateString(addDays(start, i));
      const past = date < today;
      const tasks = past
        ? []
        : this.datedTasks((t) => t.dueDate === date).sort(this.dayOrder);
      openCount += tasks.length;
      groups.push({
        key: { type: "day", date },
        showHeader: true,
        tasks: tasks.map((t) => this.toRow(t, true)),
        // Like the core, every day has its dated add row (the UI hides past days).
        addTarget: {
          subjectId: null,
          sectionId: null,
          dueToday: date === today,
          dueDate: date,
        },
      });
    }
    return { ...base, groups, openCount, completed: [] };
  }
}
