/**
 * Dialogs opened through the UI store: quick add (⌘N), move task, due date (French
 * date picker, no native input), ⌘K search, « Réglages » and the Claude Code check. A project is
 * created in place in the sidebar, never in a dialog.
 */

import { Inbox } from "lucide-react";
import type { Due } from "../../bindings";
import { DatePicker, type DueValue } from "../../components/DatePicker";
import { Dialog } from "../../components/Dialog";
import { showToast } from "../../components/Toast";
import { fr } from "../../i18n/fr";
import { projectPath, sectionPath, subjectColorVar } from "../../lib/format";
import { commands } from "../../lib/ipc";
import { useSubjects } from "../../lib/queries";
import { run } from "../../lib/run";
import { useUi } from "../../stores/ui";
import { ClaudeCheckDialog } from "../claude-check/ClaudeCheckDialog";
import { QuickAddDialog } from "../quick-add/QuickAddDialog";
import { SearchDialog } from "../search/SearchDialog";
import { SettingsDialog } from "../settings/SettingsDialog";

function MoveTaskDialog({
  taskId,
  file,
  onClose,
}: {
  taskId: string;
  /** Opened from « Ranger dans… »: titled accordingly. */
  file: boolean;
  onClose: () => void;
}) {
  const subjects = useSubjects().data ?? [];

  const move = async (
    subjectId: string | null,
    sectionId: string | null,
    label: string,
  ) => {
    onClose();
    const moved = await run(
      commands.moveTask({ id: taskId, subjectId, sectionId, index: null }),
      fr.errors.action.moveTask,
    );
    if (moved) showToast({ message: fr.toast.moved(label) });
  };

  const item =
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13.5px] hover:bg-hover focus-visible:bg-hover";

  return (
    <Dialog
      title={file ? fr.move.fileTitle : fr.move.title}
      onClose={onClose}
      width={380}
    >
      <div className="flex max-h-[420px] flex-col overflow-y-auto px-3 pt-2 pb-3">
        <button
          type="button"
          className={item}
          onClick={() => void move(null, null, fr.move.noProject)}
        >
          <Inbox size={15} aria-hidden className="text-text-2" />
          {fr.move.noProject}
        </button>
        {subjects.map((s) =>
          s.isGroup ? (
            // Taido V2.2 bis: a group holds no task, only its name shows.
            <p
              key={s.id}
              className="px-2 pt-2 pb-0.5 text-[12px] font-semibold text-text-3"
            >
              {s.name}
            </p>
          ) : (
            <div key={s.id} className="flex flex-col">
              {/* A sub-project is indented under its parent and named with it (« Globex › Admin »). */}
              <button
                type="button"
                className={s.parentId ? `${item} pl-5` : item}
                onClick={() => void move(s.id, null, projectPath(s, subjects))}
              >
                <span className="flex w-[15px] shrink-0 justify-center">
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ background: subjectColorVar(s.color) }}
                  />
                </span>
                {projectPath(s, subjects)}
              </button>
              {s.sections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className={`${item} ${s.parentId ? "pl-11" : "pl-8"} text-text-2`}
                  onClick={() =>
                    void move(
                      s.id,
                      section.id,
                      sectionPath(s, section, subjects),
                    )
                  }
                >
                  {section.name}
                </button>
              ))}
            </div>
          ),
        )}
      </div>
    </Dialog>
  );
}

function DueDialog({
  taskId,
  due,
  onClose,
}: {
  taskId: string;
  due: Due | null;
  onClose: () => void;
}) {
  const save = async (value: DueValue) => {
    onClose();
    await run(
      commands.setTaskDue({
        id: taskId,
        date: value.date,
        time: value.date ? value.time : null,
      }),
      fr.errors.action.updateTask,
    );
  };

  return (
    <Dialog title={fr.due.title} onClose={onClose} width={296}>
      <div className="flex justify-center px-1 pt-1 pb-2">
        <DatePicker
          value={{ date: due?.date ?? null, time: due?.time ?? null }}
          onChange={(value) => void save(value)}
        />
      </div>
    </Dialog>
  );
}

export function AppDialogs() {
  const dialog = useUi((s) => s.dialog);
  const close = useUi((s) => s.closeDialog);
  if (!dialog) return null;
  switch (dialog.type) {
    case "addTask":
      return <QuickAddDialog target={dialog.target} onClose={close} />;
    case "moveTask":
      return (
        <MoveTaskDialog
          taskId={dialog.taskId}
          file={dialog.file === true}
          onClose={close}
        />
      );
    case "due":
      return (
        <DueDialog taskId={dialog.taskId} due={dialog.due} onClose={close} />
      );
    case "search":
      return <SearchDialog onClose={close} />;
    case "settings":
      return <SettingsDialog tab={dialog.tab} onClose={close} />;
    case "claudeCheck":
      return (
        <ClaudeCheckDialog
          problem={dialog.problem}
          agent={dialog.agent}
          onClose={close}
        />
      );
  }
}
