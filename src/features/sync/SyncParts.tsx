/**
 * Pieces of the sync settings shared by the phone's Réglages › Synchro and the Mac's
 * Réglages › Compte: account error texts, the account, the merge
 * question before a login, « Se déconnecter » (sync first, warn), the state line, the
 * reconnect form and the interval. Both devices behave the same; only the texts that name
 * the device differ (`deviceTexts`).
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CircleAlert, CloudOff, RefreshCw } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import type { AccountInfo, SyncStatus } from "../../bindings";
import { Button } from "../../components/Button";
import { confirmDialog } from "../../components/Dialog";
import { showToast } from "../../components/Toast";
import { t } from "../../i18n";
import { commands, errorKind, errorMessage } from "../../lib/ipc";
import {
  ALREADY_LINKED,
  NOT_ON_THE_PHONE,
  SYNC_INTERVALS,
} from "../../lib/mock-sync";
import { useHasNoProjectTasks, useSubjects } from "../../lib/queries";
import { readableError, run } from "../../lib/run";
import { IS_MOBILE } from "../../lib/target";
import { lastSyncText } from "./syncLabels";
import { setSyncStatus, useNow } from "./useSyncStatus";

/** The account texts that name this device. */
interface DeviceTexts {
  mergeText: (email: string) => string;
  logoutText: string;
  logoutPending: (n: number) => string;
  logoutFailed: string;
  loggedOutToast: string;
}

/** « cet appareil », or « ce téléphone » on the phone. */
export const deviceTexts: DeviceTexts = IS_MOBILE ? t.account.phone : t.account;

/** French text of a failed account command (`sync_login`, `sync_signup`…). */
export function linkErrorText(error: unknown): string {
  const kind = errorKind(error);
  if (kind === "invalid" && errorMessage(error).includes(ALREADY_LINKED)) {
    return t.sync.accountError.alreadyLinked;
  }
  if (kind === "invalid" && errorMessage(error).includes(NOT_ON_THE_PHONE)) {
    return t.sync.accountError.notOnPhone;
  }
  switch (kind) {
    case "sync_auth":
    case "sync_rate_limited":
    case "sync_email_taken":
    case "sync_weak_password":
    case "sync_bad_email":
    case "sync_invalid_code":
    case "sync_mail_unavailable":
    case "sync_signups_closed":
    case "sync_offline":
    case "sync_server":
    case "invalid":
      return t.sync.accountError[kind];
    default:
      return readableError(error);
  }
}

/** The cached account, read again after each sync (it is refreshed then). */
export function useAccount(status: SyncStatus) {
  return useQuery({
    queryKey: ["sync-account", status.serverUrl, status.lastSyncAt],
    queryFn: commands.syncAccount,
  });
}

/**
 * « Adresse à confirmer » and « Renvoyer le mail » while the server says the address is not
 * confirmed (an account read from an older server has no flag: nothing shown).
 */
export function UnconfirmedLine({
  account,
}: {
  account: AccountInfo | null | undefined;
}) {
  const [sending, setSending] = useState(false);
  if (!account || account.emailVerified !== false) return null;
  const resend = async () => {
    setSending(true);
    const done = await run(commands.syncResendConfirmation());
    setSending(false);
    if (done !== undefined) {
      showToast({ message: t.account.resentToast(account.email) });
    }
  };
  return (
    <div className="flex flex-col gap-0.5 text-[13px]">
      <p className="flex flex-wrap items-center gap-x-2 text-text-2">
        <span className="font-medium text-text">{t.account.unconfirmed}</span>
        <button
          type="button"
          onClick={() => void resend()}
          disabled={sending}
          aria-busy={sending || undefined}
          className="text-accent underline-offset-2 hover:underline disabled:opacity-60"
        >
          {t.account.resend}
        </button>
      </p>
      <p className="text-[12.5px] text-text-3">{t.account.unconfirmedHelp}</p>
    </div>
  );
}

/** True unless this device surely holds no project and no task (unknown counts as holding). */
export function useHoldsData(): boolean {
  const subjects = useSubjects().data;
  const noProjectTasks = useHasNoProjectTasks();
  return (
    subjects === undefined || subjects.length > 0 || noProjectTasks !== false
  );
}

/**
 * Logging in to an existing account merges this device's projects into it: asked first
 * (« Fusionner » / « Annuler ») when it holds any. Resolves to whether to go on.
 */
export function confirmMerge(
  holdsData: boolean,
  email: string,
): Promise<boolean> {
  if (!holdsData) return Promise.resolve(true);
  return confirmDialog({
    title: t.account.mergeTitle,
    message: deviceTexts.mergeText(email.trim().toLowerCase()),
    confirmLabel: t.account.merge,
    danger: false,
  });
}

/**
 * « Se déconnecter »: one last sync, then out. When that sync failed or changes are still
 * pending, a warning first (« Se déconnecter quand même »); else the plain confirmation. The
 * projects always stay on this device. `leaving` is true while the last sync runs.
 */
