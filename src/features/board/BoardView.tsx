/**
 * Kanban of a project (Taido V2.2). Product decision (2026-10-09): the columns are the
 * progress of the tasks, per project and renamable (« À faire · En cours · À valider ·
 * Terminé » by default), not Claude's states. Claude shows on each card: its state dot, its
 * line (« Claude attend ta réponse »…) and its chrono. Launching Claude on a task of the first
 * column puts it in the second, once (the core does it). Dropping a card on the done column
 * checks the task (asking first if Claude runs), leaving it reopens the task.
 *
 * Web app (Taido V2.8): on a large screen (≥ 1024 px) the same board. On a phone, like Trello
 * and Todoist, one column per screen (horizontal scroll snapping), the column names with their
 * counts above (a tap scrolls to it), and a card moves with « Déplacer vers… » or a long press
 * then a drag (towards the edge scrolls to the next column). A linked device before its first
 * full sync has no columns yet: the board says so.
 */

import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightLeft, Clock, Ellipsis } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { BoardColumn, TaskRow } from "../../bindings";
import { Button } from "../../components/Button";
import { confirmDialog } from "../../components/Dialog";
import { type MenuItem, openMenuAt } from "../../components/Menu";
import { showError } from "../../components/Toast";
import { t } from "../../i18n";
import { useDefaultAgent } from "../../lib/agent";
import { formatDue, formatDueMeta } from "../../lib/dates";
import { features } from "../../lib/features";
import { commands, errorKind } from "../../lib/ipc";
import { queryKeys } from "../../lib/queries";
import { readableError, run } from "../../lib/run";
import { useLargeScreen } from "../../lib/screen";
import { settingsPatch } from "../../lib/settingsPatch";
import { IS_MOBILE } from "../../lib/target";
import { useUi } from "../../stores/ui";
import { ChronoBadge } from "../chrono/ChronoBadge";
import {
  isTouchContextMenu,
  LONG_PRESS_MS,
  NonTouchPointerSensor,
} from "../dnd/sensors";
import { LinkBadges } from "../links/LinkBadges";
import { setCompleted } from "../task-row/actions";
import { StateDot } from "../task-row/StateDot";
import { lineText, TONE_CLASS } from "../task-row/TaskRow";

export function useBoard(subjectId: string | null) {
  return useQuery({
    queryKey: queryKeys.board(subjectId),
    queryFn: () => commands.getBoard(subjectId),
  });
}

/** What dropping a card of column `from` on column `to` does. */
export function dropAction(
  from: BoardColumn,
  to: BoardColumn,
): "complete" | "move" | null {
  if (from.id === to.id) return null;
  return to.isDone ? "complete" : "move";
}

async function drop(card: TaskRow, from: BoardColumn, to: BoardColumn) {
  switch (dropAction(from, to)) {
    case "complete":
      // The usual check: asks first when Claude still runs on the task.
      await setCompleted(card.id, true);
      return;
    case "move":
      await run(
        commands.moveTaskToColumn({ taskId: card.id, columnId: to.id }),
      );
      return;
    default:
      return;
  }
}

