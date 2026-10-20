/**
 * Simulated Claude Code sessions of the mock backend (browser `pnpm dev`, tests), so every
 * state can be seen without the core. Mirrors the minimal rules of
 * the core (transitions, ring of a task, second line).
 *
 * In a simulated Claude terminal (like `fake-claude`):
 * - any text runs a turn: Working, « Commande : npm test » after 300 ms, Done after ~2 s;
 * - `/p` asks for a permission, `/q` ends the turn with a question, `/e` fails (`rate_limit`);
 * - `/x` crashes the process (exit 1, no `SessionEnd`), `/exit` ends it cleanly (Paused);
 * - `/clear` ends the conversation and starts a new one in the same terminal;
 * - a lone Escape, or `interrupt_agent`, interrupts (Idle).
 * Each simulated hook is recorded for the diagnostic panel. Sessions are kept as work
 * history: prompts and replies as exchanges, resumable in a new tab.
 */

import type {
  Agent,
  ContextUsage,
  Exchange,
  ExchangeKind,
  HookEventLog,
  Ring,
  SessionState,
  SessionSummary,
  SessionView,
  TaskLine,
  TerminalInfo,
  WaitingKind,
} from "../bindings";
import { activeLanguage, agentErrorLabel } from "../i18n";
import type { MockTerminals } from "./mock-terminals";

/** Delays of the simulation (ms). */
export const AGENT_DELAYS = {
  /** Process launch → `SessionStart`. */
  start: 600,
  /** `UserPromptSubmit` → `PreToolUse`. */
  tool: 300,
  /** `UserPromptSubmit` → `Stop`. */
  turn: 2000,
  /** End of a session → its recap « by Claude Haiku » (`summarizeSessions` on). */
  summary: 300,
} as const;

/** Simulated texts follow the UI language (tests pin French). */
export const mockText = (fr: string, en: string): string =>
  activeLanguage === "fr" ? fr : en;

export const MOCK_ACTIVITY = mockText(
  "Commande : npm test",
  "Command: npm test",
);
export const MOCK_PERMISSION = mockText(
  "Commande : rm -rf dist",
  "Command: rm -rf dist",
);
export const MOCK_QUESTION = mockText(
  "Tu veux que je continue ?",
  "Shall I continue?",
);
export const MOCK_DONE_MESSAGE = mockText(
  "Les tests passent : 42 réussis, aucun échec. J'ai aussi retiré un import inutile.",
  "Done. All 42 tests pass.",
);

export interface SessionRec {
  id: string;
  taskId: string;
  /** The tool running the conversation. */
  agent: Agent;
  /** Terminal the session was launched in (its tab may outlive the process). */
  launchTerminalId: string;
  /** Terminal currently running the conversation; `null` once the process exited. */
  terminalId: string | null;
  cwd: string;
  state: SessionState;
  waitingKind: WaitingKind | null;
  activity: string | null;
  question: string | null;
  permission: string | null;
  errorKind: string | null;
  lastMessage: string | null;
  since: string;
  startedAt: string;
  /** `SessionEnd` received: the next process exit is a pause, not a crash. */
  endedCleanly: boolean;
  /** When the conversation stopped (exit, close, `/clear`); `null` while it runs. */
  endedAt: string | null;
  /** The process died without `SessionEnd` (« arrêtée brutalement »). */
  crashed: boolean;
  /** What happened in the conversation, oldest first. */
  exchanges: Exchange[];
  /** Title the user gave it (rename). */
  title: string | null;
  /** Simulated recap « by Claude Haiku », once ended. */
  aiSummary: string | null;
  /** How full the context is (the tab's gauge), after the first reply. */
  context: ContextUsage | null;
}

/** Like the core: prompts and replies are kept up to 2,000 characters. */
const EXCHANGE_MAX = 2000;
/** First prompt shown in the history (200 characters). */
const FIRST_PROMPT_MAX = 200;

