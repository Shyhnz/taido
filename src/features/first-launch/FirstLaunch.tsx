/**
 * First launch / no data: no welcome screen, just « Commence par
 * un projet », one sentence and « Créer un projet », which opens the inline project line of
 * the sidebar.
 */

import type { Subject } from "../../bindings";
import { Button } from "../../components/Button";
import { t } from "../../i18n";
import { useUi } from "../../stores/ui";

/**
 * True when there is nothing yet: no project and no task without project, open or completed
 * (`hasNoProjectTasks`, from `useHasNoProjectTasks`). Unknown data (still loading, or failed)
 * is never treated as empty.
 */
export function isFirstLaunch(
  subjects: Subject[] | undefined,
  hasNoProjectTasks: boolean | undefined,
): boolean {
  return (
    subjects !== undefined &&
    subjects.length === 0 &&
    hasNoProjectTasks === false
  );
}

export function FirstLaunch() {
  const start = useUi((s) => s.startNewProject);
  return (
    <div className="flex flex-col items-center gap-3 pt-[22vh] text-center">
      <h1 className="text-title leading-8 font-bold">
        {t.views.firstLaunch.title}
      </h1>
      <p className="max-w-[380px] text-body text-text-2">
        {t.views.firstLaunch.text}
      </p>
      <Button variant="primary" className="mt-3" onClick={() => start()}>
        {t.views.firstLaunch.action}
      </Button>
    </div>
  );
}
