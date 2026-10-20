/**
 * Files dragged from the Finder. Tauri intercepts native drops (`dragDropEnabled`, on by
 * default) and reports them with their paths and position, which the HTML drop event cannot
 * give.
 *
 * Dropped on a task (its row, its kanban card, or the « Pièces jointes » zone of
 * its panel), the files become its attachments. Elsewhere, on a terminal (Claude Code or
 * shell), their paths are typed at the prompt.
 *
 * Plan task 8 (notebook): dropped on an open page's text, images go into the page there.
 */

import type { DragDropEvent } from "@tauri-apps/api/webview";
import { showToast } from "../../components/Toast";
import { t } from "../../i18n";
import { commands } from "../../lib/ipc";
import { OS } from "../../lib/platform";
import { run } from "../../lib/run";
import { noteDropAt } from "../notes/editor/noteDrop";
import { formatDroppedPaths } from "./droppedPaths";
import { markDropTarget, pasteIntoTerminal, terminalAt } from "./registry";

/**
 * The drop position in CSS pixels. Tauri types it as physical pixels, but on macOS wry 0.57
 * reports `draggingLocation` in points (= CSS pixels), wrapped as is in a `PhysicalPosition`
 * (tauri-runtime-wry 2.12.1): dividing by the Retina scale put drops at half the distance
 * from the top-left corner (2026-10-09). Elsewhere (WebView2) it is physical pixels.
 */
export function cssPoint(
  position: { x: number; y: number },
  mac = OS === "mac",
): [number, number] {
  const scale = mac ? 1 : window.devicePixelRatio || 1;
  return [position.x / scale, position.y / scale];
}

/** The task element under the point: an attachments zone, a row or a kanban card. */
function taskTarget(
  x: number,
  y: number,
): { id: string; el: HTMLElement } | null {
  const hit = document.elementFromPoint?.(x, y);
  const zone = hit?.closest<HTMLElement>("[data-attach-task]");
  if (zone?.dataset.attachTask)
    return { id: zone.dataset.attachTask, el: zone };
  const row = hit?.closest<HTMLElement>("[data-task-id]");
  if (row?.dataset.taskId) return { id: row.dataset.taskId, el: row };
  const card = hit?.closest<HTMLElement>("[data-card]");
  if (card?.dataset.card) return { id: card.dataset.card, el: card };
  return null;
}

let marked: HTMLElement | null = null;

function markTask(el: HTMLElement | null): void {
  if (marked === el) return;
  if (marked) delete marked.dataset.fileOver;
  marked = el;
  if (el) el.dataset.fileOver = "";
}

async function attach(taskId: string, paths: string[]) {
  const detail = await run(commands.addAttachments({ taskId, paths }));
  if (detail) {
    showToast({ message: t.attachments.added(paths.length, detail.title) });
  }
}

export function handleDragDrop(event: DragDropEvent): void {
  switch (event.type) {
    case "enter":
    case "over": {
      const [x, y] = cssPoint(event.position);
      const target = noteDropAt(x, y) ?? taskTarget(x, y);
      markTask(target?.el ?? null);
      markDropTarget(target ? null : terminalAt(x, y));
      return;
    }
    case "drop": {
      const [x, y] = cssPoint(event.position);
      markTask(null);
      markDropTarget(null);
      const page = noteDropAt(x, y);
      if (page) {
        page.drop(event.paths);
        return;
      }
      const task = taskTarget(x, y);
      if (task) {
        void attach(task.id, event.paths);
        return;
      }
      const id = terminalAt(x, y);
      if (id) pasteIntoTerminal(id, formatDroppedPaths(event.paths));
      return;
    }
    case "leave":
      markTask(null);
      markDropTarget(null);
  }
}
