/**
 * « Sessions Claude »: the task's Claude conversations as work history one comes
 * back to, like `claude --resume` (by design). Newest first; a row unfolds what happened in the
 * conversation. « Reprendre » opens it again in a new tab. Hidden while nothing is listed.
 *
 * Each row reads as one recap sentence, « first message → first sentence of
 * the last reply » (no AI), with date · duration · status in small text below.
 *
 * Redesign option A (2026-10-04): renamed « Conversations passées », folded by default
 * like « Détails techniques », and a conversation running in a tab is not listed (its tab
 * already shows it), so « Aller à l'onglet » is gone.
 */

import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Pencil, Sparkles } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type {
  Agent,
  Exchange,
  SessionSummary,
  TaskDetail,
} from "../../bindings";
import { Button, IconButton } from "../../components/Button";
import { agentErrorLabel, t } from "../../i18n";
import { formatSessionDuration, formatSessionStart } from "../../lib/dates";
import { commands } from "../../lib/ipc";
import {
  queryKeys,
  useSessionExchanges,
  useTaskSessions,
} from "../../lib/queries";
import { run } from "../../lib/run";
import { Fold } from "../task-panel/PanelFold";
import { StateDot } from "../task-row/StateDot";
import { resumeSession } from "./actions";

/** Texts longer than this get « Voir plus » (about six lines of the panel). */
const CLAMP_CHARS = 360;
const CLAMP_LINES = 6;

const isLong = (text: string) =>
  text.length > CLAMP_CHARS || text.split("\n").length > CLAMP_LINES;

function ExchangeText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = isLong(text);
  return (
    <div className="min-w-0 flex-1">
      <p
        className={`text-[13px] leading-[19px] break-words whitespace-pre-wrap text-text ${
          long && !expanded ? "line-clamp-6" : ""
        }`}
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 text-[12.5px] text-text-2 hover:text-text"
        >
          {expanded ? t.sessions.showLess : t.sessions.showMore}
        </button>
      )}
    </div>
  );
}

/** A small muted line for what is not a message (error, resumed, cleared, compacted). */
function eventText(e: Exchange): string | null {
  switch (e.kind) {
    case "error":
      return agentErrorLabel(e.text || null);
    case "resumed":
      return t.sessions.resumed;
    case "cleared":
      return t.sessions.cleared;
    case "compacted":
      return t.sessions.compacted;
    default:
      return null;
  }
}

function Exchanges({
  sessionId,
  id,
  agent,
}: {
  sessionId: string;
  id: string;
  agent: Agent;
}) {
  const { data, isPending, isError, refetch } = useSessionExchanges(
    sessionId,
    true,
  );
  let body: ReactNode;
  if (isPending) {
    body = <p className="text-[12.5px] text-text-3">{t.sessions.loading}</p>;
  } else if (isError) {
    body = (
      <p className="flex items-center gap-2 text-[12.5px] text-text-2">
        {t.sessions.loadError}
        <button
          type="button"
          onClick={() => void refetch()}
          className="underline hover:text-text"
        >
          {t.sessions.retry}
        </button>
      </p>
    );
  } else if (data.length === 0) {
    body = <p className="text-[12.5px] text-text-3">{t.sessions.empty}</p>;
  } else {
    body = (
      <ol className="flex flex-col gap-2">
        {data.map((e, i) => {
          const muted = eventText(e);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: an exchange has no id; the list only grows at the end
            <li key={i} data-kind={e.kind} className="flex gap-3">
              {muted === null ? (
                <>
                  <span
                    className={`w-12 shrink-0 pt-px text-[12px] font-medium ${
                      e.kind === "prompt" ? "text-text-2" : "text-accent"
                    }`}
                  >
                    {e.kind === "prompt"
                      ? t.sessions.you
                      : t.sessions.agent(agent)}
                  </span>
                  <ExchangeText text={e.text} />
                </>
              ) : (
                <span className="pl-15 text-[12.5px] text-text-3">{muted}</span>
              )}
            </li>
          );
        })}
      </ol>
    );
  }
  return (
    <div id={id} className="mt-2 mb-1 ml-[22px] border-l border-border pl-3">
      {body}
    </div>
  );
}

/** Where the shown recap comes from: the user's title, Claude Haiku, or the trace. */
export type RecapSource = "title" | "ai" | "fallback";

export function recapSource(summary: SessionSummary): RecapSource {
  if (summary.title) return "title";
  if (summary.aiSummary) return "ai";
  return "fallback";
}

/**
 * One recap sentence (option 4): the user's title, else Claude Haiku's summary,
 * else « first message → first sentence of the last reply ».
 */
export function sessionRecap(summary: SessionSummary): string {
  if (summary.title) return summary.title;
  if (summary.aiSummary) return summary.aiSummary;
  if (!summary.firstPrompt) return t.sessions.noMessage;
  return t.panelBis.recap(summary.firstPrompt, summary.lastReply);
}

/** Characters kept of a title (like the core). */
const TITLE_MAX = 120;

