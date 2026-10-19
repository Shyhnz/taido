/**
 * Hook events of the « Diagnostic » tab of Réglages: the last
 * 200 events received from Claude Code, newest first, each with its time, event name,
 * terminal and raw payload (collapsed, pretty-printed).
 */

import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import type { HookEventLog } from "../../bindings";
import { Button } from "../../components/Button";
import { fr } from "../../i18n/fr";
import { commands } from "../../lib/ipc";
import { queryKeys } from "../../lib/queries";

export const HOOK_EVENTS_LIMIT = 200;

/** The payload as indented JSON; the raw text when it is not JSON. */
export function prettyPayload(payload: string): string {
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload;
  }
}

/** « 14:02:07 » for today, « 01/10 14:02:07 » for an older event. */
export function eventTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => n.toString().padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? time
    : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${time}`;
}

function EventItem({ event }: { event: HookEventLog }) {
  return (
    <li className="border-b border-border-row py-1.5 last:border-b-0">
      <details className="group/event">
        <summary className="flex cursor-pointer items-center gap-3 rounded-md px-1 py-0.5 text-[13px] hover:bg-hover">
          <time
            dateTime={event.receivedAt}
            className="w-[110px] shrink-0 font-mono text-[12px] text-text-2 tabular-nums"
          >
            {eventTime(event.receivedAt)}
          </time>
          <span className="min-w-0 flex-1 truncate font-medium">
            {event.event}
          </span>
          <span className="shrink-0 truncate font-mono text-[12px] text-text-3">
            {event.terminalId
              ? fr.diagnostic.terminal(event.terminalId)
              : fr.diagnostic.noTerminal}
          </span>
        </summary>
        <pre
          data-payload
          title={fr.diagnostic.payload}
          className="mt-1 mb-1 max-h-[280px] overflow-auto rounded-md bg-aside p-2.5 font-mono text-[12px] leading-[18px] whitespace-pre-wrap break-all text-text"
        >
          {prettyPayload(event.payload)}
        </pre>
      </details>
    </li>
  );
}

export function HookEvents() {
  const query = useQuery({
    queryKey: queryKeys.hookEvents,
    queryFn: () => commands.getHookEvents(HOOK_EVENTS_LIMIT),
    // Always fresh when shown: the list is not invalidated by core events.
    staleTime: 0,
    refetchOnMount: "always",
  });
  const events = query.data ?? [];

  let body: ReactNode;
  if (query.isPending) {
    body = (
      <p role="status" className="py-6 text-center text-[13px] text-text-2">
        {fr.diagnostic.loading}
      </p>
    );
  } else if (query.isError) {
    body = (
      <div
        role="alert"
        className="flex items-center justify-between gap-3 py-4"
      >
        <p className="text-[13px] text-text">{fr.diagnostic.error}</p>
        <Button size="sm" onClick={() => void query.refetch()}>
          {fr.common.retry}
        </Button>
      </div>
    );
  } else if (events.length === 0) {
    body = (
      <p className="py-6 text-center text-[13px] text-text-2">
        {fr.diagnostic.empty}
      </p>
    );
  } else {
    body = (
      <ul aria-label={fr.diagnostic.title} className="flex flex-col">
        {events.map((event) => (
          <EventItem key={event.id} event={event} />
        ))}
      </ul>
    );
  }

  return (
    <section aria-labelledby="hook-events-title">
      <div className="flex items-center gap-3 pb-1">
        <div className="min-w-0 flex-1">
          <h3 id="hook-events-title" className="text-[13.5px] font-semibold">
            {fr.diagnostic.title}
          </h3>
          <p className="text-[12.5px] text-text-2">
            {fr.diagnostic.subtitle}
            {query.isSuccess && events.length > 0 && (
              <> · {fr.diagnostic.count(events.length)}</>
            )}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCw
            size={14}
            aria-hidden
            className={query.isFetching ? "motion-safe:animate-spin" : ""}
          />
          {fr.diagnostic.refresh}
        </Button>
      </div>
      {body}
    </section>
  );
}
