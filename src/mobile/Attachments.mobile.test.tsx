// The phone build (IS_MOBILE forced on): « Pièces jointes » on the web. Files
// come from the browser (picker, paste, drop), the Mac-only items are hidden, and « Télécharger »
// (2026-10-10) saves every file, images included: nothing is ever shown (review point 2).
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
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { fr } from "../i18n/fr";
import { openFold } from "../test/panelFolds";
import type { MemoryFileStore } from "./files";
import type { Phone } from "./test/helpers";

vi.mock("../lib/target", () => ({ IS_MOBILE: true }));

let phone: Phone;
let helpers: typeof import("./test/helpers");
let MobileApp: typeof import("./MobileApp").default;
let ui: typeof import("../stores/ui");
let toasts: typeof import("../components/Toast");

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82,
]);

beforeAll(async () => {
  helpers = await import("./test/helpers");
  phone = helpers.makePhone();
  globalThis.__TODO_BACKEND__ = phone.backend;
  MobileApp = (await import("./MobileApp")).default;
  ui = await import("../stores/ui");
  toasts = await import("../components/Toast");
});

beforeEach(async () => {
  phone.server.offline = false;
  phone.server.onFile = null;
  if (phone.backend.syncData.token !== null) {
    await phone.backend.commands.syncUnlink();
  }
  ui.resetUi();
  toasts.useToasts.setState({ toasts: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function newTask(title: string) {
  return phone.backend.commands.createTask({
    title,
    description: null,
    subjectId: null,
    sectionId: null,
    dueDate: null,
    dueTime: null,
  });
}

/** Renders the app with the task open; returns its « Pièces jointes » section. */
async function openTask(taskId: string) {
  const user = userEvent.setup();
  act(() => ui.useUi.getState().setView({ kind: "inbox", subjectId: null }));
  render(<MobileApp backend={phone.backend} />);
  act(() => ui.useUi.getState().openTask(taskId));
  const section = await openFold(
    document.body,
    fr.attachments.title,
    fr.folds.add.attachments,
  );
  return { user, section };
}

const tile = (section: HTMLElement, name: string) =>
  within(section).getByRole("button", { name: fr.attachments.menu(name) });

/** Captures object URLs, saves (anchor clicks) and window.open. */
function spyBrowser() {
  const urls = new Map<string, Blob>();
  vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
    const url = `blob:http://localhost/${urls.size + 1}`;
    urls.set(url, b as Blob);
    return url;
  });
  const revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const saves: { href: string; download: string }[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saves.push({ href: this.href, download: this.download });
  });
  const open = vi.spyOn(window, "open").mockImplementation(() => null);
  return { urls, revoked, saves, open };
}

async function downloadFromMenu(
  user: ReturnType<typeof userEvent.setup>,
  section: HTMLElement,
  name: string,
) {
  await user.click(tile(section, name));
  await user.click(
    await screen.findByRole("menuitem", { name: fr.attachments.download }),
  );
}

describe("« Pièces jointes » on the web", () => {
  it("adds files with the picker, no Finder and no Mac hint", async () => {
    const t = await newTask("Devis client");
    const { user, section } = await openTask(t.id);
    expect(
      within(section).queryByText(fr.attachments.hint("claude")),
    ).toBeNull();
    expect(within(section).getByText(fr.attachments.web.drop)).toBeVisible();
    const input = section.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    expect(input).toHaveAttribute("multiple");
    // « parcourir » opens the browser's picker (camera, photos or files on a phone).
    const picked = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => {});
    await user.click(
      within(section).getByRole("button", { name: fr.attachments.browse }),
    );
    expect(picked).toHaveBeenCalled();
    picked.mockRestore();
    await user.upload(input as HTMLInputElement, [
      new File(["%PDF"], "devis.pdf", { type: "application/pdf" }),
      new File(["abc"], "notes.txt", { type: "text/plain" }),
    ]);
    expect(await within(section).findByText("devis.pdf")).toBeVisible();
    expect(within(section).getByText("notes.txt")).toBeVisible();

    await user.click(tile(section, "devis.pdf"));
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual([fr.attachments.download, fr.attachments.delete]);
    expect(within(menu).queryByText(fr.attachments.reveal)).toBeNull();

    // No task folder on the web: the confirmation only says it leaves every device.
    await user.click(
      within(menu).getByRole("menuitem", { name: fr.attachments.delete }),
    );
    const message = await screen.findByText(fr.attachments.web.deleteMessage);
    const dialog = message.closest<HTMLElement>(
      "[role=dialog],[role=alertdialog]",
    );
    if (!dialog) throw new Error("no confirmation dialog");
    expect(message).toBeVisible();
    expect(dialog.textContent).not.toMatch(/dossier/);
    await user.click(
      within(dialog).getByRole("button", { name: fr.attachments.delete }),
    );
    await waitFor(() =>
      expect(within(section).queryByText("devis.pdf")).toBeNull(),
    );
  });

  it("adds a pasted image and dropped files", async () => {
    const t = await newTask("Maquette");
    const { section } = await openTask(t.id);
    fireEvent.paste(section, {
      clipboardData: {
        files: [new File([PNG], "image.png", { type: "image/png" })],
      },
    });
    expect(await within(section).findByText(/^capture-.*\.png$/)).toBeVisible();
    const zone = section.querySelector("[data-drop-zone]") as HTMLElement;
    const dropped = new File(["abc"], "plan.txt", { type: "text/plain" });
    const over = fireEvent.dragOver(zone, {
      dataTransfer: { files: [dropped], types: ["Files"] },
    });
    // Accepted as a drop target (the browser would open the file otherwise).
    expect(over).toBe(false);
    fireEvent.drop(zone, {
      dataTransfer: { files: [dropped], types: ["Files"] },
    });
    expect(await within(section).findByText("plan.txt")).toBeVisible();
  });

  it("review point 2: « Télécharger » saves every file; only a raster image shows, as a thumbnail", async () => {
    const t = await newTask("Fichiers piégés");
    const enc = (s: string) => new TextEncoder().encode(s);
    await phone.backend.files.add(t.id, [
      new File([enc("<script>fetch('/api/sync')</script>")], "page.html", {
        type: "text/html",
      }),
      new File(
        [enc('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"/>')],
        "logo.svg",
        { type: "image/svg+xml" },
      ),
      new File([enc("<html><script>x()</script>")], "faux.png", {
        type: "image/png",
      }),
      new File([PNG], "photo.png", { type: "image/png" }),
    ]);
    const browser = spyBrowser();
    const before = window.location.href;
    const { user, section } = await openTask(t.id);

    for (const name of ["page.html", "logo.svg", "faux.png", "photo.png"]) {
      await downloadFromMenu(user, section, name);
      await waitFor(() => expect(browser.saves.at(-1)?.download).toBe(name));
      const saved = browser.urls.get(browser.saves.at(-1)?.href ?? "");
      expect(saved?.type).toBe("application/octet-stream");
    }
    const photo = browser.urls.get(browser.saves.at(-1)?.href ?? "");
    expect(
      Array.from(new Uint8Array(await (photo as Blob).arrayBuffer())),
    ).toEqual(Array.from(PNG));

    // A double-click on a tile downloads it too.
    await user.dblClick(tile(section, "photo.png"));
    await waitFor(() => expect(browser.saves).toHaveLength(5));
    expect(browser.saves.at(-1)?.download).toBe("photo.png");

    // Never opened: no viewer, nothing opened, no navigation. Only the PNG tiles show an
    // `<img>` thumbnail (which runs no script), typed as an image; never the HTML nor the SVG.
    for (const name of ["page.html", "logo.svg", "faux.png", "photo.png"]) {
      expect(screen.queryByRole("dialog", { name })).toBeNull();
    }
    for (const name of ["faux.png", "photo.png"]) {
      await waitFor(() =>
        expect(tile(section, name).querySelector("img")).not.toBeNull(),
      );
      const src = tile(section, name).querySelector("img")?.src ?? "";
      expect(browser.urls.get(src)?.type).toBe("image/png");
    }
    for (const name of ["page.html", "logo.svg"]) {
      expect(tile(section, name).querySelector("img")).toBeNull();
    }
    expect(document.querySelector("iframe, object, embed")).toBeNull();
    expect(browser.open).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
  });

  it("« Télécharger » fetches a file added on the Mac from the server, then saves it", async () => {
    const MAC = "2026-10-01T00:00:00.000Z";
    const bytes = new TextEncoder().encode("%PDF-1.7 devis du Mac");
    const { sha256Hex } = await import("./test/fakeServer");
    const sha256 = await sha256Hex(bytes);
    phone.server.put(helpers.task("t-devis", MAC, { title: "Devis du Mac" }));
    phone.server.put(
      helpers.attachment("att-devis", "t-devis", MAC, {
        file_name: "devis.pdf",
        size: bytes.length,
        sha256,
      }),
    );
    phone.server.files.set("att-devis", {
      size: bytes.length,
      sha256,
      bytes,
      complete: true,
    });
    await helpers.link(phone);
    const browser = spyBrowser();
    const { user, section } = await openTask("t-devis");
    await downloadFromMenu(user, section, "devis.pdf");
    await waitFor(() =>
      expect(browser.saves.at(-1)?.download).toBe("devis.pdf"),
    );
    const saved = browser.urls.get(browser.saves.at(-1)?.href ?? "");
    expect(saved?.type).toBe("application/octet-stream");
    expect(
      Array.from(new Uint8Array(await (saved as Blob).arrayBuffer())),
    ).toEqual(Array.from(bytes));
  });

  it("tiles say where each file stands with the account, in the web's words", async () => {
    const MAC = "2026-10-01T00:00:00.000Z";
    phone.server.put(helpers.task("t-mac", MAC, { title: "Venue du Mac" }));
    phone.server.put(
      helpers.attachment("att-mac", "t-mac", MAC, {
        file_name: "contrat.pdf",
        sha256: "a".repeat(64),
      }),
    );
    await helpers.link(phone);
    await phone.backend.files.add("t-mac", [
      new File(["abc"], "ici.txt"),
      new File(["abd"], "gros.mov"),
      new File(["abe"], "plein.mov"),
    ]);
    for (const [name, state] of [
      ["gros.mov", "too_large"],
      ["plein.mov", "quota_exceeded"],
    ] as const) {
      const rec = phone.backend.links.attachments.find(
        (a) => a.fileName === name,
      );
      if (rec) rec.file = state;
    }
    const { user, section } = await openTask("t-mac");
    expect(
      within(tile(section, "ici.txt")).getByText(fr.attachments.web.localOnly),
    ).toBeVisible();
    expect(
      within(tile(section, "gros.mov")).getByText(
        fr.attachments.remote.too_large,
      ),
    ).toHaveClass("text-due-overdue");
    expect(
      within(tile(section, "plein.mov")).getByText(
        fr.attachments.remote.quota_full,
      ),
    ).toHaveClass("text-due-overdue");
    // On the server, not here: the normal state on the web, nothing said.
    const mac = tile(section, "contrat.pdf");
    expect(within(mac).queryByText(fr.attachments.remote.to_download)).toBe(
      null,
    );
    expect(within(mac).queryByText(fr.attachments.missing)).toBeNull();

    // Downloaded while the server does not have it yet: « Téléchargement… » while asking,
    // then said plainly.
    phone.server.onFile = async () => {
      await waitFor(() =>
        expect(mac).toHaveTextContent(fr.attachments.remote.downloading),
      );
    };
    await downloadFromMenu(user, section, "contrat.pdf");
    await waitFor(() =>
      expect(toasts.useToasts.getState().toasts[0]?.message).toBe(
        fr.attachments.web.error.not_on_server,
      ),
    );
    await waitFor(() =>
      expect(mac).not.toHaveTextContent(fr.attachments.remote.downloading),
    );
  });
  it("says when the device is full", async () => {
    const t = await newTask("Appareil plein");
    const { user, section } = await openTask(t.id);
    const toast = () => toasts.useToasts.getState().toasts[0]?.message;
    (phone.files as MemoryFileStore).failNextPut = true;
    const input = section.querySelector<HTMLInputElement>('input[type="file"]');
    await user.upload(input as HTMLInputElement, [new File(["abc"], "a.txt")]);
    await waitFor(() => expect(toast()).toBe(fr.attachments.web.error.storage));
    expect(within(section).queryByText("a.txt")).toBeNull();
  });

  it("says « Ajout… » while files are kept, and a pick meanwhile adds nothing twice", async () => {
    const t = await newTask("Ajout lent");
    const store = phone.files as MemoryFileStore;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(store, "put").mockImplementation(async (id, file) => {
      store.files.set(id, file);
      await gate;
    });
    const { section } = await openTask(t.id);
    const input = section.querySelector<HTMLInputElement>(
      'input[type="file"]',
    ) as HTMLInputElement;
    const zone = section.querySelector("[data-drop-zone]") as HTMLElement;
    const file = new File(["abc"], "lent.txt");
    fireEvent.change(input, { target: { files: [file] } });
    expect(
      await within(section).findByText(fr.attachments.web.adding),
    ).toBeVisible();
    expect(
      within(section).getByRole("button", { name: fr.attachments.browse }),
    ).toBeDisabled();
    // A second pick, a drop and a paste while busy: nothing added twice.
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.drop(zone, { dataTransfer: { files: [file], types: ["Files"] } });
    fireEvent.paste(section, { clipboardData: { files: [file] } });
    release();
    expect(await within(section).findByText("lent.txt")).toBeVisible();
    await waitFor(() =>
      expect(within(section).queryByText(fr.attachments.web.adding)).toBeNull(),
    );
    expect(
      within(section).getByRole("button", { name: fr.attachments.browse }),
    ).toBeEnabled();
    expect(
      (await phone.backend.commands.getTask(t.id)).attachments,
    ).toHaveLength(1);
  });
});