/** Inline field replacing the recap while the user renames the session. */
function RenameField({
  summary,
  label,
  onDone,
}: {
  summary: SessionSummary;
  label: string;
  onDone: () => void;
}) {
  const client = useQueryClient();
  const [value, setValue] = useState(summary.title ?? sessionRecap(summary));
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = () => {
    done.current = true;
    onDone();
  };
  const save = async () => {
    if (done.current) return;
    const title = value.trim();
    const unchanged =
      (summary.title ?? "") === title ||
      (!summary.title && title === sessionRecap(summary));
    finish();
    if (unchanged) return;
    const ok = await run(
      commands.renameSession({ agentSessionId: summary.id, title }),
      t.sessions.renameError,
    );
    if (ok !== undefined) {
      void client.invalidateQueries({ queryKey: queryKeys.sessionLists });
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish();
    }
  };

  return (
    <input
      ref={ref}
      type="text"
      aria-label={label}
      title={t.sessions.renameHint}
      maxLength={TITLE_MAX}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      // Leaving the field without Entrée cancels, like Échap.
      onBlur={() => {
        if (!done.current) finish();
      }}
      className="ml-[20px] min-w-0 flex-1 rounded-md border border-border-input bg-bg px-2 py-1 text-[14px] leading-[21px] text-text outline-none focus-visible:border-focus"
    />
  );
}

/** The tab where the conversation runs, when the task still shows it. */
function runningTab(summary: SessionSummary, task: TaskDetail) {
  return summary.terminalId
    ? task.terminals.find((t) => t.id === summary.terminalId && t.running)
    : undefined;
}

function SessionRow({
  summary,
  task,
}: {
  summary: SessionSummary;
  task: TaskDetail;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const source = recapSource(summary);
  const detailId = useId();
  const recapId = useId();
  // Running in a tab the task still shows: its live state comes from the task detail.
  const tab = runningTab(summary, task);
  const live = tab ? task.sessions.find((s) => s.id === summary.id) : undefined;
  const state = live?.state ?? summary.state;
  const start = formatSessionStart(summary.startedAt);
  // date · duration · status
  const meta = [start];
  if (tab) meta.push(t.sessions.running);
  else if (summary.endedAt) {
    meta.push(formatSessionDuration(summary.startedAt, summary.endedAt));
  }
  if (summary.crashed && !tab) meta.push(t.sessions.crashed);
  const inert = !tab && !summary.resumable;
  const unfoldable = summary.promptCount > 0;

  return (
    <li
      data-session-id={summary.id}
      className={inert ? "opacity-60" : undefined}
      title={inert ? t.sessions.notResumable : undefined}
    >
      <div className="group/session flex items-start gap-2 rounded-md py-1.5">
        {editing ? (
          <RenameField
            summary={summary}
            label={t.sessions.renameLabel(start)}
            onDone={() => setEditing(false)}
          />
        ) : (
          <button
            type="button"
            disabled={!unfoldable}
            aria-expanded={unfoldable ? open : undefined}
            aria-controls={unfoldable && open ? detailId : undefined}
            aria-label={t.sessions.showDetail(start)}
            aria-describedby={recapId}
            onClick={() => setOpen((v) => !v)}
            // A double click renames (the two clicks fold and unfold back).
            onDoubleClick={() => setEditing(true)}
            className="flex min-w-0 flex-1 items-start gap-1.5 text-left disabled:cursor-default"
          >
            <ChevronRight
              size={14}
              aria-hidden
              className={`mt-[4px] shrink-0 text-text-3 transition-transform ${
                open ? "rotate-90" : ""
              } ${unfoldable ? "" : "invisible"}`}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span
                id={recapId}
                data-part="recap"
                data-source={source}
                className={`line-clamp-2 text-[14px] leading-[21px] break-words ${
                  summary.firstPrompt ? "text-text" : "text-text-3"
                }`}
              >
                {sessionRecap(summary)}
              </span>
              <span
                data-part="meta"
                className="mt-0.5 flex items-center gap-1.5 text-[12px] text-text-3"
              >
                {tab && (
                  <span data-session-state={state} className="flex">
                    <StateDot ring={state} agent={summary.agent} size={10} />
                  </span>
                )}
                <span className="truncate">{meta.join(" · ")}</span>
                {source === "ai" && (
                  <span
                    data-part="ai-marker"
                    title={t.sessions.aiSummary(summary.agent)}
                    className="flex shrink-0 items-center gap-1"
                  >
                    <Sparkles size={11} aria-hidden />
                    <span className="sr-only">
                      {t.sessions.aiSummary(summary.agent)}
                    </span>
                  </span>
                )}
              </span>
            </span>
          </button>
        )}
        {!editing && summary.promptCount > 0 && (
          <IconButton
            label={t.sessions.rename}
            size={26}
            onClick={() => setEditing(true)}
            className="opacity-0 group-focus-within/session:opacity-100 group-hover/session:opacity-100 focus-visible:opacity-100"
          >
            <Pencil size={13} aria-hidden />
          </IconButton>
        )}
        {summary.resumable ? (
          <Button
            size="sm"
            aria-label={t.sessions.resumeLabel(start)}
            disabled={pending}
            onClick={() => {
              setPending(true);
              void resumeSession(task.id, summary.id, summary.agent).finally(
                () => setPending(false),
              );
            }}
          >
            {t.sessions.resume}
          </Button>
        ) : null}
      </div>
      {open && unfoldable && (
        <Exchanges sessionId={summary.id} id={detailId} agent={summary.agent} />
      )}
    </li>
  );
}

export function SessionHistory({ task }: { task: TaskDetail }) {
  const { data = [] } = useTaskSessions(task.id);
  // A conversation running in a tab is shown by that tab.
  const sessions = data.filter((s) => runningTab(s, task) === undefined);
  if (sessions.length === 0) return null;
  return (
    <Fold
      id="sessions"
      title={t.sessions.title}
      summary={
        <span title={t.sessions.titleCount(sessions.length)}>
          {sessions.length}
        </span>
      }
    >
      <ol className="flex flex-col">
        {sessions.map((s) => (
          <SessionRow key={s.id} summary={s} task={task} />
        ))}
      </ol>
    </Fold>
  );
}
