import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStateChanged, TerminalInfo } from "../bindings";
import { MockBackend } from "./mock-backend";
import {
  AGENT_DELAYS,
  deriveRing,
  firstSentence,
  MOCK_ACTIVITY,
  MOCK_DONE_MESSAGE,
  MOCK_PERMISSION,
  MOCK_QUESTION,
  type SessionRec,
  sessionLine,
} from "./mock-sessions";

const session = (over: Partial<SessionRec>): SessionRec => ({
  id: "s",
  taskId: "t",
  agent: "claude",
  launchTerminalId: "term",
  terminalId: "term",
  cwd: "/tmp",
  state: "idle",
  waitingKind: null,
  activity: null,
  question: null,
  permission: null,
  errorKind: null,
  lastMessage: null,
  since: "2026-10-01T08:00:00.000Z",
  startedAt: "2026-10-01T08:00:00.000Z",
  endedCleanly: false,
  endedAt: null,
  crashed: false,
  exchanges: [],
  title: null,
  aiSummary: null,
  context: null,
  ...over,
});

describe("ring and line derivation", () => {
  it("picks the most urgent open session, else the latest one", () => {
    expect(deriveRing(false, []).ring).toBe("human");
    expect(deriveRing(true, [session({ state: "waiting" })]).ring).toBe(
      "completed",
    );
    const open = [
      session({ id: "a", state: "working" }),
      session({ id: "b", state: "done" }),
      session({ id: "c", state: "idle" }),
    ];
    expect(deriveRing(false, open).ring).toBe("done");
    // A crash keeps its « ! » until its tab is closed.
    const mixed = [
      session({ id: "a", state: "crashed", terminalId: null }),
      session({ id: "b", state: "idle" }),
    ];
    expect(deriveRing(false, mixed).ring).toBe("crashed");
    // Ended sessions are history: a plain task.
    const ended = [
      session({ id: "a", state: "paused", terminalId: null }),
      session({ id: "b", state: "done", terminalId: null }),
    ];
    expect(deriveRing(false, ended).ring).toBe("human");
  });

  it("builds the second line of each state", () => {
    expect(
      sessionLine(
        session({
          state: "waiting",
          waitingKind: "permission",
          permission: "Commande : ls",
        }),
      ),
    ).toEqual({
      kind: "waiting_permission",
      agent: "claude",
      text: "Commande : ls",
      at: null,
      tone: "waiting",
    });
    expect(
      sessionLine(session({ state: "error", errorKind: "rate_limit" })),
    ).toMatchObject({
      kind: "error",
      text: "Limite d'usage atteinte",
      tone: "primary",
    });
    expect(
      sessionLine(session({ state: "done", lastMessage: "Fini. Le reste." })),
    ).toMatchObject({ kind: "done", text: "Fini.", tone: "done" });
    expect(sessionLine(session({ state: "paused" }))).toMatchObject({
      kind: "paused",
      at: "2026-10-01T08:00:00.000Z",
      tone: "muted",
    });
  });

  it("keeps the first sentence, 120 characters at most", () => {
    expect(firstSentence("\n  Fini ! Ensuite autre chose.")).toBe("Fini !");
    expect(firstSentence("a".repeat(200))).toHaveLength(120);
    expect(firstSentence(null)).toBeNull();
  });
});

