import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";
import { fr } from "../i18n/fr";
import type { MobileBackend } from "./backend";
import type { Phone } from "./test/helpers";

// The app reads its backend from the seam when src/lib/ipc.ts loads: set it first.
let phone: Phone;
let MobileApp: typeof import("./MobileApp").default;
let helpers: typeof import("./test/helpers");
let ui: typeof import("../stores/ui");

beforeAll(async () => {
  helpers = await import("./test/helpers");
  phone = helpers.makePhone();
  globalThis.__TODO_BACKEND__ = phone.backend;
  MobileApp = (await import("./MobileApp")).default;
  ui = await import("../stores/ui");
});

const addTasks = async (backend: MobileBackend, n: number) => {
  for (let i = 0; i < n; i += 1) {
    await backend.commands.createTask({
      title: `Tâche ${i}`,
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
  }
};

describe("MobileShell", () => {
  it("asks to link first, and opens Réglages on « Synchro »", async () => {
    ui.resetUi();
    render(<MobileApp backend={phone.backend} />);
    expect(await screen.findByText(fr.mobile.linkFirst)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: fr.sync.link }));
    expect(ui.useUi.getState().dialog).toEqual({
      type: "settings",
      tab: "sync",
    });
  });

  it("« Créer un projet » on the first launch opens the drawer on the project input", async () => {
    ui.resetUi();
    render(<MobileApp backend={phone.backend} />);
    await userEvent.click(
      await screen.findByRole("button", { name: fr.views.firstLaunch.action }),
    );
    const drawer = await screen.findByRole("dialog", {
      name: fr.sidebar.navLabel,
    });
    expect(drawer.querySelector("input")).not.toBeNull();
    expect(drawer.contains(document.activeElement)).toBe(true);
  });

  it("opens with the sidebar, keeps it on a view change, and folds it from the menu (remembered)", async () => {
    ui.resetUi();
    render(<MobileApp backend={phone.backend} />);
    const nav = () =>
      screen.queryByRole("dialog", { name: fr.sidebar.navLabel });
    expect(nav()).toBeInTheDocument();
    act(() =>
      ui.useUi.getState().setView({ kind: "upcoming", subjectId: null }),
    );
    expect(nav()).toBeInTheDocument();
    expect(screen.getAllByText(fr.upcoming.title).length).toBeGreaterThan(0);
    const menu = screen.getByRole("button", { name: fr.mobile.menu });
    expect(menu).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(menu);
    await waitFor(() => expect(nav()).toBeNull());
    expect(window.localStorage.getItem(ui.SIDEBAR_KEY)).toBe("false");
    await userEvent.click(menu);
    expect(nav()).toBeInTheDocument();
    expect(window.localStorage.getItem(ui.SIDEBAR_KEY)).toBe("true");
  });

  it("a wide screen has no top bar and shows the sidebar as a column", async () => {
    ui.resetUi();
    const real = window.matchMedia;
    window.matchMedia = (query: string) =>
      ({
        ...real(query),
        matches: query.includes("min-width"),
      }) as MediaQueryList;
    try {
      render(<MobileApp backend={phone.backend} />);
      expect(screen.queryByRole("button", { name: fr.mobile.menu })).toBeNull();
      expect(
        screen.queryByRole("dialog", { name: fr.sidebar.navLabel }),
      ).toBeNull();
      expect(
        screen.getByRole("navigation", { name: fr.sidebar.navLabel }),
      ).toBeInTheDocument();
      await userEvent.click(
        screen.getByRole("button", { name: fr.sidebar.collapse }),
      );
      expect(
        screen.queryByRole("navigation", { name: fr.sidebar.navLabel }),
      ).toBeNull();
      await userEvent.click(
        screen.getByRole("button", { name: fr.sidebar.expand }),
      );
      expect(
        screen.getByRole("navigation", { name: fr.sidebar.navLabel }),
      ).toBeInTheDocument();
    } finally {
      window.matchMedia = real;
    }
  });

  it("the sidebar's own button folds it", async () => {
    ui.resetUi();
    render(<MobileApp backend={phone.backend} />);
    await userEvent.click(
      screen.getByRole("button", { name: fr.sidebar.collapse }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: fr.sidebar.navLabel }),
      ).toBeNull(),
    );
  });

  it("opens the quick add from the floating button", async () => {
    ui.resetUi();
    render(<MobileApp backend={phone.backend} />);
    await userEvent.click(
      screen.getByRole("button", { name: fr.sidebar.newTask }),
    );
    expect(ui.useUi.getState().dialog?.type).toBe("addTask");
  });

  it("shows held deletions and puts the rows back", async () => {
    ui.resetUi();
    await addTasks(phone.backend, 30);
    render(<MobileApp backend={phone.backend} />);
    act(() => {
      phone.backend.state.tasks = [];
      phone.backend.emitDataChanged(["tasks"]);
    });
    expect(
      await screen.findByText(fr.mobile.deletionsHeld(30)),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: fr.mobile.deletionsHeldRestore }),
    );
    expect(phone.backend.state.tasks).toHaveLength(30);
    await waitFor(() =>
      expect(screen.queryByText(fr.mobile.deletionsHeld(30))).toBeNull(),
    );
  });

  it("shows the offline banner and the sync button once linked", async () => {
    ui.resetUi();
    render(<MobileApp backend={phone.backend} />);
    await act(() => helpers.link(phone));
    phone.server.offline = true;
    await act(() => phone.backend.engine.syncNow());
    expect(
      await screen.findByText(fr.mobile.offlineBanner),
    ).toBeInTheDocument();
    expect(screen.queryByText(fr.mobile.linkFirst)).toBeNull();
    expect(
      screen.getAllByRole("button", { name: /^Synchroniser · Hors connexion/ })
        .length,
    ).toBeGreaterThan(0);
    phone.server.offline = false;
  });

  it("the Android back button closes the dialog, then the task, then the drawer", async () => {
    ui.resetUi();
    const t = await phone.backend.commands.createTask({
      title: "Retour",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    render(<MobileApp backend={phone.backend} />);
    const back = () =>
      act(() => {
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
    // The sidebar is open at launch.
    expect(
      screen.getByRole("dialog", { name: fr.sidebar.navLabel }),
    ).toBeInTheDocument();
    back();
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: fr.sidebar.navLabel }),
      ).toBeNull(),
    );
    act(() => ui.useUi.getState().openTask(t.id));
    act(() =>
      ui.useUi.getState().openDialog({ type: "settings", tab: "sync" }),
    );
    back();
    expect(ui.useUi.getState().dialog).toBeNull();
    expect(ui.useUi.getState().openTaskId).toBe(t.id);
    back();
    expect(ui.useUi.getState().openTaskId).toBeNull();
    // Nothing open: « back » is left to the browser.
    back();
    expect(ui.useUi.getState().openTaskId).toBeNull();
  });
});
