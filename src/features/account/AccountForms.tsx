/**
 * The account forms of the Mac (Taido V2.7), shown by the welcome screen and Réglages › Compte:
 * create an account, log in, forgotten password (e-mail → code sent → code and new password →
 * logged in).
 *
 * - Each error goes under its field (e-mail, password, code, server address); network and
 *   server errors under the form. The button shows the call running and the form never sends
 *   twice.
 * - The server address is a visible, required field. There is no built-in server: it starts
 *   from the address kept from the last link (docs/SYNC.md § 0.10 rule 2), else empty.
 * - While a call runs, nothing switches form (the buttons and links that change mode, and
 *   « Retour », are disabled), so its answer lands on the form that sent it.
 * - Logging in to an existing account while this Mac holds projects or tasks asks first: they
 *   are merged into the account's. A new account takes them without asking.
 * - `sync_reset_password` does not log in: a successful reset chains `sync_login`.
 */

import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Eye, EyeOff } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { SyncStatus } from "../../bindings";
import { Button, IconButton } from "../../components/Button";
import { showToast } from "../../components/Toast";
import { fr } from "../../i18n/fr";
import { commands, errorKind, errorMessage } from "../../lib/ipc";
import { ALREADY_LINKED } from "../../lib/mock-sync";
import {
  confirmMerge,
  inputClass,
  linkErrorText,
  useHoldsData,
} from "../sync/SyncParts";
import { setSyncStatus, useSyncStatus } from "../sync/useSyncStatus";

export type AccountMode = "signup" | "login" | "forgot" | "reset";

/** Where an error shows: under a field, or under the form. */
export type ErrorPlace = "email" | "password" | "code" | "server" | "form";

export interface PlacedError {
  place: ErrorPlace;
  text: string;
}

/** Fields each form shows. */
const FIELDS: Record<AccountMode, readonly ErrorPlace[]> = {
  signup: ["email", "password", "server"],
  login: ["email", "password", "server"],
  forgot: ["email", "server"],
  reset: ["code", "password", "server"],
};

/** The French text of a failed account command and the field it belongs to in `mode`. */
export function placeError(error: unknown, mode: AccountMode): PlacedError {
  const text = linkErrorText(error);
  let place: ErrorPlace;
  switch (errorKind(error)) {
    case "sync_email_taken":
    case "sync_bad_email":
      place = "email";
      break;
    case "sync_weak_password":
    case "sync_auth":
      place = "password";
      break;
    case "sync_invalid_code":
      place = "code";
      break;
    case "invalid":
      place = errorMessage(error).includes(ALREADY_LINKED) ? "form" : "server";
      break;
    default:
      place = "form";
  }
  return { place: FIELDS[mode].includes(place) ? place : "form", text };
}

/** After any successful link: the status and a toast. */
function linked(
  client: ReturnType<typeof useQueryClient>,
  status: SyncStatus,
  toast: string,
): void {
  setSyncStatus(client, status);
  showToast({ message: toast });
}

