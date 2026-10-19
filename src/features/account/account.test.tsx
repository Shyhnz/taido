/**
 * The account is opt-in: nothing at first launch, Réglages › Compte holds signup, login,
 * forgotten password, merge confirmation and logout after a last sync, with the mock core.
 * There is no built-in server: the address is a required field.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { useToasts } from "../../components/Toast";
import { commands, mockBackend } from "../../lib/ipc";
import { createQueryClient } from "../../lib/queries";
import { resetUi } from "../../stores/ui";
import { useTutorial } from "../tutorial/store";
import { AccountForm } from "./AccountForms";

function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

type User = ReturnType<typeof userEvent.setup>;

/** A server address typed by the user (the app proposes none). */
const SERVER = "https://sync.example.com";

/** An install: no data, guide never run. */
function freshInstall() {
  backend().reset({ seed: false });
  backend().state.settings.tutorial.status = "not_started";
}

async function openAccount() {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Réglages" }));
  const dialog = await screen.findByRole("dialog", { name: "Réglages" });
  await user.click(within(dialog).getByRole("tab", { name: "Compte" }));
  return { user, dialog };
}

async function typeInto(user: User, field: HTMLElement, text: string) {
  await user.clear(field);
  if (text) await user.type(field, text);
}

async function fill(
  user: User,
  scope: HTMLElement,
  email: string,
  password: string,
) {
  await typeInto(user, within(scope).getByLabelText("Adresse e-mail"), email);
  await typeInto(user, within(scope).getByLabelText("Mot de passe"), password);
  await typeServer(user, scope);
}

/** Types SERVER in the address field unless something was typed there already. */
async function typeServer(user: User, scope: HTMLElement) {
  const field = within(scope).getByLabelText("Adresse du serveur");
  if ((field as HTMLInputElement).value === "") {
    await typeInto(user, field, SERVER);
  }
}

