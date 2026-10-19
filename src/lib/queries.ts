/**
 * Data access with TanStack Query: stable query keys, one hook per read, and a
 * single subscription to core events that invalidates the matching queries (throttled 100 ms).
 */

import {
  QueryClient,
  type QueryClient as QueryClientType,
  useQuery,
} from "@tanstack/react-query";
import type {
  Agent,
  DataScope,
  TaskDetail,
  TaskRow,
  TaskStateChanged,
  ViewKind,
  ViewModel,
} from "../bindings";
import { msUntilNextMidnight, useDay } from "./clock";
import { toLocalDateString } from "./dates";
import { commands, events } from "./ipc";

export const queryKeys = {
  subjects: ["subjects"] as const,
  /**
   * Index of « Sans projet » among the top-level projects; under `subjects`, so every
   * `subjects` or `tasks` change refetches it.
   */
  inboxIndex: ["subjects", "inbox_index"] as const,
  views: ["view"] as const,
  view: (kind: ViewKind, subjectId: string | null) =>
    ["view", kind, subjectId] as const,
  /** « Prochainement » from a given first day; under `views` too. */
  upcoming: (from: string, days: number) =>
    ["view", "upcoming", from, days] as const,
  /** Kanban of a project (Taido V2.2); under `views`, so task changes refetch it. */
  board: (subjectId: string | null) => ["view", "board", subjectId] as const,
  /** Dashboard of a project (Taido V2.5); under `views` too. */
  dashboard: (subjectId: string | null, days: number) =>
    ["view", "dashboard", subjectId, days] as const,
  counts: ["counts"] as const,
  tasks: ["task"] as const,
  task: (id: string) => ["task", id] as const,
  journals: ["journal"] as const,
  journal: (taskId: string) => ["journal", taskId] as const,
  settings: ["settings"] as const,
  /**
   * The agents installed on this computer (« + » menu); under `settings`, so a new path in
   * Réglages › Agents reads it again.
   */
  installedAgents: ["settings", "installedAgents"] as const,
  /** « Ouvrir dans »: the editors installed on this Mac. */
  installedEditors: ["installedEditors"] as const,
  /** Diagnostic tab of Réglages: last hook events. */
  hookEvents: ["hookEvents"] as const,
  /** Réglages › Claude Code: `check_claude`, read when the tab shows. */
  agentStatus: (agent: Agent) => ["agentStatus", agent] as const,
  /** Réglages › Diagnostic: `get_app_status`. */
  appStatus: ["appStatus"] as const,
  /** ⌘K: tasks matching a query. */
  search: (query: string) => ["search", query] as const,
  /**
   * Notebook pages matching a query: ⌘K (every project) or one notebook's search field. Under
   * `notebooks`, so the `notes` scope refreshes the hits.
   */
  searchNotes: (query: string, subjectId: string | null = null) =>
    ["notebook", "search", subjectId ?? "*", query] as const,
  /**
   * Project notebooks (`notebook`, backlinks, mentions, page images): invalidated by the
   * `notes` scope. Keys of the notebook's own queries start with this one.
   */
  notebooks: ["notebook"] as const,
  notebook: (subjectId: string) => ["notebook", subjectId] as const,
  /** Every terminal kept by the core, all tasks together. */
  terminals: ["terminals"] as const,
  /** « Sessions Claude » of a task. */
  sessionLists: ["sessions"] as const,
  sessions: (taskId: string) => ["sessions", taskId] as const,
  /** What happened in one session (its unfolded detail). */
  exchangeLists: ["exchanges"] as const,
  exchanges: (sessionId: string) => ["exchanges", sessionId] as const,
};

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        staleTime: Number.POSITIVE_INFINITY,
      },
    },
  });
}

export const useSubjects = () =>
  useQuery({ queryKey: queryKeys.subjects, queryFn: commands.listSubjects });

/** Where « Sans projet » sits among the top-level projects (sidebar order). */
export const useInboxIndex = () =>
  useQuery({ queryKey: queryKeys.inboxIndex, queryFn: commands.getInboxIndex });

/** Days « Prochainement » lists at least (a week, like Todoist's strip). */
export const UPCOMING_DAYS = 7;

/**
 * The view model of a list. « Prochainement » also takes its range (`from`, local
 * `YYYY-MM-DD`, and `days`): each range is a query of its own.
 */
export const useView = (
  kind: ViewKind,
  subjectId: string | null,
  range: { from: string; days: number } | null = null,
) =>
  useQuery({
    queryKey:
      kind === "upcoming" && range !== null
        ? queryKeys.upcoming(range.from, range.days)
        : queryKeys.view(kind, subjectId),
    queryFn: () =>
      commands.getView({
        kind,
        subjectId,
        from: kind === "upcoming" ? (range?.from ?? null) : null,
        days: kind === "upcoming" ? (range?.days ?? UPCOMING_DAYS) : null,
      }),
    // Changing week keeps the previous week on screen until the next one arrives (no
    // skeleton flash); never across views.
    placeholderData: (previous: ViewModel | undefined) =>
      kind === "upcoming" && previous?.kind === "upcoming"
        ? previous
        : undefined,
  });

