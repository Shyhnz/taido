/**
 * « Relations » in the task panel: three
 * lines, « Bloque », « Bloquée par », « Liée à », each linked task clickable with its state.
 * One « + Lier une tâche » opens the menu of every task (LinkMenu.tsx, 2026-10-11).
 */

import { X } from "lucide-react";
import { useState } from "react";
import type { RelatedTask, TaskDetail } from "../../bindings";
import { t } from "../../i18n";
import { commands } from "../../lib/ipc";
import { run } from "../../lib/run";
import { useUi } from "../../stores/ui";
import { Fold } from "../task-panel/PanelFold";
import { LinkMenu } from "./LinkMenu";

function Linked({ item }: { item: RelatedTask }) {
  const openTask = useUi((s) => s.openTask);
  return (
    <li className="group/linked flex min-w-0 items-center gap-1.5">
      <button
        type="button"
        onClick={() => openTask(item.taskId)}
        title={item.title}
        className={`min-w-0 truncate text-left text-[13px] underline-offset-2 hover:underline ${
          item.completed ? "text-text-3 line-through" : "text-text"
        }`}
      >
        {item.parentTitle && (
          <span className="text-text-3">{item.parentTitle} › </span>
        )}
        {item.title}
      </button>
      <span className="shrink-0 text-[12px] text-text-3">
        {item.completed ? t.relations.done : t.relations.open}
        {" · "}
        {item.project ?? t.relations.noProject}
      </span>
      <button
        type="button"
        aria-label={t.relations.remove(item.title)}
        title={t.relations.remove(item.title)}
        onClick={() => void run(commands.deleteRelation(item.relationId))}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-3 opacity-0 hover:bg-hover hover:text-text group-hover/linked:opacity-100 focus-visible:opacity-100"
      >
        <X size={12} aria-hidden />
      </button>
    </li>
  );
}

function Line({ label, items }: { label: string; items: RelatedTask[] }) {
  return (
    <div className="flex items-start gap-3 py-1">
      <span className="w-[84px] shrink-0 pt-px text-[12.5px] text-text-2">
        {label}
      </span>
      <div className="min-w-0 flex-1">
        {items.length === 0 ? (
          <span className="text-[13px] text-text-3">{t.relations.none}</span>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {items.map((item) => (
              <Linked key={item.relationId} item={item} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function RelationsSection({
  task,
  startAdding = false,
}: {
  task: TaskDetail;
  /** Opened from « Ajouter : Lien »: the menu opens at once. */
  startAdding?: boolean;
}) {
  const [adding, setAdding] = useState(startAdding);
  const { blocks, blockedBy, related } = task.relations;
  const exclude = new Set(
    [...blocks, ...blockedBy, ...related].map((r) => r.taskId),
  );
  const pendingBlockers = blockedBy.filter((r) => !r.completed).length;
  // « bloquée par 2 · bloque 1 · liée à 3 », the blockers first and orange while pending.
  const others = [
    blocks.length > 0 && t.folds.blocks(blocks.length),
    related.length > 0 && t.folds.related(related.length),
  ].filter((part): part is string => typeof part === "string");
  return (
    <Fold
      id="relations"
      title={t.relations.title}
      summary={
        (blockedBy.length > 0 || others.length > 0) && (
          <span className="truncate">
            {blockedBy.length > 0 && (
              <span
                className={pendingBlockers > 0 ? "text-due-overdue" : undefined}
              >
                {t.folds.blockedBy(blockedBy.length)}
              </span>
            )}
            {blockedBy.length > 0 && others.length > 0 && " · "}
            {others.join(" · ")}
          </span>
        )
      }
    >
      <Line label={t.relations.blocks} items={blocks} />
      <Line label={t.relations.blockedBy} items={blockedBy} />
      <Line label={t.relations.related} items={related} />
      {adding ? (
        <LinkMenu
          task={task}
          linked={exclude}
          onClose={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-0.5 mb-1 inline-flex items-center gap-1 rounded-md py-1 text-[13px] font-medium text-accent hover:underline"
        >
          {t.relations.add}
        </button>
      )}
    </Fold>
  );
}
