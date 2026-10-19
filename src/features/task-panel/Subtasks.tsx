/**
 * Subtasks:
 * counter, priority ring as check (no native checkbox), Claude's state dot and due date on
 * each line, the text opens the child's panel; rename and delete on hover, drag reorder,
 * « + Ajouter une sous-tâche ».
 */

import { closestCenter, DndContext, type DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Pencil, Plus, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { Subtask } from "../../bindings";
import { IconButton } from "../../components/Button";
import { fr } from "../../i18n/fr";
import { useDefaultAgent } from "../../lib/agent";
import { formatDue } from "../../lib/dates";
import { features } from "../../lib/features";
import { commands } from "../../lib/ipc";
import { run } from "../../lib/run";
import { useUi } from "../../stores/ui";
import { splitTouchListeners, useDragSensors } from "../dnd/sensors";
import { PriorityRing } from "../task-row/PriorityRing";
import { StateDot } from "../task-row/StateDot";
import { confirmStopSessions } from "../terminals/actions";
import { Fold, FoldProgress } from "./PanelFold";

/** Up to this many subtasks the list starts open; longer, it starts folded. */
export const SUBTASKS_OPEN_MAX = 8;

/** Checks or unchecks a subtask; checking closes its terminals, so a running Claude asks. */
async function toggleSubtask(subtask: Subtask): Promise<void> {
  if (!subtask.done && !(await confirmStopSessions(subtask.id, "complete"))) {
    return;
  }
  await run(commands.toggleSubtask(subtask.id), fr.errors.action.subtask);
}

/** Deletes a subtask (its terminals close: a running Claude asks first). */
async function deleteSubtask(subtask: Subtask): Promise<void> {
  if (!(await confirmStopSessions(subtask.id, "delete"))) return;
  await run(commands.deleteSubtask(subtask.id));
}

/** Inline rename of a subtask; Enter or blur saves, Escape cancels. */
function RenameField({
  subtask,
  onDone,
}: {
  subtask: Subtask;
  onDone: () => void;
}) {
  const [text, setText] = useState(subtask.text);
  // An edit in progress is saved when the panel closes (no blur on unmount).
  const draft = useRef({ text, saved: subtask.text, done: false });
  draft.current.text = text;
  draft.current.saved = subtask.text;
  useEffect(
    () => () => {
      const { text: t, saved, done } = draft.current;
      const trimmed = t.trim();
      if (!done && trimmed.length > 0 && trimmed !== saved) {
        void commands
          .updateSubtask({ id: subtask.id, text: trimmed })
          .catch(() => {});
      }
    },
    [subtask.id],
  );

  const save = () => {
    // Enter then the blur of the removed field: save once.
    if (draft.current.done) return;
    draft.current.done = true;
    const trimmed = text.trim();
    if (trimmed.length > 0 && trimmed !== subtask.text) {
      void run(commands.updateSubtask({ id: subtask.id, text: trimmed }));
    }
    onDone();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      // Leave the field only: the panel stays open.
      e.preventDefault();
      e.stopPropagation();
      draft.current.done = true;
      onDone();
    }
  };

  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: opened on an explicit user action
      autoFocus
      value={text}
      aria-label={fr.panel.subtaskLabel}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={save}
      onKeyDown={onKeyDown}
      className="min-w-0 flex-1 bg-transparent text-[14px] outline-none"
    />
  );
}

