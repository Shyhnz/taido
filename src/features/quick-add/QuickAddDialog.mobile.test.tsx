/**
 * The quick add where there are no terminals (the phone): `>claude` and
 * `>shell` stay text, « Ajouter et lancer » never shows, the help text has no `>claude`.
 */

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { useToasts } from "../../components/Toast";
import { commands, mockBackend } from "../../lib/ipc";
import { resetUi } from "../../stores/ui";
import { openAddTaskForView } from "../views/addTarget";

vi.mock("../../lib/features", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/features")>();
  return {
    ...actual,
    features: {
      ...actual.features,
      terminals: false,
      focusMode: false,
      states: false,
      folders: false,
      journal: false,
      dragAndDrop: false,
      touchDrag: true,
      shortcuts: false,
    },
  };
});

function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

async function openQuickAdd() {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("navigation", { name: "Navigation" });
  act(() => openAddTaskForView());
  const dialog = await screen.findByRole("dialog", { name: "Nouvelle tâche" });
  const title = within(dialog).getByRole("combobox", {
    name: "Nom de la tâche",
  });
  return { user, dialog, title };
}

const marks = (dialog: HTMLElement) =>
  Array.from(
    within(dialog).getByTestId("quick-add-highlight").querySelectorAll("mark"),
  ).map((m) => [m.dataset.token, m.textContent]);

describe("quick add without terminals (the phone)", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
    useToasts.setState({ toasts: [] });
    window.localStorage.clear();
  });

  it("shows the mobile help, keeps >claude as text and never offers to launch", async () => {
    const terminal = vi.spyOn(commands, "openTerminal");
    const { user, dialog, title } = await openQuickAdd();

    expect(
      within(dialog).getByText("#projet · /section · @date · !2"),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/>claude/)).toBeNull();

    await user.type(title, "Relire >claude !2 >shell");
    expect(marks(dialog)).toEqual([["priority", "!2"]]);
    expect(
      within(dialog).queryByRole("button", {
        name: "Retirer : Claude Code, ouvert à l'ajout",
      }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: "Ajouter et lancer" }),
    ).toBeNull();
    // No keyboard hints on the buttons.
    expect(
      within(dialog).getByRole("button", { name: "Ajouter" }),
    ).not.toHaveAttribute("title", expect.stringContaining("Entrée"));

    await user.click(within(dialog).getByRole("button", { name: "Ajouter" }));
    await waitFor(() => expect(backend().state.tasks).toHaveLength(1));
    expect(backend().state.tasks[0]).toMatchObject({
      title: "Relire >claude >shell",
      priority: 3,
    });
    expect(terminal).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Nouvelle tâche" })).toBeNull();
  });
});
