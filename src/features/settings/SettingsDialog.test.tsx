import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import type { HookEventLog } from "../../bindings";
import { useToasts } from "../../components/Toast";
import { commands, mockBackend } from "../../lib/ipc";
import { MOCK_CLAUDE_PATH } from "../../lib/mock-backend";
import { resetUi, useUi } from "../../stores/ui";
import { resetClaudeCheck } from "../claude-check/claudeCheck";
import { eventTime, prettyPayload } from "./HookEvents";

function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

const NOW = new Date(2026, 9, 1, 14, 2, 7);

const event = (id: number, name: string, at: Date): HookEventLog => ({
  id,
  receivedAt: at.toISOString(),
  terminalId: id === 1 ? null : `term-000${id}`,
  event: name,
  payload: JSON.stringify({ hook_event_name: name, error: "rate_limit" }),
});

async function openSettings(tab?: string) {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Réglages" }));
  const dialog = await screen.findByRole("dialog", { name: "Réglages" });
  if (tab) await user.click(within(dialog).getByRole("tab", { name: tab }));
  return { user, dialog };
}

async function openDiagnostic() {
  const { user, dialog } = await openSettings("Diagnostic");
  return { user, dialog };
}

describe("Réglages", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
    resetClaudeCheck();
    useToasts.setState({ toasts: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("opens on « Général » from the gear and from ⌘,", async () => {
    const { user, dialog } = await openSettings();
    expect(
      within(dialog).getByRole("tab", { name: "Général", selected: true }),
    ).toHaveFocus();
    // The gear opens the dialog itself, no menu anymore.
    expect(screen.queryByRole("menu")).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.keyboard("{Meta>},{/Meta}");
    expect(
      await screen.findByRole("dialog", { name: "Réglages" }),
    ).toBeInTheDocument();
  });

  it("turns the Claude Haiku session recaps off and on", async () => {
    const { user, dialog } = await openSettings("Agents");
    const toggle = within(dialog).getByRole("switch", {
      name: "Résumer automatiquement les sessions terminées",
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveAccessibleDescription(
      "Une phrase par session terminée, quelques centaines de tokens de ton abonnement.",
    );
    await user.click(toggle);
    await waitFor(() =>
      expect(toggle).toHaveAttribute("aria-checked", "false"),
    );
    expect((await commands.getSettings()).summarizeSessions).toBe(false);
    await user.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect((await commands.getSettings()).summarizeSessions).toBe(true);
  });

  it("turns the notifications off and on", async () => {
    const { user, dialog } = await openSettings("Agents");
    const toggle = within(dialog).getByRole("switch", {
      name: "Me prévenir quand Claude a fini ou m'attend",
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await user.click(toggle);
    await waitFor(() =>
      expect(toggle).toHaveAttribute("aria-checked", "false"),
    );
    expect((await commands.getSettings()).notifications).toBe(false);
    await user.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect((await commands.getSettings()).notifications).toBe(true);
  });

  it("shows the dictation setting where dictation exists", async () => {
    const { dialog } = await openSettings("Agents");
    expect(
      await within(dialog).findByRole("switch", {
        name: "Garder Espace enfoncée pour dicter",
      }),
    ).toBeInTheDocument();
  });

  it("hides the dictation setting when the system has no dictation", async () => {
    backend().voice.model = { state: "unavailable" };
    const { dialog } = await openSettings("Agents");
    await within(dialog).findByRole("switch", {
      name: "Me prévenir quand Claude a fini ou m'attend",
    });
    await waitFor(() =>
      expect(
        within(dialog).queryByRole("switch", {
          name: "Garder Espace enfoncée pour dicter",
        }),
      ).toBeNull(),
    );
  });

  it("moves between tabs with the arrow keys", async () => {
    const { user, dialog } = await openSettings();
    expect(
      within(dialog)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Général", "Thème", "Compte", "Agents", "Diagnostic"]);
    await user.keyboard("{ArrowDown}");
    expect(
      within(dialog).getByRole("tab", { name: "Thème", selected: true }),
    ).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(
      within(dialog).getByRole("tab", { name: "Diagnostic", selected: true }),
    ).toHaveFocus();
  });

  it("saves the theme at once", async () => {
    const spy = vi.spyOn(commands, "updateSettings");
    const { user, dialog } = await openSettings("Thème");
    const dark = within(dialog).getByRole("radio", { name: "Sombre" });
    expect(
      within(dialog).getByRole("radio", { name: "Système" }),
    ).toBeChecked();
    await user.click(dark);
    await waitFor(() => expect(dark).toBeChecked());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ theme: "dark", editor: null }),
    );
    expect((await commands.getSettings()).theme).toBe("dark");
    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe("dark"),
    );
  });

  it("keeps the folder and the guide in « Général », the theme in « Thème »", async () => {
    const { user, dialog } = await openSettings();
    expect(within(dialog).queryByRole("radio", { name: "Sombre" })).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Revoir le guide" }),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("tab", { name: "Thème" }));
    expect(
      within(dialog)
        .getAllByRole("radio")
        .filter((r) => r.getAttribute("name") === "color-theme")
        .map((r) => r.closest("label")?.textContent),
    ).toEqual([
      "Taido",
      "Ardoise",
      "Graphite",
      "Myrtille",
      "Lavande",
      "Prune",
      "Framboise",
      "Cacao",
      "Sauge",
      "Lagon",
    ]);
  });

  it("applies a colour at once and previews each one in its own colours", async () => {
    const spy = vi.spyOn(commands, "updateSettings");
    const { user, dialog } = await openSettings("Thème");
    const taido = within(dialog).getByRole("radio", { name: "Taido" });
    expect(taido).toBeChecked();
    const sage = within(dialog).getByRole("radio", { name: "Sauge" });
    const preview = sage.parentElement?.querySelector("[data-color]");
    expect(preview).toHaveAttribute("data-color", "sage");
    await user.click(sage);
    await waitFor(() => expect(sage).toBeChecked());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ colorTheme: "sage", theme: null }),
    );
    expect((await commands.getSettings()).colorTheme).toBe("sage");
    await waitFor(() =>
      expect(document.documentElement.dataset.color).toBe("sage"),
    );
  });

  it("shares the theme with the other devices unless switched off", async () => {
    const { user, dialog } = await openSettings("Thème");
    const sync = within(dialog).getByRole("switch", {
      name: "Même thème sur tous mes appareils",
    });
    expect(sync).toHaveAttribute("aria-checked", "true");
    await user.click(within(dialog).getByRole("radio", { name: "Prune" }));
    await waitFor(() =>
      expect(backend().state.syncedSettings.appearance).toEqual({
        theme: "system",
        color: "plum",
      }),
    );
    await user.click(sync);
    await waitFor(() => expect(sync).toHaveAttribute("aria-checked", "false"));
    await user.click(within(dialog).getByRole("radio", { name: "Lagon" }));
    await waitFor(() =>
      expect(document.documentElement.dataset.color).toBe("lagoon"),
    );
    // Not shared while off.
    expect(backend().state.syncedSettings.appearance).toEqual({
      theme: "system",
      color: "plum",
    });
  });

  it("chooses the default agent, and checks Codex too", async () => {
    backend().state.codex = { found: false, loggedIn: null };
    const { user, dialog } = await openSettings("Agents");
    const claude = within(dialog).getByRole("radio", { name: /Claude Code/ });
    const codex = within(dialog).getByRole("radio", { name: /Codex/ });
    expect(claude).toBeChecked();
    await user.click(codex);
    await waitFor(async () =>
      expect((await commands.getSettings()).defaultAgent).toBe("codex"),
    );
    expect(codex).toBeChecked();
    const section = within(
      within(dialog).getByRole("region", { name: "Codex" }),
    );
    expect(await section.findByText("Introuvable")).toBeInTheDocument();
    expect(
      section.getByText(/npm install -g @openai\/codex/),
    ).toBeInTheDocument();
    expect(
      section.getByRole("textbox", { name: "Chemin du programme codex" }),
    ).toBeInTheDocument();
  });

  it("checks Claude Code and shows what it found", async () => {
    const spy = vi.spyOn(commands, "checkAgent");
    const { user, dialog } = await openSettings("Agents");
    const panel = within(
      within(dialog).getByRole("region", { name: "Claude Code" }),
    );
    expect(await panel.findByText(MOCK_CLAUDE_PATH)).toBeInTheDocument();
    expect(panel.getByText("2.1.288 (mock)")).toBeInTheDocument();
    expect(panel.getByText("Connecté")).toBeInTheDocument();

    backend().state.claude = { found: true, loggedIn: false };
    await user.click(
      panel.getByRole("button", { name: "Vérifier Claude Code" }),
    );
    expect(
      await panel.findByText(/Pas connecté\. Lance claude/),
    ).toBeInTheDocument();

    backend().state.claude = { found: false, loggedIn: null };
    await user.click(
      panel.getByRole("button", { name: "Vérifier Claude Code" }),
    );
    expect(await panel.findByText("Introuvable")).toBeInTheDocument();
    expect(spy.mock.calls.filter(([a]) => a === "claude")).toHaveLength(3);
  });

  it("validates and saves the path of the binary, then checks again", async () => {
    const { user, dialog: settings } = await openSettings("Agents");
    const dialog = within(settings).getByRole("region", {
      name: "Claude Code",
    });
    const field = within(dialog).getByRole("textbox", {
      name: "Chemin du programme claude",
    });
    const save = within(dialog).getByRole("button", { name: "Enregistrer" });
    expect(field).toHaveValue("");
    expect(save).toBeDisabled();

    await user.type(field, "bin/claude");
    await user.click(save);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Indique un chemin absolu",
    );
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect((await commands.getSettings()).claudePath).toBeNull();

    await user.clear(field);
    await user.type(field, "/usr/local/bin/claude{Enter}");
    expect(
      await within(dialog).findByText("Chemin enregistré."),
    ).toBeInTheDocument();
    expect((await commands.getSettings()).claudePath).toBe(
      "/usr/local/bin/claude",
    );
    // The check runs again with the new path.
    expect(
      await within(dialog).findByText("/usr/local/bin/claude", {
        selector: "dd span",
      }),
    ).toBeInTheDocument();

    await user.clear(field);
    await user.click(save);
    expect(
      await within(dialog).findByText("Détection automatique rétablie."),
    ).toBeInTheDocument();
    expect((await commands.getSettings()).claudePath).toBeNull();
  });

  it("shows the app status with buttons to open its folders", async () => {
    const open = vi.spyOn(commands, "openPath");
    const { user, dialog } = await openDiagnostic();
    const status = await commands.getAppStatus();
    expect(await within(dialog).findByText(status.envPath)).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Port des hooks");
    expect(dialog).toHaveTextContent(String(status.hooksPort));
    expect(dialog).toHaveTextContent("0.1.0");
    await user.click(
      within(dialog).getByRole("button", {
        name: "Ouvrir le dossier des logs dans le Finder",
      }),
    );
    expect(open).toHaveBeenCalledWith({
      path: status.logDir,
      with: "finder",
      editor: null,
    });
    await user.click(
      within(dialog).getByRole("button", {
        name: "Ouvrir le dossier des données dans le Finder",
      }),
    );
    expect(open).toHaveBeenCalledWith({
      path: status.dataDir,
      with: "finder",
      editor: null,
    });
  });

  it("says when the PATH is a fallback", async () => {
    const real = await commands.getAppStatus();
    vi.spyOn(commands, "getAppStatus").mockResolvedValue({
      ...real,
      envFromLoginShell: false,
    });
    const { dialog } = await openDiagnostic();
    expect(
      await within(dialog).findByText(/PATH de secours/),
    ).toBeInTheDocument();
  });
});

