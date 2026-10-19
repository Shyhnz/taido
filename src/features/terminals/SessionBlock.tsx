/**
 * Terminals of the task panel, redesign option A (2026-10-04).
 *
 * In the panel: one row of tabs with « + » and the Finder next to them, then the active
 * terminal, wider than the task text, 380 px high by default and resizable with a visible
 * handle (double-click resets it). No « Session · état » row: each tab carries its state dot,
 * and a short « Claude attend » sits at the end of the row while a session waits.
 *
 * In focus mode (`FocusView`): one 44 px bar and the terminals below, filling the window,
 * nothing else. With two terminals or more the bar splits at the panes' border (1.35fr | 1fr)
 * and each pane has a header (state, label, ⌄ menu, ×) instead of a native select; a lone
 * terminal takes the whole width, and « + » opens a second one beside it. Up to four panes
 * (2026-10-05): a third splits the right column, a fourth the left one, and the
 * border between the rows is draggable like the one between the columns.
 *
 * Claude's state lives on the terminal itself: a 2 px red line on top and a « Claude attend ta
 * réponse » bar at the bottom while it waits; a « Session terminée » bar with « Reprendre » or
 * « Relancer » once the process has exited.
 */

import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  Plus,
  Sparkles,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  Agent,
  SessionView,
  TaskDetail,
  TerminalInfo,
} from "../../bindings";
import { Button, IconButton } from "../../components/Button";
import { type MenuItem, openMenuAt } from "../../components/Menu";
import { t as strings } from "../../i18n";
import { useDefaultAgent } from "../../lib/agent";
import { commands } from "../../lib/ipc";
import { queryKeys, useTaskSessions } from "../../lib/queries";
import { useUi } from "../../stores/ui";
import { hasStateDot, StateDot } from "../task-row/StateDot";
import { ringLabel } from "../task-row/StateRing";
import { MicButton } from "../voice/MicButton";
import {
  closeTerminal,
  launchAgent,
  openTaskFolderIn,
  openTerminal,
  promptCommand,
  registerPaneCycler,
  resumeSession,
} from "./actions";
import { ContextPeek, ContextThread, useContextBubble } from "./ContextGauge";
import { focusTerminal } from "./registry";
import { TerminalView } from "./TerminalView";
import { useTerminalLabels } from "./terminalLabels";

export const TERMINAL_HEIGHT_KEY = "todo.terminalHeight";
export const TERMINAL_HEIGHT_DEFAULT = 380;
const TERMINAL_HEIGHT_MIN = 160;
const TERMINAL_HEIGHT_MAX = 1400;

const clampHeight = (h: number) =>
  Math.round(Math.max(TERMINAL_HEIGHT_MIN, Math.min(TERMINAL_HEIGHT_MAX, h)));

function loadHeight(): number {
  try {
    const raw = Number(window.localStorage.getItem(TERMINAL_HEIGHT_KEY));
    return Number.isFinite(raw) && raw > 0
      ? clampHeight(raw)
      : TERMINAL_HEIGHT_DEFAULT;
  } catch {
    return TERMINAL_HEIGHT_DEFAULT;
  }
}

function saveHeight(h: number): void {
  try {
    window.localStorage.setItem(TERMINAL_HEIGHT_KEY, String(h));
  } catch {
    // Storage unavailable: the default height comes back next time.
  }
}

/** The Claude session running (or last run) in a terminal. */
export function sessionOf(
  task: Pick<TaskDetail, "sessions">,
  terminal: TerminalInfo,
): SessionView | null {
  if (terminal.kind !== "agent") return null;
  return (
    task.sessions.find((s) => s.id === terminal.agentSessionId) ??
    task.sessions.find((s) => s.terminalId === terminal.id) ??
    null
  );
}

function KindIcon({
  kind,
  session,
}: {
  kind: TerminalInfo["kind"];
  session?: SessionView | null;
}) {
  if (session && hasStateDot(session.state)) {
    // Decorative next to the label: the state shows on hover.
    return (
      <span
        aria-hidden
        title={ringLabel(session.state, session.agent)}
        data-session-state={session.state}
        className="inline-flex"
      >
        <StateDot ring={session.state} agent={session.agent} />
      </span>
    );
  }
  if (session) {
    return (
      <span
        title={ringLabel(session.state, session.agent)}
        data-session-state={session.state}
      >
        <Sparkles size={13} aria-hidden />
      </span>
    );
  }
  if (kind === "agent") return <Sparkles size={13} aria-hidden />;
  if (kind === "command") return <ChevronRight size={13} aria-hidden />;
  return <SquareTerminal size={13} aria-hidden />;
}

/**
 * The agents of the « + » menu: the default one first, then the other one, each only when
 * installed. Not known yet: both. None installed: the default one, whose launch explains how
 * to install it.
 */
export function menuAgents(
  agent: Agent,
  installed: readonly Agent[] | undefined,
): Agent[] {
  const other: Agent = agent === "codex" ? "claude" : "codex";
  const both = [agent, other];
  if (installed === undefined) return both;
  const found = both.filter((a) => installed.includes(a));
  return found.length > 0 ? found : [agent];
}

