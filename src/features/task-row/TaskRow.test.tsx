import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  LineKind,
  LineTone,
  TaskLine,
  TaskRow as TaskRowData,
} from "../../bindings";
import { features } from "../../lib/features";
import { TaskRow } from "./TaskRow";

// Thursday 1 October 2026, 22:40 local time.
const NOW = new Date(2026, 9, 1, 22, 40);
const minutesAgo = (n: number) =>
  new Date(NOW.getTime() - n * 60_000).toISOString();

function row(overrides: Partial<TaskRowData> = {}): TaskRowData {
  return {
    id: "t1",
    title: "Optimiser le job d'import de données",
    subject: null,
    subjectId: null,
    sectionId: null,
    ring: "human",
    line: null,
    hasDescription: false,
    due: null,
    openTerminals: 0,
    subtasksDone: 0,
    subtasksTotal: 0,
    completedAt: null,
    position: 1,
    priority: 1,
    parentId: null,
    children: [],
    chrono: null,
    attachmentCount: 0,
    blocksCount: 0,
    blockedBy: null,
    blockedByCount: 0,
    relatedCount: 0,
    ...overrides,
  };
}

const line = (
  kind: LineKind,
  tone: LineTone,
  text: string | null = null,
  at: string | null = null,
): TaskLine => ({ kind, agent: null, tone, text, at });

const LINE_CASES: [TaskLine, string, string][] = [
  [
    line("description", "muted", "Rendre le job plus rapide"),
    "Rendre le job plus rapide",
    "text-text-2",
  ],
  [
    line("completed", "faint", null, minutesAgo(8)),
    "Terminée il y a 8 min",
    "text-text-3",
  ],
  [
    line("waiting_permission", "waiting", "Commande : npm test"),
    "Claude attend ta réponse",
    "text-waiting-text",
  ],
  [
    line("waiting_question", "waiting", "je modifie le job ?"),
    "Claude attend ta réponse",
    "text-waiting-text",
  ],
  [
    line("waiting_input", "waiting"),
    "Claude attend ta réponse",
    "text-waiting-text",
  ],
  [
    line("error", "primary", "Limite d'usage atteinte"),
    "Limite d'usage atteinte",
    "text-text",
  ],
  // The core may send the raw `StopFailure.error` type: the UI translates it.
  [
    line("error", "primary", "rate_limit"),
    "Limite d'usage atteinte",
    "text-text",
  ],
  [
    line("error", "primary", "overloaded"),
    "Serveurs surchargés, réessaie",
    "text-text",
  ],
  [
    line("error", "primary", "authentication_failed"),
    "Claude Code n'est plus connecté",
    "text-text",
  ],
  [
    line("error", "primary", "billing_error"),
    "Problème de facturation",
    "text-text",
  ],
  [
    line("error", "primary", "model_not_found"),
    "Erreur : model_not_found",
    "text-text",
  ],
  [line("crashed", "primary"), "Session arrêtée", "text-text"],
  [
    line("done", "done", "champ calculé et paramètre prêts"),
    "Claude a fini",
    "text-done-text",
  ],
  [
    line("working", "muted", "Édition src/app.ts"),
    "Claude travaille",
    "text-text-2",
  ],
  [line("working", "muted"), "Claude travaille", "text-text-2"],
  [line("starting", "muted"), "Démarrage de Claude Code…", "text-text-2"],
  [line("idle", "muted"), "Session ouverte, prête", "text-text-2"],
  [
    line("paused", "muted", null, new Date(2026, 8, 30, 17, 42).toISOString()),
    "En pause · hier 17:42",
    "text-text-2",
  ],
];

function withStates(on: boolean, fn: () => void) {
  const previous = features.states;
  Object.assign(features, { states: on });
  try {
    fn();
  } finally {
    Object.assign(features, { states: previous });
  }
}

