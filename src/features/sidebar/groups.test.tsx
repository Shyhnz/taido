/**
 * Groups of projects in the sidebar: like Brave's tab groups. A
 * group is a colored label that folds its projects; projects are selected with ⌘-clic and
 * grouped from the right-click menu; « Dégrouper » keeps the projects.
 */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../../App";
import { useToasts } from "../../components/Toast";
import { mockBackend } from "../../lib/ipc";
import { resetUi, useUi } from "../../stores/ui";
import { useProjectSelection } from "./groupActions";
import { useProjectRename } from "./subjectActions";

function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

const nav = () => screen.getByRole("navigation", { name: "Navigation" });

const project = async (name: string) =>
  (
    await backend().commands.createSubject({
      name,
      color: "violet",
      rootPath: null,
      parentId: null,
    })
  ).id;

describe("groups in the sidebar", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
    useProjectRename.setState({ renamingId: null });
    useProjectSelection.getState().clear();
    useToasts.setState({ toasts: [] });
  });

  it("shows a group as a label that folds its projects, and never opens it", async () => {
    const peak = await project("SummitEvents");
    await backend().commands.groupProjects({
      projectIds: [peak],
      groupId: null,
      name: "Globex",
    });
    const user = userEvent.setup();
    render(<App />);
    const label = await within(nav()).findByRole("button", {
      name: "Replier le groupe « Globex »",
    });
    expect(label).toHaveAttribute("aria-expanded", "true");
    expect(
      within(nav()).getByRole("button", { name: /^SummitEvents/ }),
    ).toBeTruthy();
    const view = useUi.getState().view;
    await user.click(label);
    expect(useUi.getState().view).toEqual(view);
    await waitFor(() =>
      expect(
        within(nav()).queryByRole("button", { name: /^SummitEvents/ }),
      ).toBeNull(),
    );
    expect(
      within(nav()).getByRole("button", {
        name: "Déplier le groupe « Globex »",
      }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("groups selected projects into a new group named in place", async () => {
    await project("Acme Studio");
    await project("Globex");
    const user = userEvent.setup();
    render(<App />);
    const acme = await within(nav()).findByRole("button", {
      name: /^Acme Studio/,
    });
    const globex = within(nav()).getByRole("button", { name: /^Globex/ });
    fireEvent.click(acme, { metaKey: true });
    fireEvent.click(globex, { metaKey: true });
    expect(useProjectSelection.getState().ids).toHaveLength(2);
    fireEvent.contextMenu(globex, { clientX: 20, clientY: 20 });
    const menu = await screen.findByRole("menu", {
      name: "2 projets sélectionnés",
    });
    await user.click(
      within(menu).getByRole("menuitem", { name: /Ajouter à un groupe/ }),
    );
    const targets = await screen.findByRole("menu", {
      name: "Ajouter les 2 projets à un groupe",
    });
    await user.click(
      within(targets).getByRole("menuitem", { name: "Nouveau groupe" }),
    );
    const input = await within(nav()).findByRole("textbox", {
      name: /Nouveau groupe/,
    });
    await user.clear(input);
    await user.type(input, "Missions{Enter}");
    await within(nav()).findByRole("button", {
      name: "Replier le groupe « Missions »",
    });
    const subjects = await backend().commands.listSubjects();
    const group = subjects.find((s) => s.isGroup);
    expect(group?.name).toBe("Missions");
    expect(
      subjects.filter((s) => s.parentId === group?.id).map((s) => s.name),
    ).toEqual(["Acme Studio", "Globex"]);
    expect(useProjectSelection.getState().ids).toEqual([]);
  });

  it("dissolves a group from its menu, its projects stay", async () => {
    const peak = await project("SummitEvents");
    await backend().commands.groupProjects({
      projectIds: [peak],
      groupId: null,
      name: "Globex",
    });
    const user = userEvent.setup();
    render(<App />);
    await within(nav()).findByRole("button", {
      name: "Replier le groupe « Globex »",
    });
    await user.click(
      within(nav()).getByRole("button", {
        name: "Options du groupe « Globex »",
      }),
    );
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "Dégrouper" }));
    await waitFor(() =>
      expect(
        within(nav()).queryByRole("button", { name: /groupe « Globex »/ }),
      ).toBeNull(),
    );
    expect(
      within(nav()).getByRole("button", { name: /^SummitEvents/ }),
    ).toBeTruthy();
  });
});