function addItems(
  taskId: string,
  agent: Agent,
  installed: readonly Agent[] | undefined,
): MenuItem[] {
  return [
    ...menuAgents(agent, installed).map((a) => ({
      label: strings.terminals.addAgent(a),
      onSelect: () => void launchAgent(taskId, a),
    })),
    {
      label: strings.terminals.addShell,
      onSelect: () => void openTerminal(taskId, "shell"),
    },
    {
      label: strings.terminals.addCommand,
      onSelect: () => void promptCommand(taskId),
    },
  ];
}

/** « + » menu: Claude Code…, Codex…, Shell, Commande… */
export function openAddMenu(
  anchor: HTMLElement,
  taskId: string,
  agent: Agent,
  installed: readonly Agent[] | undefined,
): void {
  openMenuAt(anchor, addItems(taskId, agent, installed), strings.terminals.add);
}

function AddButton({ taskId }: { taskId: string }) {
  const agent = useDefaultAgent();
  // Read again when the window comes back: an agent may have been installed meanwhile.
  const installed = useQuery({
    queryKey: queryKeys.installedAgents,
    queryFn: commands.installedAgents,
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: false,
  }).data;
  return (
    <IconButton
      label={strings.terminals.add}
      aria-haspopup="menu"
      onClick={(e) => openAddMenu(e.currentTarget, taskId, agent, installed)}
    >
      <Plus size={16} aria-hidden />
    </IconButton>
  );
}

/**
 * The Finder on the task's folder, one click away, always right after « + ». The editor stays
 * in ⋯: the point is to work inside the app.
 */
function FinderButton({ taskId }: { taskId: string }) {
  return (
    <IconButton
      label={strings.terminals.openInFinder}
      title={strings.terminals.openInFinder}
      onClick={() => void openTaskFolderIn(taskId, "finder")}
    >
      <Folder size={15} aria-hidden />
    </IconButton>
  );
}

/**
 * A task without terminal: the actions in one row under the chips. Launching Claude is the
 * primary action; a shell and the Finder stay one click away.
 */
function QuickActions({ taskId }: { taskId: string }) {
  const agent = useDefaultAgent();
  return (
    <div
      role="toolbar"
      aria-label={strings.terminals.quickActions}
      className="mt-5 flex flex-wrap items-center gap-1.5 pl-8"
    >
      <Button
        variant="primary"
        size="sm"
        data-tutorial="launch-claude"
        onClick={() => void launchAgent(taskId, agent)}
      >
        <Sparkles size={14} aria-hidden />
        {strings.terminals.launchAgent(agent)}
        <span className="text-[11.5px] opacity-70">⌘T</span>
      </Button>
      <Button size="sm" onClick={() => void openTerminal(taskId, "shell")}>
        <SquareTerminal size={14} aria-hidden />
        {strings.terminals.shell}
      </Button>
      <FinderButton taskId={taskId} />
    </div>
  );
}

/** The terminal shown for a task: the remembered tab when it still exists, else the last. */
export function activeTerminalOf(
  terminals: TerminalInfo[],
  remembered: string | undefined,
): TerminalInfo | null {
  return terminals.find((t) => t.id === remembered) ?? terminals.at(-1) ?? null;
}

/** Most panes focus mode shows at once (2026-10-05); the others wait in « +N ». */
export const MAX_PANES = 4;

/**
 * Panes of focus mode: one per terminal, four at most. The chosen ones keep their
 * place while they exist; by default the first Claude terminal is on the left, the first other
 * terminal on the right, then the rest in order. The place of a closed terminal takes the last
 * pane's one when a pane goes away, else a terminal no pane shows.
 */
export function resolvePanes(
  terminals: TerminalInfo[],
  chosen: readonly string[] = [],
): string[] | null {
  const count = Math.min(terminals.length, MAX_PANES);
  if (count < 2) return null;
  const known = new Set(terminals.map((t) => t.id));
  const used = new Set<string>();
  const take = (id: string | undefined): string | null => {
    if (id === undefined || !known.has(id) || used.has(id)) return null;
    used.add(id);
    return id;
  };
  const free = (t: TerminalInfo) => !used.has(t.id);
  // Kept first, so that a default never takes a terminal chosen further on.
  const kept = Array.from({ length: count }, (_, i) => take(chosen[i]));
  const panes = kept.map((id, i) => {
    if (id) return id;
    for (const spare of chosen.slice(count)) {
      const moved = take(spare);
      if (moved) return moved;
    }
    const preferred =
      i === 0
        ? terminals.find((t) => free(t) && t.kind === "agent")
        : i === 1
          ? terminals.find((t) => free(t) && t.kind !== "agent")
          : undefined;
    return take((preferred ?? terminals.find(free))?.id);
  });
  const shown = panes.filter((id): id is string => id !== null);
  return shown.length === count ? shown : null;
}

/**
 * ⌘⇧[ / ⌘⇧] in focus mode: from the terminal of the focused pane, the previous or next one of
 * the task (wrapping around). Already in another pane: the focus goes there. Otherwise it
 * replaces the focused pane's terminal, so every step shows something.
 */