describe("Réglages › Diagnostic, hook events", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
  });
  afterEach(() => vi.restoreAllMocks());

  it("formats times and payloads", () => {
    expect(eventTime(NOW.toISOString(), NOW)).toBe("14:02:07");
    expect(eventTime(new Date(2026, 8, 30, 9, 5, 1).toISOString(), NOW)).toBe(
      "30/09 09:05:01",
    );
    expect(prettyPayload('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyPayload("pas du JSON")).toBe("pas du JSON");
  });

  it("says when there is no event yet", async () => {
    const { dialog } = await openDiagnostic();
    expect(
      await within(dialog).findByText(/Aucun événement pour l'instant/),
    ).toBeInTheDocument();
  });

  it("lists the last 200 events, newest first, with their payload", async () => {
    const spy = vi
      .spyOn(commands, "getHookEvents")
      .mockResolvedValue([
        event(2, "StopFailure", new Date()),
        event(1, "SessionStart", new Date()),
      ]);
    const { user, dialog } = await openDiagnostic();
    const list = await within(dialog).findByRole("list", {
      name: "Événements des sessions",
    });
    expect(spy).toHaveBeenCalledWith(200);
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector("summary")?.textContent)).toEqual(
      [
        expect.stringContaining("StopFailure"),
        expect.stringContaining("SessionStart"),
      ],
    );
    expect(items[0]).toHaveTextContent("Terminal term-0002");
    expect(items[1]).toHaveTextContent("sans terminal");
    expect(dialog).toHaveTextContent("2 événements");

    // The payload is folded, pretty-printed once opened.
    const details = items[0].querySelector("details");
    expect(details?.open).toBe(false);
    await user.click(within(items[0]).getByText("StopFailure"));
    expect(details?.open).toBe(true);
    expect(items[0].querySelector("[data-payload]")?.textContent).toBe(
      '{\n  "hook_event_name": "StopFailure",\n  "error": "rate_limit"\n}',
    );
  });

  it("refreshes, and offers to retry after an error", async () => {
    const spy = vi
      .spyOn(commands, "getHookEvents")
      .mockRejectedValueOnce({ kind: "internal", message: "db locked" })
      .mockResolvedValue([event(3, "Stop", new Date())]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { user, dialog } = await openDiagnostic();
    expect(
      await within(dialog).findByText("Impossible de lire les événements."),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Réessayer" }));
    expect(await within(dialog).findByText("Stop")).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Actualiser" }),
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
  });

  it("shows the events of a simulated Claude session", async () => {
    const subject = await commands.createSubject({
      name: "Globex",
      color: null,
      rootPath: "/tmp/globex",
      parentId: null,
    });
    const task = await commands.createTask({
      title: "Exporter",
      description: null,
      subjectId: subject.id,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    const term = await commands.openTerminal({
      taskId: task.id,
      kind: "agent",
      agent: null,
      command: null,
      initialPrompt: null,
      permissionMode: null,
      addTaskContext: null,
      cols: 80,
      rows: 24,
    });
    await commands.writeTerminal({ terminalId: term.id, data: "/e\r" });
    const { dialog } = await openDiagnostic();
    expect(await within(dialog).findByText("StopFailure")).toBeInTheDocument();
    expect(dialog).toHaveTextContent(`Terminal ${term.id}`);
  });
});

// The account forms themselves: src/features/account/account.test.tsx.
describe("Réglages › Compte", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
    useToasts.setState({ toasts: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("changes the interval and syncs now once logged in", async () => {
    await backend().sync.signup({
      serverUrl: "https://sync.example.com",
      email: "user@exemple.fr",
      password: "un-bon-mot-de-passe",
    });
    const { user, dialog } = await openSettings("Compte");
    expect(
      await within(dialog).findByText("user@exemple.fr"),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "À jour · Dernière synchro : à l'instant",
    );
    expect(
      within(dialog).getByText("Serveur : https://sync.example.com"),
    ).toBeInTheDocument();
    // The sidebar button shows once linked.
    expect(
      screen.getByRole("button", { name: /^Synchroniser · À jour/ }),
    ).toBeInTheDocument();

    const interval = within(dialog).getByLabelText("Synchroniser toutes les");
    expect(interval).toHaveValue("5");
    expect(
      within(interval)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["1 min", "5 min", "15 min", "30 min", "1 heure"]);
    await user.selectOptions(interval, "15");
    await waitFor(async () =>
      expect((await commands.syncStatus()).intervalMinutes).toBe(15),
    );
    expect(interval).toHaveValue("15");

    const now = vi.spyOn(commands, "syncNow");
    await user.click(
      within(dialog).getByRole("button", { name: "Synchroniser maintenant" }),
    );
    expect(now).toHaveBeenCalledTimes(1);
  });

  it("shows the error of the last sync", async () => {
    act(() => {
      backend().sync.set({
        state: "error",
        serverUrl: "https://sync.example.com",
        errorKind: "server",
        pending: 3,
      });
    });
    const { dialog } = await openSettings("Compte");
    const status = await within(dialog).findByRole("status");
    expect(status).toHaveTextContent("Erreur de synchro · Jamais synchronisé");
    expect(status).toHaveTextContent(
      "Le serveur a renvoyé une erreur. Nouvel essai à la prochaine synchro.",
    );
    expect(status).toHaveTextContent("3 modifications à envoyer");
  });

  it("reconnects with the password when the server refused this device", async () => {
    await backend().sync.login({
      serverUrl: "https://sync.example.com",
      email: "user@exemple.fr",
      password: "l'ancien mot de passe",
    });
    act(() => {
      backend().sync.set({
        state: "error",
        serverUrl: "https://sync.example.com",
        errorKind: "unauthorized",
      });
    });
    const link = vi.spyOn(commands, "syncLogin");
    const { user, dialog } = await openSettings("Compte");
    const password = await within(dialog).findByLabelText("Mot de passe");
    expect(within(dialog).queryByLabelText("Adresse du serveur")).toBeNull();
    // Prefilled with the linked account.
    await waitFor(() =>
      expect(within(dialog).getByLabelText("Adresse e-mail")).toHaveValue(
        "user@exemple.fr",
      ),
    );
    await user.type(password, "le bon mot de passe");
    await user.click(
      within(dialog).getByRole("button", { name: "Se reconnecter" }),
    );
    expect(link).toHaveBeenCalledWith({
      serverUrl: "https://sync.example.com",
      email: "user@exemple.fr",
      password: "le bon mot de passe",
    });
    await waitFor(() =>
      expect(within(dialog).queryByLabelText("Mot de passe")).toBeNull(),
    );
    expect(
      await within(dialog).findByText(/^À jour/, { exact: false }),
    ).toBeInTheDocument();
  });

  it("opens on the Compte tab when asked", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: "Réglages" });
    act(() => {
      useUi.getState().openDialog({ type: "settings", tab: "sync" });
    });
    const dialog = await screen.findByRole("dialog", { name: "Réglages" });
    expect(
      within(dialog).getByRole("tab", { name: "Compte", selected: true }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
  });
});

describe("Réglages › Langue", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
    useToasts.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.setItem("taido.language", "fr");
  });

  it("shows a select with English and Français, and saves the choice", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    const { user, dialog } = await openSettings();
    const select = within(dialog).getByRole("combobox", {
      name: "Langue / Language",
    });
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["English", "Français"]);
    expect(select).toHaveValue("fr");
    await user.selectOptions(select, "English");
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(window.localStorage.getItem("taido.language")).toBe("en");
    expect((await commands.getSettings()).language).toBe("en");
  });
});
