import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToasts } from "../../components/Toast";
import { commands, mockBackend } from "../../lib/ipc";
import { resetUi, useUi } from "../../stores/ui";
import { useDebouncedSave } from "../task-panel/debouncedSave";
import {
  COMPLETION_COLLAPSE_MS,
  COMPLETION_HOLD_MS,
  completeFromRow,
  deleteTask,
  fileMenuItems,
  setCompleted,
  useCompletion,
} from "./actions";

function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

const newTask = (title: string) =>
  backend().commands.createTask({
    title,
    description: null,
    subjectId: null,
    sectionId: null,
    dueDate: null,
    dueTime: null,
  });

describe("task row actions", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
    useToasts.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("checking from the keyboard during the pointer animation checks only once", async () => {
    const task = await newTask("Relancer");
    const spy = vi.spyOn(commands, "setTaskCompleted");
    vi.useFakeTimers();
    completeFromRow(task.id);
    expect(useCompletion.getState().phases[task.id]).toBe("checking");
    await setCompleted(task.id, true);
    expect(useCompletion.getState().phases[task.id]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(
      COMPLETION_HOLD_MS + COMPLETION_COLLAPSE_MS + 100,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(
      useToasts.getState().toasts.filter((t) => t.message === "Tâche terminée"),
    ).toHaveLength(1);
  });

  it("deleting from a row saves pending panel edits first", async () => {
    const task = await newTask("Relancer");
    useUi.getState().openTask(task.id);
    const order: string[] = [];
    const update = commands.updateTask;
    const remove = commands.deleteTask;
    vi.spyOn(commands, "updateTask").mockImplementation(async (input) => {
      order.push("update");
      return update(input);
    });
    vi.spyOn(commands, "deleteTask").mockImplementation(async (id) => {
      order.push("delete");
      return remove(id);
    });
    const { result } = renderHook(() =>
      useDebouncedSave((value) => {
        void commands.updateTask({
          id: task.id,
          title: value,
          description: null,
        });
      }),
    );
    result.current.schedule("Relancer la DSI");
    await deleteTask(task.id, task.title);
    expect(order).toEqual(["update", "delete"]);
  });
});

describe("« Ranger dans… » menu", () => {
  it("names a sub-project with its parent", () => {
    const items = fileMenuItems({ id: "t", title: "Relancer" }, [
      { id: "globex", name: "Globex", parentId: null },
      { id: "globex-admin", name: "Admin", parentId: "globex" },
      { id: "perso", name: "Perso", parentId: null },
      { id: "perso-admin", name: "Admin", parentId: "perso" },
    ]);
    expect(items.map((i) => ("label" in i ? i.label : null))).toEqual([
      "Globex",
      "Globex › Admin",
      "Perso",
      "Perso › Admin",
    ]);
  });
});