export function cyclePanes(
  terminals: TerminalInfo[],
  panes: string[],
  focused: number,
  step: 1 | -1,
): { panes: string[]; pane: number; focus: string } {
  const n = terminals.length;
  const at = terminals.findIndex((t) => t.id === panes[focused]);
  const next = terminals[(at + step + n) % n];
  if (!next || next.id === panes[focused]) {
    return { panes, pane: focused, focus: panes[focused] };
  }
  const holder = panes.indexOf(next.id);
  if (holder !== -1) {
    return { panes, pane: holder, focus: next.id };
  }
  const moved = panes.map((id, i) => (i === focused ? next.id : id));
  return { panes: moved, pane: focused, focus: next.id };
}

function Tab({
  terminal,
  label,
  session,
  active,
  onSelect,
}: {
  terminal: TerminalInfo;
  label: string;
  session: SessionView | null;
  active: boolean;
  onSelect: () => void;
}) {
  // The context gauge (option C): only while the agent runs in this tab.
  const usage = (terminal.running && session?.context) || null;
  const { bind, bubble } = useContextBubble(usage, session?.agent);
  return (
    <div
      {...bind}
      className={`group/tab relative flex h-[30px] max-w-[220px] min-w-[72px] shrink items-center rounded-md ${
        active ? "bg-hover text-text" : "text-text-2 hover:bg-hover"
      }`}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        onClick={onSelect}
        title={usage ? undefined : label}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-1 pl-2.5 text-[13px]"
      >
        <KindIcon kind={terminal.kind} session={session} />
        <span
          className={`truncate ${terminal.kind === "command" ? "font-mono text-[12px]" : ""}`}
        >
          {label}
        </span>
        {!terminal.running && (
          <span className="shrink-0 text-[12px] text-text-3">
            · {strings.terminals.exited}
          </span>
        )}
        {usage && session && active && (
          <ContextPeek usage={usage} agent={session.agent} />
        )}
      </button>
      {usage && active && <ContextThread usage={usage} />}
      {bubble}
      <IconButton
        label={strings.terminals.close(label)}
        size={24}
        onClick={() => void closeTerminal(terminal)}
        className={`mr-0.5 focus-visible:opacity-100 group-hover/tab:opacity-100 ${
          active ? "opacity-60" : "opacity-0"
        }`}
      >
        <X size={13} aria-hidden />
      </IconButton>
    </div>
  );
}

function HeightHandle({
  height,
  onResize,
  onCommit,
}: {
  height: number;
  onResize: (h: number) => void;
  onCommit: (h: number) => void;
}) {
  const start = useRef<{ y: number; height: number } | null>(null);
  const latest = useRef(height);
  latest.current = height;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    start.current = { y: e.clientY, height };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    onResize(start.current.height + (e.clientY - start.current.y));
  };
  const onPointerUp = () => {
    if (!start.current) return;
    start.current = null;
    onCommit(latest.current);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      onCommit(height + (e.key === "ArrowDown" ? step : -step));
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot be focused and dragged
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={strings.terminals.resize}
      aria-valuemin={TERMINAL_HEIGHT_MIN}
      aria-valuemax={TERMINAL_HEIGHT_MAX}
      aria-valuenow={height}
      title={strings.terminals.resetHeight}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onCommit(TERMINAL_HEIGHT_DEFAULT)}
      onKeyDown={onKeyDown}
      className="group/handle flex h-3.5 cursor-row-resize items-center justify-center rounded-md focus-visible:bg-accent/20"
    >
      <span className="h-[3px] w-8 rounded-full bg-border-terminal group-hover/handle:bg-text-3" />
    </div>
  );
}

/**
 * Bottom bar of a terminal: « Claude attend ta réponse » while its session waits, « Session
 * terminée » with « Reprendre » / « Relancer » once the process has exited, else nothing.
 */