export function useLogout(status: SyncStatus): {
  leaving: boolean;
  logout: () => Promise<void>;
} {
  const client = useQueryClient();
  const [leaving, setLeaving] = useState(false);

  const logout = async () => {
    setLeaving(true);
    let synced: SyncStatus | null = null;
    try {
      synced = await commands.syncNow();
      setSyncStatus(client, synced);
    } catch (error) {
      console.error(errorMessage(error), error);
    }
    setLeaving(false);
    const failed =
      synced === null || synced.state === "error" || synced.state === "offline";
    const pending = synced?.pending ?? status.pending;
    const ok = await confirmDialog(
      pending > 0 || failed
        ? {
            title: t.account.logoutPendingTitle,
            message:
              pending > 0
                ? deviceTexts.logoutPending(pending)
                : deviceTexts.logoutFailed,
            confirmLabel: t.account.logoutAnyway,
          }
        : {
            title: t.account.logoutTitle,
            message: deviceTexts.logoutText,
            confirmLabel: t.account.logout,
          },
    );
    if (!ok) return;
    const next = await run(commands.syncUnlink());
    if (!next) return;
    setSyncStatus(client, next);
    showToast({ message: deviceTexts.loggedOutToast });
  };

  return { leaving, logout };
}

export const inputClass =
  "h-8 w-full min-w-0 rounded-md border border-border bg-bg px-2.5 text-[13.5px] outline-none placeholder:text-text-3 focus:border-accent";

export function StateLine({ status }: { status: SyncStatus }) {
  const now = useNow();
  const Icon =
    status.state === "offline"
      ? CloudOff
      : status.state === "error"
        ? AlertCircle
        : RefreshCw;
  return (
    <div role="status" className="flex flex-col gap-1 text-[13px]">
      <p className="flex items-center gap-2">
        <Icon
          size={15}
          aria-hidden
          className={
            status.state === "error"
              ? "text-waiting-text"
              : status.state === "syncing"
                ? "text-text-2 motion-safe:animate-spin"
                : "text-text-2"
          }
        />
        <span>
          <span className="font-medium">{t.sync.state[status.state]}</span>{" "}
          <span className="text-text-2">· {lastSyncText(status, now)}</span>
        </span>
      </p>
      {status.state === "error" && (
        <p className="pl-[23px] text-text">
          {t.sync.error[status.errorKind ?? "internal"]}
        </p>
      )}
      {status.pending > 0 && (
        <p className="pl-[23px] text-text-2">
          {t.sync.pending(status.pending)}
        </p>
      )}
    </div>
  );
}

/**
 * The token was refused: the same server, the e-mail (prefilled with the cached account) and
 * the password again (docs/SYNC.md § 3.4).
 */
export function ReconnectForm({ serverUrl }: { serverUrl: string }) {
  const client = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailId = useId();
  const passwordId = useId();
  const helpId = useId();
  const errorId = useId();
  const ready = email.trim().length > 0 && password.length > 0;

  useEffect(() => {
    let live = true;
    commands
      .syncAccount()
      .then((account) => {
        if (live && account) setEmail((typed) => typed || account.email);
      })
      .catch((err: unknown) => console.error(errorMessage(err), err));
    return () => {
      live = false;
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await commands.syncLogin({
        serverUrl,
        email: email.trim(),
        password,
      });
      setPassword("");
      setSyncStatus(client, next);
      showToast({ message: t.sync.reconnectedToast });
    } catch (err) {
      console.error(errorMessage(err), err);
      setError(linkErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  const describedBy = error ? `${helpId} ${errorId}` : helpId;
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="flex max-w-[420px] flex-col gap-1.5 pl-[23px]"
    >
      <p id={helpId} className="text-[12.5px] text-text-2">
        {t.sync.reconnectHelp}
      </p>
      <label htmlFor={emailId} className="text-[13.5px] font-medium">
        {t.sync.email}
      </label>
      <input
        id={emailId}
        type="email"
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          setError(null);
        }}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="email"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={inputClass}
      />
      <label htmlFor={passwordId} className="pt-1 text-[13.5px] font-medium">
        {t.sync.password}
      </label>
      <input
        id={passwordId}
        type="password"
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
          setError(null);
        }}
        autoComplete="current-password"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={inputClass}
      />
      {error && (
        <p
          id={errorId}
          role="alert"
          className="flex items-start gap-1.5 text-[12.5px] font-medium text-text"
        >
          <CircleAlert size={14} aria-hidden className="mt-px shrink-0" />
          {error}
        </p>
      )}
      <div className="pt-1">
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={!ready || busy}
          aria-busy={busy || undefined}
        >
          {busy ? t.sync.linking : t.sync.reconnect}
        </Button>
      </div>
    </form>
  );
}

/** « Synchroniser toutes les » and its choices. */
export function IntervalSetting({ status }: { status: SyncStatus }) {
  const client = useQueryClient();
  const intervalId = useId();
  const helpId = useId();

  const changeInterval = async (minutes: number) => {
    const next = await run(
      commands.syncSetInterval(minutes),
      t.errors.action.settings,
    );
    if (next) setSyncStatus(client, next);
  };

  return (
    <div className="border-b border-border-row py-4">
      <label htmlFor={intervalId} className="text-[13.5px] font-medium">
        {t.sync.interval}
      </label>
      <p id={helpId} className="pt-0.5 text-[12.5px] text-text-2">
        {t.sync.intervalHelp}
      </p>
      <select
        id={intervalId}
        value={status.intervalMinutes}
        aria-describedby={helpId}
        onChange={(e) => void changeInterval(Number(e.target.value))}
        className="mt-2.5 h-8 rounded-md border border-border bg-bg px-2 text-[13.5px] outline-none focus:border-accent"
      >
        {SYNC_INTERVALS.map((m) => (
          <option key={m} value={m}>
            {t.sync.intervalOption(m)}
          </option>
        ))}
      </select>
    </div>
  );
}
