/** Root of the phone app: the same query client and core events as the desktop `App`. */

import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  createQueryClient,
  subscribeToCoreEvents,
  watchDayChange,
} from "../lib/queries";
import type { MobileBackend } from "./backend";
import { MobileShell } from "./MobileShell";

export default function MobileApp({
  backend,
  client,
}: {
  backend: MobileBackend;
  client?: QueryClient;
}) {
  const [queryClient] = useState(() => client ?? createQueryClient());
  useEffect(() => subscribeToCoreEvents(queryClient), [queryClient]);
  useEffect(() => watchDayChange(queryClient), [queryClient]);
  return (
    <QueryClientProvider client={queryClient}>
      <MobileShell backend={backend} />
    </QueryClientProvider>
  );
}
