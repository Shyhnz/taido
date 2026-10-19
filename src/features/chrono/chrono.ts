/**
 * Chrono display helpers (Taido V2.1): the core gives the stopped seconds and the start of the
 * running segment; the UI adds the running part up to now and ticks every second.
 */

import { useEffect, useState } from "react";
import type { TaskChrono } from "../../bindings";

/** Total seconds at `now`: the stopped segments plus the running one. */
export function chronoSeconds(chrono: TaskChrono, now: Date): number {
  if (chrono.runningSince === null) return chrono.seconds;
  const running = Math.floor(
    (now.getTime() - Date.parse(chrono.runningSince)) / 1000,
  );
  return chrono.seconds + Math.max(0, running);
}

/** `h:mm:ss`, as on the wireframes (`1:15:32`, `0:06:12`). */
export function formatChrono(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** `h:mm` for the journal's durations (`0:38`, `1:10`). */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}`;
}

/** The current time, refreshed every second while `running` (else frozen at mount). */
export function useNow(running: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!running) return;
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [running]);
  return running ? now : new Date();
}

/** « 9 h 40 », « 42 min », « 0 min » (dashboard figures). */
export function formatHours(seconds: number): string {
  const m = Math.floor(Math.max(0, seconds) / 60);
  const h = Math.floor(m / 60);
  if (h === 0) return `${m} min`;
  return `${h} h ${String(m % 60).padStart(2, "0")}`;
}
