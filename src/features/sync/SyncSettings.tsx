/**
 * Réglages › Synchro on the phone, Réglages › Compte on the Mac (docs/SYNC.md § 5).
 *
 * - Mac: the account screens of src/features/account/ (create an account, log in, forgotten
 *   password; once logged in the e-mail, the state and « Se déconnecter »).
 * - Phone, not linked: what is synced, the e-mail, the password and the server address,
 *   « Se connecter » (`sync_login`). The address is prefilled with the last one used, else
 *   `defaultServerUrl` (the phone passes its own origin: the server serves the app), else
 *   only a placeholder. No signup nor password reset on the phone in V2.7: two lines send to
 *   the Mac for those. Like the Mac, when the phone holds projects or tasks, « Fusionner » /
 *   « Annuler » is asked before the login.
 * - Phone, linked: the account's e-mail, the server, the state and the last sync,
 *   « Synchroniser », the interval and « Se déconnecter » (the Mac's flow: one last sync, a
 *   warning when changes are still pending; the data stays on this device). When the server
 *   refused the token (`unauthorized`), e-mail and password fields and « Se reconnecter » log
 *   this device in again to the same account.
 */

import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, RefreshCw } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import type { SyncStatus } from "../../bindings";
import { Button } from "../../components/Button";
import { showToast } from "../../components/Toast";
import { t } from "../../i18n";
import { commands, errorMessage } from "../../lib/ipc";
import { run } from "../../lib/run";
import { IS_MOBILE } from "../../lib/target";
import { AccountSettings } from "../account/AccountSettings";
import {
  confirmMerge,
  IntervalSetting,
  inputClass,
  linkErrorText,
  ReconnectForm,
  StateLine,
  UnconfirmedLine,
  useAccount,
  useHoldsData,
  useLogout,
} from "./SyncParts";
import { setSyncStatus, useSyncStatus } from "./useSyncStatus";

export { linkErrorText } from "./SyncParts";

export interface SyncSettingsProps {
  /** Prefilled server address when none was used yet (the phone: `location.origin`). */
  defaultServerUrl?: string;
}

function LinkForm({
  status,
  defaultServerUrl,
}: {
  status: SyncStatus;
  defaultServerUrl?: string;
}) {
  const client = useQueryClient();
  const [serverUrl, setServerUrl] = useState(
    status.serverUrl ?? defaultServerUrl ?? "",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const holdsData = useHoldsData();
  const urlId = useId();
  const emailId = useId();
  const passwordId = useId();
  const forgotId = useId();
  const errorId = useId();
  const ready =
    serverUrl.trim().length > 0 &&
    email.trim().length > 0 &&
    password.length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      // This phone's projects would go into the account: asked first, as on the Mac.
      if (!(await confirmMerge(holdsData, email))) return;
      const next = await commands.syncLogin({
        serverUrl: serverUrl.trim(),
        email: email.trim(),
        password,
      });
      setPassword("");
      setSyncStatus(client, next);
      showToast({ message: t.sync.linkedToast });
    } catch (err) {
      console.error(errorMessage(err), err);
      setError(linkErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  const describedBy = error ? errorId : undefined;
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <p className="text-[13.5px]">
          {IS_MOBILE ? t.sync.introMobile : t.sync.intro}
        </p>
        <p className="text-[12.5px] text-text-2">{t.sync.privacy}</p>
      </div>
      <div className="flex max-w-[420px] flex-col gap-1.5">
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
          placeholder={t.sync.emailPlaceholder}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="email"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={inputClass}
        />
      </div>
      <div className="flex max-w-[420px] flex-col gap-1.5">
        <label htmlFor={passwordId} className="text-[13.5px] font-medium">
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
          aria-describedby={
            describedBy ? `${forgotId} ${describedBy}` : forgotId
          }
          className={inputClass}
        />
        <p id={forgotId} className="text-[12.5px] text-text-2">
          {t.sync.forgotOnMac}
        </p>
      </div>
      <div className="flex max-w-[420px] flex-col gap-1.5">
        <label htmlFor={urlId} className="text-[13.5px] font-medium">
          {t.sync.serverUrl}
        </label>
        <input
          id={urlId}
          type="url"
          inputMode="url"
          value={serverUrl}
          onChange={(e) => {
            setServerUrl(e.target.value);
            setError(null);
          }}
          placeholder={t.sync.serverUrlPlaceholder}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="url"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={inputClass}
        />
      </div>
      {error && (
        <p
          id={errorId}
          role="alert"
          className="flex max-w-[420px] items-start gap-1.5 text-[12.5px] font-medium text-text"
        >
          <CircleAlert size={14} aria-hidden className="mt-px shrink-0" />
          {error}
        </p>
      )}
      <div className="flex flex-col items-start gap-2">
        <Button
          type="submit"
          variant="primary"
          disabled={!ready || busy}
          aria-busy={busy || undefined}
        >
          {busy ? t.sync.linking : t.sync.link}
        </Button>
        <p className="text-[12.5px] text-text-2">{t.sync.signupOnMac}</p>
      </div>
    </form>
  );
}

function LinkedView({ status }: { status: SyncStatus }) {
  const client = useQueryClient();
  const account = useAccount(status).data;
  const [busy, setBusy] = useState(false);
  const { leaving, logout } = useLogout(status);

  const syncNow = async () => {
    setBusy(true);
    const next = await run(commands.syncNow());
    setBusy(false);
    if (next) setSyncStatus(client, next);
  };

  const syncing = busy || status.state === "syncing";
  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-3 border-b border-border-row pb-4">
        <div className="flex flex-col gap-1">
          {account && (
            <>
              <p className="text-[15px] font-semibold break-all">
                {account.email}
              </p>
              <UnconfirmedLine account={account} />
            </>
          )}
          <p
            className={
              account
                ? "text-[12.5px] break-all text-text-2"
                : "text-[13.5px] font-medium break-all"
            }
          >
            {t.sync.linkedTo(status.serverUrl ?? "")}
          </p>
        </div>
        <StateLine status={status} />
        {status.state === "error" &&
          status.errorKind === "unauthorized" &&
          status.serverUrl && <ReconnectForm serverUrl={status.serverUrl} />}
        <div>
          <Button
            size="sm"
            onClick={() => void syncNow()}
            disabled={syncing || leaving}
            aria-busy={syncing || undefined}
          >
            <RefreshCw
              size={14}
              aria-hidden
              className={syncing ? "motion-safe:animate-spin" : undefined}
            />
            {t.sync.syncNow}
          </Button>
        </div>
      </div>
      <IntervalSetting status={status} />
      <div className="pt-4">
        <Button
          onClick={() => void logout()}
          disabled={syncing || leaving}
          aria-busy={leaving || undefined}
        >
          {leaving ? t.account.loggingOut : t.account.logout}
        </Button>
      </div>
    </div>
  );
}

export function SyncSettings({ defaultServerUrl }: SyncSettingsProps) {
  const query = useSyncStatus();
  const status = query.data;

  if (query.isPending) {
    return (
      <p role="status" className="pt-1 text-[13px] text-text-2">
        {t.sync.loading}
      </p>
    );
  }
  if (query.isError || !status) {
    return (
      <div role="alert" className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-text">{t.sync.loadError}</p>
        <Button size="sm" onClick={() => void query.refetch()}>
          {t.common.retry}
        </Button>
      </div>
    );
  }
  if (!IS_MOBILE) return <AccountSettings status={status} />;
  return status.state === "unlinked" ? (
    <LinkForm status={status} defaultServerUrl={defaultServerUrl} />
  ) : (
    <LinkedView status={status} />
  );
}