function StatusBar({
  task,
  terminal,
  session,
}: {
  task: TaskDetail;
  terminal: TerminalInfo;
  session: SessionView | null;
}) {
  const { data: summaries = [] } = useTaskSessions(task.id);
  const [pending, setPending] = useState(false);

  if (terminal.running && session?.state === "waiting") {
    const detail = session.permission ?? session.question;
    return (
      <div
        data-part="waiting-bar"
        className="flex h-9 shrink-0 items-center gap-2 border-t border-[var(--bar-waiting-border)] bg-[var(--bar-waiting)] px-3 text-[12.5px] text-waiting-text"
      >
        <StateDot ring="waiting" agent={session.agent} size={10} />
        <span className="shrink-0">
          {strings.terminals.waitingBar(session.agent)}
        </span>
        {detail && <span className="truncate text-text-2">· {detail}</span>}
      </div>
    );
  }
  if (terminal.running) return null;

  const summary =
    terminal.kind === "agent"
      ? summaries.find((s) => s.id === terminal.agentSessionId)
      : undefined;
  const canResume =
    summary?.resumable === true && terminal.agentSessionId !== null;
  // The new tab opens first; the exited one closes once it is there.
  const again = async () => {
    setPending(true);
    try {
      const opened = canResume
        ? await resumeSession(
            task.id,
            terminal.agentSessionId as string,
            terminal.agent ?? "claude",
          )
        : terminal.kind === "agent"
          ? await launchAgent(task.id, terminal.agent ?? "claude")
          : await openTerminal(task.id, terminal.kind, {
              command: terminal.command ?? undefined,
            });
      if (opened) await closeTerminal(terminal);
    } finally {
      setPending(false);
    }
  };
  return (
    <div
      data-part="exit-bar"
      className="flex h-9 shrink-0 items-center gap-2 border-t border-border bg-hover pr-1.5 pl-3 text-[12.5px] text-text-2"
    >
      <span className="truncate">
        {terminal.kind === "agent"
          ? strings.terminals.sessionEnded
          : strings.terminals.processEnded(terminal.exitCode)}
      </span>
      <span className="ml-auto flex shrink-0 gap-1.5">
        <Button
          size="sm"
          variant="primary"
          className="h-6"
          disabled={pending}
          onClick={() => void again()}
        >
          {canResume ? strings.sessions.resume : strings.terminals.relaunch}
        </Button>
        <Button
          size="sm"
          className="h-6"
          onClick={() => void closeTerminal(terminal)}
        >
          {strings.terminals.closeTab}
        </Button>
      </span>
    </div>
  );
}

/**
 * A terminal with its status bar. `bare`: edge to edge (focus mode), else a rounded frame.
 * `fill`: the terminal takes the free height; else `height` sets it.
 */
function Frame({
  task,
  terminal,
  label,
  bare = false,
  fill = false,
  height,
  className = "",
}: {
  task: TaskDetail;
  terminal: TerminalInfo;
  label: string;
  bare?: boolean;
  fill?: boolean;
  height?: number;
  className?: string;
}) {
  const session = sessionOf(task, terminal);
  const waiting = terminal.running && session?.state === "waiting";
  const termStyle: CSSProperties | undefined = fill ? undefined : { height };
  return (
    <div
      data-terminal-frame={terminal.id}
      data-waiting={waiting || undefined}
      className={`relative flex flex-col overflow-hidden bg-terminal ${
        bare
          ? ""
          : `rounded-lg border ${
              waiting
                ? "border-[var(--bar-waiting-border)]"
                : "border-border-terminal"
            }`
      } ${className}`}
    >
      {waiting && (
        <span
          aria-hidden
          className="absolute inset-x-0 top-0 z-10 h-0.5 bg-waiting"
        />
      )}
      <div
        className={`relative ${fill ? "min-h-0 flex-1" : "shrink-0"} ${bare ? "pt-2 pl-3" : ""}`}
        style={termStyle}
      >
        <TerminalView
          terminalId={terminal.id}
          label={strings.terminals.view(label)}
        />
        <MicButton terminal={terminal} />
      </div>
      <StatusBar task={task} terminal={terminal} session={session} />
    </div>
  );
}

/** « Claude attend », at the end of the tab row while one of the task's sessions waits. */
function WaitingWord({ task }: { task: TaskDetail }) {
  const waiting = task.sessions.find((s) => s.state === "waiting");
  if (!waiting) return null;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 pr-1 pl-2 text-[12.5px] text-waiting-text">
      <StateDot ring="waiting" agent={waiting.agent} size={10} />
      {strings.terminals.waitingShort(waiting.agent)}
    </span>
  );
}

function Tabs({ task, active }: { task: TaskDetail; active: TerminalInfo }) {
  const setActiveTerminal = useUi((s) => s.setActiveTerminal);
  const labels = useTerminalLabels(task);
  const terminals = task.terminals;

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const list = e.currentTarget;
    const i = terminals.findIndex((t) => t.id === active.id);
    const next =
      terminals[
        (i + (e.key === "ArrowRight" ? 1 : -1) + terminals.length) %
          terminals.length
      ];
    setActiveTerminal(task.id, next.id);
    setTimeout(() =>
      list
        .querySelector<HTMLElement>("[role=tab][aria-selected=true]")
        ?.focus(),
    );
  };

  return (
    <div
      role="tablist"
      aria-label={strings.terminals.tabs}
      onKeyDown={onTabKey}
      className="flex min-w-0 gap-0.5 overflow-hidden"
    >
      {terminals.map((t) => (
        <Tab
          key={t.id}
          terminal={t}
          label={labels.get(t.id) ?? ""}
          session={sessionOf(task, t)}
          active={t.id === active.id}
          onSelect={() => {
            setActiveTerminal(task.id, t.id);
            focusTerminal(t.id);
          }}
        />
      ))}
    </div>
  );
}

