/**
 * In the lists: « Claude attend » at the top of Today, the red
 * counter of « Aujourd'hui », the state dot of the project, all following the sessions live.
 */

import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { todayString } from "../../lib/dates";
import { commands } from "../../lib/ipc";
import { resetUi } from "../../stores/ui";
import { createFakeXterm, resetFakeTerms } from "../terminals/fakeXterm";
import { resetRegistry, setXtermFactory } from "../terminals/registry";
import { setTerminalList } from "../terminals/terminalList";
import {
  backend,
  openRaw,
  taskWithFolder,
  taskWithoutFolder,
} from "../terminals/testSupport";
import { resetList } from "./listStore";

const main = () => screen.getByRole("main");
const nav = () => screen.getByRole("navigation");

const type = (terminalId: string, data: string) =>
  act(() => commands.writeTerminal({ terminalId, data }));

describe("Claude attend", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
    resetList();
    resetFakeTerms();
    setXtermFactory(createFakeXterm);
    setTerminalList([]);
  });
  afterEach(() => {
    backend().reset();
    resetRegistry();
    setXtermFactory(null);
    vi.restoreAllMocks();
  });

  it("puts waiting tasks first in Today, with the counter and the project dot", async () => {
    const quiet = await taskWithoutFolder("Tâche calme");
    await commands.setTaskDue({
      id: quiet.id,
      date: todayString(),
      time: null,
    });
    const waiting = await taskWithFolder("Optimiser le job d'import");
    const term = await openRaw(waiting.id, "agent");
    render(<App />);
    // A session at work brings its task into Today, in the rest of the day.
    await within(main()).findByText("Optimiser le job d'import");
    expect(
      within(main()).queryByRole("region", { name: "Claude attend" }),
    ).toBeNull();

    await type(term.id, "/p\r");
    const group = await within(main()).findByRole("region", {
      name: "Claude attend",
    });
    expect(
      within(group).getByText("Optimiser le job d'import"),
    ).toBeInTheDocument();
    expect(within(group).getByText("Claude attend ta réponse")).toHaveAttribute(
      "data-tone",
      "waiting",
    );
    // The checkbox is plain, Claude's state is the red dot after the title.
    expect(
      within(group).getByRole("button", { name: "Terminer" }),
    ).toBeInTheDocument();
    expect(
      within(group).getByRole("img", { name: "Claude attend ta réponse" }),
    ).toHaveAttribute("data-state-dot", "waiting");
    expect(within(group).queryByText("Tâche calme")).toBeNull();
    // Red counter on « Aujourd'hui », red dot on the project.
    const today = within(nav()).getByRole("button", { name: /Aujourd'hui/ });
    expect(today).toHaveTextContent("1 tâche où Claude attend");
    expect(
      within(nav()).getByRole("button", { name: /^Globex/ }),
    ).toHaveTextContent("Claude attend ta réponse");

    // Done stays in the group (green), without the red counter.
    await type(term.id, "/q\r");
    // A question reads like any wait: only the state.
    await within(group).findByText("Claude attend ta réponse");
    await act(() => commands.interruptAgent(term.agentSessionId ?? ""));
    await waitFor(() =>
      expect(
        within(main()).queryByRole("region", { name: "Claude attend" }),
      ).toBeNull(),
    );
    expect(
      within(nav()).getByRole("button", { name: /Aujourd'hui/ }),
    ).not.toHaveTextContent("Claude attend");
  });

  it("shows errors and Done in the group, black and green", async () => {
    const failing = await taskWithFolder("Tâche en erreur");
    const term = await openRaw(failing.id, "agent");
    await commands.writeTerminal({ terminalId: term.id, data: "/e\r" });
    render(<App />);
    const group = await within(main()).findByRole("region", {
      name: "Claude attend",
    });
    expect(within(group).getByText("Limite d'usage atteinte")).toHaveAttribute(
      "data-tone",
      "primary",
    );
    expect(
      within(nav()).getByRole("button", { name: /^Globex/ }),
    ).toHaveTextContent("Erreur");
    expect(
      within(nav()).getByRole("button", { name: /Aujourd'hui/ }),
    ).not.toHaveTextContent("Claude attend");
  });
});
