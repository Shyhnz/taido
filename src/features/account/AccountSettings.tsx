/**
 * Réglages › Compte on the Mac (Taido V2.7).
 *
 * - Not logged in: what an account gives, then the welcome's two buttons, which open the
 *   account forms here.
 * - Logged in: the e-mail, the sync
 *   state, « Synchroniser maintenant », the interval and « Se déconnecter ». Logging out first
 *   syncs; when changes could not be sent, it says so before going on. The projects always
 *   stay on this Mac.
 */

import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import type { SyncStatus } from "../../bindings";
import { Button } from "../../components/Button";
import { fr } from "../../i18n/fr";
import { commands } from "../../lib/ipc";
import { run } from "../../lib/run";
import {
  IntervalSetting,
  ReconnectForm,
  StateLine,
  UnconfirmedLine,
  useAccount,
  useLogout,
} from "../sync/SyncParts";
import { setSyncStatus } from "../sync/useSyncStatus";
import { AccountForm, type AccountMode } from "./AccountForms";

function SignedOut() {
  const [mode, setMode] = useState<AccountMode | null>(null);
  if (mode !== null) {
    return (
      <AccountForm
        key={mode}
        initialMode={mode}
        onCancel={() => setMode(null)}
      />
    );
  }
  return (
    <div className="flex max-w-[420px] flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <p className="text-[13.5px]">{fr.account.intro}</p>
        <p className="text-[12.5px] text-text-2">{fr.account.privacy}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => setMode("signup")}>
          {fr.account.start.signup}
        </Button>
        <Button onClick={() => setMode("login")}>
          {fr.account.start.login}
        </Button>
      </div>
    </div>
  );
}

function SignedIn({ status }: { status: SyncStatus }) {
  const client = useQueryClient();
  const account = useAccount(status).data;
  const [syncing, setSyncing] = useState(false);
  // One last sync, then out: a warning first when changes are still on this Mac only.
  const { leaving, logout } = useLogout(status);

  const syncNow = async () => {
    setSyncing(true);
    const next = await run(commands.syncNow());
    setSyncing(false);
    if (next) setSyncStatus(client, next);
  };

  const busy = syncing || leaving || status.state === "syncing";
  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-3 border-b border-border-row pb-4">
        <div className="flex flex-col gap-1">
          <p className="text-[15px] font-semibold break-all">
            {account?.email ?? "…"}
          </p>
          <UnconfirmedLine account={account} />
          {status.serverUrl && (
            <p className="text-[12.5px] break-all text-text-3">
              {fr.account.server(status.serverUrl)}
            </p>
          )}
        </div>
        <StateLine status={status} />
        {status.state === "error" &&
          status.errorKind === "unauthorized" &&
          status.serverUrl && <ReconnectForm serverUrl={status.serverUrl} />}
        <div>
          <Button
            size="sm"
            onClick={() => void syncNow()}
            disabled={busy}
            aria-busy={syncing || undefined}
          >
            <RefreshCw
              size={14}
              aria-hidden
              className={
                syncing || status.state === "syncing"
                  ? "motion-safe:animate-spin"
                  : undefined
              }
            />
            {fr.account.syncNow}
          </Button>
        </div>
      </div>
      <IntervalSetting status={status} />
      <div className="pt-4">
        <Button
          onClick={() => void logout()}
          disabled={busy}
          aria-busy={leaving || undefined}
        >
          {leaving ? fr.account.loggingOut : fr.account.logout}
        </Button>
      </div>
    </div>
  );
}

export function AccountSettings({ status }: { status: SyncStatus }) {
  return status.state === "unlinked" ? (
    <SignedOut />
  ) : (
    <SignedIn status={status} />
  );
}