/** Every terminal kept by the core. */
export const useTerminals = () =>
  useQuery({ queryKey: queryKeys.terminals, queryFn: commands.listTerminals });

export const useCounts = () =>
  useQuery({ queryKey: queryKeys.counts, queryFn: commands.getCounts });

/**
 * True when « Sans projet » holds at least one live task, open or completed (D2); `undefined`
 * while unknown (loading or error). The open count comes from the counts; only when it is 0
 * is the « Sans projet » view read, for its completed tasks.
 */
export function useHasNoProjectTasks(): boolean | undefined {
  const counts = useCounts().data;
  const view = useQuery({
    queryKey: queryKeys.view("inbox", null),
    queryFn: () =>
      commands.getView({
        kind: "inbox",
        subjectId: null,
        from: null,
        days: null,
      }),
    enabled: counts !== undefined && counts.inbox === 0,
  });
  if (counts === undefined) return undefined;
  if (counts.inbox > 0) return true;
  if (view.data === undefined) return undefined;
  return view.data.completed.length > 0;
}

export const useTask = (id: string | null) =>
  useQuery({
    queryKey: queryKeys.task(id ?? ""),
    queryFn: () => commands.getTask(id ?? ""),
    enabled: id !== null,
  });

/** The Claude conversations of a task, newest first (« Sessions Claude »). */
export const useTaskSessions = (taskId: string) =>
  useQuery({
    queryKey: queryKeys.sessions(taskId),
    queryFn: () => commands.listTaskSessions(taskId),
  });

/** What happened in a session, oldest first; fetched when its row is unfolded. */
export const useSessionExchanges = (sessionId: string, enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.exchanges(sessionId),
    queryFn: () => commands.getSessionExchanges(sessionId),
    enabled,
  });

export const useJournal = (taskId: string | null) =>
  useQuery({
    queryKey: queryKeys.journal(taskId ?? ""),
    queryFn: () => commands.listJournal(taskId ?? ""),
    enabled: taskId !== null,
  });

export const useSettings = () =>
  useQuery({ queryKey: queryKeys.settings, queryFn: commands.getSettings });

/** The editors installed here (`installed_editors`), read again when the window gets focus. */
export const useInstalledEditors = (enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.installedEditors,
    queryFn: commands.installedEditors,
    enabled,
  });

/**
 * `task-state-changed`: the ring and the second line of the task change at
 * once in every cached list and in its detail, without waiting for the refetch that the
 * following `data-changed` triggers (it may move the row to another group).
 */
export function applyTaskState(
  client: QueryClientType,
  change: TaskStateChanged,
): void {
  // Subtasks are rows too, nested under their parent.
  const patchRows = (rows: TaskRow[]): TaskRow[] | null => {
    let touched = false;
    const next = rows.map((row) => {
      const children = row.children.length > 0 ? patchRows(row.children) : null;
      if (row.id !== change.taskId && !children) return row;
      touched = true;
      const patched = children ? { ...row, children } : row;
      return row.id === change.taskId
        ? { ...patched, ring: change.ring, line: change.line }
        : patched;
    });
    return touched ? next : null;
  };
  client.setQueriesData<ViewModel>({ queryKey: queryKeys.views }, (view) => {
    if (!view?.groups) return view;
    let touched = false;
    const groups = view.groups.map((group) => {
      const tasks = patchRows(group.tasks);
      if (!tasks) return group;
      touched = true;
      return { ...group, tasks };
    });
    return touched ? { ...view, groups } : view;
  });
  client.setQueryData<TaskDetail>(queryKeys.task(change.taskId), (task) =>
    task
      ? {
          ...task,
          ring: change.ring,
          // `at` is the last change of any session of the task (an activity, another
          // terminal): « depuis… » moves only when the ring does; the refetch that follows
          // `data-changed` brings the exact instant.
          ringSince: change.ring !== task.ring ? change.at : task.ringSince,
          // Without agent state the panel keeps its own line (description, completion).
          line: change.line ?? task.line,
        }
      : task,
  );
  // The parent's panel lists its subtasks with their own dot.
  client.setQueriesData<TaskDetail>({ queryKey: queryKeys.tasks }, (task) => {
    if (!task?.subtasks?.some((s) => s.id === change.taskId)) return task;
    return {
      ...task,
      subtasks: task.subtasks.map((s) =>
        s.id === change.taskId ? { ...s, ring: change.ring } : s,
      ),
    };
  });
}

export const INVALIDATION_THROTTLE_MS = 100;

/**
 * Subscribes once to `data-changed` and `counts-changed`. Scopes are accumulated and flushed
 * at most every 100 ms. Returns the unsubscribe function.
 */
