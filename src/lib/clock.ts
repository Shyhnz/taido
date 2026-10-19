/**
 * The current local day, as UI state (bug #13). Relative labels (« Aujourd'hui », « Demain »,
 * « En retard », the Today title) are computed at render time from `new Date()`: the shell
 * subscribes to `useDay` so the whole tree re-renders, and recomputes them, when the day
 * changes. See `watchDayChange` in src/lib/queries.ts for the data side.
 */

import { create } from "zustand";
import { toLocalDateString } from "./dates";

export const useDay = create<{ day: string }>(() => ({
  day: toLocalDateString(new Date()),
}));

/** Milliseconds from `now` to the next local midnight (always > 0). */
export function msUntilNextMidnight(now: Date = new Date()): number {
  const next = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    0,
    0,
  );
  return Math.max(1, next.getTime() - now.getTime());
}
