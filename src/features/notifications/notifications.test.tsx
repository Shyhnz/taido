import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../../App";
import { resetUi, useUi } from "../../stores/ui";
import { createFakeXterm, resetFakeTerms } from "../terminals/fakeXterm";
import { resetRegistry, setXtermFactory } from "../terminals/registry";
import { setTerminalList } from "../terminals/terminalList";
import { backend, openRaw, taskWithFolder } from "../terminals/testSupport";

describe("notifications", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
    resetFakeTerms();
    setXtermFactory(createFakeXterm);
    setTerminalList([]);
  });
  afterEach(() => {
    resetRegistry();
    setXtermFactory(null);
  });

  it("tells the core which task is open", async () => {
    const task = await taskWithFolder();
    render(<App />);
    await waitFor(() => expect(backend().openTaskId).toBeNull());

    act(() => useUi.getState().openTask(task.id));
    await waitFor(() => expect(backend().openTaskId).toBe(task.id));

    act(() => useUi.getState().openTask(null));
    await waitFor(() => expect(backend().openTaskId).toBeNull());
  });

  it("a click opens the task on the terminal of the session", async () => {
    const task = await taskWithFolder();
    const claude = await openRaw(task.id, "agent");
    // The shell is the last tab: the one the panel would show by default.
    await openRaw(task.id, "shell");
    render(<App />);
    expect(
      screen.queryByRole("region", { name: "Panneau de la tâche" }),
    ).toBeNull();

    await act(() =>
      backend().events.notificationOpened.emit({
        taskId: task.id,
        terminalId: claude.id,
      }),
    );
    const panel = await screen.findByRole("region", {
      name: "Panneau de la tâche",
    });
    expect(useUi.getState().openTaskId).toBe(task.id);
    expect(
      await within(panel).findByRole("tab", { name: "Claude Code" }),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("without a known terminal, a click opens the task", async () => {
    const task = await taskWithFolder();
    render(<App />);

    await act(() =>
      backend().events.notificationOpened.emit({
        taskId: task.id,
        terminalId: null,
      }),
    );
    expect(
      await screen.findByRole("region", { name: "Panneau de la tâche" }),
    ).toBeInTheDocument();
    expect(useUi.getState().openTaskId).toBe(task.id);
  });
});