describe("first launch", () => {
  beforeEach(() => {
    freshInstall();
    resetUi();
    useTutorial.setState({ run: null });
    useToasts.setState({ toasts: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("first launch opens the app without the account screen", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Réglages" });
    // The guide starts at once, nothing asks for an account first.
    await waitFor(() =>
      expect(useTutorial.getState().run?.step).toBe("welcome"),
    );
    expect(screen.queryByRole("dialog", { name: "Taido" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Créer un compte" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Continuer sans compte" }),
    ).toBeNull();
  });
});

describe("account form", () => {
  beforeEach(() => {
    freshInstall();
    resetUi();
    useTutorial.setState({ run: null });
    useToasts.setState({ toasts: [] });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("starts from the server address kept after a logout (SYNC.md § 0.10 rule 2)", async () => {
    await backend().sync.signup({
      serverUrl: "https://sync.exemple.fr/",
      email: "user@exemple.fr",
      password: "un-bon-mot-de-passe",
    });
    await backend().sync.unlink();
    const { user, dialog } = await openAccount();
    await user.click(
      await within(dialog).findByRole("button", {
        name: "J'ai déjà un compte",
      }),
    );
    expect(within(dialog).getByLabelText("Adresse du serveur")).toHaveValue(
      "https://sync.exemple.fr",
    );
    const login = vi.spyOn(commands, "syncLogin");
    await fill(user, dialog, "user@exemple.fr", "un-bon-mot-de-passe");
    await user.click(
      within(dialog).getByRole("button", { name: "Se connecter" }),
    );
    expect(login).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: "https://sync.exemple.fr" }),
    );
  });

  it("account form has no default server", async () => {
    const { user, dialog } = await openAccount();
    await user.click(
      await within(dialog).findByRole("button", { name: "Créer un compte" }),
    );
    const url = within(dialog).getByLabelText("Adresse du serveur");
    expect(url).toHaveValue("");
    expect(url).toHaveAttribute("placeholder", "https://sync.example.com");
    // Visible at once, not folded under « Avancé ».
    expect(url).toBeVisible();
    expect(within(dialog).queryByText("Avancé")).toBeNull();
  });

  it("account form requires a server address", async () => {
    const signup = vi.spyOn(commands, "syncSignup");
    const { user, dialog } = await openAccount();
    await user.click(
      await within(dialog).findByRole("button", { name: "Créer un compte" }),
    );
    await typeInto(
      user,
      within(dialog).getByLabelText("Adresse e-mail"),
      "user@exemple.fr",
    );
    await typeInto(
      user,
      within(dialog).getByLabelText("Mot de passe"),
      "un-bon-mot-de-passe",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Créer mon compte" }),
    );
    const url = within(dialog).getByLabelText("Adresse du serveur");
    await waitFor(() =>
      expect(url).toHaveAccessibleDescription(
        /Indique l'adresse de ton serveur de synchro\./,
      ),
    );
    expect(url).toHaveAttribute("aria-invalid", "true");
    expect(signup).not.toHaveBeenCalled();
  });

  it("locks every form switch while a call runs", async () => {
    const calls: Array<() => void> = [];
    const pending = () =>
      new Promise<never>((_, reject) => {
        calls.push(() => reject({ kind: "sync_offline", message: "down" }));
      });
    vi.spyOn(commands, "syncLogin").mockImplementation(pending);
    vi.spyOn(commands, "syncForgotPassword").mockImplementation(pending);
    vi.spyOn(commands, "syncResetPassword").mockImplementation(pending);
    const { user, dialog } = await openAccount();
    await user.click(
      await within(dialog).findByRole("button", {
        name: "J'ai déjà un compte",
      }),
    );
    const button = (name: string) =>
      within(dialog).getByRole("button", { name });
    const runAndCheck = async (submit: string, switches: string[]) => {
      await user.click(button(submit));
      for (const name of switches) expect(button(name)).toBeDisabled();
      await act(async () => calls.shift()?.());
      await within(dialog).findByRole("alert");
      for (const name of switches) expect(button(name)).toBeEnabled();
    };
    // Login: « Mot de passe oublié ? », « Créer un compte », « Retour ».
    await fill(user, dialog, "user@exemple.fr", "un-bon-mot-de-passe");
    await runAndCheck("Se connecter", [
      "Mot de passe oublié ?",
      "Créer un compte",
      "Retour",
    ]);
    // Forgotten password: « Retour ».
    await user.click(button("Mot de passe oublié ?"));
    await runAndCheck("Envoyer le code", ["Retour"]);
    // Code and new password: « Demander un nouveau code ».
    vi.mocked(commands.syncForgotPassword).mockResolvedValueOnce(null);
    await user.click(button("Envoyer le code"));
    await user.type(
      await within(dialog).findByLabelText("Code reçu par e-mail"),
      "123456",
    );
    await user.type(
      within(dialog).getByLabelText("Nouveau mot de passe"),
      "un-nouveau-mot-de-passe",
    );
    await runAndCheck("Changer le mot de passe", ["Demander un nouveau code"]);
  });

  it("never leaves its parent busy when it goes during a call", async () => {
    vi.spyOn(commands, "syncSignup").mockImplementation(
      () => new Promise<never>(() => {}),
    );
    const onBusyChange = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(
      <QueryClientProvider client={createQueryClient()}>
        <AccountForm initialMode="signup" onBusyChange={onBusyChange} />
      </QueryClientProvider>,
    );
    await fill(user, document.body, "user@exemple.fr", "un-bon-mot-de-passe");
    await user.click(screen.getByRole("button", { name: "Créer mon compte" }));
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));
    unmount();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });
});

