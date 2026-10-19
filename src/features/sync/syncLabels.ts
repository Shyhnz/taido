/** Texts of the sync status (docs/SYNC.md § 5), shared by the button and Réglages. */

import type { SyncStatus } from "../../bindings";
import { t } from "../../i18n";
import { formatRelative } from "../../lib/dates";

/** « Dernière synchro : il y a 8 min » or « Jamais synchronisé ». */
export function lastSyncText(status: SyncStatus, now: Date): string {
  return status.lastSyncAt
    ? t.sync.lastSync(formatRelative(status.lastSyncAt, now))
    : t.sync.never;
}

/**
 * Second half of the button label: the error text while in error, else the last sync, plus
 * the changes waiting to be sent when up to date.
 */
export function syncDetail(status: SyncStatus, now: Date): string | null {
  if (status.state === "unlinked") return null;
  if (status.state === "error") {
    return t.sync.error[status.errorKind ?? "internal"];
  }
  const last = lastSyncText(status, now);
  if (status.state === "idle" && status.pending > 0) {
    return `${last} · ${t.sync.pending(status.pending)}`;
  }
  return last;
}

/** Tooltip and accessible name of the sync button. */
export function syncButtonLabel(status: SyncStatus, now: Date): string {
  return t.sync.buttonLabel(
    t.sync.state[status.state],
    syncDetail(status, now),
  );
}