/** The terminals in the panel (not in focus mode). */
export function SessionBlock({ task }: { task: TaskDetail }) {
  const remembered = useUi((s) => s.activeTerminals[task.id]);
  const [height, setHeight] = useState(loadHeight);
  const labels = useTerminalLabels(task);
  // Not written back: a terminal just opened is remembered before the task lists it, and a
  // closed tab simply falls back to the last one.
  const active = activeTerminalOf(task.terminals, remembered);

  if (!active) {
    return task.completedAt === null ? <QuickActions taskId={task.id} /> : null;
  }

  return (
    // Wider than the task text: the terminal is narrow enough already.
    <section aria-labelledby="session-title" className="-mx-3 mt-5">
      <h2 id="session-title" className="sr-only">
        {strings.terminals.session}
      </h2>
      <div className="mb-1.5 flex items-center gap-0.5">
        <Tabs task={task} active={active} />
        <AddButton taskId={task.id} />
        <FinderButton taskId={task.id} />
        <WaitingWord task={task} />
      </div>
      <Frame
        task={task}
        terminal={active}
        label={labels.get(active.id) ?? ""}
        height={height}
      />
      <HeightHandle
        height={height}
        onResize={(h) => setHeight(clampHeight(h))}
        onCommit={(h) => {
          const next = clampHeight(h);
          setHeight(next);
          saveHeight(next);
        }}
      />
    </section>
  );
}

export const PANE_SPLIT_KEY = "todo.paneSplit";
/** Share of the left pane by default: the old 1.35fr | 1fr. */
export const PANE_SPLIT_DEFAULT = 1.35 / 2.35;
/** Share of the top row once a column holds two panes (2026-10-05). */
export const PANE_ROWS_KEY = "todo.paneRows";
export const PANE_ROWS_DEFAULT = 0.5;
/** Narrowest and lowest pane while dragging (px). */
const PANE_MIN = 240;
const PANE_MIN_HEIGHT = 140;
/** Height of focus mode's bar (px): the rows share what is under it. */
const BAR_HEIGHT = 44;

const clampSplit = (r: number) => Math.min(0.85, Math.max(0.15, r));

function loadRatio(key: string, fallback: number): number {
  try {
    const raw = Number(window.localStorage.getItem(key));
    return Number.isFinite(raw) && raw > 0 ? clampSplit(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveRatio(key: string, r: number): void {
  try {
    window.localStorage.setItem(key, String(r));
  } catch {
    // Storage unavailable: the default comes back next time.
  }
}

const DIVIDERS = {
  columns: {
    orientation: "vertical",
    label: strings.terminals.resizePanes,
    title: strings.terminals.resetPanes,
    fallback: PANE_SPLIT_DEFAULT,
    back: "ArrowLeft",
    forward: "ArrowRight",
    cursor: "col-resize",
    className: "inset-y-0 w-2 -translate-x-1/2 cursor-col-resize",
    line: "inset-y-0 left-1/2 w-0.5 -translate-x-1/2",
  },
  rows: {
    orientation: "horizontal",
    label: strings.terminals.resizePaneRows,
    title: strings.terminals.resetPaneRows,
    fallback: PANE_ROWS_DEFAULT,
    back: "ArrowUp",
    forward: "ArrowDown",
    cursor: "row-resize",
    className: "h-2 -translate-y-1/2 cursor-row-resize",
    line: "inset-x-0 top-1/2 h-0.5 -translate-y-1/2",
  },
} as const;

/**
 * A border between panes of focus mode, draggable: `columns` moves the split of the bar and
 * of the terminals together (2026-10-04), `rows` the height of stacked panes (product decision,
 * 2026-10-05). Double-click resets it; the arrow keys move it.
 */
function PaneDivider({
  axis,
  ratio,
  onRatio,
  container,
  style,
}: {
  axis: keyof typeof DIVIDERS;
  ratio: number;
  onRatio: (r: number, commit: boolean) => void;
  container: { current: HTMLElement | null };
  style: CSSProperties;
}) {
  const dragging = useRef(false);
  const latest = useRef(ratio);
  latest.current = ratio;
  const kind = DIVIDERS[axis];

  const ratioAt = (e: PointerEvent<HTMLDivElement>) => {
    const box = container.current?.getBoundingClientRect();
    if (!box) return latest.current;
    const columns = axis === "columns";
    const start = columns ? box.left : box.top + BAR_HEIGHT;
    const size = columns ? box.width : box.height - BAR_HEIGHT;
    if (size <= 0) return latest.current;
    const min = Math.min(0.45, (columns ? PANE_MIN : PANE_MIN_HEIGHT) / size);
    const r = ((columns ? e.clientX : e.clientY) - start) / size;
    return clampSplit(Math.min(1 - min, Math.max(min, r)));
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragging.current = true;
    document.body.style.cursor = kind.cursor;
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    // Kept now: a release before the next render commits where the pointer is.
    latest.current = ratioAt(e);
    onRatio(latest.current, false);
  };
  const onPointerUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.style.cursor = "";
    onRatio(latest.current, true);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== kind.back && e.key !== kind.forward) return;
    e.preventDefault();
    const step = e.shiftKey ? 0.1 : 0.025;
    onRatio(clampSplit(ratio + (e.key === kind.forward ? step : -step)), true);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot be focused and dragged
    <div
      role="separator"
      aria-orientation={kind.orientation}
      aria-label={kind.label}
      aria-valuemin={15}
      aria-valuemax={85}
      aria-valuenow={Math.round(ratio * 100)}
      title={kind.title}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onRatio(kind.fallback, true)}
      onKeyDown={onKeyDown}
      style={style}
      className={`group/divider absolute z-20 focus-visible:outline-none ${kind.className}`}
    >
      <span
        className={`absolute bg-transparent transition-colors group-hover/divider:bg-accent/60 group-focus-visible/divider:bg-accent group-active/divider:bg-accent ${kind.line}`}
      />
    </div>
  );
}

