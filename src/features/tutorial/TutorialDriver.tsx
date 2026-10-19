/**
 * Turns what happens in the app into guide events: a project or a task appears, a panel opens, Claude's ring
 * changes, the guide's task changes column on the kanban or gets a file, a task is checked.
 * It also walks the user to each step (opens the sidebar, the project, the task) so the bubble
 * always has something to point at. Rendered only while a guide runs.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { announce } from "../../components/LiveRegion";
import { t } from "../../i18n";
import { useDefaultAgent } from "../../lib/agent";
import { features } from "../../lib/features";
import { commands, errorKind, errorMessage } from "../../lib/ipc";
import {
  queryKeys,
  useHasNoProjectTasks,
  useSettings,
  useSubjects,
  useTask,
  useView,
} from "../../lib/queries";
import { useUi } from "../../stores/ui";
import { isFirstLaunch } from "../first-launch/FirstLaunch";
import {
  boardColumnOf,
  openTaskIds,
  STEP_COUNT,
  type StepId,
  savedProgress,
  stepNumber,
  type TutorialRun,
} from "./model";
import { saveTutorial, useTutorial } from "./store";
import { stepTitle } from "./texts";

/** Steps that watch new or checked tasks. */
const WATCH_TASKS: ReadonlySet<StepId> = new Set<StepId>([
  "task",
  "quickAdd",
  "complete",
]);

/**
 * At launch: resumes a guide left in progress, or offers it to an app without any data (« premier lancement »). An app that already holds data never gets it by itself: it is
 * marked done, « Revoir le guide » stays in Réglages.
 */
export function useTutorialAutoStart(): void {
  const settings = useSettings().data;
  const subjects = useSubjects().data;
  const hasNoProjectTasks = useHasNoProjectTasks();
  const decided = useRef(false);

  useEffect(() => {
    if (!features.tutorial || decided.current || !settings) return;
    const saved = settings.tutorial;
    if (saved.status === "in_progress") {
      decided.current = true;
      useTutorial.getState().resume(saved);
      return;
    }
    if (saved.status === "done") {
      decided.current = true;
      return;
    }
    if (subjects === undefined || hasNoProjectTasks === undefined) return;
    decided.current = true;
    if (isFirstLaunch(subjects, hasNoProjectTasks)) {
      useTutorial.getState().begin();
    } else {
      saveTutorial(savedProgress(null));
    }
  }, [settings, subjects, hasNoProjectTasks]);
}

export function TutorialDriver({ run }: { run: TutorialRun }) {
  const dispatch = useTutorial((s) => s.dispatch);
  // Read when a step starts: a later change of agent does not walk the step again.
  const defaultAgent = useDefaultAgent();
  const agent = useRef(defaultAgent);
  agent.current = defaultAgent;
  const { step, taskId, subjectId } = run;
  const task = useTask(taskId).data;
  // The kanban to show is the one of the guide's task (any task when steps were skipped).
  const taskSubjectId =
    task && task.id === taskId ? (task.subject?.id ?? null) : subjectId;

  // Each step: walk the user there, then say it to screen readers.
  useEffect(() => {
    const ui = useUi.getState();
    if (step === "project" || step === "account") ui.toggleSidebar(true);
    if (step === "project" && !ui.newProjectOpen) ui.startNewProject();
    if (
      step === "task" &&
      subjectId !== null &&
      (ui.view.kind !== "subject" || ui.view.subjectId !== subjectId)
    ) {
      ui.setView({ kind: "subject", subjectId });
    }
    if (step === "open" && taskId !== null && ui.openTaskId === taskId) {
      dispatch({ type: "taskOpened", id: taskId });
    }
    if ((step === "claude" || step === "talk") && taskId !== null) {
      if (ui.openTaskId !== taskId) ui.openTask(taskId);
    }
    if (step === "complete") {
      if (ui.focusMode) ui.setFocusMode(false);
      // The ring to click is on the list's row, not on the kanban's card.
      if (ui.projectTab !== "list") ui.setProjectTab("list");
    }
    const n = stepNumber(step);
    if (n !== null) {
      announce(
        `${t.tutorial.stepOf(n, STEP_COUNT)} : ${stepTitle(step, agent.current)}`,
      );
    }
    // `subjectId` and `taskId` change together with the step that sets them.
  }, [step, subjectId, taskId, dispatch]);

  // « Kanban » is a tab of the page of the task's project (read once the task loads): the
  // page shows, out of focus mode.
  useEffect(() => {
    if (step !== "kanban") return;
    const ui = useUi.getState();
    if (
      taskSubjectId !== null &&
      (ui.view.kind !== "subject" || ui.view.subjectId !== taskSubjectId)
    ) {
      ui.setView({ kind: "subject", subjectId: taskSubjectId });
    }
    if (ui.focusMode) ui.setFocusMode(false);
  }, [step, taskSubjectId]);

  useSubjectWatch(run);
  useTaskListWatch(run);
  useGuideTaskWatch(run);
  useBoardWatch(run, taskSubjectId);
  usePanelWatch();
  return null;
}

