// The web build (IS_MOBILE forced on): Kanban, Dashboard and Portfolio.
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { fr } from "../i18n/fr";
import { openFold } from "../test/panelFolds";
import type { Phone } from "./test/helpers";

vi.mock("../lib/target", () => ({ IS_MOBILE: true }));

/** A window whose width tests set; `(min-width: N px)` queries follow it, with `change`. */
let width = 390;
const listeners = new Set<() => void>();
function setWidth(px: number) {
  width = px;
  act(() => {
    for (const l of listeners) l();
  });
}
const realMatchMedia = window.matchMedia;

let phone: Phone;
let MobileApp: typeof import("./MobileApp").default;
let ui: typeof import("../stores/ui");

beforeAll(async () => {
  window.matchMedia = (query: string): MediaQueryList => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    return {
      get matches() {
        return min ? width >= Number(min[1]) : false;
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  };
  const helpers = await import("./test/helpers");
  phone = helpers.makePhone();
  globalThis.__TODO_BACKEND__ = phone.backend;
  MobileApp = (await import("./MobileApp")).default;
  ui = await import("../stores/ui");
});

afterAll(() => {
  window.matchMedia = realMatchMedia;
});

beforeEach(() => {
  width = 390;
  listeners.clear();
  phone.backend.reset({ seed: false });
  phone.backend.board.canCreateDefaults = () => true;
  ui.resetUi();
});

async function projectWithTask(title: string) {
  const subject = await phone.backend.commands.createSubject({
    name: "Summit Events",
    color: null,
    rootPath: null,
    parentId: null,
  });
  const task = await phone.backend.commands.createTask({
    title,
    description: null,
    subjectId: subject.id,
    sectionId: null,
    dueDate: null,
    dueTime: null,
  });
  return { subjectId: subject.id, taskId: task.id };
}

/** Renders the app on a project, the drawer closed. */
async function openProject(subjectId: string) {
  act(() => {
    ui.useUi.getState().setView({ kind: "subject", subjectId });
    ui.useUi.getState().toggleSidebar(false);
  });
  render(<MobileApp backend={phone.backend} />);
  return screen.findByRole("main");
}

describe("Kanban, Dashboard and Portfolio on the web", () => {
  it("shows the List | Kanban | Dashboard | Notes tabs and the figures strip", async () => {
    const { subjectId } = await projectWithTask("Facture");
    const main = await openProject(subjectId);
    const tabs = await within(main).findByRole("tablist", {
      name: fr.board.tabs,
    });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual([fr.board.list, fr.board.board, fr.dashboard.tab, fr.notes.tab]);
    await waitFor(() =>
      expect(main.querySelector("[data-project-strip]")).not.toBeNull(),
    );
  });

  it("says the columns are coming while the first sync has not ended", async () => {
    phone.backend.board.canCreateDefaults = () => false;
    const { subjectId } = await projectWithTask("Facture");
    const main = await openProject(subjectId);
    await userEvent.click(
      await within(main).findByRole("tab", { name: fr.board.board }),
    );
    expect(await within(main).findByRole("status")).toHaveTextContent(
      fr.board.notReady,
    );
    expect(within(main).queryByText(fr.board.addColumn)).toBeNull();
  });

  it("phone: one column per screen, its names on top, « Déplacer vers… » and the long press", async () => {
    const { subjectId, taskId } = await projectWithTask("Facture");
    const main = await openProject(subjectId);
    await userEvent.click(
      await within(main).findByRole("tab", { name: fr.board.board }),
    );
    const nav = await within(main).findByRole("navigation", {
      name: fr.board.columnsNav,
    });
    const names = within(nav).getAllByRole("button");
    expect(names.map((b) => b.getAttribute("aria-label"))).toEqual([
      fr.board.columnTab("À faire", 1),
      fr.board.columnTab("En cours", 0),
      fr.board.columnTab("À valider", 0),
      fr.board.columnTab("Terminé", 0),
      null,
    ]);
    expect(names[0]).toHaveAttribute("aria-current", "true");
    expect(main.querySelector("[data-board-phone]")).toHaveClass(
      "snap-x",
      "snap-mandatory",
    );
    // A tap on a name goes to its column.
    await userEvent.click(names[1]);
    expect(names[1]).toHaveAttribute("aria-current", "true");
    expect(names[0]).not.toHaveAttribute("aria-current");

    // « Déplacer vers… » → « En cours ».
    await userEvent.click(
      within(main).getByRole("button", {
        name: fr.board.moveToLabel("Facture"),
      }),
    );
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((m) => m.textContent),
    ).toEqual(["En cours", "À valider", "Terminé"]);
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "En cours" }),
    );
    await waitFor(async () => {
      const board = await phone.backend.commands.getBoard(subjectId);
      expect(board.columns[1].cards.map((c) => c.id)).toEqual([taskId]);
    });

    const doing = (await phone.backend.commands.getBoard(subjectId)).columns[1]
      .id;
    // A long press picks the card up (the drag of the Mac, with a finger).
    const card = await waitFor(() => {
      const el = main.querySelector<HTMLElement>(
        `[data-column="${doing}"] [data-card="${taskId}"]`,
      );
      if (!el) throw new Error("card not in « En cours » yet");
      return el;
    });
    const handle = within(card).getByText("Facture");
    fireEvent.touchStart(handle, { touches: [{ clientX: 20, clientY: 20 }] });
    await waitFor(() => expect(card).toHaveClass("opacity-80"), {
      timeout: 3000,
    });
    // Snapping is off during the drag, so the edge auto-scroll moves freely.
    expect(main.querySelector("[data-board-phone]")).not.toHaveClass(
      "snap-mandatory",
    );
    fireEvent.touchEnd(handle);
    await waitFor(() => expect(card).not.toHaveClass("opacity-80"));
  });

  it("large screen: the columns side by side, no « Déplacer vers… » button", async () => {
    width = 1280;
    const { subjectId } = await projectWithTask("Facture");
    const main = await openProject(subjectId);
    await userEvent.click(
      await within(main).findByRole("tab", { name: fr.board.board }),
    );
    await within(main).findByText("Facture");
    expect(main.querySelector("[data-board-phone]")).toBeNull();
    expect(
      within(main).queryByRole("navigation", { name: fr.board.columnsNav }),
    ).toBeNull();
    expect(
      within(main).queryByRole("button", {
        name: fr.board.moveToLabel("Facture"),
      }),
    ).toBeNull();
    // No Claude on the web: no « Lancer Claude… » hint.
    expect(
      within(main).queryByText(fr.board.hint("À faire", "En cours", "claude")),
    ).toBeNull();
  });

  it("phone dashboard: figures two by two, no « attend ta réponse »", async () => {
    const { subjectId } = await projectWithTask("Facture");
    const main = await openProject(subjectId);
    await userEvent.click(
      await within(main).findByRole("tab", { name: fr.dashboard.tab }),
    );
    await within(main).findByText(fr.dashboard.blocked);
    expect(main.querySelector("[data-dashboard-figures]")).toHaveClass(
      "grid-cols-2",
    );
    expect(
      within(main).getByText(fr.dashboard.blockedHintWeb(0)),
    ).toBeInTheDocument();
    expect(within(main).queryByText(/attend.* ta réponse/)).toBeNull();
  });

  it("portfolio: from 1024 px only, re-evaluated on resize", async () => {
    await projectWithTask("Facture");
    act(() => ui.useUi.getState().setView({ kind: "all", subjectId: null }));
    render(<MobileApp backend={phone.backend} />);
    // 390 px: the sidebar is the drawer.
    act(() => ui.useUi.getState().toggleSidebar(true));
    const nav = await screen.findByRole("navigation", {
      name: fr.sidebar.navLabel,
    });
    expect(
      within(nav).queryByRole("button", { name: fr.portfolio.title }),
    ).toBeNull();
    setWidth(1200);
    const item = await within(
      await screen.findByRole("navigation", { name: fr.sidebar.navLabel }),
    ).findByRole("button", { name: fr.portfolio.title });
    await userEvent.click(item);
    expect(ui.useUi.getState().view.kind).toBe("portfolio");
    // Narrowed under 1024 px: no portfolio, back to « À faire ».
    setWidth(800);
    await waitFor(() => expect(ui.useUi.getState().view.kind).toBe("all"));
    expect(
      screen.queryByRole("button", { name: fr.portfolio.title }),
    ).toBeNull();
  });

  it("portfolio on the web: no « Sessions » column, the CSV is downloaded", async () => {
    width = 1280;
    const { taskId } = await projectWithTask("Facture");
    await phone.backend.commands.addManualTime({
      taskId,
      minutes: 30,
      note: "appel",
    });
    act(() =>
      ui.useUi.getState().setView({ kind: "portfolio", subjectId: null }),
    );
    const created: Blob[] = [];
    const clicked: string[] = [];
    const createObjectURL = vi.fn((b: Blob) => {
      created.push(b);
      return "blob:csv";
    });
    const saved = {
      createObjectURL: URL.createObjectURL,
      revokeObjectURL: URL.revokeObjectURL,
    };
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push(this.download);
      });
    try {
      render(<MobileApp backend={phone.backend} />);
      const table = await screen.findByRole("table", {
        name: fr.portfolio.table,
      });
      const headers = within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent);
      expect(headers).toContain(fr.portfolio.cols.project);
      expect(headers).not.toContain(fr.portfolio.cols.sessions);
      await userEvent.click(
        screen.getByRole("button", { name: fr.portfolio.export }),
      );
      expect(clicked).toHaveLength(1);
      expect(clicked[0]).toMatch(/^taido-temps-7j-\d{4}-\d{2}-\d{2}\.csv$/);
      const text = await created[0].text();
      expect(text).toContain(
        "Projet;Tâche;Début;Fin;Durée;Durée (min);Source;Raison d'arrêt;Note",
      );
      expect(text).toContain("Summit Events;Facture;");
      expect(text).toContain(";0:30:00;30;à la main;;appel");
      expect(
        await screen.findByText(fr.portfolio.downloaded(clicked[0])),
      ).toBeInTheDocument();
    } finally {
      click.mockRestore();
      Object.assign(URL, saved);
    }
  });

  it("chrono on the web: a Mac's running segment runs until « Arrêter »; time added and removed by hand", async () => {
    const { subjectId, taskId } = await projectWithTask("Facture");
    const started = new Date(phone.clock.t - 10 * 60_000).toISOString();
    // Pulled from a Mac where Claude works: running, no session of this device.
    phone.backend.chrono.segments.push({
      id: "seg-mac",
      taskId,
      agentSessionId: null,
      source: "auto",
      startedAt: started,
      endedAt: null,
      stopReason: null,
      note: "",
      createdAt: started,
      deletedAt: null,
    });
    const main = await openProject(subjectId);
    await within(main).findByText("Facture");
    act(() => ui.useUi.getState().openTask(taskId));
    const panel = await screen.findByRole("region", { name: fr.panel.label });
    await openFold(panel, fr.chrono.title);
    const section = await waitFor(() => {
      const el = panel.querySelector<HTMLElement>("[data-chrono-section]");
      if (!el) throw new Error("no chrono section");
      return el;
    });
    expect(section.querySelector('[data-chrono="running"]')).not.toBeNull();
    const macLine = section.querySelector('[data-segment="seg-mac"]');
    expect(macLine).not.toBeNull();
    // A running segment has only « Arrêter », no « Retirer ce temps ».
    expect(
      within(macLine as HTMLElement)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([fr.chrono.stop]);

    // By hand: 25 minutes, then removed.
    await userEvent.click(
      within(section).getByRole("button", { name: fr.chrono.addManual }),
    );
    await userEvent.type(
      within(section).getByLabelText(fr.chrono.manualMinutes),
      "25",
    );
    await userEvent.click(
      within(section).getByRole("button", { name: fr.chrono.manualAdd }),
    );
    const remove = await within(section).findByRole("button", {
      name: fr.chrono.deleteSegment,
    });
    await userEvent.click(remove);
    await waitFor(() =>
      expect(
        within(section).queryByRole("button", {
          name: fr.chrono.deleteSegment,
        }),
      ).toBeNull(),
    );
    // The Mac's segment is still running, untouched.
    const seg = phone.backend.chrono.segments.find((x) => x.id === "seg-mac");
    expect(seg?.endedAt).toBeNull();
    expect(seg?.deletedAt).toBeNull();

    // « Arrêter »: stopped by hand, now, with no reason; then removable like any other.
    await userEvent.click(
      within(macLine as HTMLElement).getByRole("button", {
        name: fr.chrono.stop,
      }),
    );
    expect(await screen.findByText(fr.chrono.stopped)).toBeInTheDocument();
    await waitFor(() =>
      expect(section.querySelector('[data-chrono="paused"]')).not.toBeNull(),
    );
    expect(seg?.endedAt).toBe(new Date(phone.clock.t).toISOString());
    expect(seg?.stopReason).toBeNull();
    const stoppedLine = section.querySelector(
      '[data-segment="seg-mac"]',
    ) as HTMLElement;
    expect(
      within(stoppedLine).getByText(fr.chrono.event.stoppedByHand),
    ).toBeInTheDocument();
    await userEvent.click(
      within(stoppedLine).getByRole("button", {
        name: fr.chrono.deleteSegment,
      }),
    );
    await waitFor(() => expect(seg?.deletedAt).not.toBeNull());
  });
});
