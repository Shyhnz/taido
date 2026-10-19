/**
 * Sync status shared by the sidebar button, Réglages › Synchro and the phone's top bar
 *. One React Query entry, `["sync-status"]`, read once from
 * `sync_status` and then replaced in place by every `sync-changed` event.
 */

import {
  type QueryClient,
  type UseQueryResult,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { SyncStatus } from "../../bindings";
import { commands, events } from "../../lib/ipc";

export const SYNC_STATUS_KEY = ["sync-status"] as const;

/** Stores a status returned by a command or carried by an event. */
export function setSyncStatus(client: QueryClient, status: SyncStatus): void {
  client.setQueryData<SyncStatus>(SYNC_STATUS_KEY, status);
}

export function useSyncStatus(): UseQueryResult<SyncStatus> {
  const client = useQueryClient();
  useEffect(() => {
    const unlisten = events.syncChanged.listen(({ payload }) =>
      setSyncStatus(client, payload.status),
    );
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [client]);
  return useQuery({
    queryKey: SYNC_STATUS_KEY,
    queryFn: commands.syncStatus,
  });
}

/** Refresh period of the « il y a 8 min » texts. */
export const RELATIVE_TICK_MS = 30_000;

/** The current time, refreshed every 30 s so relative times stay true. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), RELATIVE_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}
