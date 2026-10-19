// The phone build (IS_MOBILE forced on): Réglages › Synchro is the phone's own login screen
// (Taido V2.7: e-mail and password; accounts are created and reset from the Mac).
import { act, render, screen, waitFor, within } from "@testing-library/react";
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
import type { Phone } from "./test/helpers";

vi.mock("../lib/target", () => ({ IS_MOBILE: true }));

const EMAIL = "user@exemple.fr";
const MAC = "2026-10-01T00:00:00.000Z";

let phone: Phone;
let helpers: typeof import("./test/helpers");
let MobileApp: typeof import("./MobileApp").default;
let ui: typeof import("../stores/ui");
let toasts: typeof import("../components/Toast");
let linkErrorText: typeof import("../features/sync/SyncParts").linkErrorText;

beforeAll(async () => {
  helpers = await import("./test/helpers");
  phone = helpers.makePhone();
  globalThis.__TODO_BACKEND__ = phone.backend;
  MobileApp = (await import("./MobileApp")).default;
  ui = await import("../stores/ui");
  toasts = await import("../components/Toast");
  linkErrorText = (await import("../features/sync/SyncParts")).linkErrorText;
});

beforeEach(async () => {
  phone.server.canned = [];
  phone.server.offline = false;
  if (phone.backend.syncData.token !== null) {
    await phone.backend.commands.syncUnlink();
  }
  ui.resetUi();
  toasts.useToasts.setState({ toasts: [] });
});

afterEach(() => vi.restoreAllMocks());

/** Renders the app and opens Réglages › Synchro. */
async function openSync() {
  const user = userEvent.setup();
  render(<MobileApp backend={phone.backend} />);
  act(() => ui.useUi.getState().openDialog({ type: "settings", tab: "sync" }));
  const dialog = await screen.findByRole("dialog", { name: fr.settings.title });
  return { user, dialog };
}

async function fillAndLogin(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  email: string,
  password: string,
) {
  const emailField = within(dialog).getByLabelText(fr.sync.email);
  await user.clear(emailField);
  await user.type(emailField, email);
  const passwordField = within(dialog).getByLabelText(fr.sync.password);
  await user.clear(passwordField);
  await user.type(passwordField, password);
  await user.click(within(dialog).getByRole("button", { name: fr.sync.link }));
}