describe("TaskRow", () => {
  it("renders only the title when there is nothing else", () => {
    const { container } = render(<TaskRow row={row()} now={NOW} />);
    expect(
      screen.getByText("Optimiser le job d'import de données"),
    ).toBeInTheDocument();
    expect(container.querySelector("[data-tone]")).toBeNull();
    expect(screen.queryByText(/\//)).toBeNull();
    expect(screen.queryByText("A une note")).toBeNull();
  });

  it("is a single line without the states flag", () => {
    withStates(false, () => {
      const { container } = render(
        <TaskRow
          row={row({ line: line("working", "muted", "Édition") })}
          now={NOW}
        />,
      );
      expect(container.querySelector("[data-tone]")).toBeNull();
      expect(screen.queryByText(/Claude travaille/)).toBeNull();
    });
  });

  it.each(LINE_CASES)("renders the %o line", (taskLine, text, toneClass) => {
    withStates(true, () => {
      render(<TaskRow row={row({ line: taskLine })} now={NOW} />);
      const el = screen.getByText(text);
      expect(el).toHaveAttribute("data-tone", taskLine.tone);
      expect(el.className).toContain(toneClass);
    });
  });

  it("shows Claude's state as a dot right of the title, not in the checkbox", () => {
    withStates(true, () => {
      render(
        <TaskRow
          row={row({
            ring: "waiting",
            line: line("waiting_question", "waiting", "On continue ?"),
          })}
          now={NOW}
        />,
      );
      // The checkbox stays a plain checkbox.
      const ring = screen.getByRole("button", { name: "Terminer" });
      expect(ring.querySelector("svg")).toHaveAttribute("data-priority", "1");
      const dot = screen.getByRole("img", { name: "Claude attend ta réponse" });
      expect(dot).toHaveAttribute("data-state-dot", "waiting");
      // Right after the title, before the meta.
      const title = screen.getByRole("button", {
        name: "Optimiser le job d'import de données",
      });
      expect(title.nextElementSibling).toBe(dot);
      expect(screen.getByText("Claude attend ta réponse")).toBeInTheDocument();
    });
  });

  it("names Codex on the dot of a Codex session", () => {
    withStates(true, () => {
      render(
        <TaskRow
          row={row({
            ring: "working",
            line: { ...line("working", "muted"), agent: "codex" },
          })}
          now={NOW}
        />,
      );
      expect(
        screen.getByRole("img", { name: "Codex travaille" }),
      ).toBeInTheDocument();
    });
  });

  it("shows no dot for a plain task", () => {
    withStates(true, () => {
      const { container } = render(<TaskRow row={row()} now={NOW} />);
      expect(container.querySelector("[data-state-dot]")).toBeNull();
    });
  });

  it.each([
    [1, "Terminer", "var(--priority-1)", "none"],
    [2, "Terminer · Priorité 3", "var(--priority-2)", "var(--priority-2-fill)"],
    [3, "Terminer · Priorité 2", "var(--priority-3)", "var(--priority-3-fill)"],
    [4, "Terminer · Priorité 1", "var(--priority-4)", "var(--priority-4-fill)"],
  ])(
    "draws stored priority %i on the checkbox outline",
    (priority, name, stroke, fill) => {
      render(<TaskRow row={row({ priority })} now={NOW} />);
      const svg = screen.getByRole("button", { name }).querySelector("svg");
      expect(svg).toHaveAttribute("data-priority", String(priority));
      const base = svg?.querySelector("[data-part='base']");
      expect(base).toHaveAttribute("stroke", stroke);
      expect(base).toHaveAttribute("fill", fill);
    },
  );

  it("shows a chevron that folds the subtasks", () => {
    const child = row({ id: "c1", title: "Sous-tâche", parentId: "t1" });
    let open = true;
    const onToggleChildren = vi.fn(() => {
      open = !open;
    });
    const { rerender } = render(
      <TaskRow
        row={row({ children: [child], subtasksTotal: 1 })}
        now={NOW}
        childrenOpen={open}
        onToggleChildren={onToggleChildren}
      />,
    );
    const chevron = screen.getByRole("button", {
      name: "Masquer les sous-tâches de « Optimiser le job d'import de données »",
    });
    expect(chevron).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(chevron);
    expect(onToggleChildren).toHaveBeenCalledTimes(1);
    rerender(
      <TaskRow
        row={row({ children: [child], subtasksTotal: 1 })}
        now={NOW}
        childrenOpen={open}
        onToggleChildren={onToggleChildren}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: "Afficher les sous-tâches de « Optimiser le job d'import de données »",
      }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("0/1")).toBeInTheDocument();
  });

  it("has no chevron without subtasks", () => {
    render(<TaskRow row={row()} now={NOW} onToggleChildren={() => {}} />);
    expect(screen.queryByRole("button", { name: /sous-tâches/ })).toBeNull();
  });

  it("never shows the description, only a note icon", () => {
    render(<TaskRow row={row({ hasDescription: true })} now={NOW} />);
    expect(screen.getByText("A une note")).toBeInTheDocument();
  });

  it("shows the project label (dot + name) in transverse views", () => {
    render(
      <TaskRow
        row={row({
          subject: { id: "s1", name: "Acme Studio", color: "violet" },
        })}
        now={NOW}
      />,
    );
    const label = screen.getByText("Acme Studio");
    expect(label).toBeInTheDocument();
    expect(label.parentElement?.textContent).not.toContain("#");
  });

  it("shows due, subtasks and open terminals meta", () => {
    render(
      <TaskRow
        row={row({
          due: { date: "2026-10-01", time: "14:00", overdue: false },
          openTerminals: 2,
          subtasksDone: 1,
          subtasksTotal: 3,
        })}
        now={NOW}
      />,
    );
    expect(screen.getByText("14:00")).toBeInTheDocument();
    expect(screen.getByText("1/3")).toBeInTheDocument();
    expect(screen.getByText("2 sessions")).toBeInTheDocument();
  });

  it("hides a due date of today without time in Today", () => {
    const due = { date: "2026-10-01", time: null, overdue: false };
    const { rerender } = render(<TaskRow row={row({ due })} now={NOW} />);
    expect(screen.getByText("Aujourd'hui")).toBeInTheDocument();
    rerender(<TaskRow row={row({ due })} now={NOW} shownDate="2026-10-01" />);
    expect(screen.queryByText("Aujourd'hui")).toBeNull();
  });

  it("keeps only the time of a due date its group already shows", () => {
    const due = { date: "2026-10-14", time: "09:30", overdue: false };
    const { rerender } = render(
      <TaskRow
        row={row({ due: { ...due, time: null } })}
        now={NOW}
        shownDate="2026-10-14"
      />,
    );
    expect(screen.queryByText(/mer/i)).toBeNull();
    rerender(<TaskRow row={row({ due })} now={NOW} shownDate="2026-10-14" />);
    expect(screen.getByText("09:30")).toBeInTheDocument();
    // Another day (a subtask nested under a task of another day) keeps its date.
    rerender(<TaskRow row={row({ due })} now={NOW} shownDate="2026-10-13" />);
    expect(screen.queryByText("09:30")).toBeNull();
  });

  it("marks an overdue due date in brick, not in the waiting red", () => {
    render(
      <TaskRow
        row={row({ due: { date: "2026-09-30", time: null, overdue: true } })}
        now={NOW}
      />,
    );
    // « En retard · Hier », like the kanban card.
    const due = screen.getByText("En retard · Hier").closest("[data-overdue]");
    expect(due?.className).toContain("text-due-overdue");
    expect(due?.className).not.toContain("waiting");
  });

  it("hides empty meta", () => {
    render(
      <TaskRow
        row={row({
          due: { date: "2026-10-12", time: null, overdue: false },
        })}
        now={NOW}
      />,
    );
    expect(screen.getByText("12 oct.")).toBeInTheDocument();
    expect(screen.queryByText(/\d\/\d/)).toBeNull();
  });

  it("strikes a completed task and offers to reopen it", () => {
    render(
      <TaskRow
        row={row({
          ring: "completed",
          completedAt: minutesAgo(8),
          line: line("completed", "faint", null, minutesAgo(8)),
        })}
        now={NOW}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: "Optimiser le job d'import de données",
      }).className,
    ).toContain("line-through");
    expect(screen.getByRole("button", { name: "Rouvrir" })).toBeInTheDocument();
  });

  it("plays the completion animation: filled ring, struck title", () => {
    const { container } = render(
      <TaskRow row={row()} now={NOW} completing="checking" />,
    );
    expect(
      container.querySelector("[data-completing='checking']"),
    ).not.toBeNull();
    const svg = container.querySelector("svg[data-priority]");
    expect(svg).toHaveAttribute("data-completed", "true");
    expect(svg).toHaveAttribute("data-animate", "true");
  });

  it("keeps a single tab stop: inner buttons leave the tab order", () => {
    render(
      <TaskRow
        row={row()}
        now={NOW}
        tabIndex={-1}
        onMenu={() => {}}
        onFile={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: "Optimiser le job d'import de données",
      }),
    ).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: "Terminer" })).toHaveAttribute(
      "tabindex",
      "-1",
    );
    expect(
      screen.getByRole("button", {
        name: "Actions de la tâche Optimiser le job d'import de données",
      }),
    ).toHaveAttribute("tabindex", "-1");
    expect(
      screen.getByRole("button", {
        name: "Ranger « Optimiser le job d'import de données » dans un projet",
      }),
    ).toBeInTheDocument();
  });
});