/** Characters kept of a title or a recap (like the core). */
export const TITLE_MAX = 120;

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** History row of a session (`list_task_sessions`). */
export function sessionSummary(s: SessionRec): SessionSummary {
  const prompts = s.exchanges.filter((e) => e.kind === "prompt");
  return {
    id: s.id,
    agent: s.agent,
    state: s.state,
    terminalId: s.terminalId,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    firstPrompt: prompts[0] ? clip(prompts[0].text, FIRST_PROMPT_MAX) : null,
    promptCount: prompts.length,
    crashed: s.crashed,
    resumable: s.terminalId === null && prompts.length > 0,
    lastReply: lastReply(s.exchanges),
    title: s.title,
    aiSummary: s.aiSummary,
  };
}

/** First sentence of Claude's last reply (160 characters), for the session recap. */
function lastReply(exchanges: Exchange[]): string | null {
  const reply = [...exchanges].reverse().find((e) => e.kind === "reply");
  return reply ? firstSentence(reply.text, 160) : null;
}

/** Urgency of a session state, most urgent first. */
const URGENCY: Record<SessionState, number> = {
  waiting: 0,
  error: 1,
  crashed: 2,
  done: 3,
  working: 4,
  starting: 4,
  idle: 5,
  paused: 6,
};

/** Urgency of a ring (sort of Today). */
export function ringUrgency(ring: Ring): number {
  if (ring === "human") return 7;
  if (ring === "completed") return 8;
  return URGENCY[ring];
}

/** « Claude attend »: the group at the top of Today. */
export const isClaudeWaiting = (ring: Ring) =>
  ring === "waiting" ||
  ring === "error" ||
  ring === "crashed" ||
  ring === "done";

/**
 * Rings that bring an open task into Today without a due date (Starting counts
 * as Working). Same rule as the core's `derive::is_active_today`.
 */
export const isActiveToday = (ring: Ring) =>
  isClaudeWaiting(ring) ||
  ring === "working" ||
  ring === "starting" ||
  ring === "idle";

/**
 * Ring of a task and the session it comes from. `sessions` are in launch order;
 * a session is a candidate while its process runs, else the most recent one counts.
 */
export function deriveRing(
  completed: boolean,
  sessions: SessionRec[],
): { ring: Ring; session: SessionRec | null } {
  if (completed) return { ring: "completed", session: null };
  // Like the core: only a running Claude colours the ring, plus a
  // crash while its tab is open; ended sessions are history.
  const candidates = sessions.filter(
    (s) =>
      (s.terminalId !== null &&
        s.state !== "paused" &&
        s.state !== "crashed") ||
      s.state === "crashed",
  );
  let best: SessionRec | null = null;
  // Most recent first, so a tie goes to the newest session.
  for (const s of [...candidates].reverse()) {
    if (best === null || URGENCY[s.state] < URGENCY[best.state]) best = s;
  }
  return best
    ? { ring: best.state, session: best }
    : { ring: "human", session: null };
}