describe("simulated Claude sessions", () => {
  let backend: MockBackend;
  let changes: TaskStateChanged[];

  async function claudeTask() {
    const c = backend.commands;
    const subject = await c.createSubject({
      name: "Globex",
      color: null,
      rootPath: "/tmp/globex",
      parentId: null,
    });
    const task = await c.createTask({
      title: "Exporter",
      description: null,
      subjectId: subject.id,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    const term = await c.openTerminal({
      taskId: task.id,
      kind: "agent",
      agent: null,
      command: null,
      initialPrompt: null,
      permissionMode: null,
      addTaskContext: null,
      cols: 80,
      rows: 24,
    });
    return { task, term, subject };
  }

  const type = (term: TerminalInfo, text: string) =>
    backend.commands.writeTerminal({ terminalId: term.id, data: text });

  const detail = (id: string) => backend.commands.getTask(id);

  beforeEach(async () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 1, 10, 0) });
    backend = new MockBackend({ seed: false });
    changes = [];
    await backend.events.taskStateChanged.listen((e) =>
      changes.push(e.payload),
    );
  });

  afterEach(() => {
    backend.reset();
    vi.useRealTimers();
  });

  it("puts a Starting task without a due date in Today, like the core", async () => {
    const { task } = await claudeTask();
    expect((await detail(task.id)).ring).toBe("starting");
    const today = await backend.commands.getView({
      kind: "today",
      subjectId: null,
      from: null,
      days: null,
    });
    const ids = today.groups.flatMap((g) => g.tasks.map((t) => t.id));
    expect(ids).toEqual([task.id]);
    expect((await backend.commands.getCounts()).today).toBe(1);
  });

  it("starts in Starting, then goes Idle", async () => {
    const { task, term } = await claudeTask();
    let d = await detail(task.id);
    expect(d.ring).toBe("starting");
    expect(d.sessions).toHaveLength(1);
    expect(d.sessions[0]).toMatchObject({
      id: term.agentSessionId,
      terminalId: term.id,
      state: "starting",
    });
    await vi.advanceTimersByTimeAsync(AGENT_DELAYS.start);
    d = await detail(task.id);
    expect(d.ring).toBe("idle");
    expect(changes.at(-1)).toMatchObject({
      taskId: task.id,
      ring: "idle",
      line: { kind: "idle" },
    });
  });

  it("runs a turn: Working, the tool, then Done", async () => {
    const { task, term } = await claudeTask();
    await vi.advanceTimersByTimeAsync(AGENT_DELAYS.start);
    await type(term, "Lance les tests\r");
    expect((await detail(task.id)).ring).toBe("working");
    await vi.advanceTimersByTimeAsync(AGENT_DELAYS.tool);
    expect((await detail(task.id)).sessions[0].activity).toBe(MOCK_ACTIVITY);
    await vi.advanceTimersByTimeAsync(AGENT_DELAYS.turn);
    const d = await detail(task.id);
    expect(d.ring).toBe("done");
    expect(d.sessions[0].lastMessage).toBe(MOCK_DONE_MESSAGE);
    expect(d.sessions[0].activity).toBeNull();
    // Done tasks join Today's « Claude attend » group.
    const today = await backend.commands.getView({
      kind: "today",
      subjectId: null,
      from: null,
      days: null,
    });
    expect(today.groups[0].key).toEqual({ type: "today_waiting" });
    expect(today.groups[0].tasks[0]).toMatchObject({
      id: task.id,
      ring: "done",
      line: { kind: "done", tone: "done" },
    });
  });

  it("asks for a permission, then a question, and counts the waiting tasks", async () => {
    const { task, term, subject } = await claudeTask();
    await type(term, "/p\r");
    let d = await detail(task.id);
    expect(d.sessions[0]).toMatchObject({
      state: "waiting",
      waitingKind: "permission",
      permission: MOCK_PERMISSION,
    });
    expect((await backend.commands.getCounts()).waiting).toBe(1);
    expect((await backend.commands.listSubjects())[0]).toMatchObject({
      id: subject.id,
      dot: "waiting",
    });
    await type(term, "/q\r");
    d = await detail(task.id);
    expect(d.sessions[0]).toMatchObject({
      waitingKind: "question",
      question: MOCK_QUESTION,
      permission: null,
    });
    expect(d.line).toMatchObject({ kind: "waiting_question" });
  });

  it("fails with rate_limit, and interrupts back to Idle", async () => {
    const { task, term } = await claudeTask();
    await type(term, "/e\r");
    let d = await detail(task.id);
    expect(d.sessions[0]).toMatchObject({
      state: "error",
      errorKind: "rate_limit",
    });
    expect((await backend.commands.listSubjects())[0].dot).toBe("error");
    await type(term, "go\r");
    await backend.commands.interruptAgent(term.agentSessionId ?? "");
    d = await detail(task.id);
    expect(d.ring).toBe("idle");
    // Interrupted: the end of the turn never comes.
    await vi.advanceTimersByTimeAsync(AGENT_DELAYS.turn * 2);
    expect((await detail(task.id)).ring).toBe("idle");
    await expect(backend.commands.interruptAgent("nope")).rejects.toMatchObject(
      { kind: "not_found" },
    );
  });

  it("treats a lone Escape in the terminal as an interruption", async () => {
    const { task, term } = await claudeTask();
    await type(term, "go\r");
    await type(term, "\x1b");
    expect((await detail(task.id)).ring).toBe("idle");
  });

  it("crashes on /x and pauses on /exit", async () => {
    const first = await claudeTask();
    await type(first.term, "/x\r");
    let d = await detail(first.task.id);
    expect(d.ring).toBe("crashed");
    expect(d.terminals[0].running).toBe(false);
    expect(d.sessions[0]).toMatchObject({ state: "crashed", terminalId: null });

    await backend.commands.closeTerminal(first.term.id);
    const second = await backend.commands.openTerminal({
      taskId: first.task.id,
      kind: "agent",
      agent: null,
      command: null,
      initialPrompt: null,
      permissionMode: null,
      addTaskContext: null,
      cols: 80,
      rows: 24,
    });
    await vi.advanceTimersByTimeAsync(AGENT_DELAYS.start);
    await type(second, "/exit\r");
    d = await detail(first.task.id);
    expect(d.ring).toBe("human");
    expect(d.sessions).toHaveLength(1);
    expect(d.line).toBeNull();
  });

  it("pauses the session when the tab is closed or the task checked", async () => {
    const { task, term } = await claudeTask();
    await type(term, "/p\r");
    await backend.commands.closeTerminal(term.id);
    let d = await detail(task.id);
    expect(d.ring).toBe("human");
    expect(d.line).toBeNull();
    expect(d.sessions).toEqual([]);

    await backend.commands.openTerminal({
      taskId: task.id,
      kind: "agent",
      agent: null,
      command: null,
      initialPrompt: null,
      permissionMode: null,
      addTaskContext: null,
      cols: 80,
      rows: 24,
    });
    d = await backend.commands.setTaskCompleted({
      id: task.id,
      completed: true,
    });
    expect(d.ring).toBe("completed");
    expect(d.terminals).toEqual([]);
  });

  it("records the simulated hooks, newest first", async () => {
    const { term } = await claudeTask();
    await vi.advanceTimersByTimeAsync(AGENT_DELAYS.start);
    await type(term, "/e\r");
    const events = await backend.commands.getHookEvents(200);
    expect(events.map((e) => e.event)).toEqual(["StopFailure", "SessionStart"]);
    expect(events[0].terminalId).toBe(term.id);
    expect(JSON.parse(events[0].payload)).toMatchObject({
      hook_event_name: "StopFailure",
      error: "rate_limit",
      session_id: term.agentSessionId,
    });
    expect(await backend.commands.getHookEvents(1)).toHaveLength(1);
  });
});

