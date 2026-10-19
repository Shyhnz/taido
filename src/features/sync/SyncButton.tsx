/**
 * « Synchroniser »: an icon button left of Réglages in the
 * sidebar, or in the phone's top bar (44 px target). Hidden while no account is linked.
 *
 * Icon: `RefreshCw` (spinning while syncing), `CloudOff` when offline, a red `AlertCircle`
 * on error. Its tooltip and accessible name tell the state and the last sync.
 */

import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CloudOff, RefreshCw } from "lucide-react";
import { IconButton } from "../../components/Button";
import { commands } from "../../lib/ipc";
import { run } from "../../lib/run";
import { syncButtonLabel } from "./syncLabels";
import { setSyncStatus, useNow, useSyncStatus } from "./useSyncStatus";

export interface SyncButtonProps {
  /** `sidebar` (default, 28 px like the gear) or `topbar` (phone, 44 px target). */
  variant?: "sidebar" | "topbar";
}

export function SyncButton({ variant = "sidebar" }: SyncButtonProps) {
  const status = useSyncStatus().data;
  const client = useQueryClient();
  const now = useNow();
  if (!status || status.state === "unlinked") return null;

  const label = syncButtonLabel(status, now);
  const iconSize = variant === "topbar" ? 20 : 16;
  const icon =
    status.state === "offline" ? (
      <CloudOff size={iconSize} aria-hidden />
    ) : status.state === "error" ? (
      <AlertCircle
        size={iconSize}
        aria-hidden
        className="text-waiting-text"
        data-sync-error
      />
    ) : (
      <RefreshCw
        size={iconSize}
        aria-hidden
        className={
          status.state === "syncing" ? "motion-safe:animate-spin" : undefined
        }
      />
    );

  return (
    <IconButton
      label={label}
      size={variant === "topbar" ? 44 : 28}
      aria-busy={status.state === "syncing" || undefined}
      data-sync-state={status.state}
      onClick={async () => {
        // Never throws for a failed sync: the failure is in the returned status.
        const next = await run(commands.syncNow());
        if (next) setSyncStatus(client, next);
      }}
    >
      {icon}
    </IconButton>
  );
}
