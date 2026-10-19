/**
 * Quick add: ⌘N, `q` and « Nouvelle tâche ».
 * One title field whose tokens are coloured live (`#projet`, `/section`, French dates and
 * times, `>claude`, `>shell`), a description, chips that say what the add will do, `#` and `/`
 * completion, and « Créer « X » ? » for an unknown project.
 *
 * The text is parsed by `parseQuickAdd` (pure). Removing a chip, or picking a value in its
 * menu, turns the matching tokens back into plain text (`literals`). The context of the view
 * (project, « Aujourd'hui ») is a default that tokens override.
 *
 * `>claude` opens Claude Code once the task exists, with no first message (by design: the user
 * talks to Claude in its terminal), through the usual folder flow; `>shell` opens a shell.
 * Where there are no terminals (`features.terminals` off: the phone), `>claude` and `>shell`
 * are plain text and « Ajouter et lancer » never shows.
 *
 * `!1`, `!2`, `!3` set the priority: `createTask` has no
 * priority, so it is set right after with `setTaskPriority`.
 */

import { useQueryClient } from "@tanstack/react-query";
import {
  CalendarDays,
  Flag,
  Inbox,
  Sparkles,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { AddTarget, Subject } from "../../bindings";
import { Button } from "../../components/Button";
import { DatePickerPopover } from "../../components/DatePicker";
import { Dialog } from "../../components/Dialog";
import { announce } from "../../components/LiveRegion";
import { openMenuAt } from "../../components/Menu";
import { t } from "../../i18n";
import { formatDue } from "../../lib/dates";
import { features } from "../../lib/features";
import { subjectColorVar } from "../../lib/format";
import { commands } from "../../lib/ipc";
import { queryKeys, useSubjects } from "../../lib/queries";
import { run } from "../../lib/run";
import { useUi } from "../../stores/ui";
import { createProject, nextProjectColor } from "../sidebar/subjectActions";
import { displayPriority, priorityColor } from "../task-row/PriorityRing";
import { launchAgent, openTerminal } from "../terminals/actions";
import {
  Dot,
  type Draft,
  destinationItems,
  destinationLabel,
  draftFromTarget,
  dueChoiceOf,
  dueDateOf,
  dueTimeOf,
  notifyAdded,
} from "../views/TaskEditor";
import {
  applyCompletion,
  type Completion,
  type CompletionOption,
  findCompletion,
} from "./complete";
import {
  type LaunchKind,
  literalsWithout,
  type ParseResult,
  parseQuickAdd,
  type QuickToken,
  type Range,
  shiftRanges,
  type TokenKind,
} from "./parse";

/** Destination and due date of the task: the defaults, overridden by the tokens. */
export function effectiveDraft(parsed: ParseResult, defaults: Draft): Draft {
  return {
    subjectId: parsed.subject?.id ?? defaults.subjectId,
    sectionId: parsed.subject
      ? (parsed.section?.id ?? null)
      : defaults.sectionId,
    due: parsed.due
      ? { date: parsed.due.date, time: parsed.due.time ?? null }
      : defaults.due,
  };
}

/** Opens what `>claude`, `>codex` or `>shell` asked for, in the new task's panel. */
function launch(taskId: string, kind: LaunchKind): void {
  useUi.getState().openTask(taskId);
  // No first message: Claude only gets the task context.
  if (kind === "shell") void openTerminal(taskId, "shell");
  else void launchAgent(taskId, kind);
}

const TOKEN_CLASS: Record<TokenKind, string> = {
  project: "bg-token-project-bg text-token-project",
  section: "bg-token-project-bg text-token-project",
  agent: "bg-token-agent-bg text-token-agent",
  date: "bg-token-date-bg text-token-date",
  time: "bg-token-date-bg text-token-date",
  // Coloured inline with the `--priority-N` tokens (tokenStyle).
  priority: "",
};

/** A priority token takes the colours of its flag: `--priority-N` on `--priority-N-fill`. */
function tokenStyle(token: QuickToken): CSSProperties | undefined {
  if (token.kind !== "priority") return undefined;
  return {
    color: `var(--priority-${token.value})`,
    backgroundColor: `var(--priority-${token.value}-fill)`,
  };
}

function tokenClass(token: QuickToken): string {
  if (token.kind === "project" && token.value.subjectId === null) {
    // Unknown project: not recognised yet, only hinted.
    return "bg-transparent text-token-project underline decoration-dotted underline-offset-4";
  }
  return `rounded-[3px] ${TOKEN_CLASS[token.kind]}`;
}

/** Same metrics for the field and the coloured copy drawn under it. */
const FIELD_TEXT = "h-9 w-full px-4 text-[16px] font-medium leading-9";

function Highlight({ text, tokens }: { text: string; tokens: QuickToken[] }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const token of tokens) {
    parts.push(text.slice(cursor, token.start));
    parts.push(
      <mark
        key={token.start}
        data-token={token.kind}
        className={tokenClass(token)}
        style={tokenStyle(token)}
      >
        {text.slice(token.start, token.end)}
      </mark>,
    );
    cursor = token.end;
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

const CHIP =
  "inline-flex h-7 max-w-[280px] items-center rounded-md border border-border text-[12.5px] text-text-2";
const CHIP_PART =
  "inline-flex h-full min-w-0 items-center gap-1.5 px-2 hover:bg-hover hover:text-text";

function Chip({
  icon,
  label,
  accessibleLabel,
  onOpen,
  onRemove,
  dashed = false,
  chipRef,
}: {
  icon: ReactNode;
  label: string;
  accessibleLabel: string;
  onOpen?: (anchor: HTMLButtonElement) => void;
  onRemove?: () => void;
  dashed?: boolean;
  chipRef?: RefObject<HTMLButtonElement | null>;
}) {
  if (!onOpen) {
    // A chip that can only be removed: the whole chip is the remove button.
    return (
      <button
        type="button"
        aria-label={t.quickAdd.remove(label)}
        className={`${CHIP} ${CHIP_PART} rounded-md`}
        onClick={onRemove}
      >
        {icon}
        <span className="truncate">{label}</span>
        <X size={12} aria-hidden className="shrink-0 text-text-3" />
      </button>
    );
  }
  return (
    <span className={`${CHIP} ${dashed ? "border-dashed" : ""}`}>
      <button
        ref={chipRef}
        type="button"
        aria-label={accessibleLabel}
        className={`${CHIP_PART} ${onRemove ? "rounded-l-md" : "rounded-md"}`}
        onClick={(e) => onOpen(e.currentTarget)}
      >
        {icon}
        <span className="truncate">{label}</span>
      </button>
      {onRemove && (
        <button
          type="button"
          aria-label={t.quickAdd.remove(label)}
          title={t.quickAdd.remove(label)}
          className="inline-flex h-full items-center rounded-r-md border-l border-border px-1.5 text-text-3 hover:bg-hover hover:text-text"
          onClick={onRemove}
        >
          <X size={12} aria-hidden />
        </button>
      )}
    </span>
  );
}

function Suggestions({
  id,
  completion,
  active,
  onPick,
  onHover,
}: {
  id: string;
  completion: Completion;
  active: number;
  onPick: (option: CompletionOption) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div
      id={id}
      role="listbox"
      aria-label={t.quickAdd.suggestions}
      className="mx-3 mb-1 max-h-56 overflow-y-auto rounded-lg border border-border bg-elevated py-1 shadow-pop"
    >
      {completion.options.map((option, i) => (
        <div
          key={option.insert}
          id={`${id}-${i}`}
          role="option"
          // Never focused: the field keeps the focus (aria-activedescendant).
          tabIndex={-1}
          aria-selected={i === active}
          // The field keeps the focus: the pointer picks without blurring it.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(option);
          }}
          onMouseEnter={() => onHover(i)}
          className={`flex cursor-default items-center gap-2 px-3 py-1.5 text-[13.5px] ${
            i === active ? "bg-selected text-text" : "text-text-2"
          }`}
        >
          {option.date ? (
            <CalendarDays size={14} aria-hidden className="text-text-3" />
          ) : (
            <Dot color={subjectColorVar(option.color)} />
          )}
          <span className="truncate">{option.label}</span>
          {option.hint && (
            <span className="ml-auto shrink-0 text-[12px] text-text-3">
              {option.hint}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function QuickAddForm({
  target,
  onClose,
}: {
  target: AddTarget;
  onClose: () => void;
}) {
  const subjects: Subject[] = useSubjects().data ?? [];
  const queryClient = useQueryClient();
  const [text, setTextState] = useState("");
  const [description, setDescription] = useState("");
  const [literals, setLiterals] = useState<Range[]>([]);
  const [defaults, setDefaults] = useState<Draft>(() =>
    draftFromTarget(target),
  );
  const [caret, setCaret] = useState(0);
  const [titleFocused, setTitleFocused] = useState(true);
  const [active, setActive] = useState(0);
  /** The suggestion was chosen with ↑/↓: Entrée takes it even when it is a loose match. */
  const [navigated, setNavigated] = useState(false);
  /** Text at which the suggestions were closed (Escape, a pick): shown again on typing. */
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [dueOpen, setDueOpen] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const dueRef = useRef<HTMLButtonElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const listId = useId();

  const options = {
    contextSubjectId: defaults.subjectId,
    literals,
    agents: features.terminals,
  };
  const parsed = parseQuickAdd(text, new Date(), subjects, options);
  const draft = effectiveDraft(parsed, defaults);
  const completion =
    titleFocused && dismissedAt !== text
      ? findCompletion(text, caret, subjects, parsed.slashSubject)
      : null;
  const activeIndex = completion
    ? Math.min(active, completion.options.length - 1)
    : 0;

  // The coloured copy scrolls with the field; the caret moves after a pick.
  useLayoutEffect(() => {
    const input = titleRef.current;
    if (!input) return;
    if (pendingCaret.current !== null) {
      input.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
    if (mirrorRef.current) mirrorRef.current.scrollLeft = input.scrollLeft;
  });

  const setText = (next: string) => {
    setLiterals((current) => shiftRanges(text, next, current));
    setTextState(next);
    setActive(0);
    setNavigated(false);
  };

  const readCaret = () => {
    const input = titleRef.current;
    if (input) setCaret(input.selectionStart ?? input.value.length);
    if (input && mirrorRef.current) {
      mirrorRef.current.scrollLeft = input.scrollLeft;
    }
  };

  const pick = (option: CompletionOption) => {
    if (!completion) return;
    const next = applyCompletion(text, completion, option);
    setText(next.text);
    setCaret(next.caret);
    pendingCaret.current = next.caret;
    setDismissedAt(next.text);
  };

  /** Turns the tokens of `kinds` back into text so they no longer apply. */
  const forget = (kinds: TokenKind[]) =>
    setLiterals(literalsWithout(text, new Date(), subjects, options, kinds));

  const removeDue = () => {
    forget(["date", "time"]);
    setDefaults((d) => ({ ...d, due: null }));
  };
  const removeDestination = () => {
    forget(["project", "section"]);
    setDefaults((d) => ({ ...d, subjectId: null, sectionId: null }));
  };
  const removeAgent = () => forget(["agent"]);
  const removePriority = () => forget(["priority"]);

  const createUnknown = async () => {
    const name = parsed.unknownProject;
    if (!name || creating) return;
    setCreating(true);
    const subject = await createProject(
      name,
      nextProjectColor(subjects),
      false,
    );
    if (subject) {
      // The token is recognised as soon as the list knows the project.
      await queryClient.invalidateQueries({ queryKey: queryKeys.subjects });
      announce(t.quickAdd.projectCreated(subject.name));
    }
    setCreating(false);
    titleRef.current?.focus();
  };

  const submit = async (keepOpen: boolean) => {
    if (busy) return;
    // Parsed again at the moment of adding: « demain » after midnight is the right day.
    const now = new Date();
    const final = parseQuickAdd(text, now, subjects, options);
    if (final.title.length === 0) return;
    const finalDraft = effectiveDraft(final, defaults);
    setBusy(true);
    const task = await run(
      commands.createTask({
        title: final.title,
        description: description.trim().length > 0 ? description : null,
        subjectId: finalDraft.subjectId,
        sectionId: finalDraft.sectionId,
        dueDate: dueDateOf(finalDraft.due, now),
        dueTime: dueTimeOf(finalDraft.due),
      }),
      t.errors.action.createTask,
    );
    if (task && final.priority !== undefined) {
      // The task exists even when this fails: the toast says so and the add goes on.
      await run(
        commands.setTaskPriority({ id: task.id, priority: final.priority }),
        t.errors.action.updateTask,
      );
    }
    setBusy(false);
    if (!task) return;
    notifyAdded(target, finalDraft, task.title, subjects);
    // Opening Claude or a shell needs the panel (and maybe a folder): the dialog closes,
    // with ⌥Enter too.
    if (final.launch) {
      onClose();
      launch(task.id, final.launch);
      return;
    }
    if (!keepOpen) {
      onClose();
      return;
    }
    setTextState("");
    setDescription("");
    setLiterals([]);
    setCaret(0);
    titleRef.current?.focus();
  };

  const onTitleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (completion) {
      const count = completion.options.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setActive((activeIndex + delta + count) % count);
        setNavigated(true);
        return;
      }
      const option = completion.options[activeIndex];
      // Entrée adds the task over a loose match (« Nettoyer /tmp » and a « Templates »
      // section) unless that suggestion was chosen with ↑/↓; Tab always inserts it.
      const takes =
        e.key === "Tab"
          ? !e.shiftKey
          : e.key === "Enter" && !e.altKey && (option.strong || navigated);
      if (takes) {
        e.preventDefault();
        pick(option);
        return;
      }
      if (e.key === "Escape") {
        // Closes the suggestions only, not the dialog.
        e.preventDefault();
        e.stopPropagation();
        setDismissedAt(text);
        return;
      }
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      descriptionRef.current?.focus();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit(e.altKey);
    }
  };

  const onDescriptionKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit(e.altKey);
      return;
    }
    const field = e.currentTarget;
    if (
      e.key === "ArrowUp" &&
      field.selectionStart === 0 &&
      field.selectionEnd === 0
    ) {
      e.preventDefault();
      titleRef.current?.focus();
    }
  };

  const subject = subjects.find((s) => s.id === draft.subjectId);
  const where = destinationLabel(draft, subjects);
  const dueDate = dueDateOf(draft.due);
  const dueLabel = dueDate
    ? formatDue({ date: dueDate, time: dueTimeOf(draft.due) })
    : null;
  const agentLabel =
    parsed.launch === "shell"
      ? t.quickAdd.agentShell
      : parsed.launch
        ? t.quickAdd.agentOnAdd(parsed.launch)
        : null;
  const priorityLabel =
    parsed.priority !== undefined
      ? t.quickAdd.priority(displayPriority(parsed.priority))
      : null;
  const empty = parsed.title.length === 0;

  return (
    <div className="flex flex-col">
      <div className="relative pt-3">
        <div
          ref={mirrorRef}
          aria-hidden="true"
          data-testid="quick-add-highlight"
          className={`pointer-events-none absolute inset-x-0 top-3 overflow-hidden whitespace-pre text-text ${FIELD_TEXT}`}
        >
          <Highlight text={text} tokens={parsed.tokens} />
        </div>
        <input
          ref={titleRef}
          data-autofocus
          role="combobox"
          aria-label={t.quickAdd.titleLabel}
          aria-autocomplete="list"
          aria-expanded={completion !== null}
          aria-controls={completion ? listId : undefined}
          aria-activedescendant={
            completion ? `${listId}-${activeIndex}` : undefined
          }
          autoComplete="off"
          spellCheck={false}
          placeholder={t.quickAdd.titlePlaceholder}
          value={text}
          onChange={(e) => {
            setText(e.target.value.replace(/[\r\n]+/g, " "));
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={readCaret}
          onScroll={readCaret}
          onFocus={() => setTitleFocused(true)}
          onBlur={() => setTitleFocused(false)}
          onKeyDown={onTitleKeyDown}
          className={`relative bg-transparent text-transparent caret-text outline-hidden placeholder:text-text-3 selection:bg-selected selection:text-text ${FIELD_TEXT}`}
        />
      </div>
      {completion && (
        <Suggestions
          id={listId}
          completion={completion}
          active={activeIndex}
          onPick={pick}
          onHover={setActive}
        />
      )}
      <textarea
        ref={descriptionRef}
        aria-label={t.quickAdd.descriptionLabel}
        placeholder={t.quickAdd.descriptionLabel}
        value={description}
        rows={1}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={onDescriptionKeyDown}
        className="field-sizing-content mx-4 mb-2 resize-none bg-transparent text-[13.5px] text-text-2 outline-hidden placeholder:text-text-3"
      />
      {parsed.unknownProject !== undefined && !completion && (
        <p className="px-4 pb-2 text-[12.5px] text-text-2">
          {t.quickAdd.unknownProject} ·{" "}
          <button
            type="button"
            disabled={creating}
            onClick={() => void createUnknown()}
            className="rounded-sm font-medium text-accent hover:underline disabled:opacity-50"
          >
            {t.quickAdd.createProject(parsed.unknownProject)}
          </button>
        </p>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: a group of chips, not a form fieldset */}
      <div
        role="group"
        aria-label={t.quickAdd.chips}
        className="flex flex-wrap items-center gap-2 px-4 pb-3"
      >
        <Chip
          chipRef={dueRef}
          icon={<CalendarDays size={13} aria-hidden className="shrink-0" />}
          label={dueLabel ?? t.editor.noDue}
          accessibleLabel={dueLabel ? t.editor.due(dueLabel) : t.editor.noDue}
          dashed={!dueLabel}
          onOpen={() => setDueOpen((o) => !o)}
          onRemove={dueLabel ? removeDue : undefined}
        />
        <Chip
          icon={
            subject ? (
              <Dot color={subjectColorVar(subject.color)} />
            ) : (
              <Inbox size={13} aria-hidden className="shrink-0" />
            )
          }
          label={where}
          accessibleLabel={t.editor.destination(where)}
          onOpen={(anchor) =>
            openMenuAt(
              anchor,
              destinationItems(draft, subjects, (d) => {
                forget(["project", "section"]);
                setDefaults((current) => ({
                  ...current,
                  subjectId: d.subjectId,
                  sectionId: d.sectionId,
                }));
              }),
              t.editor.projectMenu,
            )
          }
          onRemove={subject ? removeDestination : undefined}
        />
        {agentLabel && (
          <Chip
            icon={
              parsed.launch !== "shell" ? (
                <Sparkles size={13} aria-hidden className="shrink-0" />
              ) : (
                <SquareTerminal size={13} aria-hidden className="shrink-0" />
              )
            }
            label={agentLabel}
            accessibleLabel={agentLabel}
            onRemove={removeAgent}
          />
        )}
        {priorityLabel && parsed.priority !== undefined && (
          <Chip
            icon={
              <Flag
                size={13}
                aria-hidden
                className="shrink-0"
                style={{ color: priorityColor(parsed.priority) }}
                fill="currentColor"
              />
            }
            label={priorityLabel}
            accessibleLabel={priorityLabel}
            onRemove={removePriority}
          />
        )}
        {dueOpen && (
          <DatePickerPopover
            anchorRef={dueRef}
            value={{ date: dueDate, time: dueTimeOf(draft.due) }}
            onChange={(v) => {
              forget(["date", "time"]);
              setDefaults((d) => ({ ...d, due: dueChoiceOf(v) }));
            }}
            onClose={(restoreFocus) => {
              setDueOpen(false);
              if (restoreFocus) dueRef.current?.focus();
            }}
          />
        )}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5">
        <span className="truncate text-[12px] text-text-3">
          {features.terminals ? t.quickAdd.help : t.quickAdd.helpMobile}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            title={features.shortcuts ? t.quickAdd.cancelHint : undefined}
            onClick={onClose}
          >
            {t.common.cancel}
          </Button>
          <Button
            size="sm"
            variant="primary"
            title={features.shortcuts ? t.quickAdd.submitHint : undefined}
            disabled={empty || busy}
            onClick={() => void submit(false)}
          >
            {parsed.launch ? t.quickAdd.submitAndLaunch : t.quickAdd.submit}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function QuickAddDialog({
  target,
  onClose,
}: {
  target: AddTarget;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={t.addTask.dialogTitle}
      onClose={onClose}
      width={640}
      hideTitle
    >
      <QuickAddForm target={target} onClose={onClose} />
    </Dialog>
  );
}