/** « Ton premier projet »: a project that was not there when the step began. */
function useSubjectWatch({ step }: TutorialRun) {
  const dispatch = useTutorial((s) => s.dispatch);
  const subjects = useSubjects().data;
  const known = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (step !== "project") {
      known.current = null;
      return;
    }
    if (!subjects) return;
    const ids = new Set(subjects.map((s) => s.id));
    const before = known.current;
    known.current = ids;
    if (before === null) return;
    const created = subjects.find((s) => !before.has(s.id));
    if (created) dispatch({ type: "subjectCreated", id: created.id });
  }, [step, subjects, dispatch]);
}

/**
 * New tasks (« Une tâche », ⌘N) and, without a guide task, a checked one (« Coche »): the open
 * tasks of « À faire » (every project and « Sans projet ») compared with the step's start.
 */
function useTaskListWatch({ step, taskId }: TutorialRun) {
  const dispatch = useTutorial((s) => s.dispatch);
  const watching = WATCH_TASKS.has(step);
  const all = useView("all", null).data;
  const known = useRef<{
    step: StepId;
    ids: Map<string, string | null>;
  } | null>(null);

  useEffect(() => {
    if (!watching) {
      known.current = null;
      return;
    }
    if (!all) return;
    const ids = openTaskIds(all);
    const before = known.current?.step === step ? known.current.ids : null;
    known.current = { step, ids };
    if (before === null) return;
    for (const [id, subject] of ids) {
      if (!before.has(id)) {
        dispatch({ type: "taskCreated", id, subjectId: subject });
        return;
      }
    }
    if (step !== "complete" || taskId !== null) return;
    for (const id of before.keys()) {
      if (ids.has(id)) continue;
      commands
        .getTask(id)
        .then((task) => {
          if (task.completedAt !== null)
            dispatch({ type: "taskCompleted", id });
        })
        .catch((error) => console.error(errorMessage(error), error));
    }
  }, [watching, step, taskId, all, dispatch]);
}

/** The guide's task: Claude's ring, a file attached, checked or reopened, or gone. */
function useGuideTaskWatch({ step, taskId }: TutorialRun) {
  const dispatch = useTutorial((s) => s.dispatch);
  const task = useTask(taskId);
  const mine = task.data?.id === taskId ? task.data : undefined;
  const ring = mine?.ring;
  const completedAt = mine === undefined ? undefined : mine.completedAt;
  const attached = (mine?.attachments.length ?? 0) > 0;
  const lost = task.error ? errorKind(task.error) === "not_found" : false;

  useEffect(() => {
    if (taskId !== null && ring !== undefined) {
      dispatch({ type: "ring", taskId, ring });
    }
  }, [taskId, ring, dispatch]);

  useEffect(() => {
    if (taskId === null || completedAt === undefined) return;
    dispatch(
      completedAt
        ? { type: "taskCompleted", id: taskId }
        : { type: "taskReopened", id: taskId },
    );
  }, [taskId, completedAt, dispatch]);

  useEffect(() => {
    if (step === "file" && taskId !== null && attached) {
      dispatch({ type: "attached", id: taskId });
    }
  }, [step, taskId, attached, dispatch]);

  useEffect(() => {
    if (lost) dispatch({ type: "taskLost" });
  }, [lost, dispatch]);
}

/**
 * « Passe en Kanban »: the guide's task changes column, out of the first one. Its column when
 * the step began is the reference: launching Claude already moved it « En cours » (core
 * rule), so only a move made during the step counts.
 */
function useBoardWatch(
  { step, taskId }: TutorialRun,
  subjectId: string | null,
) {
  const dispatch = useTutorial((s) => s.dispatch);
  const watching = step === "kanban" && taskId !== null;
  // Same key as the kanban's own query: `data-changed` on tasks refetches both.
  const { data: board, isFetching } = useQuery({
    queryKey: queryKeys.board(subjectId),
    queryFn: () => commands.getBoard(subjectId),
    enabled: watching,
  });
  const task = useTask(taskId).data;
  const completed = task?.id === taskId && task?.completedAt != null;
  const start = useRef<string | null>(null);

  useEffect(() => {
    if (!watching || taskId === null) {
      start.current = null;
      return;
    }
    if (board === undefined || board.subjectId !== subjectId) return;
    const column = boardColumnOf(board, taskId, completed);
    if (column === null) return;
    if (start.current === null) {
      // A board cached earlier may predate Claude's own move: start from fresh data only.
      if (isFetching) return;
      start.current = column;
      return;
    }
    if (column !== start.current && column !== board.columns[0]?.id) {
      dispatch({ type: "taskMoved", id: taskId });
    }
  }, [watching, taskId, subjectId, board, isFetching, completed, dispatch]);
}

/** A task panel opens (click, Enter, ⌘K). */
function usePanelWatch() {
  const dispatch = useTutorial((s) => s.dispatch);
  useEffect(
    () =>
      useUi.subscribe((s, prev) => {
        const id = s.openTaskId;
        const opened =
          id !== null &&
          s.selectedTaskId === id &&
          (id !== prev.openTaskId || prev.selectedTaskId !== id);
        if (opened) dispatch({ type: "taskOpened", id });
      }),
    [dispatch],
  );
}