function Card({
  card,
  column,
  columns,
  phone,
}: {
  card: TaskRow;
  column: BoardColumn;
  /** Every column of the board, in display order (« Déplacer vers… »). */
  columns: BoardColumn[];
  /** Phone layout: the « Déplacer vers… » button shows. */
  phone: boolean;
}) {
  const openTask = useUi((s) => s.openTask);
  const selected = useUi((s) => s.openTaskId === card.id);
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: card.id, data: { card, column } });
  const overdue = card.due?.overdue === true && card.completedAt === null;
  const failed = card.ring === "error" || card.ring === "crashed";
  // Claude's state, now that the columns are the progress.
  const line =
    card.ring !== "human" && card.ring !== "completed" ? card.line : null;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      data-card={card.id}
      className={`flex items-start gap-1 rounded-lg border bg-bg px-3 py-2.5 ${
        isDragging ? "z-10 opacity-80 shadow-lg" : ""
      } ${selected ? "border-accent" : failed ? "border-waiting-text" : "border-border"}`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-roledescription={t.board.dragLabel(card.title)}
        onClick={() => openTask(card.id)}
        // A long press picks the card up (web app): no context menu under the finger.
        onContextMenu={(e) => {
          if (isTouchContextMenu(e)) e.preventDefault();
        }}
        className={`block min-w-0 flex-1 cursor-pointer text-left ${
          features.touchDrag ? "touch-drag" : ""
        }`}
      >
        <span className="flex items-start gap-2">
          <span
            className={`min-w-0 flex-1 text-[13.5px] leading-[18px] [overflow-wrap:anywhere] ${
              card.completedAt ? "text-text-3 line-through" : "text-text"
            }`}
          >
            {card.title}
          </span>
          <StateDot ring={card.ring} agent={card.line?.agent ?? undefined} />
        </span>
        {line && (
          <span
            className={`mt-1 block truncate text-[12px] leading-4 ${TONE_CLASS[line.tone]}`}
          >
            {lineText(line)}
          </span>
        )}
        <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] leading-4 text-text-2">
          {card.due && (
            <span
              className={`inline-flex items-center gap-1 ${overdue ? "text-due-overdue" : ""}`}
              title={t.row.dueLabel(formatDue(card.due))}
              data-overdue={overdue || undefined}
            >
              {card.due.time && <Clock size={12} aria-hidden />}
              {overdue ? t.row.overdue : formatDueMeta(card.due)}
              {overdue && ` · ${formatDueMeta(card.due)}`}
            </span>
          )}
          {card.subtasksTotal > 0 && (
            <span
              className="tabular-nums"
              title={t.row.subtasksLabel(card.subtasksDone, card.subtasksTotal)}
            >
              {t.row.subtasks(card.subtasksDone, card.subtasksTotal)}
            </span>
          )}
          <LinkBadges row={card} />
          {card.chrono && <ChronoBadge chrono={card.chrono} />}
        </span>
      </button>
      {phone && (
        <button
          type="button"
          aria-label={t.board.moveToLabel(card.title)}
          title={t.board.moveTo}
          onClick={(e) =>
            openMenuAt(
              e.currentTarget,
              columns
                .filter((c) => c.id !== column.id)
                .map((to) => ({
                  label: to.name,
                  onSelect: () => void drop(card, column, to),
                })),
              t.board.moveToLabel(card.title),
              true,
            )
          }
          className="touch-target relative -mr-1.5 -mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-text-3 hover:bg-hover hover:text-text"
        >
          <ArrowRightLeft size={15} aria-hidden />
        </button>
      )}
    </li>
  );
}

/** A name field (new column, renaming): Enter saves, Escape or leaving cancels. */
function NameField({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) onSave(name.trim());
    else onCancel();
  };
  return (
    <form onSubmit={submit} className="min-w-0 flex-1">
      <input
        ref={ref}
        value={name}
        aria-label={t.board.newColumnPlaceholder}
        placeholder={t.board.newColumnPlaceholder}
        onChange={(e) => setName(e.target.value)}
        onBlur={onCancel}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
        className="h-7 w-full rounded-md border border-border bg-bg px-2 text-[13px] text-text"
      />
    </form>
  );
}