function SubtaskItem({ subtask }: { subtask: Subtask }) {
  const agent = useDefaultAgent();
  const openTask = useUi((s) => s.openTask);
  const [editing, setEditing] = useState(false);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: subtask.id, disabled: !features.dragAndDrop });
  // Mouse: the grip. Finger (web app): a long press anywhere on the subtask.
  const { grip: gripListeners, onTouchStart } = splitTouchListeners(listeners);
  const due = subtask.due ? formatDue(subtask.due) : null;
  const overdue = subtask.due?.overdue === true && !subtask.done;

  return (
    <li
      ref={setNodeRef}
      onTouchStart={onTouchStart}
      data-subtask-id={subtask.id}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`touch-drag group relative flex h-8 items-center gap-2.5 ${
        isDragging ? "z-10 bg-bg opacity-70" : ""
      }`}
    >
      {features.dragAndDrop && (
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...gripListeners}
          aria-label={`${fr.panel.dragSubtask} · ${subtask.text}`}
          className="drag-grip absolute -left-5 flex h-6 w-4 cursor-grab items-center justify-center text-text-3 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <GripVertical size={13} aria-hidden />
        </button>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: the priority ring replaces the native checkbox */}
      <button
        type="button"
        role="checkbox"
        aria-checked={subtask.done}
        aria-label={subtask.text}
        title={fr.panelBis.priorityName(subtask.priority)}
        onClick={() => void toggleSubtask(subtask)}
        className="-m-1 inline-flex h-[23px] w-[23px] shrink-0 items-center justify-center rounded-full"
      >
        <PriorityRing
          priority={subtask.priority}
          completed={subtask.done}
          size={15}
        />
      </button>
      {editing ? (
        <RenameField subtask={subtask} onDone={() => setEditing(false)} />
      ) : (
        <button
          type="button"
          aria-label={fr.panelBis.openSubtask(subtask.text)}
          onClick={() => openTask(subtask.id)}
          className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span
            title={subtask.text}
            className={`truncate text-[14px] ${
              subtask.done ? "text-text-3 line-through" : "text-text"
            }`}
          >
            {subtask.text}
          </span>
          {!subtask.done && <StateDot ring={subtask.ring} agent={agent} />}
          {due && (
            <span
              title={fr.panelBis.subtaskDue(due)}
              className={`ml-auto shrink-0 text-[12px] ${
                overdue ? "text-due-overdue" : "text-text-2"
              }`}
            >
              {due}
            </span>
          )}
        </button>
      )}
      {!editing && (
        <IconButton
          label={`${fr.panelBis.renameSubtask} · ${subtask.text}`}
          size={24}
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => setEditing(true)}
        >
          <Pencil size={13} aria-hidden />
        </IconButton>
      )}
      <IconButton
        label={`${fr.panel.deleteSubtask} · ${subtask.text}`}
        size={24}
        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        onClick={() => void deleteSubtask(subtask)}
      >
        <X size={14} aria-hidden />
      </IconButton>
    </li>
  );
}

function AddSubtask({
  taskId,
  startOpen = false,
}: {
  taskId: string;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const [text, setText] = useState("");

  const add = async () => {
    if (text.trim().length === 0) return;
    const created = await run(
      commands.addSubtask({ taskId, text: text.trim() }),
    );
    if (created) setText("");
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 items-center gap-2.5 text-[14px] text-text-2 hover:text-text"
      >
        <Plus size={15} aria-hidden />
        {fr.panel.addSubtask}
      </button>
    );
  }
  return (
    <div className="flex h-8 items-center gap-2.5">
      <Plus size={15} aria-hidden className="text-text-3" />
      <input
        // biome-ignore lint/a11y/noAutofocus: opened on an explicit user action
        autoFocus
        aria-label={fr.panel.addSubtask}
        placeholder={fr.panel.subtaskPlaceholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text.trim().length === 0) setOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void add();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setText("");
            setOpen(false);
          }
        }}
        className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-text-3"
      />
    </div>
  );
}

export function Subtasks({
  taskId,
  subtasks,
  startAdding = false,
}: {
  taskId: string;
  subtasks: Subtask[];
  /** Opened from « Ajouter : Sous-tâche »: the field takes the focus. */
  startAdding?: boolean;
}) {
  const sensors = useDragSensors(4);
  const done = subtasks.filter((s) => s.done).length;

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const index = subtasks.findIndex((s) => s.id === over.id);
    if (index >= 0) {
      void run(commands.reorderSubtask({ id: String(active.id), index }));
    }
  };

  return (
    <Fold
      id="subtasks"
      title={fr.panel.subtasks}
      // A long list starts folded: its summary says enough (layout C).
      defaultOpen={subtasks.length <= SUBTASKS_OPEN_MAX}
      summary={
        subtasks.length > 0 && (
          <span
            className="flex items-center gap-2"
            title={fr.row.subtasksLabel(done, subtasks.length)}
          >
            <FoldProgress done={done} total={subtasks.length} />
            {done}/{subtasks.length}
          </span>
        )
      }
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={subtasks.map((s) => s.id)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="flex flex-col">
            {subtasks.map((s) => (
              <SubtaskItem key={s.id} subtask={s} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <AddSubtask taskId={taskId} startOpen={startAdding} />
    </Fold>
  );
}