describe("Réglages › Compte", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
    useToasts.setState({ toasts: [] });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("offers the two buttons, the server address in plain sight", async () => {
    const { user, dialog } = await openAccount();
    expect(
      await within(dialog).findByRole("button", { name: "Créer un compte" }),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "J'ai déjà un compte" }),
    );
    expect(within(dialog).getByLabelText("Mot de passe")).toHaveAttribute(
      "autocomplete",
      "current-password",
    );
    expect(within(dialog).getByLabelText("Adresse du serveur")).toBeVisible();
  });

  it("creates an account, then Réglages › Compte shows the e-mail", async () => {
    const signup = vi.spyOn(commands, "syncSignup");
    const { user, dialog } = await openAccount();
    await user.click(
      await within(dialog).findByRole("button", { name: "Créer un compte" }),
    );
    const pass = within(dialog).getByLabelText("Mot de passe");
    expect(pass).toHaveAttribute("type", "password");
    expect(pass).toHaveAttribute("autocomplete", "new-password");
    await user.click(
      within(dialog).getByRole("button", { name: "Afficher le mot de passe" }),
    );
    expect(pass).toHaveAttribute("type", "text");
    await fill(user, dialog, "User@Exemple.fr", "un-bon-mot-de-passe");
    await user.click(
      within(dialog).getByRole("button", { name: "Créer mon compte" }),
    );
    expect(signup).toHaveBeenCalledWith({
      serverUrl: SERVER,
      email: "User@Exemple.fr",
      password: "un-bon-mot-de-passe",
    });
    expect(useToasts.getState().toasts[0]?.message).toBe(
      "Compte créé. Première synchro en cours…",
    );
    expect(
      await within(dialog).findByText("user@exemple.fr"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Synchroniser maintenant" }),
    ).toBeInTheDocument();

    // Signed up: the address is to confirm, the mail can be sent again.
    expect(within(dialog).getByText("Adresse à confirmer")).toBeInTheDocument();
    const resend = vi.spyOn(commands, "syncResendConfirmation");
    await user.click(
      within(dialog).getByRole("button", { name: "Renvoyer le mail" }),
    );
    expect(resend).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(useToasts.getState().toasts.at(-1)?.message).toBe(
        "Mail envoyé à user@exemple.fr.",
      ),
    );
  });

  it("shows each error under the field concerned", async () => {
    const { user, dialog } = await openAccount();
    await user.click(
      await within(dialog).findByRole("button", { name: "Créer un compte" }),
    );
    const email = () => within(dialog).getByLabelText("Adresse e-mail");
    const password = () => within(dialog).getByLabelText("Mot de passe");
    const submit = () =>
      user.click(
        within(dialog).getByRole("button", { name: "Créer mon compte" }),
      );

    await fill(user, dialog, "pris@exemple.fr", "un-bon-mot-de-passe");
    await submit();
    await waitFor(() =>
      expect(email()).toHaveAccessibleDescription(
        "Un compte existe déjà avec cette adresse. Connecte-toi plutôt.",
      ),
    );
    expect(email()).toHaveAttribute("aria-invalid", "true");
    expect(password()).not.toHaveAttribute("aria-invalid");

    await fill(user, dialog, "pas-une-adresse", "un-bon-mot-de-passe");
    await submit();
    await waitFor(() =>
      expect(email()).toHaveAccessibleDescription(
        "Cette adresse e-mail n'est pas valide.",
      ),
    );

    await fill(user, dialog, "user@exemple.fr", "court");
    await submit();
    await waitFor(() =>
      expect(password()).toHaveAccessibleDescription(
        /Le mot de passe doit faire au moins 10 caractères\./,
      ),
    );
    expect(email()).not.toHaveAttribute("aria-invalid");

    // A bad server address: under the address.
    const url = within(dialog).getByLabelText("Adresse du serveur");
    await typeInto(user, url, "http://exemple.fr");
    await fill(user, dialog, "user@exemple.fr", "un-bon-mot-de-passe");
    await submit();
    await waitFor(() =>
      expect(url).toHaveAccessibleDescription(
        /Indique une adresse de serveur qui commence par https:\/\//,
      ),
    );

    // Network: at the form level.
    await typeInto(user, url, "https://injoignable.exemple.fr");
    await submit();
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Serveur injoignable. Vérifie ta connexion.",
    );
    expect(email()).not.toHaveAttribute("aria-invalid");
    expect(password()).not.toHaveAttribute("aria-invalid");

    // Login: a wrong password goes under the password.
    await typeInto(user, url, SERVER);
    await user.click(
      within(dialog).getByRole("button", { name: "J'ai déjà un compte" }),
    );
    await fill(user, dialog, "user@exemple.fr", "mauvais");
    await user.click(
      within(dialog).getByRole("button", { name: "Se connecter" }),
    );
    await waitFor(() =>
      expect(password()).toHaveAccessibleDescription(
        "E-mail ou mot de passe incorrect.",
      ),
    );
    expect((await commands.syncStatus()).state).toBe("unlinked");
  });

  it("signup on a closed server shows the closed message", async () => {
    const { user, dialog } = await openAccount();
    await user.click(
      await within(dialog).findByRole("button", { name: "Créer un compte" }),
    );
    await fill(user, dialog, "user@exemple.fr", "un-bon-mot-de-passe");
    const url = within(dialog).getByLabelText("Adresse du serveur");
    await typeInto(user, url, "https://inscriptions-fermees.exemple.fr");
    await user.click(
      within(dialog).getByRole("button", { name: "Créer mon compte" }),
    );
    await waitFor(() =>
      expect(url).toHaveAccessibleDescription(
        /^Les inscriptions sont fermées sur ce serveur\. Demande un compte à la personne qui l'héberge\./,
      ),
    );
    expect((await commands.syncStatus()).state).toBe("unlinked");
  });

  it("never sends twice while a call runs", async () => {
    let finish: () => void = () => {};
    const login = vi.spyOn(commands, "syncLogin").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(backend().sync.get());
        }),
    );
    const { user, dialog } = await openAccount();
    await user.click(
      await within(dialog).findByRole("button", {
        name: "J'ai déjà un compte",
      }),
    );
    await fill(user, dialog, "user@exemple.fr", "un-bon-mot-de-passe");
    const button = within(dialog).getByRole("button", { name: "Se connecter" });
    await user.click(button);
    const busy = within(dialog).getByRole("button", { name: "Connexion…" });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    await user.keyboard("{Enter}");
    expect(login).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it("resets a forgotten password with the mailed code, then logs in", async () => {
    const forgot = vi.spyOn(commands, "syncForgotPassword");
    const reset = vi.spyOn(commands, "syncResetPassword");
    const login = vi.spyOn(commands, "syncLogin");
    const { user, dialog } = await openAccount();
    await user.click(
      await within(dialog).findByRole("button", {
        name: "J'ai déjà un compte",
      }),
    );
    await typeInto(
      user,
      within(dialog).getByLabelText("Adresse e-mail"),
      "user@exemple.fr",
    );
    await typeServer(user, dialog);
    await user.click(
      within(dialog).getByRole("button", { name: "Mot de passe oublié ?" }),
    );
    // The e-mail typed is kept.
    expect(within(dialog).getByLabelText("Adresse e-mail")).toHaveValue(
      "user@exemple.fr",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Envoyer le code" }),
    );
    expect(forgot).toHaveBeenCalledWith({
      serverUrl: SERVER,
      email: "user@exemple.fr",
    });
    expect(
      await within(dialog).findByText(
        "On t'a envoyé un code à user@exemple.fr. Il est valable 30 minutes.",
      ),
    ).toBeInTheDocument();

    const code = within(dialog).getByLabelText("Code reçu par e-mail");
    const fresh = within(dialog).getByLabelText("Nouveau mot de passe");
    await user.type(code, "000000");
    await user.type(fresh, "un-nouveau-mot-de-passe");
    await user.click(
      within(dialog).getByRole("button", { name: "Changer le mot de passe" }),
    );
    await waitFor(() =>
      expect(code).toHaveAccessibleDescription(
        "Code faux ou expiré. Demande un nouveau code.",
      ),
    );
    expect(login).not.toHaveBeenCalled();

    await typeInto(user, code, "123456");
    await user.click(
      within(dialog).getByRole("button", { name: "Changer le mot de passe" }),
    );
    expect(await within(dialog).findByText("user@exemple.fr")).toBeVisible();
    expect(reset).toHaveBeenLastCalledWith({
      serverUrl: SERVER,
      email: "user@exemple.fr",
      code: "123456",
      password: "un-nouveau-mot-de-passe",
    });
    expect(login).toHaveBeenCalledWith({
      serverUrl: SERVER,
      email: "user@exemple.fr",
      password: "un-nouveau-mot-de-passe",
    });
    expect((await commands.syncStatus()).state).toBe("idle");
    expect(useToasts.getState().toasts[0]?.message).toBe(
      "Mot de passe changé. Tu es connecté.",
    );
  });

  it("signs up a Mac holding projects without asking", async () => {
    await commands.createSubject({
      name: "Taido",
      color: "blue",
      rootPath: null,
      parentId: null,
    });
    const signup = vi.spyOn(commands, "syncSignup");
    const { user, dialog } = await openAccount();
    await user.click(
      await within(dialog).findByRole("button", { name: "Créer un compte" }),
    );
    await fill(user, dialog, "user@exemple.fr", "un-bon-mot-de-passe");
    await user.click(
      within(dialog).getByRole("button", { name: "Créer mon compte" }),
    );
    await waitFor(() => expect(signup).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole("dialog", { name: "Fusionner avec ce compte ?" }),
    ).toBeNull();
  });

  it("asks before merging this Mac's projects into an existing account", async () => {
    await commands.createTask({
      title: "Une tâche sans projet",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    const login = vi.spyOn(commands, "syncLogin");
    const { user, dialog } = await openAccount();
    await user.click(
      await within(dialog).findByRole("button", {
        name: "J'ai déjà un compte",
      }),
    );
    await fill(user, dialog, "user@exemple.fr", "un-bon-mot-de-passe");
    await user.click(
      within(dialog).getByRole("button", { name: "Se connecter" }),
    );
    const confirm = await screen.findByRole("dialog", {
      name: "Fusionner avec ce compte ?",
    });
    expect(confirm).toHaveTextContent(
      "Cet appareil contient déjà des projets. Ils seront ajoutés à ceux du compte user@exemple.fr.",
    );
    await user.click(within(confirm).getByRole("button", { name: "Annuler" }));
    expect(login).not.toHaveBeenCalled();
    expect((await commands.syncStatus()).state).toBe("unlinked");

    await user.click(
      within(dialog).getByRole("button", { name: "Se connecter" }),
    );
    await user.click(
      within(
        await screen.findByRole("dialog", {
          name: "Fusionner avec ce compte ?",
        }),
      ).getByRole("button", { name: "Fusionner" }),
    );
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
    expect(await within(dialog).findByText("user@exemple.fr")).toBeVisible();
  });

  it("logs in an empty Mac without asking", async () => {
    const login = vi.spyOn(commands, "syncLogin");
    const { user, dialog } = await openAccount();
    await user.click(
      await within(dialog).findByRole("button", {
        name: "J'ai déjà un compte",
      }),
    );
    await fill(user, dialog, "user@exemple.fr", "un-bon-mot-de-passe");
    await user.click(
      within(dialog).getByRole("button", { name: "Se connecter" }),
    );
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole("dialog", { name: "Fusionner avec ce compte ?" }),
    ).toBeNull();
  });

  it("syncs before logging out, and warns when changes are left", async () => {
    await backend().sync.signup({
      serverUrl: SERVER,
      email: "user@exemple.fr",
      password: "un-bon-mot-de-passe",
    });
    const now = vi.spyOn(commands, "syncNow");
    const { user, dialog } = await openAccount();
    await within(dialog).findByText("user@exemple.fr");

    // A clean sync: the plain confirmation.
    await user.click(
      within(dialog).getByRole("button", { name: "Se déconnecter" }),
    );
    const plain = await screen.findByRole("dialog", {
      name: "Se déconnecter du compte ?",
    });
    expect(now).toHaveBeenCalledTimes(1);
    await user.click(within(plain).getByRole("button", { name: "Annuler" }));
    expect((await commands.syncStatus()).state).toBe("idle");

    // Changes left after the sync: the warning, « Se déconnecter quand même ».
    now.mockResolvedValueOnce({
      ...backend().sync.get(),
      state: "offline",
      pending: 3,
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Se déconnecter" }),
    );
    const warning = await screen.findByRole("dialog", {
      name: "Modifications pas encore envoyées",
    });
    expect(warning).toHaveTextContent(
      "3 modifications n'ont pas encore été envoyées au compte. Elles restent sur cet appareil et partiront à ta prochaine connexion.",
    );
    await user.click(
      within(warning).getByRole("button", {
        name: "Se déconnecter quand même",
      }),
    );
    await waitFor(async () =>
      expect((await commands.syncStatus()).state).toBe("unlinked"),
    );
    expect(
      await within(dialog).findByRole("button", { name: "Créer un compte" }),
    ).toBeInTheDocument();
    expect(useToasts.getState().toasts[0]?.message).toBe(
      "Déconnecté. Tes projets restent sur cet appareil.",
    );
  });

  it("puts throttling and mail errors of the forgotten password under the form", async () => {
    const { user, dialog } = await openAccount();
    await user.click(
      await within(dialog).findByRole("button", {
        name: "J'ai déjà un compte",
      }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Mot de passe oublié ?" }),
    );
    const email = within(dialog).getByLabelText("Adresse e-mail");
    await typeInto(user, email, "bloque@exemple.fr");
    await typeServer(user, dialog);
    await user.click(
      within(dialog).getByRole("button", { name: "Envoyer le code" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Trop d'essais. Attends quelques minutes avant de réessayer.",
    );
    expect(email).not.toHaveAttribute("aria-invalid");

    await typeInto(user, email, "user@exemple.fr");
    await typeInto(
      user,
      within(dialog).getByLabelText("Adresse du serveur"),
      "https://sans-mail.exemple.fr",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Envoyer le code" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Le serveur ne peut pas envoyer d'e-mails pour le moment. Réessaie plus tard.",
    );
    // Still on the e-mail step.
    expect(within(dialog).queryByLabelText("Code reçu par e-mail")).toBeNull();
  });

  it("after a reset whose login fails, retries only the login", async () => {
    const reset = vi.spyOn(commands, "syncResetPassword");
    const login = vi
      .spyOn(commands, "syncLogin")
      .mockRejectedValueOnce({ kind: "sync_offline", message: "unreachable" });
    const { user, dialog } = await openAccount();
    await user.click(
      await within(dialog).findByRole("button", {
        name: "J'ai déjà un compte",
      }),
    );
    await typeInto(
      user,
      within(dialog).getByLabelText("Adresse e-mail"),
      "user@exemple.fr",
    );
    await typeServer(user, dialog);
    await user.click(
      within(dialog).getByRole("button", { name: "Mot de passe oublié ?" }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Envoyer le code" }),
    );
    await user.type(
      await within(dialog).findByLabelText("Code reçu par e-mail"),
      "123456",
    );
    await user.type(
      within(dialog).getByLabelText("Nouveau mot de passe"),
      "un-nouveau-mot-de-passe",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Changer le mot de passe" }),
    );
    // Back on the login form, e-mail and new password kept, the failure said.
    expect(
      await within(dialog).findByText("Mot de passe changé. Connecte-toi."),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Serveur injoignable. Vérifie ta connexion.",
    );
    expect(within(dialog).getByLabelText("Adresse e-mail")).toHaveValue(
      "user@exemple.fr",
    );
    expect(within(dialog).getByLabelText("Mot de passe")).toHaveValue(
      "un-nouveau-mot-de-passe",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Se connecter" }),
    );
    expect(await within(dialog).findByText("user@exemple.fr")).toBeVisible();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(login).toHaveBeenCalledTimes(2);
  });

  it("asks the merge question of a reset only once the code is accepted", async () => {
    await commands.createSubject({
      name: "Client Dupont",
      color: null,
      rootPath: null,
      parentId: null,
    });
    const { user, dialog } = await openAccount();
    await user.click(
      await within(dialog).findByRole("button", {
        name: "J'ai déjà un compte",
      }),
    );
    await typeInto(
      user,
      within(dialog).getByLabelText("Adresse e-mail"),
      "user@exemple.fr",
    );
    await typeServer(user, dialog);
    await user.click(
      within(dialog).getByRole("button", { name: "Mot de passe oublié ?" }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Envoyer le code" }),
    );
    const code = await within(dialog).findByLabelText("Code reçu par e-mail");
    await user.type(code, "000000");
    await user.type(
      within(dialog).getByLabelText("Nouveau mot de passe"),
      "un-nouveau-mot-de-passe",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Changer le mot de passe" }),
    );
    await waitFor(() =>
      expect(code).toHaveAccessibleDescription(
        "Code faux ou expiré. Demande un nouveau code.",
      ),
    );
    expect(
      screen.queryByRole("dialog", { name: "Fusionner avec ce compte ?" }),
    ).toBeNull();
    await typeInto(user, code, "123456");
    await user.click(
      within(dialog).getByRole("button", { name: "Changer le mot de passe" }),
    );
    await user.click(
      within(
        await screen.findByRole("dialog", {
          name: "Fusionner avec ce compte ?",
        }),
      ).getByRole("button", { name: "Fusionner" }),
    );
    expect(await within(dialog).findByText("user@exemple.fr")).toBeVisible();
  });

  it("warns when the sync before logging out is offline", async () => {
    await backend().sync.signup({
      serverUrl: SERVER,
      email: "user@exemple.fr",
      password: "un-bon-mot-de-passe",
    });
    vi.spyOn(commands, "syncNow").mockRejectedValueOnce({
      kind: "sync_offline",
      message: "unreachable",
    });
    const { user, dialog } = await openAccount();
    await within(dialog).findByText("user@exemple.fr");
    await user.click(
      within(dialog).getByRole("button", { name: "Se déconnecter" }),
    );
    const warning = await screen.findByRole("dialog", {
      name: "Modifications pas encore envoyées",
    });
    expect(warning).toHaveTextContent(/La synchro n'a pas pu se faire/);
    await user.click(
      within(warning).getByRole("button", {
        name: "Se déconnecter quand même",
      }),
    );
    await waitFor(async () =>
      expect((await commands.syncStatus()).state).toBe("unlinked"),
    );
  });

  it("cannot log out while a sync runs", async () => {
    await backend().sync.signup({
      serverUrl: SERVER,
      email: "user@exemple.fr",
      password: "un-bon-mot-de-passe",
    });
    const { dialog } = await openAccount();
    await within(dialog).findByText("user@exemple.fr");
    act(() => {
      backend().sync.set({ state: "syncing" });
    });
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Se déconnecter" }),
      ).toBeDisabled(),
    );
  });

  it("warns when the last sync fails", async () => {
    await backend().sync.signup({
      serverUrl: SERVER,
      email: "user@exemple.fr",
      password: "un-bon-mot-de-passe",
    });
    vi.spyOn(commands, "syncNow").mockRejectedValueOnce({
      kind: "internal",
      message: "boom",
    });
    const { user, dialog } = await openAccount();
    await within(dialog).findByText("user@exemple.fr");
    await user.click(
      within(dialog).getByRole("button", { name: "Se déconnecter" }),
    );
    const warning = await screen.findByRole("dialog", {
      name: "Modifications pas encore envoyées",
    });
    expect(warning).toHaveTextContent(/La synchro n'a pas pu se faire/);
    await user.click(within(warning).getByRole("button", { name: "Annuler" }));
    expect((await commands.syncStatus()).state).toBe("idle");
  });
});