describe("Réglages › Synchro on the phone", () => {
  it("asks for the e-mail and the password, the server prefilled, and sends to the Mac for the rest", async () => {
    const { dialog } = await openSync();
    expect(
      within(dialog).getByRole("tab", {
        name: fr.settings.tabs.sync,
        selected: true,
      }),
    ).toBeInTheDocument();
    const email = await within(dialog).findByLabelText(fr.sync.email);
    expect(email).toHaveAttribute("type", "email");
    expect(email).toHaveAttribute("autocomplete", "email");
    const password = within(dialog).getByLabelText(fr.sync.password);
    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveAttribute("autocomplete", "current-password");
    // The phone app is served by the server: its own address.
    expect(within(dialog).getByLabelText(fr.sync.serverUrl)).toHaveValue(
      window.location.origin,
    );
    expect(within(dialog).getByText(fr.sync.signupOnMac)).toBeInTheDocument();
    expect(within(dialog).getByText(fr.sync.forgotOnMac)).toBeInTheDocument();
    // No signup nor reset flow on the phone (V2.7).
    expect(
      within(dialog).queryByRole("button", { name: fr.account.start.signup }),
    ).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: fr.sync.link }),
    ).toBeDisabled();
  });

  it("explains each login error under the form", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { user, dialog } = await openSync();
    await within(dialog).findByLabelText(fr.sync.email);

    await fillAndLogin(user, dialog, EMAIL, "mauvais");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      fr.sync.accountError.sync_auth,
    );
    expect(within(dialog).getByLabelText(fr.sync.password)).toHaveAttribute(
      "aria-invalid",
      "true",
    );

    phone.server.canned.push({
      status: 429,
      body: '{"error":"rate_limited","message":"slow down"}',
    });
    await fillAndLogin(user, dialog, EMAIL, phone.server.password);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      fr.sync.accountError.sync_rate_limited,
    );

    phone.server.offline = true;
    await fillAndLogin(user, dialog, EMAIL, phone.server.password);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      fr.sync.accountError.sync_offline,
    );
    phone.server.offline = false;

    const url = within(dialog).getByLabelText(fr.sync.serverUrl);
    await user.clear(url);
    await user.type(url, "http://exemple.fr");
    await fillAndLogin(user, dialog, EMAIL, phone.server.password);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      fr.sync.accountError.invalid,
    );
    expect((await phone.backend.commands.syncStatus()).state).toBe("unlinked");
  });

  it("logs in a fresh phone without asking, shows the account's e-mail, and logs out", async () => {
    const { user, dialog } = await openSync();
    await within(dialog).findByLabelText(fr.sync.email);
    await fillAndLogin(
      user,
      dialog,
      ` ${EMAIL.toUpperCase()} `,
      phone.server.password,
    );

    expect(await within(dialog).findByText(EMAIL)).toBeInTheDocument();
    // Nothing on this phone yet: no merge question.
    expect(
      screen.queryByRole("dialog", { name: fr.account.mergeTitle }),
    ).toBeNull();
    expect(
      within(dialog).getByText(fr.sync.linkedTo(window.location.origin)),
    ).toBeInTheDocument();
    expect(toasts.useToasts.getState().toasts[0]?.message).toBe(
      fr.sync.linkedToast,
    );
    await waitFor(() =>
      expect(within(dialog).getByRole("status")).toHaveTextContent(
        fr.sync.state.idle,
      ),
    );

    // The Mac's flow: one last sync (nothing pending), then the plain confirmation.
    const syncNow = vi.spyOn(phone.backend.commands, "syncNow");
    await user.click(
      within(dialog).getByRole("button", { name: fr.account.logout }),
    );
    const confirm = await screen.findByRole("dialog", {
      name: fr.account.logoutTitle,
    });
    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveTextContent(fr.account.phone.logoutText);
    await user.click(
      within(confirm).getByRole("button", { name: fr.account.logout }),
    );
    // Back to the form, the address kept.
    expect(await within(dialog).findByLabelText(fr.sync.serverUrl)).toHaveValue(
      window.location.origin,
    );
    expect(within(dialog).getByLabelText(fr.sync.password)).toHaveValue("");
    expect(await phone.backend.commands.syncAccount()).toBeNull();
    expect(toasts.useToasts.getState().toasts[0]?.message).toBe(
      fr.account.phone.loggedOutToast,
    );
  });

  it("asks before merging this phone's projects into the account, like the Mac", async () => {
    await phone.backend.commands.createTask({
      title: "Notée sur le téléphone",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    const login = vi.spyOn(phone.backend.commands, "syncLogin");
    const { user, dialog } = await openSync();
    await within(dialog).findByLabelText(fr.sync.email);

    await fillAndLogin(user, dialog, EMAIL, phone.server.password);
    let ask = await screen.findByRole("dialog", {
      name: fr.account.mergeTitle,
    });
    expect(ask).toHaveTextContent(fr.account.phone.mergeText(EMAIL));
    // « Annuler »: nothing sent, still on the form with what was typed.
    await user.click(
      within(ask).getByRole("button", { name: fr.common.cancel }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: fr.account.mergeTitle }),
      ).toBeNull(),
    );
    expect(login).not.toHaveBeenCalled();
    expect((await phone.backend.commands.syncStatus()).state).toBe("unlinked");
    expect(within(dialog).getByLabelText(fr.sync.email)).toHaveValue(EMAIL);

    await user.click(
      within(dialog).getByRole("button", { name: fr.sync.link }),
    );
    ask = await screen.findByRole("dialog", { name: fr.account.mergeTitle });
    await user.click(
      within(ask).getByRole("button", { name: fr.account.merge }),
    );
    expect(await within(dialog).findByText(EMAIL)).toBeInTheDocument();
    expect(login).toHaveBeenCalledTimes(1);
    await phone.backend.commands.syncNow();
    expect(
      [...phone.server.records.values()].some(
        (r) =>
          r.change.entity === "task" &&
          (r.change.data as { title?: string } | null)?.title ===
            "Notée sur le téléphone",
      ),
    ).toBe(true);
  });

  it("warns before logging out when the last sync fails or leaves changes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await phone.backend.commands.syncLogin({
      serverUrl: window.location.origin,
      email: EMAIL,
      password: phone.server.password,
    });
    await phone.backend.commands.syncNow();
    const { user, dialog } = await openSync();
    await within(dialog).findByText(EMAIL);

    // Offline with one change: it stays on the phone, said with the count.
    phone.server.offline = true;
    await phone.backend.commands.createTask({
      title: "Pas encore envoyée",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    await user.click(
      within(dialog).getByRole("button", { name: fr.account.logout }),
    );
    let warn = await screen.findByRole("dialog", {
      name: fr.account.logoutPendingTitle,
    });
    expect(warn).toHaveTextContent(fr.account.phone.logoutPending(1));
    await user.click(
      within(warn).getByRole("button", { name: fr.common.cancel }),
    );
    expect((await phone.backend.commands.syncStatus()).state).not.toBe(
      "unlinked",
    );

    // Back online but the server fails: nothing counted, the failure said.
    phone.server.offline = false;
    await phone.backend.commands.syncNow();
    phone.server.canned.push({ status: 500, body: "{}" });
    await user.click(
      within(dialog).getByRole("button", { name: fr.account.logout }),
    );
    warn = await screen.findByRole("dialog", {
      name: fr.account.logoutPendingTitle,
    });
    expect(warn).toHaveTextContent(fr.account.phone.logoutFailed);
    await user.click(
      within(warn).getByRole("button", { name: fr.account.logoutAnyway }),
    );
    expect(
      await within(dialog).findByLabelText(fr.sync.email),
    ).toBeInTheDocument();
    expect((await phone.backend.commands.syncStatus()).state).toBe("unlinked");
  });

  it("reconnects to the same account after the token was refused, never to another one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await phone.backend.commands.syncLogin({
      serverUrl: window.location.origin,
      email: EMAIL,
      password: phone.server.password,
    });
    await phone.backend.commands.syncNow();
    // The password was changed on the Mac: every device is logged out.
    phone.server.tokens.clear();
    await phone.backend.commands.syncNow();
    const { user, dialog } = await openSync();
    const email = await within(dialog).findByLabelText(fr.sync.email);
    // Prefilled with the account.
    await waitFor(() => expect(email).toHaveValue(EMAIL));
    const password = within(dialog).getByLabelText(fr.sync.password);

    await user.clear(email);
    await user.type(email, "autre@exemple.fr");
    await user.type(password, phone.server.password);
    await user.click(
      within(dialog).getByRole("button", { name: fr.sync.reconnect }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      fr.sync.accountError.alreadyLinked,
    );

    await user.clear(email);
    await user.type(email, EMAIL);
    await user.click(
      within(dialog).getByRole("button", { name: fr.sync.reconnect }),
    );
    await waitFor(() =>
      expect(toasts.useToasts.getState().toasts[0]?.message).toBe(
        fr.sync.reconnectedToast,
      ),
    );
    expect(await within(dialog).findByText(EMAIL)).toBeInTheDocument();
  });

  it("says where to sign up when a Mac-only account command is refused", async () => {
    const error = await phone.backend.commands
      .syncSignup({
        serverUrl: window.location.origin,
        email: EMAIL,
        password: "un mot de passe",
      })
      .catch((e: unknown) => e);
    expect(linkErrorText(error)).toBe(fr.sync.accountError.notOnPhone);
    expect(linkErrorText(error)).not.toBe(fr.sync.accountError.invalid);
  });

  it("shows a group pulled from the Mac as a group, with no task of its own", async () => {
    phone.server.put(
      helpers.subject("grp", MAC, { name: "Clients", is_group: true }),
    );
    phone.server.put(
      helpers.subject("proj", MAC, { name: "Site", parent_id: "grp" }),
    );
    await helpers.link(phone);
    render(<MobileApp backend={phone.backend} />);
    const drawer = await screen.findByRole("dialog", {
      name: fr.sidebar.navLabel,
    });
    const toggle = await within(drawer).findByRole("button", {
      name: fr.groups.toggle("Clients", true),
    });
    expect(toggle.closest("[data-group]")).not.toBeNull();
    expect(within(drawer).getByText("Site")).toBeInTheDocument();
    // Tapping the group folds its projects: it never opens as a list of tasks.
    const before = ui.useUi.getState().view;
    await userEvent.click(toggle);
    expect(ui.useUi.getState().view).toEqual(before);
    expect(
      within(drawer).getByRole("button", {
        name: fr.groups.toggle("Clients", false),
      }),
    ).toBeInTheDocument();
    await expect(
      phone.backend.commands.createTask({
        title: "Dans le groupe",
        description: null,
        subjectId: "grp",
        sectionId: null,
        dueDate: null,
        dueTime: null,
      }),
    ).rejects.toMatchObject({ kind: "invalid" });
  });
});
