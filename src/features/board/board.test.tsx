/**
 * Kanban (Taido V2.2) and chrono (V2.1) on the mock backend. Product decision (2026-10-09): the columns
 * are the progress of the tasks (« À faire · En cours · À valider · Terminé », renamable);
 * Claude's state shows on the cards. Launching Claude moves a task « À faire » to « En cours »,
 * once; the chrono runs while Claude works and pauses while it waits.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Board, BoardColumn } from "../../bindings";
import { commands } from "../../lib/ipc";
import { createQueryClient } from "../../lib/queries";
import { resetUi } from "../../stores/ui";
import { setTerminalList } from "../terminals/terminalList";
import { backend, openRaw, taskWithFolder } from "../terminals/testSupport";
import { BoardView, dropAction } from "./BoardView";

const titles = (board: Board, index: number) =>
  board.columns[index].cards.map((c) => c.title);

const type = (terminalId: string, data: string) =>
  commands.writeTerminal({ terminalId, data });

const column = (id: string, isDone = false): BoardColumn => ({
  id,
  name: id,
  isDone,
  cards: [],
  total: 0,
});

describe("kanban", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
    setTerminalList([]);
  });
  afterEach(() => backend().reset());

  it("completes on the done column, moves elsewhere", () => {
    expect(dropAction(column("a"), column("b"))).toBe("move");
    expect(dropAction(column("a"), column("z", true))).toBe("complete");
    expect(dropAction(column("a"), column("a"))).toBeNull();
  });

  it("starts with the progress columns; Claude moves a task « En cours » once", async () => {
    const task = await taskWithFolder("Export PDF du planning");
    const subjectId = task.subject?.id ?? "";
    let board = await commands.getBoard(subjectId);
    expect(board.columns.map((c) => c.name)).toEqual([
      "À faire",
      "En cours",
      "À valider",
      "Terminé",
    ]);
    expect(titles(board, 0)).toEqual(["Export PDF du planning"]);

    const term = await openRaw(task.id, "agent");
    await type(term.id, "Génère l'export\r");
    board = await commands.getBoard(subjectId);
    expect(titles(board, 1)).toEqual(["Export PDF du planning"]);
    expect(board.columns[1].cards[0].ring).toBe("working");
    expect(board.columns[1].cards[0].chrono?.runningSince).not.toBeNull();

    // Claude asks a question: the card stays « En cours », the chrono pauses.
    await type(term.id, "/q\r");
    board = await commands.getBoard(subjectId);
    expect(titles(board, 1)).toEqual(["Export PDF du planning"]);
    expect(board.columns[1].cards[0].ring).toBe("waiting");
    const detail = await commands.getTask(task.id);
    expect(detail.time.chrono.runningSince).toBeNull();
    expect(detail.time.segments[0].stopReason).toBe("waiting");

    // By hand to « À valider »; the done column completes, leaving it reopens.
    await commands.moveTaskToColumn({
      taskId: task.id,
      columnId: board.columns[2].id,
    });
    board = await commands.getBoard(subjectId);
    expect(titles(board, 2)).toEqual(["Export PDF du planning"]);
    await commands.moveTaskToColumn({
      taskId: task.id,
      columnId: board.columns[3].id,
    });
    expect((await commands.getTask(task.id)).completedAt).not.toBeNull();
    await commands.moveTaskToColumn({
      taskId: task.id,
      columnId: board.columns[1].id,
    });
    expect((await commands.getTask(task.id)).completedAt).toBeNull();
  });

  it("adds, renames, moves and removes columns", async () => {
    const task = await taskWithFolder("T");
    const subjectId = task.subject?.id ?? "";
    await commands.getBoard(subjectId);
    const id = await commands.createBoardColumn({
      subjectId,
      name: "Chez le client",
    });
    await commands.renameBoardColumn({ id, name: "Envoyé" });
    await commands.moveBoardColumn({ id, index: 0 });
    let board = await commands.getBoard(subjectId);
    expect(board.columns.map((c) => c.name)).toEqual([
      "Envoyé",
      "À faire",
      "En cours",
      "À valider",
      "Terminé",
    ]);
    await commands.deleteBoardColumn(id);
    board = await commands.getBoard(subjectId);
    expect(board.columns).toHaveLength(4);
    await expect(
      commands.deleteBoardColumn(board.columns[3].id),
    ).rejects.toMatchObject({ kind: "invalid" });
  });

  it("V2.8: default columns have the core's fixed ids; a card's column is its task's synced column", async () => {
    const task = await taskWithFolder("T");
    const subjectId = task.subject?.id ?? "";
    let board = await commands.getBoard(subjectId);
    expect(board.columns.map((c) => c.id)).toEqual(
      [0, 1, 2, 3].map((i) => `col-${subjectId}-${i}`),
    );
    expect((await commands.getBoard(null)).columns[0].id).toBe("col-inbox-0");
    const rec = () => backend().state.tasks.find((t) => t.id === task.id);
    const id = await commands.createBoardColumn({ subjectId, name: "Envoyé" });
    await commands.moveTaskToColumn({ taskId: task.id, columnId: id });
    expect(rec()?.boardColumnId).toBe(id);
    board = await commands.getBoard(subjectId);
    expect(board.columns.find((c) => c.id === id)?.cards[0]?.id).toBe(task.id);
    // A column gone: its tasks fall back to no column (the first one).
    await commands.deleteBoardColumn(id);
    expect(rec()?.boardColumnId).toBeNull();
    board = await commands.getBoard(subjectId);
    expect(titles(board, 0)).toEqual(["T"]);
    // A column pulled for this task (another device moved it) is followed.
    const target = board.columns[2].id;
    const r = rec();
    if (r) r.boardColumnId = target;
    board = await commands.getBoard(subjectId);
    expect(titles(board, 2)).toEqual(["T"]);
  });

  it("shows the last three done tasks and counts the others", async () => {
    const first = await taskWithFolder("T0");
    const subjectId = first.subject?.id ?? "";
    await commands.setTaskCompleted({ id: first.id, completed: true });
    for (let i = 1; i < 5; i++) {
      const t = await commands.createTask({
        title: `T${i}`,
        description: "",
        subjectId,
        sectionId: null,
        dueDate: null,
        dueTime: null,
      });
      await commands.setTaskCompleted({ id: t.id, completed: true });
    }
    render(
      <QueryClientProvider client={createQueryClient()}>
        <BoardView subjectId={subjectId} />
      </QueryClientProvider>,
    );
    const done = await screen.findByRole("region", { name: /^Terminé, 5/ });
    expect(within(done).getAllByRole("listitem")).toHaveLength(3);
    expect(
      within(done).getByRole("button", { name: "+ 2 autres" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "En cours, 0 tâche" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ Colonne" })).toBeTruthy();
  });
});