/** Where a pane sits; its name in the pane's menu comes from `strings.terminals.panePlace`. */
type PanePlace = keyof typeof strings.terminals.panePlace;

/**
 * Places of the panes by count (2026-10-05): two side by side; with a third the right
 * column splits and the left pane keeps the whole height; with a fourth the left column splits
 * too, the fourth pane under the first.
 */
const PLACES: Record<number, PanePlace[]> = {
  2: ["left", "right"],
  3: ["left", "topRight", "bottomRight"],
  4: ["topLeft", "topRight", "bottomRight", "bottomLeft"],
};

/** Cell of each place in focus mode's grid; row 1 is the bar. */
const AREAS: Record<PanePlace, CSSProperties> = {
  left: { gridColumn: 1, gridRow: "2 / -1" },
  right: { gridColumn: 2, gridRow: "2 / -1" },
  topLeft: { gridColumn: 1, gridRow: 2 },
  topRight: { gridColumn: 2, gridRow: 2 },
  bottomRight: { gridColumn: 2, gridRow: 3 },
  bottomLeft: { gridColumn: 1, gridRow: 3 },
};

/** The bar carries the headers of the top panes; a bottom pane has its own. */
const isBottom = (place: PanePlace) =>
  place === "bottomLeft" || place === "bottomRight";
const isRight = (place: PanePlace) =>
  place === "right" || place === "topRight" || place === "bottomRight";

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

function Separator() {
  return <span aria-hidden className="mx-1.5 h-[18px] w-px bg-border" />;
}

/**
 * Header of a focus-mode pane: state, label and ⌄ (menu of the task's terminals: picking one
 * shown in another pane swaps the two), ×.
 */
function PaneHeader({
  task,
  labels,
  panes,
  pane,
  place,
  focused,
  onChoose,
  onSwap,
}: {
  task: TaskDetail;
  labels: Map<string, string>;
  panes: string[];
  pane: number;
  place: PanePlace;
  focused: boolean;
  onChoose: (pane: number, id: string) => void;
  onSwap: () => void;
}) {
  const terminal = task.terminals.find((t) => t.id === panes[pane]);
  if (!terminal) return null;
  const label = labels.get(terminal.id) ?? "";
  const session = sessionOf(task, terminal);
  const usage = (terminal.running && session?.context) || null;
  const title = strings.terminals.paneMenu(strings.terminals.panePlace[place]);
  // With more panes, picking a terminal shown elsewhere swaps them already.
  const swap: MenuItem[] =
    panes.length === 2
      ? [
          { separator: true },
          { label: strings.terminals.swapPanes, onSelect: onSwap },
        ]
      : [];
  const items = (): MenuItem[] => [
    ...task.terminals.map((t) => ({
      label: labels.get(t.id) ?? "",
      icon: <KindIcon kind={t.kind} session={sessionOf(task, t)} />,
      checked: t.id === terminal.id,
      hint:
        t.id !== terminal.id && panes.includes(t.id)
          ? strings.terminals.inOtherPane
          : undefined,
      onSelect: () => onChoose(pane, t.id),
    })),
    ...swap,
  ];
  return (
    <>
      <PaneButton usage={usage} agent={session?.agent}>
        {(bind) => (
          <button
            {...bind}
            type="button"
            aria-haspopup="menu"
            aria-label={`${title} : ${label}`}
            title={usage ? undefined : label}
            onClick={(e) => openMenuAt(e.currentTarget, items(), title)}
            className={`group/tab relative flex h-[30px] min-w-0 items-center gap-1.5 rounded-md px-2 text-[13px] hover:bg-hover aria-expanded:bg-hover ${
              focused ? "text-text" : "text-text-2"
            }`}
          >
            <KindIcon kind={terminal.kind} session={session} />
            <span className="truncate">{label}</span>
            {!terminal.running && (
              <span className="shrink-0 text-[12px] text-text-3">
                · {strings.terminals.exited}
              </span>
            )}
            {usage && session && (
              <ContextPeek usage={usage} agent={session.agent} />
            )}
            <ChevronDown
              size={12}
              aria-hidden
              className="shrink-0 text-text-3"
            />
            {usage && <ContextThread usage={usage} />}
          </button>
        )}
      </PaneButton>
      <IconButton
        label={strings.terminals.close(label)}
        size={24}
        onClick={() => void closeTerminal(terminal)}
      >
        <X size={13} aria-hidden />
      </IconButton>
    </>
  );
}