function FieldError({ id, text }: { id: string; text: string }) {
  return (
    <p
      id={id}
      aria-live="polite"
      className="flex items-start gap-1.5 text-[12.5px] font-medium text-text"
    >
      <CircleAlert size={14} aria-hidden className="mt-px shrink-0" />
      {text}
    </p>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[13.5px] font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

const describedBy = (...ids: (string | false | undefined)[]) =>
  ids.filter(Boolean).join(" ") || undefined;

export interface AccountFormProps {
  initialMode: AccountMode;
  /** « Retour » of the create / log in forms (back to the two buttons); none when omitted. */
  onCancel?: () => void;
  /** Called once logged in. */
  onDone?: () => void;
  /** Told when a call starts and ends (the welcome cannot be closed meanwhile). */
  onBusyChange?: (busy: boolean) => void;
}

export function AccountForm({
  initialMode,
  onCancel,
  onDone,
  onBusyChange,
}: AccountFormProps) {
  const client = useQueryClient();
  const holdsData = useHoldsData();
  const [mode, setMode] = useState<AccountMode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  // Both callers render once the status is read; the kept address of a past link wins.
  const keptServerUrl = useSyncStatus().data?.serverUrl ?? null;
  const [serverUrl, setServerUrl] = useState<string>(keptServerUrl ?? "");
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<PlacedError | null>(null);
  const [busy, setBusy] = useState(false);
  /** « Mot de passe changé. Connecte-toi. » after a reset whose login did not go through. */
  const [notice, setNotice] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only `busy` matters.
  useEffect(() => {
    onBusyChange?.(busy);
    // Unmounted during a call: the parent is never left busy.
    return () => onBusyChange?.(false);
  }, [busy]);
  // A ref, not the state: two submits in the same tick both see `busy` false.
  const sending = useRef(false);
  const firstRef = useRef<HTMLInputElement>(null);

  const ids = {
    email: useId(),
    password: useId(),
    passwordRule: useId(),
    code: useId(),
    codeSent: useId(),
    server: useId(),
    serverHelp: useId(),
    error: useId(),
  };

  // Each form starts on its first field.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus on each form change.
  useEffect(() => {
    firstRef.current?.focus();
  }, [mode]);

  // The field in error takes the focus, so it can be fixed at once (each new error).
  const errorFieldId =
    error === null || error.place === "form" ? null : ids[error.place];
  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus on each new error.
  useEffect(() => {
    if (errorFieldId) document.getElementById(errorFieldId)?.focus();
  }, [error]);

  const go = (next: AccountMode) => {
    setMode(next);
    setError(null);
    setNotice(null);
    setPassword("");
    setShown(false);
    if (next === "reset") setCode("");
  };

  const ready = (() => {
    const hasEmail = email.trim().length > 0;
    switch (mode) {
      case "signup":
      case "login":
        return hasEmail && password.length > 0;
      case "forgot":
        return hasEmail;
      case "reset":
        return code.trim().length > 0 && password.length > 0;
    }
  })();

  /** Logging in to an existing account merges this Mac's projects: asked first. */
  const mergeAccepted = (): Promise<boolean> => confirmMerge(holdsData, email);

  const call = async () => {
    const url = serverUrl.trim();
    const account = { serverUrl: url, email: email.trim(), password };
    switch (mode) {
      case "signup": {
        const next = await commands.syncSignup(account);
        linked(client, next, fr.account.signedUpToast);
        onDone?.();
        return;
      }
      case "login": {
        if (!(await mergeAccepted())) return;
        const next = await commands.syncLogin(account);
        linked(client, next, fr.account.loggedInToast);
        onDone?.();
        return;
      }
      case "forgot":
        await commands.syncForgotPassword({
          serverUrl: url,
          email: email.trim(),
        });
        go("reset");
        return;
      case "reset": {
        await commands.syncResetPassword({
          serverUrl: url,
          email: email.trim(),
          code: code.trim(),
          password,
        });
        // The code is used now: whatever happens next is a plain login with the new
        // password (kept typed), never a second reset.
        const toLogin = (failure: unknown) => {
          setMode("login");
          setNotice(fr.account.resetThenLogin);
          if (failure !== null) setError(placeError(failure, "login"));
        };
        // Asked once the code is accepted, so a wrong code never asks it twice.
        if (!(await mergeAccepted())) {
          toLogin(null);
          return;
        }
        let next: SyncStatus;
        try {
          next = await commands.syncLogin(account);
        } catch (failure) {
          console.error(errorMessage(failure), failure);
          toLogin(failure);
          return;
        }
        linked(client, next, fr.account.resetToast);
        onDone?.();
        return;
      }
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || sending.current) return;
    // No built-in server: an empty address is asked for, nothing is sent.
    if (serverUrl.trim().length === 0) {
      setError({ place: "server", text: fr.account.serverRequired });
      return;
    }
    sending.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await call();
    } catch (err) {
      console.error(errorMessage(err), err);
      const placed = placeError(err, mode);
      setError(placed);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const errorAt = (place: ErrorPlace) =>
    error?.place === place ? error.text : null;
  const invalid = (place: ErrorPlace) =>
    error?.place === place ? true : undefined;
  const clearError = () => setError(null);

  const emailError = errorAt("email");
  const passwordError = errorAt("password");
  const codeError = errorAt("code");
  const serverError = errorAt("server");
  const formError = errorAt("form");
  const newPassword = mode === "signup" || mode === "reset";

  return (
    <form
      onSubmit={(e) => void submit(e)}
      noValidate
      className="flex max-w-[420px] flex-col gap-4"
    >
      <h3 className="text-[15px] font-semibold">{fr.account.title[mode]}</h3>
      {notice && (
        <p role="status" className="-mt-2 text-[13px] font-medium text-text">
          {notice}
        </p>
      )}
      {mode === "forgot" && (
        <p className="-mt-2 text-[13px] text-text-2">{fr.account.forgotHelp}</p>
      )}
      {mode === "reset" && (
        <p
          id={ids.codeSent}
          role="status"
          className="-mt-2 text-[13px] text-text-2"
        >
          {fr.account.codeSent(email.trim())}
        </p>
      )}

      {mode !== "reset" && (
        <Field label={fr.account.email} htmlFor={ids.email}>
          <input
            ref={firstRef}
            id={ids.email}
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              clearError();
            }}
            placeholder={fr.account.emailPlaceholder}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="email"
            aria-invalid={invalid("email")}
            aria-describedby={describedBy(emailError !== null && ids.error)}
            className={inputClass}
          />
          {emailError && <FieldError id={ids.error} text={emailError} />}
        </Field>
      )}

      {mode === "reset" && (
        <Field label={fr.account.code} htmlFor={ids.code}>
          <input
            ref={firstRef}
            id={ids.code}
            type="text"
            inputMode="numeric"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              clearError();
            }}
            spellCheck={false}
            autoComplete="one-time-code"
            aria-invalid={invalid("code")}
            aria-describedby={describedBy(codeError !== null && ids.error)}
            className={`${inputClass} max-w-[160px] tracking-[0.2em]`}
          />
          {codeError && <FieldError id={ids.error} text={codeError} />}
        </Field>
      )}

      {mode !== "forgot" && (
        <Field
          label={
            mode === "reset" ? fr.account.newPassword : fr.account.password
          }
          htmlFor={ids.password}
        >
          <div className="relative">
            <input
              id={ids.password}
              type={shown ? "text" : "password"}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                clearError();
              }}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete={newPassword ? "new-password" : "current-password"}
              aria-invalid={invalid("password")}
              aria-describedby={describedBy(
                passwordError !== null && ids.error,
                newPassword && passwordError === null && ids.passwordRule,
              )}
              className={`${inputClass} pr-9`}
            />
            <IconButton
              label={shown ? fr.account.hidePassword : fr.account.showPassword}
              size={26}
              onClick={() => setShown((v) => !v)}
              className="absolute top-[3px] right-[3px]"
            >
              {shown ? (
                <EyeOff size={15} aria-hidden />
              ) : (
                <Eye size={15} aria-hidden />
              )}
            </IconButton>
          </div>
          {passwordError && <FieldError id={ids.error} text={passwordError} />}
          {newPassword && passwordError === null && (
            <p id={ids.passwordRule} className="text-[12.5px] text-text-2">
              {fr.account.passwordRule}
            </p>
          )}
          {mode === "login" && (
            <div>
              <button
                type="button"
                disabled={busy}
                onClick={() => go("forgot")}
                className="text-[12.5px] text-text-2 underline-offset-2 hover:text-text hover:underline disabled:opacity-50 disabled:hover:text-text-2 disabled:hover:no-underline"
              >
                {fr.account.forgotLink}
              </button>
            </div>
          )}
        </Field>
      )}

      <Field label={fr.account.serverUrl} htmlFor={ids.server}>
        <input
          id={ids.server}
          type="url"
          inputMode="url"
          value={serverUrl}
          onChange={(e) => {
            setServerUrl(e.target.value);
            clearError();
          }}
          placeholder={fr.account.serverUrlPlaceholder}
          required
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="url"
          aria-invalid={invalid("server")}
          aria-describedby={describedBy(
            serverError !== null && ids.error,
            ids.serverHelp,
          )}
          className={inputClass}
        />
        {serverError && <FieldError id={ids.error} text={serverError} />}
        <p id={ids.serverHelp} className="text-[12.5px] text-text-2">
          {fr.account.serverHelp}
        </p>
      </Field>

      {formError && (
        <p
          id={ids.error}
          role="alert"
          className="flex items-start gap-1.5 text-[12.5px] font-medium text-text"
        >
          <CircleAlert size={14} aria-hidden className="mt-px shrink-0" />
          {formError}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          type="submit"
          variant="primary"
          disabled={!ready || busy}
          aria-busy={busy || undefined}
        >
          {busy ? fr.account.busy[mode] : fr.account.submit[mode]}
        </Button>
        {mode === "signup" && (
          <Button variant="ghost" disabled={busy} onClick={() => go("login")}>
            {fr.account.toLogin}
          </Button>
        )}
        {mode === "login" && (
          <Button variant="ghost" disabled={busy} onClick={() => go("signup")}>
            {fr.account.toSignup}
          </Button>
        )}
        {mode === "reset" && (
          <Button variant="ghost" disabled={busy} onClick={() => go("forgot")}>
            {fr.account.newCode}
          </Button>
        )}
        {mode === "forgot" && (
          <Button variant="ghost" disabled={busy} onClick={() => go("login")}>
            {fr.account.back}
          </Button>
        )}
        {(mode === "signup" || mode === "login") && onCancel && (
          <Button
            variant="ghost"
            className="ml-auto"
            disabled={busy}
            onClick={onCancel}
          >
            {fr.account.back}
          </Button>
        )}
      </div>
    </form>
  );
}