function Column({
  column,
  index,
  columns,
  subjectId,
  phone = false,
}: {
  column: BoardColumn;
  index: number;
  columns: BoardColumn[];
  /** `null`: « Sans projet ». */
  subjectId: string | null;
  /** Phone layout: one column per screen, snapped. */
  phone?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: column.id,
    data: { column },
  });
  const [renaming, setRenaming] = useState(false);
  const hidden = column.total - column.cards.length;
  const openDialog = useUi((s) => s.openDialog);
  const setProjectTab = useUi((s) => s.setProjectTab);
  const work = columns.filter((c) => !c.isDone);

  const menu = (anchor: HTMLElement) => {
    const items: MenuItem[] = [
      { label: t.board.rename, onSelect: () => setRenaming(true) },
    ];
    if (!column.isDone) {
      items.push(
        {
          label: t.board.moveLeft,
          disabled: index === 0,
          onSelect: () =>
            void run(
              commands.moveBoardColumn({ id: column.id, index: index - 1 }),
            ),
        },
        {
          label: t.board.moveRight,
          disabled: index >= work.length - 1,
          onSelect: () =>
            void run(
              commands.moveBoardColumn({ id: column.id, index: index + 1 }),
            ),
        },
        { separator: true },
        {
          label: t.board.delete,
          danger: true,
          disabled: work.length <= 1,
          onSelect: async () => {
            const first = work.find((c) => c.id !== column.id) ?? work[0];
            const ok = await confirmDialog({
              title: t.board.deleteTitle(column.name),
              message: t.board.deleteMessage(first.name),
              confirmLabel: t.board.delete,
            });
            if (ok) void run(commands.deleteBoardColumn(column.id));
          },
        },
      );
    }
    openMenuAt(anchor, items, t.board.columnMenu(column.name), true);
  };

  return (
    <section
      ref={setNodeRef}
      aria-label={t.board.columnLabel(column.name, column.total)}
      data-column={column.isDone ? "done" : column.id}
      className={`group/column flex flex-col rounded-xl p-2 ${
        phone
          ? "w-[min(88%,420px)] shrink-0 snap-start"
          : "min-w-[128px] max-w-[300px] flex-1 basis-0"
      } ${isOver ? "bg-selected" : "bg-hover/60"}`}
    >
      <h2 className="flex min-h-7 items-center justify-between gap-2 px-1.5 pb-1.5 text-[12.5px] font-medium text-text-2">
        {renaming ? (
          <NameField
            initial={column.name}
            onCancel={() => setRenaming(false)}
            onSave={(name) => {
              setRenaming(false);
              void run(commands.renameBoardColumn({ id: column.id, name }));
            }}
          />
        ) : (
          <>
            <span className="truncate" title={column.name}>
              {column.name}
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <span className="font-normal tabular-nums text-text-3">
                {column.total}
              </span>
              <button
                type="button"
                aria-label={t.board.columnMenu(column.name)}
                title={t.common.more}
                onClick={(e) => menu(e.currentTarget)}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-text-3 opacity-0 hover:bg-hover hover:text-text focus-visible:opacity-100 group-hover/column:opacity-100"
              >
                <Ellipsis size={14} aria-hidden />
              </button>
            </span>
          </>
        )}
      </h2>
      <ul className="flex min-h-12 flex-col gap-2">
        {column.cards.map((card) => (
          <Card
            key={card.id}
            card={card}
            column={column}
            columns={columns}
            phone={phone}
          />
        ))}
        {column.cards.length === 0 && (
          <li className="px-1.5 py-2 text-[12.5px] text-text-3">
            {t.board.empty}
          </li>
        )}
      </ul>
      {index === 0 && (
        <button
          type="button"
          onClick={() =>
            openDialog({
              type: "addTask",
              target: {
                subjectId,
                sectionId: null,
                dueToday: false,
                dueDate: null,
              },
            })
          }
          className="mt-2 rounded-md px-1.5 py-1 text-left text-[13px] text-text-2 hover:bg-hover hover:text-text"
        >
          {t.board.addTask}
        </button>
      )}
      {column.isDone && hidden > 0 && (
        <button
          type="button"
          onClick={() => {
            setProjectTab("list");
            void run(
              commands.updateSettings(settingsPatch({ showCompleted: true })),
            );
          }}
          className="mt-2 rounded-md px-1.5 py-1 text-left text-[13px] text-text-2 hover:bg-hover hover:text-text"
        >
          {t.board.more(hidden)}
        </button>
      )}
    </section>
  );
}