/** A pane header's button with the context gauge's bubble (hooks need a component). */
function PaneButton({
  usage,
  agent,
  children,
}: {
  usage: SessionView["context"];
  agent: Agent | undefined;
  children: (bind: ReturnType<typeof useContextBubble>["bind"]) => ReactNode;
}) {
  const { bind, bubble } = useContextBubble(usage, agent);
  return (
    <>
      {children(bind)}
      {bubble}
    </>
  );
}

/** « +1 »: the terminals no pane shows; red while one of them waits. */
function HiddenTerminals({
  task,
  labels,
  panes,
  onPick,
}: {
  task: TaskDetail;
  labels: Map<string, string>;
  panes: string[];
  onPick: (id: string) => void;
}) {
  const hidden = task.terminals.filter((t) => !panes.includes(t.id));
  if (hidden.length === 0) return null;
  const waitingSession = hidden
    .filter((t) => t.running)
    .map((t) => sessionOf(task, t))
    .find((s) => s?.state === "waiting");
  const waiting = waitingSession !== undefined;
  return (
    <button
      type="button"
      aria-haspopup="menu"
      aria-label={strings.terminals.hiddenTerminals(hidden.length)}
      title={strings.terminals.hiddenTerminals(hidden.length)}
      onClick={(e) =>
        openMenuAt(
          e.currentTarget,
          hidden.map((t) => ({
            label: labels.get(t.id) ?? "",
            icon: <KindIcon kind={t.kind} session={sessionOf(task, t)} />,
            hint: strings.terminals.toFocusedPane,
            onSelect: () => onPick(t.id),
          })),
          strings.terminals.hiddenTerminals(hidden.length),
        )
      }
      className={`mr-1 inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-[12px] ${
        waiting
          ? "border-[var(--bar-waiting-border)] bg-[var(--bar-waiting)] text-waiting-text"
          : "border-border text-text-2 hover:bg-hover"
      }`}
    >
      {waitingSession && (
        <StateDot ring="waiting" agent={waitingSession.agent} size={10} />
      )}
      +{hidden.length}
    </button>
  );
}

/**
 * Focus mode: the 44 px bar and the terminals, nothing else.
 * `lead` is the task's ring and title, `actions` the panel's ⤡ ⋯ ×.
 */
