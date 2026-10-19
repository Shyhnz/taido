/** Texts of the sync status (docs/SYNC.md § 5), shared by the button and Réglages. */

import type { SyncStatus } from "../../bindings";
import { fr } from "../../i18n/fr";
import { formatRelative } from "../../lib/dates";

/** « Dernière synchro : il y a 8 min » or « Jamais synchronisé ». */
export function lastSyncText(status: SyncStatus, now: Date): string {
  return status.lastSyncAt
    ? fr.sync.lastSync(formatRelative(status.lastSyncAt, now))
    : fr.sync.never;
}

/**
 * Second half of the button label: the error text while in error, else the last sync, plus
 * the changes waiting to be sent when up to date.
 */
export function syncDetail(status: SyncStatus, now: Date): string | null {
  if (status.state === "unlinked") return null;
  if (status.state === "error") {
    return fr.sync.error[status.errorKind ?? "internal"];
  }
  const last = lastSyncText(status, now);
  if (status.state === "idle" && status.pending > 0) {
    return `${last} · ${fr.sync.pending(status.pending)}`;
  }
  return last;
}

/** Tooltip and accessible name of the sync button. */
export function syncButtonLabel(status: SyncStatus, now: Date): string {
  return fr.sync.buttonLabel(
    fr.sync.state[status.state],
    syncDetail(status, now),
  );
}
