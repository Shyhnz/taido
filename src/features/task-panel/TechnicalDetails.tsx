/**
 * « Détails techniques » of the task panel: folder, git branch,
 * terminals and state, in a collapsed block.
 */

import { X } from "lucide-react";
import type { ReactNode } from "react";
import type { TaskDetail } from "../../bindings";
import { IconButton } from "../../components/Button";
import { t } from "../../i18n";
import { formatRelative } from "../../lib/dates";
import { shortenPath } from "../../lib/format";
import { commands } from "../../lib/ipc";
import { run } from "../../lib/run";
import { StateDot } from "../task-row/StateDot";
import { ringLabel } from "../task-row/StateRing";
import { TONE_CLASS } from "../task-row/TaskRow";
import { terminalLabel } from "../terminals/terminalList";
import { Fold } from "./PanelFold";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5">
      <span className="w-[108px] shrink-0 text-[12px] text-text-2">
        {label}
      </span>
      <div className="min-w-0 flex-1 text-[13px]">{children}</div>
    </div>
  );
}

export function TechnicalDetails({ task }: { task: TaskDetail }) {
  const since = task.ringSince ? formatRelative(task.ringSince) : null;

  const pickFolder = async () => {
    const path = await run(commands.pickFolder(t.attrs.folderPick));
    if (path) {
      await run(commands.setTaskWorkdirOverride({ id: task.id, path }));
    }
  };

  const folderName = task.workdir?.path.split("/").filter(Boolean).pop();
  return (
    <Fold
      id="technical"
      title={t.folds.technical}
      summary={
        (folderName || task.gitBranch) && (
          <span className="truncate font-mono text-[12px]">
            {[folderName, task.gitBranch].filter(Boolean).join(" · ")}
          </span>
        )
      }
    >
      <div>
        <Row label={t.attrs.folder}>
          <div className="flex items-start gap-1">
            <button
              type="button"
              onClick={() => void pickFolder()}
              title={task.workdir?.path ?? t.attrs.folderPick}
              aria-label={`${t.attrs.folderPick} · ${task.workdir?.path ?? t.attrs.folderNone}`}
              className="-mx-1 min-w-0 flex-1 rounded-md px-1 text-left font-mono text-[12.5px] break-all hover:bg-hover"
            >
              {task.workdir
                ? shortenPath(task.workdir.path)
                : t.attrs.folderNone}
            </button>
            {task.workdirOverride && (
              <IconButton
                label={t.attrs.folderReset}
                size={22}
                onClick={() =>
                  void run(
                    commands.setTaskWorkdirOverride({
                      id: task.id,
                      path: null,
                    }),
                  )
                }
              >
                <X size={13} aria-hidden />
              </IconButton>
            )}
          </div>
          {task.workdir && (
            <p className="mt-0.5 text-[12px] text-text-3">
              {task.workdir.exists
                ? t.attrs.folderInherited[task.workdir.source]
                : t.attrs.folderMissing}
            </p>
          )}
        </Row>
        <Row label={t.attrs.gitBranch}>
          <span className="font-mono text-[12.5px]">
            {task.gitBranch ?? "—"}
          </span>
        </Row>
        <Row label={t.attrs.terminals}>
          {task.terminals.length > 0
            ? task.terminals.map((t) => terminalLabel(t)).join(", ")
            : "—"}
        </Row>
        <Row label={t.attrs.state}>
          <div className="flex items-start gap-2">
            <span className="pt-1">
              <StateDot
                ring={task.ring}
                agent={task.line?.agent ?? undefined}
              />
            </span>
            <span className={task.line ? TONE_CLASS[task.line.tone] : ""}>
              {ringLabel(task.ring, task.line?.agent ?? undefined)}
              {since && ` · ${since}`}
            </span>
          </div>
        </Row>
      </div>
    </Fold>
  );
}