export function FocusView({
  task,
  lead,
  actions,
}: {
  task: TaskDetail;
  lead: ReactNode;
  actions: ReactNode;
}) {
  const terminals = task.terminals;
  const labels = useTerminalLabels(task);
  const remembered = useUi((s) => s.activeTerminals[task.id]);
  const setActiveTerminal = useUi((s) => s.setActiveTerminal);
  const [chosen, setChosen] = useState<string[]>([]);
  const [focused, setFocused] = useState(0);
  const [ratio, setRatio] = useState(() =>
    loadRatio(PANE_SPLIT_KEY, PANE_SPLIT_DEFAULT),
  );
  const [rows, setRows] = useState(() =>
    loadRatio(PANE_ROWS_KEY, PANE_ROWS_DEFAULT),
  );
  const gridRef = useRef<HTMLDivElement>(null);
  const panes = resolvePanes(terminals, chosen);
  // The focused pane; the first one when it went away.
  const current = panes && focused < panes.length ? focused : 0;
  const paneRefs = useRef<(HTMLDivElement | null)[]>([]);
  const known = useRef(new Set(terminals.map((t) => t.id)));
  // The terminal to focus once the panes have moved: one swapped into another pane is still
  // in its old pane until then, and focusing it there would mark that pane as the focused one.
  const focusNext = useRef<string | null>(null);

  useEffect(() => {
    const id = focusNext.current;
    if (id === null) return;
    focusNext.current = null;
    focusTerminal(id);
  });

  // The panes keep what they show (a closed terminal's place keeps the one that took it), and
  // a terminal opened while every pane is taken goes into the focused pane.
  useEffect(() => {
    const fresh = terminals.filter((t) => !known.current.has(t.id));
    known.current = new Set(terminals.map((t) => t.id));
    if (!panes) return;
    const id = fresh.length === 1 ? fresh[0].id : null;
    const next =
      id && !panes.includes(id)
        ? panes.map((shown, i) => (i === current ? id : shown))
        : panes;
    if (!sameIds(chosen, next)) setChosen(next);
  });

  useEffect(() => {
    if (!panes) return;
    return registerPaneCycler(task.id, (step) => {
      const holder = paneRefs.current.findIndex((el) =>
        el?.contains(document.activeElement),
      );
      const from = holder !== -1 && holder < panes.length ? holder : current;
      const next = cyclePanes(terminals, panes, from, step);
      setFocused(next.pane);
      if (next.panes === panes) {
        focusTerminal(next.focus);
        return;
      }
      setChosen(next.panes);
      focusNext.current = next.focus;
    });
  });

  const choose = (pane: number, id: string) => {
    if (!panes) return;
    // Picking a terminal shown in another pane swaps the two panes.
    const next = panes.map((shown, i) =>
      i === pane ? id : shown === id ? panes[pane] : shown,
    );
    setChosen(next);
    setFocused(pane);
    focusNext.current = id;
  };
  const swap = () => {
    if (panes?.length === 2) setChosen([panes[1], panes[0]]);
  };

  if (panes) {
    const places = PLACES[panes.length];
    const stacked = panes.length > 2;
    const header = (pane: number) => (
      <PaneHeader
        task={task}
        labels={labels}
        panes={panes}
        pane={pane}
        place={places[pane]}
        focused={current === pane}
        onChoose={choose}
        onSwap={swap}
      />
    );
    return (
      <div
        ref={gridRef}
        className="relative grid min-h-0 flex-1"
        style={{
          gridTemplateColumns: `minmax(0, ${ratio}fr) minmax(0, ${1 - ratio}fr)`,
          gridTemplateRows: stacked
            ? `${BAR_HEIGHT}px minmax(0, ${rows}fr) minmax(0, ${1 - rows}fr)`
            : `${BAR_HEIGHT}px minmax(0, 1fr)`,
        }}
      >
        <PaneDivider
          axis="columns"
          ratio={ratio}
          container={gridRef}
          style={{ left: `${ratio * 100}%` }}
          onRatio={(r, commit) => {
            setRatio(r);
            if (commit) saveRatio(PANE_SPLIT_KEY, r);
          }}
        />
        {stacked && (
          <PaneDivider
            axis="rows"
            ratio={rows}
            container={gridRef}
            style={{
              top: `calc(${BAR_HEIGHT}px + (100% - ${BAR_HEIGHT}px) * ${rows})`,
              // Three panes: only the right column is split.
              left: panes.length === 3 ? `${ratio * 100}%` : 0,
              right: 0,
            }}
            onRatio={(r, commit) => {
              setRows(r);
              if (commit) saveRatio(PANE_ROWS_KEY, r);
            }}
          />
        )}
        <div
          style={{ gridColumn: 1, gridRow: 1 }}
          className="flex min-w-0 items-center gap-0.5 border-b border-border pr-1.5 pl-3.5"
        >
          {lead}
          <Separator />
          {header(0)}
        </div>
        <div
          style={{ gridColumn: 2, gridRow: 1 }}
          className="flex min-w-0 items-center gap-0.5 border-b border-l border-border px-1.5"
        >
          {header(1)}
          <span className="flex-1" />
          <HiddenTerminals
            task={task}
            labels={labels}
            panes={panes}
            onPick={(id) => choose(current, id)}
          />
          <AddButton taskId={task.id} />
          <FinderButton taskId={task.id} />
          <Separator />
          {actions}
        </div>
        {panes.map((id, pane) => {
          const terminal = terminals.find((t) => t.id === id);
          if (!terminal) return null;
          const place = places[pane];
          const waiting =
            terminal.running && sessionOf(task, terminal)?.state === "waiting";
          return (
            <div
              key={place}
              ref={(el) => {
                paneRefs.current[pane] = el;
              }}
              onFocusCapture={() => setFocused(pane)}
              onPointerDown={() => setFocused(pane)}
              data-pane={pane}
              data-place={place}
              data-focused={current === pane || undefined}
              style={AREAS[place]}
              className={`relative flex min-h-0 min-w-0 flex-col ${
                isRight(place) ? "border-l border-border" : ""
              } ${isBottom(place) ? "border-t border-border" : ""}`}
            >
              {current === pane && !waiting && (
                <span
                  aria-hidden
                  className="absolute inset-x-0 top-0 z-10 h-0.5 bg-accent"
                />
              )}
              {isBottom(place) && (
                <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border px-1.5">
                  {header(pane)}
                </div>
              )}
              <Frame
                task={task}
                terminal={terminal}
                label={labels.get(terminal.id) ?? ""}
                bare
                fill
                className="min-h-0 flex-1"
              />
            </div>
          );
        })}
      </div>
    );
  }

  const active = activeTerminalOf(terminals, remembered);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-0.5 border-b border-border pr-1.5 pl-3.5">
        {lead}
        {task.subject && (
          <span className="ml-1 shrink-[2] truncate text-[12.5px] text-text-3">
            · {task.subject.name}
            {task.section && ` › ${task.section.name}`}
          </span>
        )}
        <Separator />
        {active && (
          <div className="flex min-w-0 items-center">
            <Tab
              terminal={active}
              label={labels.get(active.id) ?? ""}
              session={sessionOf(task, active)}
              active
              onSelect={() => {
                setActiveTerminal(task.id, active.id);
                focusTerminal(active.id);
              }}
            />
          </div>
        )}
        <AddButton taskId={task.id} />
        <FinderButton taskId={task.id} />
        <span className="flex-1" />
        {actions}
      </div>
      {active ? (
        // A lone terminal takes the whole width (by design): « + » opens a second one beside it.
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <Frame
            task={task}
            terminal={active}
            label={labels.get(active.id) ?? ""}
            bare
            fill
            className="min-h-0 flex-1"
          />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-[13.5px] text-text-2">
          <span>{strings.terminals.noTerminal}</span>
          {task.completedAt === null && <QuickActions taskId={task.id} />}
        </div>
      )}
    </div>
  );
}