describe("simulated session history", () => {
  let backend: MockBackend;

  async function claudeTask() {
    const c = backend.commands;
    const subject = await c.createSubject({
      name: "Globex",
      color: null,
      rootPath: "/tmp/globex",
      parentId: null,
    });
    const task = await c.createTask({
      title: "Exporter",
      description: null,
      subjectId: subject.id,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    const term = await c.openTerminal({
      taskId: task.id,
      kind: "agent",
      agent: null,
      command: null,
      initialPrompt: null,
      permissionMode: null,
      addTaskContext: null,
      cols: 80,
      rows: 24,
    });
    return { task, term };
  }

  const type = (term: TerminalInfo, text: string) =>
    backend.commands.writeTerminal({ terminalId: term.id, data: text });

  const resume = (agentSessionId: string) =>
    backend.commands.resumeSession({ agentSessionId, cols: 80, rows: 24 });

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(2026, 9, 1, 10, 0) });
    backend = new MockBackend({ seed: false });
  });

  afterEach(() => {
    backend.reset();
    vi.useRealTimers();
  });

  it("records prompts, replies and errors, and summarizes the session", async () => {
    const { task, term } = await claudeTask();
    await type(term, "bonjour\r");
    await vi.advanceTimersByTimeAsync(AGENT_DELAYS.turn);
    await type(term, "/e\r");
    const [summary] = await backend.commands.listTaskSessions(task.id);
    expect(summary).toMatchObject({
      id: term.agentSessionId,
      terminalId: term.id,
      firstPrompt: "bonjour",
      promptCount: 1,
      crashed: false,
      resumable: false,
      endedAt: null,
    });
    const exchanges = await backend.commands.getSessionExchanges(
      term.agentSessionId ?? "",
    );
    expect(exchanges.map((e) => [e.kind, e.text])).toEqual([
      ["prompt", "bonjour"],
      ["reply", MOCK_DONE_MESSAGE],
      ["error", "rate_limit"],
    ]);
  });

  it("refuses to resume a running session or one without message", async () => {
    const { task, term } = await claudeTask();
    const id = term.agentSessionId ?? "";
    await expect(resume(id)).rejects.toMatchObject({ kind: "invalid" });
    await type(term, "/exit\r");
    await expect(resume(id)).rejects.toMatchObject({ kind: "invalid" });
    // Like the core: an ended conversation without message is not listed.
    expect(await backend.commands.listTaskSessions(task.id)).toEqual([]);
  });

  it("lists a running conversation without message, then hides it once ended", async () => {
    const { task, term } = await claudeTask();
    let sessions = await backend.commands.listTaskSessions(task.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      firstPrompt: null,
      lastReply: null,
      resumable: false,
    });
    await type(term, "/exit\r");
    sessions = await backend.commands.listTaskSessions(task.id);
    expect(sessions).toEqual([]);
  });

  it("recaps a session with the first sentence of the last reply", async () => {
    const { task, term } = await claudeTask();
    await type(term, "lance les tests\r");
    let [summary] = await backend.commands.listTaskSessions(task.id);
    // No reply yet.
    expect(summary).toMatchObject({
      firstPrompt: "lance les tests",
      lastReply: null,
    });
    await vi.advanceTimersByTimeAsync(AGENT_DELAYS.turn);
    await type(term, "et la doc\r");
    await type(term, "/q\r");
    [summary] = await backend.commands.listTaskSessions(task.id);
    // The last reply counts, cut at its first sentence.
    expect(summary.firstPrompt).toBe("lance les tests");
    expect(summary.lastReply).toBe("J'ai fini l'analyse du job.");
    await type(term, "encore\r");
    await vi.advanceTimersByTimeAsync(AGENT_DELAYS.turn);
    [summary] = await backend.commands.listTaskSessions(task.id);
    expect(summary.lastReply).toBe(
      "Les tests passent : 42 réussis, aucun échec.",
    );
  });

  it("resumes an ended or crashed session in a new terminal", async () => {
    const { task, term } = await claudeTask();
    const id = term.agentSessionId ?? "";
    await type(term, "bonjour\r");
    await type(term, "/x\r");
    let [summary] = await backend.commands.listTaskSessions(task.id);
    expect(summary).toMatchObject({ crashed: true, resumable: true });

    const next = await resume(id);
    expect(next.id).not.toBe(term.id);
    expect(next).toMatchObject({ kind: "agent", agentSessionId: id });
    [summary] = await backend.commands.listTaskSessions(task.id);
    expect(summary).toMatchObject({
      terminalId: next.id,
      state: "starting",
      crashed: false,
      resumable: false,
      endedAt: null,
    });
    await vi.advanceTimersByTimeAsync(AGENT_DELAYS.start);
    const d = await backend.commands.getTask(task.id);
    expect(d.ring).toBe("idle");
    expect(d.sessions.map((s) => s.id)).toEqual([id]);
    const kinds = (await backend.commands.getSessionExchanges(id)).map(
      (e) => e.kind,
    );
    expect(kinds).toEqual(["prompt", "resumed"]);
    // The resumed conversation works in its new tab.
    await type(next, "encore\r");
    [summary] = await backend.commands.listTaskSessions(task.id);
    expect(summary.promptCount).toBe(2);
  });

  it("starts a new conversation in the same terminal on /clear", async () => {
    const { task, term } = await claudeTask();
    await type(term, "première\r");
    await type(term, "/clear\r");
    const sessions = await backend.commands.listTaskSessions(task.id);
    expect(sessions).toHaveLength(2);
    const [current, old] = sessions;
    expect(current.terminalId).toBe(term.id);
    expect(current.id).not.toBe(term.agentSessionId);
    expect(old).toMatchObject({
      id: term.agentSessionId,
      terminalId: null,
      resumable: true,
      crashed: false,
    });
    const oldKinds = (await backend.commands.getSessionExchanges(old.id)).map(
      (e) => e.kind,
    );
    expect(oldKinds).toEqual(["prompt", "cleared"]);
    const terms = await backend.commands.listTerminals();
    expect(terms[0].agentSessionId).toBe(current.id);
    const d = await backend.commands.getTask(task.id);
    expect(d.sessions.map((s) => s.id)).toEqual([current.id]);
  });
});
