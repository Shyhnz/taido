// The main screens in English: a first launch on an English system shows no French.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frenchIn } from "./test/french";

/** Lines of the page that give French away. */
function frenchOnPage(): string[] {
  const found: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ALL);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const texts: string[] = [];
    if (node.nodeType === Node.TEXT_NODE) texts.push(node.textContent ?? "");
    if (node instanceof Element) {
      for (const name of ["aria-label", "title", "placeholder"]) {
        const value = node.getAttribute(name);
        if (value) texts.push(value);
      }
    }
    for (const text of texts) {
      // The language select names French in French, on purpose.
      if (text === "Français") continue;
      if (frenchIn(` ${text} `)) found.push(text);
    }
  }
  return [...new Set(found)];
}

/** App, Testing Library and the mock backend, loaded again so that they read English. */
async function loadEnglish() {
  window.localStorage.setItem("taido.language", "en");
  vi.resetModules();
  const [{ default: App }, rtl, { default: userEvent }, ipc, react] =
    await Promise.all([
      import("./App"),
      import("@testing-library/react"),
      import("@testing-library/user-event"),
      import("./lib/ipc"),
      import("react"),
    ]);
  return { App, rtl, userEvent, ipc, react };
}

let cleanup: () => void = () => {};

describe("App in English", () => {
  beforeEach(() => {
    window.localStorage.removeItem("taido.sidebar");
  });
  afterEach(() => {
    cleanup();
    window.localStorage.setItem("taido.language", "fr");
    vi.resetModules();
  });

  it("first launch: the sidebar and the empty screen are in English", async () => {
    const { App, rtl, ipc, react } = await loadEnglish();
    cleanup = rtl.cleanup;
    ipc.mockBackend?.reset({ seed: false });
    rtl.render(react.createElement(App));
    const nav = await rtl.screen.findByRole("navigation", {
      name: "Navigation",
    });
    for (const name of ["Today", "Upcoming"]) {
      expect(rtl.within(nav).getAllByText(name).length).toBeGreaterThan(0);
    }
    expect(
      await rtl.screen.findByRole("heading", {
        level: 1,
        name: "Start with a project",
      }),
    ).toBeInTheDocument();
    expect(frenchOnPage()).toEqual([]);
    expect(frenchIn(document.body.textContent ?? "")).toBeNull();
  });

  it("Inbox, Today, a project, its task panel, Upcoming, quick add and settings are in English", async () => {
    const { App, rtl, userEvent, ipc, react } = await loadEnglish();
    cleanup = rtl.cleanup;
    ipc.mockBackend?.reset({ seed: false });
    const project = await ipc.commands.createSubject({
      name: "Acme",
      color: null,
      rootPath: null,
      parentId: null,
    });
    const today = new Date();
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    await ipc.commands.createTask({
      title: "Call Bob",
      description: "About the invoice",
      subjectId: project.id,
      sectionId: null,
      dueDate: ymd,
      dueTime: null,
    });
    await ipc.commands.createTask({
      title: "Buy milk",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    const user = userEvent.setup();
    rtl.render(react.createElement(App));
    const { screen, within } = rtl;

    // The sidebar, Inbox included now that it holds a task.
    const nav = await screen.findByRole("navigation", { name: "Navigation" });
    for (const name of ["Inbox", "Today", "Upcoming"]) {
      expect((await within(nav).findAllByText(name)).length).toBeGreaterThan(0);
    }

    // Inbox.
    await user.click(within(nav).getAllByText("Inbox")[0]);
    expect(await screen.findByText("Buy milk")).toBeInTheDocument();
    expect(frenchOnPage()).toEqual([]);

    // Today.
    await user.click(within(nav).getAllByText("Today")[0]);
    expect(await screen.findByText("Call Bob")).toBeInTheDocument();
    expect(frenchOnPage()).toEqual([]);

    // The project.
    await user.click(within(nav).getByText("Acme"));
    expect(
      await screen.findByRole("heading", { level: 1, name: /Acme/ }),
    ).toBeInTheDocument();
    expect(frenchOnPage()).toEqual([]);

    // The task panel.
    await user.click(await screen.findByRole("button", { name: "Call Bob" }));
    expect(
      await screen.findByRole("region", { name: "Task panel" }),
    ).toBeInTheDocument();
    expect(frenchOnPage()).toEqual([]);
    await user.keyboard("{Escape}");

    // Upcoming.
    await user.click(within(nav).getByText("Upcoming"));
    expect(
      await screen.findByRole("heading", { level: 1, name: /Upcoming/ }),
    ).toBeInTheDocument();
    expect(frenchOnPage()).toEqual([]);

    // Quick add.
    await user.click(screen.getByRole("button", { name: /New task/ }));
    const field = await screen.findByLabelText("Task name");
    await user.type(field, "Pay rent tomorrow #Acme");
    expect(frenchOnPage()).toEqual([]);
    await user.keyboard("{Escape}");

    // Settings, every tab.
    await user.click(screen.getByRole("button", { name: /Settings/ }));
    const dialog = await screen.findByRole("dialog");
    const tabs = within(dialog).getAllByRole("tab");
    expect(tabs.length).toBeGreaterThan(2);
    for (const tab of tabs) {
      await user.click(tab);
      expect(frenchOnPage()).toEqual([]);
    }
  });
});