export function subscribeToCoreEvents(client: QueryClientType): () => void {
  let scopes = new Set<DataScope>();
  let taskIds: Set<string> | null = new Set();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const flush = () => {
    timer = null;
    const s = scopes;
    const ids = taskIds;
    scopes = new Set();
    taskIds = new Set();
    if (s.has("subjects")) {
      void client.invalidateQueries({ queryKey: queryKeys.subjects });
      void client.invalidateQueries({ queryKey: queryKeys.views });
    }
    if (s.has("terminals")) {
      void client.invalidateQueries({ queryKey: queryKeys.terminals });
    }
    if (s.has("tasks") || s.has("terminals")) {
      void client.invalidateQueries({ queryKey: queryKeys.views });
      void client.invalidateQueries({ queryKey: queryKeys.subjects });
      void client.invalidateQueries({ queryKey: queryKeys.counts });
      if (ids === null) {
        void client.invalidateQueries({ queryKey: queryKeys.tasks });
      } else {
        for (const id of ids) {
          void client.invalidateQueries({ queryKey: queryKeys.task(id) });
        }
      }
    }
    // Sessions follow their task (states, new or resumed sessions, exchanges recorded).
    if (s.has("tasks") || s.has("terminals") || s.has("journal")) {
      if (ids === null) {
        void client.invalidateQueries({ queryKey: queryKeys.sessionLists });
      } else {
        for (const id of ids) {
          void client.invalidateQueries({ queryKey: queryKeys.sessions(id) });
        }
      }
      // Keyed by session, not by task: only the unfolded ones are fetched again.
      void client.invalidateQueries({ queryKey: queryKeys.exchangeLists });
    }
    if (s.has("journal")) {
      if (ids === null) {
        void client.invalidateQueries({ queryKey: queryKeys.journals });
      } else {
        for (const id of ids) {
          void client.invalidateQueries({ queryKey: queryKeys.journal(id) });
        }
      }
    }
    if (s.has("settings")) {
      void client.invalidateQueries({ queryKey: queryKeys.settings });
    }
    if (s.has("notes")) {
      void client.invalidateQueries({ queryKey: queryKeys.notebooks });
    }
  };

  const unlisteners: Promise<() => void>[] = [
    events.dataChanged.listen(({ payload }) => {
      for (const scope of payload.scopes) scopes.add(scope);
      if (payload.taskIds === null) {
        // Unknown tasks: invalidate every detail of the touched scopes.
        if (
          payload.scopes.some(
            (x) => x !== "subjects" && x !== "settings" && x !== "notes",
          )
        ) {
          taskIds = null;
        }
      } else if (taskIds !== null) {
        for (const id of payload.taskIds) taskIds.add(id);
      }
      if (timer === null && !disposed) {
        timer = setTimeout(flush, INVALIDATION_THROTTLE_MS);
      }
    }),
    events.countsChanged.listen(({ payload }) => {
      client.setQueryData(queryKeys.counts, payload.counts);
    }),
    // An instant ring change; `data-changed` follows and refetches.
    events.taskStateChanged.listen(({ payload }) => {
      applyTaskState(client, payload);
    }),
    // A process ended: its tab shows « Terminé », the row count drops.
    events.terminalExited.listen(({ payload }) => {
      scopes.add("terminals");
      if (taskIds !== null) taskIds.add(payload.taskId);
      if (timer === null && !disposed) {
        timer = setTimeout(flush, INVALIDATION_THROTTLE_MS);
      }
    }),
  ];

  return () => {
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    for (const p of unlisteners) {
      void p.then((unlisten) => unlisten());
    }
  };
}

/** Margin after midnight, so the core's own clock is surely on the new day too. */
export const MIDNIGHT_MARGIN_MS = 1000;

/**
 * Bug #13: at local midnight, Today, « En retard » and the counters change without any core
 * event. Invalidates the views, counts, task details and journals, and moves `useDay` to the
 * new day (relative labels re-render). A timer fires just after midnight; window focus and
 * visibility changes check again, since timers run late after the Mac sleeps.
 * Returns the stop function.
 */
export function watchDayChange(
  client: QueryClientType,
  now: () => Date = () => new Date(),
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const check = () => {
    const today = toLocalDateString(now());
    if (today === useDay.getState().day) return;
    useDay.setState({ day: today });
    void client.invalidateQueries({ queryKey: queryKeys.views });
    void client.invalidateQueries({ queryKey: queryKeys.counts });
    void client.invalidateQueries({ queryKey: queryKeys.tasks });
    void client.invalidateQueries({ queryKey: queryKeys.journals });
  };

  const schedule = () => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      check();
      schedule();
    }, msUntilNextMidnight(now()) + MIDNIGHT_MARGIN_MS);
  };

  const onWake = () => {
    if (document.hidden) return;
    check();
    schedule();
  };

  // The day may have changed since the module loaded (`useDay`'s initial value).
  check();
  schedule();
  window.addEventListener("focus", onWake);
  document.addEventListener("visibilitychange", onWake);

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    window.removeEventListener("focus", onWake);
    document.removeEventListener("visibilitychange", onWake);
  };
}