/** First sentence of a message, `max` characters at most (Done line). */
export function firstSentence(text: string | null, max = 120): string | null {
  if (!text) return null;
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  const end = line.search(/[.!?…](\s|$)/);
  const sentence = end === -1 ? line : line.slice(0, end + 1);
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

/** Second line of a task from its session. */
export function sessionLine(s: SessionRec): TaskLine {
  const line = (
    kind: TaskLine["kind"],
    tone: TaskLine["tone"],
    text: string | null = null,
    at: string | null = null,
  ): TaskLine => ({ kind, agent: s.agent, text, at, tone });
  switch (s.state) {
    case "waiting":
      if (s.waitingKind === "permission") {
        return line("waiting_permission", "waiting", s.permission);
      }
      if (s.waitingKind === "question") {
        return line("waiting_question", "waiting", s.question);
      }
      return line("waiting_input", "waiting");
    case "error":
      // Like the core: the French text, not the raw `StopFailure.error` type.
      return line("error", "primary", agentErrorLabel(s.errorKind));
    case "crashed":
      return line("crashed", "primary");
    case "done":
      return line("done", "done", firstSentence(s.lastMessage));
    case "working":
      return line("working", "muted", s.activity);
    case "starting":
      return line("starting", "muted");
    case "idle":
      return line("idle", "muted");
    case "paused":
      return line("paused", "muted", null, s.since);
  }
}

/** Context window of the simulated models (like the core's `agents::usage`). */
const MOCK_WINDOW = { claude: 1_000_000, codex: 258_400 } as const;
/** Tokens a simulated turn adds to the context. */
const MOCK_TURN_TOKENS = 24_000;

export function mockContext(agent: Agent, share: number): ContextUsage {
  const limit = MOCK_WINDOW[agent];
  const used = Math.round(limit * share);
  return {
    used,
    limit,
    percent: Math.min(100, Math.round((used * 100) / limit)),
    model: agent === "codex" ? "gpt-6-luna" : "Opus 5.5",
    planPercent: agent === "codex" ? 2 : null,
  };
}

function grownContext(s: SessionRec): ContextUsage {
  const limit = MOCK_WINDOW[s.agent];
  const used = (s.context?.used ?? 18_000) + MOCK_TURN_TOKENS;
  return mockContext(s.agent, Math.min(used, limit) / limit);
}

export function sessionView(s: SessionRec): SessionView {
  return {
    id: s.id,
    agent: s.agent,
    terminalId: s.terminalId,
    state: s.state,
    waitingKind: s.waitingKind,
    activity: s.activity,
    question: s.question,
    permission: s.permission,
    permissionsMore: 0,
    errorKind: s.errorKind,
    lastMessage: s.lastMessage,
    since: s.since,
    context: s.context,
  };
}

export interface MockAgentsDeps {
  nowIso: () => string;
  terminals: MockTerminals;
  /** A session of the task changed state: the backend emits the core's events. */
  changed: (taskId: string) => void;
  /** Réglages › « Résumer les sessions avec Claude Haiku » (default on). */
  summarizeSessions?: () => boolean;
}

type Patch = Partial<
  Pick<
    SessionRec,
    | "state"
    | "waitingKind"
    | "activity"
    | "question"
    | "permission"
    | "errorKind"
    | "lastMessage"
    | "terminalId"
    | "context"
  >
>;

const DIM = (text: string) => `\x1b[2m${text}\x1b[0m`;

export class MockAgents {
  private sessions: SessionRec[] = [];
  private timers = new Map<string, Set<ReturnType<typeof setTimeout>>>();
  private summaryTimers = new Set<ReturnType<typeof setTimeout>>();
  private hooks: HookEventLog[] = [];
  private hookSeq = 0;

  constructor(private readonly deps: MockAgentsDeps) {}

  /** Forgets every session, hook and pending timer. */
  reset(): void {
    for (const set of this.timers.values()) {
      for (const timer of set) clearTimeout(timer);
    }
    this.timers.clear();
    for (const timer of this.summaryTimers) clearTimeout(timer);
    this.summaryTimers.clear();
    this.sessions = [];
    this.hooks = [];
    this.hookSeq = 0;
  }

  /** Sessions of a task, in launch order. */
  forTask(taskId: string): SessionRec[] {
    return this.sessions.filter((s) => s.taskId === taskId);
  }

  get(id: string): SessionRec | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  /**
   * History of a task's sessions, newest first. Like the core, a conversation without any
   * message is left out, unless it runs in a tab.
   */
  summaries(taskId: string): SessionSummary[] {
    // Newest launch first on a tie (same instant, e.g. `/clear`): the sort is stable.
    return this.forTask(taskId)
      .filter(
        (s) =>
          s.terminalId !== null || s.exchanges.some((e) => e.kind === "prompt"),
      )
      .reverse()
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(sessionSummary);
  }

  /** What happened in a session, oldest first. */
  exchanges(sessionId: string): Exchange[] {
    const s = this.get(sessionId);
    if (!s) {
      throw {
        kind: "not_found",
        message: `session introuvable : ${sessionId}`,
      };
    }
    return s.exchanges.map((e) => ({ ...e }));
  }

  /** Renames a session; an empty title goes back to the automatic recap (120 chars). */
  rename(sessionId: string, title: string): void {
    const s = this.get(sessionId);
    if (!s) {
      throw {
        kind: "not_found",
        message: `session introuvable : ${sessionId}`,
      };
    }
    const trimmed = title.trim().slice(0, TITLE_MAX);
    s.title = trimmed.length > 0 ? trimmed : null;
    this.deps.changed(s.taskId);
  }

  /**
   * Like the core's summarizer: an ended session with messages and no recap gets one
   * « by Claude Haiku » a little later, when the setting is on.
   */
  private summarizeLater(s: SessionRec): void {
    if (!(this.deps.summarizeSessions?.() ?? true)) return;
    if (s.aiSummary !== null) return;
    const prompts = s.exchanges.filter((e) => e.kind === "prompt");
    if (prompts.length === 0) return;
    const first = prompts[0].text;
    // Not a session timer: closing the tab right after the exit must not cancel it.
    const timer = setTimeout(() => {
      this.summaryTimers.delete(timer);
      if (s.endedAt === null || s.aiSummary !== null) return;
      s.aiSummary = clip(
        `${mockText("Résumé simulé :", "Simulated summary:")} ${first}`,
        TITLE_MAX,
      );
      this.deps.changed(s.taskId);
    }, AGENT_DELAYS.summary);
    this.summaryTimers.add(timer);
  }

  /**
   * Checks that a session can be resumed (`invalid` otherwise, like the core): not running
   * in a tab, and at least one message.
   */
  checkResumable(sessionId: string): SessionRec {
    const s = this.get(sessionId);
    if (!s) {
      throw {
        kind: "not_found",
        message: `session introuvable : ${sessionId}`,
      };
    }
    if (s.terminalId !== null) {
      throw { kind: "invalid", message: "session already running in a tab" };
    }
    if (!s.exchanges.some((e) => e.kind === "prompt")) {
      throw { kind: "invalid", message: "session without any message" };
    }
    return s;
  }

  /** « Reprendre »: the session is reattached to a new terminal, Starting then Idle. */
  resume(sessionId: string, info: TerminalInfo): void {
    const s = this.checkResumable(sessionId);
    this.cancel(s);
    s.launchTerminalId = info.id;
    s.cwd = info.cwd;
    s.endedCleanly = false;
    s.endedAt = null;
    s.crashed = false;
    this.record(s, "resumed", "");
    this.set(s, { state: "starting", terminalId: info.id });
    this.later(s, AGENT_DELAYS.start, () => {
      this.hook(s, "SessionStart", { source: "resume" });
      if (s.state === "starting") this.set(s, { state: "idle" });
    });
  }

  /** Sessions whose terminal is still kept, in the order of the terminals (TaskDetail). */
  views(kept: TerminalInfo[]): SessionView[] {
    const out: SessionView[] = [];
    for (const t of kept) {
      const s = this.sessions.find((x) => x.launchTerminalId === t.id);
      if (s) out.push(sessionView(s));
    }
    return out;
  }

  /** Last hook events, newest first (diagnostic panel). */
  hookEvents(limit: number): HookEventLog[] {
    return this.hooks.slice(0, Math.max(0, limit)).map((h) => ({ ...h }));
  }

  // --- lifecycle ------------------------------------------------------------

  /** A Claude terminal was launched: Starting, then Idle at `SessionStart`. */
  start(info: TerminalInfo): void {
    if (!info.agentSessionId) return;
    const at = this.deps.nowIso();
    const s: SessionRec = {
      id: info.agentSessionId,
      taskId: info.taskId,
      agent: info.agent ?? "claude",
      launchTerminalId: info.id,
      terminalId: info.id,
      cwd: info.cwd,
      state: "starting",
      waitingKind: null,
      activity: null,
      question: null,
      permission: null,
      errorKind: null,
      lastMessage: null,
      since: at,
      startedAt: at,
      endedCleanly: false,
      endedAt: null,
      crashed: false,
      exchanges: [],
      title: null,
      aiSummary: null,
      context: null,
    };
    this.sessions.push(s);
    this.later(s, AGENT_DELAYS.start, () => {
      this.hook(s, "SessionStart", { source: "startup" });
      if (s.state === "starting") this.set(s, { state: "idle" });
    });
  }

  /** A line typed in the session's terminal. */
  onLine(info: TerminalInfo, line: string): void {
    const s = this.sessions.find((x) => x.terminalId === info.id);
    const term = this.deps.terminals;
    if (!s) {
      term.print(
        info.id,
        `${DIM(mockText("(simulé)", "(simulated)"))} ${line}\r\n`,
      );
      term.prompt(info.id);
      return;
    }
    this.cancel(s);
    switch (line) {
      case "/exit":
        this.hook(s, "SessionEnd", { reason: "prompt_input_exit" });
        s.endedCleanly = true;
        term.exitProcess(info.id, 0);
        return;
      case "/x":
        term.print(
          info.id,
          `${DIM(mockText("Plantage simulé.", "Simulated crash."))}\r\n`,
        );
        term.exitProcess(info.id, 1);
        return;
      case "/clear":
        this.clear(s, info);
        return;
      case "/p":
        this.hook(s, "PreToolUse", {
          tool_name: "Bash",
          tool_input: { command: "rm -rf dist" },
        });
        this.hook(s, "PermissionRequest", {
          tool_name: "Bash",
          tool_input: { command: "rm -rf dist" },
        });
        term.print(
          info.id,
          "Claude veut lancer : rm -rf dist\r\n Do you want to proceed? 1. Yes  2. No\r\n",
        );
        this.set(s, {
          state: "waiting",
          waitingKind: "permission",
          permission: MOCK_PERMISSION,
        });
        return;
      case "/q": {
        const message = `${mockText("J'ai fini l'analyse du job.", "I finished analysing the job.")} ${MOCK_QUESTION}`;
        this.hook(s, "Stop", { last_assistant_message: message });
        this.record(s, "reply", message);
        term.print(info.id, `${message}\r\n`);
        term.prompt(info.id);
        this.set(s, {
          state: "waiting",
          waitingKind: "question",
          question: MOCK_QUESTION,
          lastMessage: message,
        });
        return;
      }
      case "/c":
        // A long conversation: the gauge turns orange.
        this.set(s, { context: mockContext(s.agent, 0.86) });
        term.prompt(info.id);
        return;
      case "/e":
        this.hook(s, "StopFailure", { error: "rate_limit" });
        this.record(s, "error", "rate_limit");
        term.print(info.id, `${DIM("API Error: rate limit reached")}\r\n`);
        term.prompt(info.id);
        this.set(s, { state: "error", errorKind: "rate_limit" });
        return;
      default:
        this.turn(s, line);
    }
  }

  /** An ordinary prompt: Working, a tool, then Done. */
  private turn(s: SessionRec, prompt: string): void {
    const term = this.deps.terminals;
    const id = s.terminalId ?? s.launchTerminalId;
    this.hook(s, "UserPromptSubmit", { prompt });
    this.record(s, "prompt", prompt);
    this.set(s, { state: "working", activity: null });
    this.later(s, AGENT_DELAYS.tool, () => {
      this.hook(s, "PreToolUse", {
        tool_name: "Bash",
        tool_input: { command: "npm test" },
      });
      term.print(id, `${DIM("● Bash(npm test)")}\r\n`);
      this.set(s, { activity: MOCK_ACTIVITY });
    });
    this.later(s, AGENT_DELAYS.turn, () => {
      this.hook(s, "PostToolUse", { tool_name: "Bash" });
      this.hook(s, "Stop", { last_assistant_message: MOCK_DONE_MESSAGE });
      this.record(s, "reply", MOCK_DONE_MESSAGE);
      term.print(id, `${MOCK_DONE_MESSAGE}\r\n`);
      term.prompt(id);
      this.set(s, {
        state: "done",
        lastMessage: MOCK_DONE_MESSAGE,
        context: grownContext(s),
      });
    });
  }

  /** A lone Escape typed in the terminal interrupts a turn or a permission (E4). */
  onEscape(info: TerminalInfo): void {
    const s = this.sessions.find((x) => x.terminalId === info.id);
    if (!s) return;
    const busy =
      s.state === "working" ||
      (s.state === "waiting" && s.waitingKind === "permission");
    if (busy) this.interruptSession(s);
  }

  /** « Interrompre » (`interrupt_agent`): any live state goes Idle. */
  interrupt(sessionId: string): void {
    const s = this.get(sessionId);
    if (!s) {
      throw {
        kind: "not_found",
        message: `session introuvable : ${sessionId}`,
      };
    }
    if (s.terminalId === null) return;
    this.interruptSession(s);
  }

  private interruptSession(s: SessionRec): void {
    this.cancel(s);
    if (s.terminalId) {
      this.deps.terminals.print(s.terminalId, `${DIM("Interrupted")}\r\n`);
      this.deps.terminals.prompt(s.terminalId);
    }
    this.set(s, { state: "idle" });
  }

  /** The process of a terminal exited: Paused after `SessionEnd`, else Crashed. */
  onExit(info: TerminalInfo): void {
    const s = this.sessions.find((x) => x.terminalId === info.id);
    if (!s) return;
    this.cancel(s);
    s.endedAt = this.deps.nowIso();
    s.crashed = !s.endedCleanly;
    this.set(s, {
      state: s.endedCleanly ? "paused" : "crashed",
      terminalId: null,
    });
    this.summarizeLater(s);
  }

  /** The user closed the terminal (tab ×, task checked or deleted): the session pauses. */
  onClosed(info: TerminalInfo): void {
    const s = this.sessions.find((x) => x.launchTerminalId === info.id);
    if (!s) return;
    this.cancel(s);
    // Closing the tab of a crashed Claude ends its « ! » (like the core).
    if (s.terminalId === null) {
      if (s.state === "crashed") this.set(s, { state: "paused" });
      return;
    }
    s.endedAt = this.deps.nowIso();
    this.set(s, { state: "paused", terminalId: null });
    this.summarizeLater(s);
  }

  /**
   * `/clear`: `SessionEnd(clear)` then `SessionStart(clear)` with a new conversation in the
   * same terminal; the old one becomes history.
   */
  private clear(s: SessionRec, info: TerminalInfo): void {
    const at = this.deps.nowIso();
    this.hook(s, "SessionEnd", { reason: "clear" });
    this.record(s, "cleared", "");
    s.endedCleanly = true;
    s.endedAt = at;
    // The old conversation leaves the terminal; its id stays for the history.
    s.launchTerminalId = "";
    this.set(s, { state: "paused", terminalId: null });
    this.summarizeLater(s);
    const next: SessionRec = {
      ...s,
      id: `${s.id}-clear-${this.sessions.length}`,
      launchTerminalId: info.id,
      terminalId: info.id,
      state: "idle",
      lastMessage: null,
      since: at,
      startedAt: at,
      endedCleanly: false,
      endedAt: null,
      crashed: false,
      exchanges: [],
      title: null,
      aiSummary: null,
    };
    this.sessions.push(next);
    this.deps.terminals.setAgentSession(info.id, next.id);
    this.hook(next, "SessionStart", { source: "clear" });
    this.deps.terminals.print(
      info.id,
      `${DIM(mockText("(conversation effacée)", "(conversation cleared)"))}\r\n`,
    );
    this.deps.terminals.prompt(info.id);
    this.deps.changed(next.taskId);
  }

  // --- internals ------------------------------------------------------------

  private set(s: SessionRec, patch: Patch): void {
    const before = s.state;
    if (patch.state !== undefined) {
      // A new state starts clean: only what the patch says survives (`last_message` stays).
      Object.assign(s, {
        waitingKind: null,
        activity: null,
        question: null,
        permission: null,
        errorKind: null,
      });
    }
    Object.assign(s, patch);
    if (patch.state !== undefined && patch.state !== before) {
      s.since = this.deps.nowIso();
    }
    this.deps.changed(s.taskId);
  }

  private record(s: SessionRec, kind: ExchangeKind, text: string): void {
    s.exchanges.push({
      kind,
      text: clip(text, EXCHANGE_MAX),
      at: this.deps.nowIso(),
    });
  }

  private later(s: SessionRec, ms: number, fn: () => void): void {
    let set = this.timers.get(s.id);
    if (!set) {
      set = new Set();
      this.timers.set(s.id, set);
    }
    const timers = set;
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  }

  private cancel(s: SessionRec): void {
    const set = this.timers.get(s.id);
    if (!set) return;
    for (const timer of set) clearTimeout(timer);
    set.clear();
  }

  private hook(
    s: SessionRec,
    event: string,
    fields: Record<string, unknown>,
  ): void {
    this.hookSeq += 1;
    const payload = {
      session_id: s.id,
      transcript_path: `/Users/user/.claude/projects/simule/${s.id}.jsonl`,
      cwd: s.cwd,
      hook_event_name: event,
      ...fields,
    };
    this.hooks.unshift({
      id: this.hookSeq,
      receivedAt: this.deps.nowIso(),
      terminalId: s.terminalId,
      event,
      payload: JSON.stringify(payload),
    });
  }
}
