import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { msUntilNextMidnight, useDay } from "./clock";
import { MIDNIGHT_MARGIN_MS, queryKeys, watchDayChange } from "./queries";

describe("msUntilNextMidnight", () => {
  it("counts to the next local midnight", () => {
    expect(msUntilNextMidnight(new Date(2026, 9, 1, 23, 59, 0))).toBe(60_000);
    expect(msUntilNextMidnight(new Date(2026, 9, 1, 0, 0, 0))).toBe(
      24 * 3600_000,
    );
    // Month and year boundaries.
    expect(msUntilNextMidnight(new Date(2026, 11, 31, 23, 0, 0))).toBe(
      3600_000,
    );
  });
});

describe("watchDayChange (bug #13)", () => {
  let clock: Date;
  let client: QueryClient;
  let stop: () => void = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    clock = new Date(2026, 9, 1, 23, 59, 0);
    vi.setSystemTime(clock);
    useDay.setState({ day: "2026-10-01" });
    client = new QueryClient();
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  const invalidated = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((c) => (c[0] as { queryKey: unknown }).queryKey);

  it("invalidates views, counts, tasks and journals just after midnight", () => {
    const spy = vi.spyOn(client, "invalidateQueries");
    stop = watchDayChange(client, () => clock);
    expect(spy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(59_000);
    expect(spy).not.toHaveBeenCalled();

    clock = new Date(2026, 9, 2, 0, 0, 1);
    vi.advanceTimersByTime(1000 + MIDNIGHT_MARGIN_MS);
    expect(useDay.getState().day).toBe("2026-10-02");
    expect(invalidated(spy)).toEqual([
      queryKeys.views,
      queryKeys.counts,
      queryKeys.tasks,
      queryKeys.journals,
    ]);
  });

  it("catches up when the window comes back after a sleep", () => {
    const spy = vi.spyOn(client, "invalidateQueries");
    stop = watchDayChange(client, () => clock);
    // The Mac slept through midnight: the timer has not fired yet.
    clock = new Date(2026, 9, 2, 8, 30, 0);
    window.dispatchEvent(new Event("focus"));
    expect(useDay.getState().day).toBe("2026-10-02");
    expect(spy).toHaveBeenCalledTimes(4);

    // Same day: nothing more.
    window.dispatchEvent(new Event("focus"));
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("stops listening once stopped", () => {
    const spy = vi.spyOn(client, "invalidateQueries");
    stop = watchDayChange(client, () => clock);
    stop();
    clock = new Date(2026, 9, 2, 8, 30, 0);
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(24 * 3600_000);
    expect(spy).not.toHaveBeenCalled();
  });
});