function AddColumn({ subjectId }: { subjectId: string | null }) {
  const [open, setOpen] = useState(false);
  if (open) {
    return (
      <div className="w-[160px] shrink-0 rounded-xl bg-hover/60 p-2">
        <NameField
          initial=""
          onCancel={() => setOpen(false)}
          onSave={(name) => {
            setOpen(false);
            commands.createBoardColumn({ subjectId, name }).catch((e) => {
              // `invalid` with a name given: a linked device before its first full sync.
              showError(
                errorKind(e) === "invalid"
                  ? t.board.notReadyError
                  : readableError(e, t.errors.action.createColumn),
              );
            });
          }}
        />
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="h-9 shrink-0 rounded-xl px-3 text-[13px] whitespace-nowrap text-text-2 hover:bg-hover hover:text-text"
    >
      {t.board.addColumn}
    </button>
  );
}

/** Phone: the column names and their counts; a tap scrolls to the column. */
function ColumnTabs({
  columns,
  active,
  onPick,
  subjectId,
}: {
  columns: BoardColumn[];
  active: number;
  onPick: (index: number) => void;
  subjectId: string | null;
}) {
  return (
    <nav
      aria-label={t.board.columnsNav}
      className="-mx-1 mb-2 flex items-center gap-1 overflow-x-auto px-1 pb-1"
    >
      {columns.map((column, i) => (
        <button
          key={column.id}
          type="button"
          aria-current={active === i ? "true" : undefined}
          aria-label={t.board.columnTab(column.name, column.total)}
          onClick={() => onPick(i)}
          className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] whitespace-nowrap ${
            active === i
              ? "bg-selected font-medium text-text"
              : "text-text-2 hover:bg-hover"
          }`}
        >
          {column.name}
          <span className="tabular-nums text-text-3">{column.total}</span>
        </button>
      ))}
      <AddColumn subjectId={subjectId} />
    </nav>
  );
}

export function BoardView({ subjectId }: { subjectId: string | null }) {
  const agent = useDefaultAgent();
  const { data: board, error, refetch } = useBoard(subjectId);
  // Web app under 1024 px: one column per screen.
  const phone = !useLargeScreen();
  const [active, setActive] = useState(0);
  // Column picked in the header: the smooth scroll toward it does not move the highlight.
  const picked = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  // Web app: fingers drag after a long press, so that a swipe still scrolls the columns.
  const pointer = useSensor(
    features.touchDrag ? NonTouchPointerSensor : PointerSensor,
    { activationConstraint: { distance: 6 } },
  );
  const keyboard = useSensor(KeyboardSensor);
  const touch = useSensor(TouchSensor, {
    activationConstraint: { delay: LONG_PRESS_MS, tolerance: 8 },
  });
  const sensors = useSensors(
    pointer,
    keyboard,
    features.touchDrag ? touch : undefined,
  );

  const onDragEnd = (event: DragEndEvent) => {
    setDragging(false);
    const data = event.active.data.current as
      | { card: TaskRow; column: BoardColumn }
      | undefined;
    const to = event.over?.data.current?.column as BoardColumn | undefined;
    if (!data || !to) return;
    void drop(data.card, data.column, to);
  };

  if (!board) {
    return (
      <div className="py-6 text-[13.5px] text-text-2">
        {error ? (
          <span className="flex items-center gap-3">
            {t.board.error}
            <Button size="sm" onClick={() => void refetch()}>
              {t.board.retry}
            </Button>
          </span>
        ) : (
          t.board.loading
        )}
      </div>
    );
  }

  // A linked web app before its first full sync: the Mac's columns are still on their way.
  if (board.columns.length === 0) {
    return (
      <p role="status" className="py-6 text-[13.5px] text-text-2">
        {t.board.notReady}
      </p>
    );
  }

  const [first, second] = board.columns;
  const work = board.columns.filter((c) => !c.isDone);
  const done = board.columns.find((c) => c.isDone);

  if (phone) {
    const ordered = done ? [...work, done] : work;
    const pick = (i: number) => {
      picked.current = i;
      // Never stuck: a swipe right after the tap (or no scroll at all) moves it again.
      setTimeout(() => {
        if (picked.current === i) picked.current = null;
      }, 800);
      setActive(i);
      const el = scroller.current?.children[i];
      if (el instanceof HTMLElement) {
        scroller.current?.scrollTo?.({
          left: el.offsetLeft,
          behavior: "smooth",
        });
      }
    };
    // The column whose left edge is nearest to the scroll position.
    const onScroll = () => {
      const box = scroller.current;
      if (!box) return;
      let best = 0;
      Array.from(box.children).forEach((el, i) => {
        const left = (el as HTMLElement).offsetLeft;
        const bestLeft = (box.children[best] as HTMLElement).offsetLeft;
        if (
          Math.abs(left - box.scrollLeft) < Math.abs(bestLeft - box.scrollLeft)
        ) {
          best = i;
        }
      });
      if (picked.current !== null) {
        if (best !== picked.current) return;
        picked.current = null;
      }
      setActive(best);
    };
    return (
      <div className="pb-16">
        <ColumnTabs
          columns={ordered}
          active={Math.min(active, ordered.length - 1)}
          onPick={pick}
          subjectId={subjectId}
        />
        <DndContext
          sensors={sensors}
          onDragStart={() => setDragging(true)}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDragging(false)}
        >
          {/* Snapping off while a card is dragged: the auto-scroll at the edge moves freely. */}
          <div
            ref={scroller}
            onScroll={onScroll}
            data-board-phone
            className={`relative flex min-w-0 items-start gap-3 overflow-x-auto pb-4 ${
              dragging ? "" : "snap-x snap-mandatory"
            }`}
          >
            {ordered.map((column, i) => (
              <Column
                key={column.id}
                column={column}
                index={column.isDone ? work.length : i}
                columns={board.columns}
                subjectId={subjectId}
                phone
              />
            ))}
          </div>
        </DndContext>
      </div>
    );
  }

  return (
    <div className="pb-16">
      {/* Launching Claude moves a card: not on the web, which has no Claude. */}
      {!IS_MOBILE && first && second && !second.isDone && (
        <p className="mb-3 text-[12.5px] text-text-3">
          {t.board.hint(first.name, second.name, agent)}
        </p>
      )}
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="flex min-w-0 items-start gap-2 overflow-x-auto pb-4 xl:gap-3">
          {work.map((column, i) => (
            <Column
              key={column.id}
              column={column}
              index={i}
              columns={board.columns}
              subjectId={subjectId}
            />
          ))}
          <AddColumn subjectId={subjectId} />
          {done && (
            <Column
              column={done}
              index={work.length}
              columns={board.columns}
              subjectId={subjectId}
            />
          )}
        </div>
      </DndContext>
    </div>
  );
}
