/**
 * The running guide. Every change of step, project or task is
 * saved in the core (`Settings.tutorial`), so a launch resumes where the previous one stopped.
 */

import { create } from "zustand";
import type { Tutorial } from "../../bindings";
import { commands, errorMessage } from "../../lib/ipc";
import { settingsPatch } from "../../lib/settingsPatch";
import {
  newRun,
  reduce,
  resumeRun,
  savedProgress,
  type TutorialEvent,
  type TutorialRun,
} from "./model";

interface TutorialStore {
  /** `null` while no guide runs. */
  run: TutorialRun | null;
  /** Starts the guide on its welcome card (first launch, « Revoir le guide »). */
  begin: () => void;
  /** Resumes a guide left at a step by a previous launch. */
  resume: (saved: Tutorial) => void;
  dispatch: (event: TutorialEvent) => void;
  /** Ends the guide (finished, declined or left): it no longer starts by itself. */
  finish: () => void;
}

export const useTutorial = create<TutorialStore>((set, get) => ({
  run: null,
  begin: () => set({ run: newRun() }),
  resume: (saved) => set({ run: resumeRun(saved) }),
  dispatch: (event) => {
    const run = get().run;
    if (run === null) return;
    const next = reduce(run, event);
    if (next !== run) set({ run: next });
  },
  finish: () => set({ run: null }),
}));

/** Writes the progress (failures are logged: the guide goes on without them). */
export function saveTutorial(tutorial: Tutorial): void {
  commands.updateSettings(settingsPatch({ tutorial })).catch((error) => {
    console.error(errorMessage(error), error);
  });
}

const sameProgress = (a: Tutorial, b: Tutorial) =>
  a.status === b.status &&
  a.step === b.step &&
  a.subjectId === b.subjectId &&
  a.taskId === b.taskId;

// The ring and « Claude asked » are not kept: the next launch reads them again.
useTutorial.subscribe((state, previous) => {
  if (state.run === previous.run) return;
  // Before any guide ran (`previous.run` null and `state.run` null) there is nothing to say.
  const before = previous.run === null ? null : savedProgress(previous.run);
  const now = savedProgress(state.run);
  if (before !== null && sameProgress(before, now)) return;
  saveTutorial(now);
});
