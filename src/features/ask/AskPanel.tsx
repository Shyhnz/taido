/**
 * « Demander au projet ». Since 2026-10-18 (by design): a panel on the right holding a real
 * Claude Code terminal, the same as in a task, opened by the core in the project's folder
 * with read-only tools on its notes, completed tasks and past conversations
 * (`ask::terminal`). Closing the panel keeps Claude running, like a task's terminals; it is
 * found again on the next opening. « Nouvelle conversation » starts another one.
 */

import { RotateCcw, Search, SquarePen, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalInfo } from "../../bindings";
import { Button, IconButton } from "../../components/Button";
import { t } from "../../i18n";
import { commands } from "../../lib/ipc";
import { useSubjects, useTerminals } from "../../lib/queries";
import { run } from "../../lib/run";
import { useUi } from "../../stores/ui";
import { ensureAgentReady } from "../claude-check/claudeCheck";
import { ASK_PANEL, usePanelWidth } from "../task-panel/panelWidth";
import { ResizeHandle } from "../task-panel/ResizeHandle";
import { DEFAULT_SIZE } from "../terminals/actions";
import { focusTerminal, shownSize } from "../terminals/registry";
import { TerminalView } from "../terminals/TerminalView";
import { MicButton } from "../voice/MicButton";

/** `task_id` of a project's Claude terminal (core: `ask::terminal::task_key`). */
export const askTerminalKey = (subjectId: string) => `ask:${subjectId}`;

/** The project's terminal: the running one, else the last one (exited). */
function pickTerminal(
  list: TerminalInfo[] | undefined,
  subjectId: string,
): TerminalInfo | null {
  const mine = (list ?? []).filter(
    (t) => t.taskId === askTerminalKey(subjectId),
  );
  return mine.find((t) => t.running) ?? mine[mine.length - 1] ?? null;
}

export function AskPanel({ subjectId }: { subjectId: string }) {
  const closeAsk = useUi((s) => s.closeAsk);
  const subjects = useSubjects().data;
  const terminals = useTerminals();
  const { width, max, setWidth, commit } = usePanelWidth(ASK_PANEL);
  // The terminal just opened, until the list has it.
  const [opened, setOpened] = useState<TerminalInfo | null>(null);
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  const listed = pickTerminal(terminals.data, subjectId);
  const terminal =
    listed ?? (opened?.taskId === askTerminalKey(subjectId) ? opened : null);

  const open = useCallback(async () => {
    setOpening(true);
    setFailed(false);
    const ready = await ensureAgentReady("claude");
    const size = shownSize() ?? DEFAULT_SIZE;
    const info = ready
      ? await run(
          commands.openAskTerminal(subjectId, size.cols, size.rows),
          t.ask.openError,
        )
      : undefined;
    setOpening(false);
    if (!info) {
      setFailed(true);
      return;
    }
    setOpened(info);
    requestAnimationFrame(() => focusTerminal(info.id));
  }, [subjectId]);

  // First opening of the panel: Claude starts unless it already runs for this project.
  useEffect(() => {
    if (started.current || terminals.data === undefined) return;
    started.current = true;
    const running = pickTerminal(terminals.data, subjectId);
    if (running?.running) {
      requestAnimationFrame(() => focusTerminal(running.id));
    } else {
      void open();
    }
  }, [terminals.data, subjectId, open]);

  // The project was deleted: the panel goes.
  const gone =
    subjects !== undefined && !subjects.some((s) => s.id === subjectId);
  useEffect(() => {
    if (gone) closeAsk();
  }, [gone, closeAsk]);

  /** Another conversation: the current terminal (running or ended) goes first. */
  const fresh = async () => {
    if (terminal) {
      await run(commands.closeTerminal(terminal.id), t.ask.openError);
    }
    setOpened(null);
    await open();
  };

  const running = terminal?.running ?? false;

  return (
    <section
      aria-label={t.ask.title}
      className="relative flex h-full shrink-0 flex-col border-l border-border bg-bg"
      style={{ width }}
    >
      <ResizeHandle
        width={width}
        max={max}
        onResize={setWidth}
        onCommit={commit}
        label={t.ask.resize}
      />
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <Search size={15} aria-hidden className="text-text-2" />
        <h2 className="mr-auto text-[14px] font-semibold">{t.ask.title}</h2>
        {terminal && !opening && (
          <IconButton label={t.ask.newConversation} onClick={fresh}>
            <SquarePen size={15} aria-hidden />
          </IconButton>
        )}
        <IconButton label={t.ask.close} onClick={closeAsk}>
          <X size={16} aria-hidden />
        </IconButton>
      </header>
      <div className="flex min-h-0 flex-1 flex-col p-3">
        {running && terminal ? (
          <div
            data-terminal-frame={terminal.id}
            className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border-terminal bg-terminal"
          >
            <div className="relative min-h-0 flex-1">
              <TerminalView
                terminalId={terminal.id}
                label={t.terminals.view(t.terminals.agent("claude"))}
              />
              <MicButton terminal={terminal} />
            </div>
          </div>
        ) : (
          <div className="grid flex-1 place-content-center justify-items-center gap-3 px-6 text-center">
            <p
              className="text-[13px] leading-relaxed text-text-2"
              role="status"
            >
              {opening
                ? t.ask.opening
                : terminal
                  ? t.ask.ended
                  : failed
                    ? t.ask.failedToOpen
                    : t.ask.opening}
            </p>
            {!opening && (terminal || failed) && (
              <Button
                size="sm"
                onClick={() => void (terminal ? fresh() : open())}
              >
                <RotateCcw size={14} aria-hidden />
                {terminal ? t.ask.restart : t.ask.retry}
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
