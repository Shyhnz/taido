// The phone build: IS_MOBILE (hence the mobile feature flags) forced on.
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fr } from "../i18n/fr";
import type { Phone } from "./test/helpers";

vi.mock("../lib/target", () => ({ IS_MOBILE: true }));

/**
 * A finger held on `el` until the drag starts (long-press delay: 300 ms, DndProvider):
 * `lifted` is polled, never a fixed wait, so a slow machine only takes longer.
 */
async function longPress(el: Element, lifted: () => boolean) {
  fireEvent.touchStart(el, { touches: [{ clientX: 20, clientY: 20 }] });
  await waitFor(() => expect(lifted()).toBe(true), { timeout: 3000 });
}

/** Resolves on the next `popstate` (`history.go` delivers it a few tasks later). */
function nextPopState(): Promise<void> {
  return new Promise((resolve) =>
    window.addEventListener("popstate", () => resolve(), { once: true }),
  );
}

let phone: Phone;
let MobileApp: typeof import("./MobileApp").default;
let ui: typeof import("../stores/ui");
let features: typeof import("../lib/features").features;

beforeAll(async () => {
  const helpers = await import("./test/helpers");
  phone = helpers.makePhone();
  globalThis.__TODO_BACKEND__ = phone.backend;
  MobileApp = (await import("./MobileApp")).default;
  ui = await import("../stores/ui");
  features = (await import("../lib/features")).features;
});

describe("MobileShell on the phone build", () => {
  it("uses the mobile flags", () => {
    expect(features).toMatchObject({
      terminals: false,
      journal: false,
      dragAndDrop: true,
      touchDrag: true,
      folders: false,
      shortcuts: false,
      search: true,
    });
  });

  it("shows the task as a full-screen sheet with « Retour », without journal, mouse grips kept", async () => {
    ui.resetUi();
    const t = await phone.backend.commands.createTask({
      title: "Acheter du pain",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    await phone.backend.commands.addSubtask({ taskId: t.id, text: "Baguette" });
    act(() => ui.useUi.getState().setView({ kind: "inbox", subjectId: null }));
    render(<MobileApp backend={phone.backend} />);
    expect(await screen.findByText("Acheter du pain")).toBeInTheDocument();
    // Same drag as the Mac with a mouse (grips; hidden by CSS on a touch screen).
    expect(
      screen.getByRole("button", { name: new RegExp(fr.row.dragHandle) }),
    ).toHaveClass("drag-grip");
    act(() => ui.useUi.getState().openTask(t.id));
    const panel = await screen.findByRole("region", { name: fr.panel.label });
    expect(
      within(panel).getByRole("button", { name: fr.mobile.back }),
    ).toBeInTheDocument();
    expect(within(panel).queryByText(fr.panel.journal)).toBeNull();
    // The list is hidden behind the sheet; « Retour » closes it. Both things that closing
    // leaves queued happen here, not in the next test: the `history.go` of the sheet's entry
    // (its popstate) and, one frame later, the focus back on the task's row.
    const popped = nextPopState();
    await userEvent.click(
      within(panel).getByRole("button", { name: fr.mobile.back }),
    );
    expect(ui.useUi.getState().openTaskId).toBeNull();
    await act(() => popped);
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute("data-row-focus", t.id),
    );
  });

  it("keeps the long press for dragging: no menu from a finger, a right click still opens it", async () => {
    ui.resetUi();
    await phone.backend.commands.createTask({
      title: "Ranger le garage",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    act(() => ui.useUi.getState().setView({ kind: "inbox", subjectId: null }));
    render(<MobileApp backend={phone.backend} />);
    const title = await screen.findByText("Ranger le garage");
    fireEvent.touchStart(title, { touches: [{ clientX: 20, clientY: 20 }] });
    expect(fireEvent.contextMenu(title)).toBe(false);
    fireEvent.touchEnd(title);
    expect(screen.queryByRole("menu")).toBeNull();
    // A mouse right click, long after any touch: the row's menu, as on the Mac.
    const later = vi
      .spyOn(performance, "now")
      .mockReturnValue(performance.now() + 10_000);
    try {
      fireEvent.contextMenu(title);
    } finally {
      later.mockRestore();
    }
    const menu = await screen.findByRole("menu");
    // Escape is the menu's own key: it needs the focus inside first.
    await waitFor(() =>
      expect(menu).toContainElement(document.activeElement as HTMLElement),
    );
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("picks « À faire » rows, group headers and the drawer's projects up on a long press", async () => {
    ui.resetUi();
    phone.backend.reset({ seed: false });
    const globex = await phone.backend.commands.createSubject({
      name: "Globex",
      color: null,
      rootPath: null,
      parentId: null,
    });
    for (const [title, subjectId] of [
      ["Facture", globex.id],
      ["Raycast", null],
    ] as const) {
      await phone.backend.commands.createTask({
        title,
        description: null,
        subjectId,
        sectionId: null,
        dueDate: null,
        dueTime: null,
      });
    }
    // The drawer starts closed (resetUi opens the sidebar): the rows below are not covered,
    // and the drawer is opened by its button further down, no history entry popped.
    act(() => {
      ui.useUi.getState().setView({ kind: "all", subjectId: null });
      ui.useUi.getState().toggleSidebar(false);
    });
    render(<MobileApp backend={phone.backend} />);
    const main = await screen.findByRole("main");
    await within(main).findByText("Facture");
    expect(
      screen.queryByRole("dialog", { name: fr.sidebar.navLabel }),
    ).toBeNull();
    const group = main.querySelector<HTMLElement>(
      `[data-group="project:${globex.id}"]`,
    );
    const header = group?.querySelector("header");
    if (!group || !header) throw new Error("no Globex group header");
    // The header keeps the long press for dragging: no native menu.
    fireEvent.touchStart(header, { touches: [{ clientX: 20, clientY: 20 }] });
    expect(fireEvent.contextMenu(header)).toBe(false);
    fireEvent.touchEnd(header);

    await longPress(header, () => group.classList.contains("opacity-60"));
    fireEvent.touchEnd(header);
    await waitFor(() => expect(group).not.toHaveClass("opacity-60"));

    const row = within(main).getByText("Facture");
    await longPress(row, () => row.closest(".opacity-40") !== null);
    fireEvent.touchEnd(row);
    await waitFor(() => expect(row.closest(".opacity-40")).toBeNull());

    // The drawer's projects and « Sans projet » move like on the Mac's sidebar. dnd-kit
    // swallows clicks until 50 ms after a drag ends: the menu button waits past that.
    await act(() => new Promise((resolve) => setTimeout(resolve, 80)));
    await userEvent.click(screen.getByRole("button", { name: fr.mobile.menu }));
    const drawer = await screen.findByRole("dialog", {
      name: fr.sidebar.navLabel,
    });
    for (const name of [/^Globex/, /^Sans projet/]) {
      const line = await within(drawer).findByRole("button", { name });
      await longPress(line, () => drawer.querySelector(".opacity-60") !== null);
      fireEvent.touchEnd(line);
      await waitFor(() =>
        expect(drawer.querySelector(".opacity-60")).toBeNull(),
      );
    }
    // dnd-kit swallows clicks until 50 ms after a drag ends.
    await act(() => new Promise((resolve) => setTimeout(resolve, 80)));
  });

  it("Réglages puts its tabs on top and speaks of the phone", async () => {
    ui.resetUi();
    render(<MobileApp backend={phone.backend} />);
    act(() =>
      ui.useUi.getState().openDialog({ type: "settings", tab: "sync" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: fr.settings.title,
    });
    const tabs = within(dialog).getByRole("tablist");
    expect(tabs).toHaveAttribute("aria-orientation", "horizontal");
    expect(
      await within(dialog).findByText(fr.sync.introMobile),
    ).toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole("tab", { name: fr.settings.tabs.theme }),
    );
    expect(
      within(dialog).getByText(fr.settings.themeHelpMobile),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(fr.settings.syncThemeHelpMobile),
    ).toBeInTheDocument();
    // Arrow keys follow the horizontal tabs.
    await userEvent.keyboard("{ArrowRight}");
    expect(
      within(dialog).getByRole("tab", {
        name: fr.settings.tabs.sync,
        selected: true,
      }),
    ).toBeInTheDocument();
  });
});
