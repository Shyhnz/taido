/**
 * « + Lier une tâche » (Relations, 2026-10-11, option A of the mockup): one menu under the
 * section instead of three searches. The kind of link on top (Tab cycles it), a search, quick
 * filters, then every task grouped by project (the task's own project first and open, the
 * others folded). Subtasks sit under their task, folded behind « ▸ 3 » right after its name
 * (→ / ← at the keyboard); a search shows the matching ones unfolded under their task.
 * The list comes from the core (`relation_candidates`): never the task itself nor its own
 * subtasks. ↑↓ move, Entrée links, Échap closes.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  RelationCandidate,
  RelationKind,
  TaskDetail,
} from "../../bindings";
import { fr } from "../../i18n/fr";
import { formatDueDate } from "../../lib/dates";
import { commands } from "../../lib/ipc";
import { run } from "../../lib/run";
import { hasStateDot, StateDot } from "../task-row/StateDot";

const KINDS: { kind: RelationKind; label: string }[] = [
  { kind: "blocks", label: fr.relations.blocks },
  { kind: "blocked_by", label: fr.relations.blockedBy },
  { kind: "relates_to", label: fr.relations.related },
];

type Filter = keyof typeof fr.relations.filter;
const FILTERS = Object.keys(fr.relations.filter) as Filter[];

/** Case and accent insensitive. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** One line of the list: a task (depth 0) or a subtask (depth 1). */
interface Line {
  item: RelationCandidate;
  depth: 0 | 1;
  /** Shown only because a subtask matches the search: greyed. */
  context: boolean;
  /** « Tâche › » before the title (« Récentes »). */
  crumb: boolean;
  /** Subtasks kept by the filter (the « ▸ 3 » toggle), 0 when there is none to show. */
  kids: number;
}

interface Group {
  key: string;
  label: string;
  open: boolean;
  lines: Line[];
}

export function LinkMenu({
  task,
  linked,
  onClose,
}: {
  task: TaskDetail;
  /** Tasks already linked (any kind): shown, not offered. */
  linked: ReadonlySet<string>;
  onClose: () => void;
}) {
  const { data } = useQuery({
    queryKey: ["relationCandidates", task.id],
    queryFn: () => commands.relationCandidates(task.id),
  });
  const [kind, setKind] = useState<RelationKind>("relates_to");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(
    () => new Set([task.subject?.id ?? ""]),
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const optionId = (id: string) => `${baseId}-o-${id}`;
  useEffect(() => inputRef.current?.focus(), []);

  const words = useMemo(
    () => fold(query).split(/\s+/).filter(Boolean),
    [query],
  );
  const ownProject = task.subject?.id ?? null;
  const groups = useMemo(
    () =>
      buildGroups(data?.tasks ?? [], data?.recent ?? [], {
        words,
        filter,
        ownProject,
        openGroups,
        expanded,
      }),
    [data, words, filter, ownProject, openGroups, expanded],
  );
  const lines = groups.flatMap((g) => (g.open ? g.lines : []));
  const current = lines[Math.min(active, lines.length - 1)];
  useEffect(() => {
    if (!current) return;
    document
      .getElementById(optionId(current.item.id))
      ?.scrollIntoView?.({ block: "nearest" });
  });

  const pick = async (item: RelationCandidate) => {
    if (linked.has(item.id)) return;
    await run(
      commands.addRelation({ taskId: task.id, otherId: item.id, kind }),
    );
    onClose();
  };
  const toggle = (id: string, on?: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (on ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });

  const onKeyDown = (e: React.KeyboardEvent) => {
    const at = Math.min(active, lines.length - 1);
    if (e.key === "ArrowDown") {
      setActive(Math.min(at + 1, lines.length - 1));
    } else if (e.key === "ArrowUp") {
      setActive(Math.max(at - 1, 0));
    } else if (e.key === "Enter") {
      if (current) void pick(current.item);
    } else if (e.key === "ArrowRight" && current?.kids) {
      toggle(current.item.id, true);
    } else if (e.key === "ArrowLeft" && current) {
      const parent = current.depth === 1 ? current.item.parentId : null;
      if (parent) {
        setActive(lines.findIndex((l) => l.item.id === parent));
        toggle(parent, false);
      } else if (expanded.has(current.item.id)) {
        toggle(current.item.id, false);
      } else {
        return;
      }
    } else if (e.key === "Tab") {
      const i = KINDS.findIndex((k) => k.kind === kind);
      setKind(KINDS[(i + (e.shiftKey ? 2 : 1)) % 3].kind);
    } else if (e.key === "Escape") {
      onClose();
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const listId = `${baseId}-list`;
  return (
    <section
      aria-label={fr.relations.menu}
      className="mt-1 mb-2 overflow-hidden rounded-lg border border-border bg-elevated shadow-[var(--shadow-popover)]"
    >
      <div className="flex flex-col gap-2 border-b border-border p-2.5">
        <fieldset className="inline-flex self-start rounded-md bg-hover p-0.5">
          <legend className="sr-only">{fr.relations.kind}</legend>
          {KINDS.map((k) => (
            <label key={k.kind} className="relative">
              <input
                type="radio"
                name={`${baseId}-kind`}
                value={k.kind}
                checked={kind === k.kind}
                tabIndex={-1}
                onChange={() => {
                  setKind(k.kind);
                  inputRef.current?.focus();
                }}
                className="peer sr-only"
              />
              <span className="block cursor-pointer rounded-[5px] px-2.5 py-0.5 text-[12.5px] text-text-2 peer-checked:bg-bg peer-checked:font-medium peer-checked:text-text peer-checked:shadow-[0_1px_2px_rgba(0,0,0,0.12)]">
                {k.label}
              </span>
            </label>
          ))}
        </fieldset>
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            current ? optionId(current.item.id) : undefined
          }
          aria-label={fr.relations.searchLabel}
          placeholder={fr.relations.search}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="h-8 w-full rounded-md border border-border-input bg-bg px-2.5 text-[13px] text-text"
        />
        <fieldset className="flex flex-wrap gap-1">
          <legend className="sr-only">{fr.relations.filters}</legend>
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => {
                setFilter(f);
                setActive(0);
                inputRef.current?.focus();
              }}
              className={`rounded-full border px-2.5 py-px text-[12px] ${
                filter === f
                  ? "border-transparent bg-nav-active text-text-nav-active"
                  : "border-border text-text-2 hover:bg-hover"
              }`}
            >
              {fr.relations.filter[f]}
            </button>
          ))}
        </fieldset>
      </div>
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={fr.relations.menu}
        className="max-h-[320px] overflow-y-auto p-1"
      >
        {!data ? (
          <p className="px-2.5 py-2 text-[12.5px] text-text-3">
            {fr.relations.loading}
          </p>
        ) : lines.length === 0 && groups.every((g) => g.open) ? (
          <p className="px-2.5 py-2 text-[12.5px] text-text-3">
            {fr.relations.noResult}
          </p>
        ) : (
          groups.map((g) => (
            // biome-ignore lint/a11y/useSemanticElements: a group of options inside the listbox
            <div key={g.key} role="group" aria-label={g.label}>
              <button
                type="button"
                tabIndex={-1}
                aria-expanded={g.open}
                aria-label={fr.relations.groupLabel(
                  g.label,
                  g.lines.filter((l) => l.depth === 0).length,
                )}
                onClick={() =>
                  setOpenGroups((prev) => {
                    const next = new Set(prev);
                    if (next.has(g.key)) next.delete(g.key);
                    else next.add(g.key);
                    return next;
                  })
                }
                className="flex w-full items-center gap-1.5 px-2.5 pt-2 pb-1 text-left text-[11.5px] font-medium tracking-[0.02em] text-text-3"
              >
                <span
                  aria-hidden
                  className={`inline-block w-2.5 transition-transform ${g.open ? "" : "-rotate-90"}`}
                >
                  ▾
                </span>
                {g.label.toUpperCase()}
                <span className="font-normal">
                  · {g.lines.filter((l) => l.depth === 0).length}
                </span>
              </button>
              {g.open &&
                g.lines.map((line) => (
                  <Option
                    key={`${g.key}-${line.item.id}`}
                    id={optionId(line.item.id)}
                    line={line}
                    active={current?.item.id === line.item.id}
                    linked={linked.has(line.item.id)}
                    expanded={expanded.has(line.item.id)}
                    showToggle={words.length === 0 && filter !== "recent"}
                    onPick={() => void pick(line.item)}
                    onHover={() => setActive(lines.indexOf(line))}
                    onToggle={() => {
                      toggle(line.item.id);
                      inputRef.current?.focus();
                    }}
                  />
                ))}
            </div>
          ))
        )}
      </div>
      <p className="flex flex-wrap gap-x-3 gap-y-0.5 border-t border-border px-2.5 py-1.5 text-[11.5px] text-text-3">
        <span>↑↓ {fr.relations.hints.move}</span>
        <span>→ ← {fr.relations.hints.subtasks}</span>
        <span>Entrée {fr.relations.hints.pick}</span>
        <span>Tab {fr.relations.hints.kind}</span>
        <span>Échap {fr.relations.hints.close}</span>
      </p>
    </section>
  );
}

function Option({
  id,
  line,
  active,
  linked,
  expanded,
  showToggle,
  onPick,
  onHover,
  onToggle,
}: {
  id: string;
  line: Line;
  active: boolean;
  linked: boolean;
  expanded: boolean;
  showToggle: boolean;
  onPick: () => void;
  onHover: () => void;
  onToggle: () => void;
}) {
  const { item, depth } = line;
  const meta = [
    linked
      ? fr.relations.alreadyLinked
      : depth === 0
        ? item.section?.name
        : null,
    item.dueDate ? formatDueDate(item.dueDate) : null,
  ].filter(Boolean);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox input drives the keyboard
    <div
      id={id}
      role="option"
      // Never focused: the search field keeps the focus (aria-activedescendant).
      tabIndex={-1}
      aria-selected={active}
      aria-disabled={linked || undefined}
      onClick={onPick}
      onMouseMove={onHover}
      className={`flex min-w-0 items-center gap-2 rounded-md py-1 pr-2.5 ${
        depth ? "pl-8" : "pl-2.5"
      } ${active ? "bg-hover" : ""} ${linked ? "cursor-default opacity-50" : "cursor-pointer"} ${
        line.context ? "opacity-60" : ""
      }`}
    >
      <span
        aria-hidden
        className={`inline-block shrink-0 rounded-full border-[1.5px] ${
          depth ? "size-[11px]" : "size-[13px]"
        } ${item.completed ? "border-done bg-done" : "border-text-3"}`}
      />
      <span
        className={`min-w-0 truncate ${depth ? "text-[12.5px]" : "text-[13px]"} ${
          item.completed ? "text-text-3 line-through" : "text-text"
        }`}
      >
        {line.crumb && item.parentTitle && (
          <span className="text-text-3">{item.parentTitle} › </span>
        )}
        {item.title}
      </span>
      {hasStateDot(item.ring) && <StateDot ring={item.ring} size={11} />}
      {showToggle && depth === 0 && line.kids > 0 && (
        <button
          type="button"
          tabIndex={-1}
          aria-expanded={expanded}
          aria-label={
            expanded
              ? fr.relations.hideSubtasks(item.title)
              : fr.relations.showSubtasks(line.kids, item.title)
          }
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="shrink-0 rounded border border-border bg-hover px-1.5 text-[12px] font-medium text-text tabular-nums hover:border-border-input"
        >
          {expanded ? "▾" : "▸"} {line.kids}
        </button>
      )}
      {meta.length > 0 && (
        <span className="ml-auto shrink-0 pl-2 text-[12px] text-text-3">
          {meta.join(" · ")}
        </span>
      )}
    </div>
  );
}

/** The groups and lines shown, from the core's list (already in the app's order). */
export function buildGroups(
  tasks: readonly RelationCandidate[],
  recent: readonly string[],
  opts: {
    words: readonly string[];
    filter: Filter;
    ownProject: string | null;
    openGroups: ReadonlySet<string>;
    expanded: ReadonlySet<string>;
  },
): Group[] {
  const { words, filter, ownProject, openGroups, expanded } = opts;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const matches = (t: RelationCandidate) => {
    const text = fold(
      `${t.title} ${t.parentTitle ?? ""} ${t.project ?? ""} ${t.section?.name ?? ""}`,
    );
    return words.every((w) => text.includes(w));
  };
  const keep = (t: RelationCandidate) => {
    switch (filter) {
      case "done":
        return t.completed;
      case "waiting":
        return t.ring === "waiting";
      case "project":
        return !t.completed && (t.subject?.id ?? "") === (ownProject ?? "");
      default:
        return !t.completed;
    }
  };

  if (filter === "recent") {
    const lines: Line[] = recent
      .map((id) => byId.get(id))
      .filter((t): t is RelationCandidate => t !== undefined && matches(t))
      .map((item) => ({
        item,
        depth: 0,
        context: false,
        crumb: true,
        kids: 0,
      }));
    return [
      { key: "recent", label: fr.relations.recentGroup, open: true, lines },
    ];
  }

  // A subtask whose task is listed sits under it; otherwise it is a task of its own here.
  const isTop = (t: RelationCandidate) =>
    t.parentId === null || !byId.has(t.parentId);
  const kidsOf = new Map<string, RelationCandidate[]>();
  for (const t of tasks) {
    if (!isTop(t) && t.parentId) {
      kidsOf.set(t.parentId, [...(kidsOf.get(t.parentId) ?? []), t]);
    }
  }

  const groups = new Map<string, Group>();
  const searching = words.length > 0;
  for (const t of tasks) {
    if (!isTop(t)) continue;
    const kids = (kidsOf.get(t.id) ?? []).filter(keep);
    const hitKids = searching ? kids.filter(matches) : [];
    const self = keep(t) && matches(t);
    if (!self && hitKids.length === 0) continue;
    const key = t.subject?.id ?? "";
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: t.project ?? fr.relations.noProject,
        // Everything open while searching or filtering; else the task's own project only.
        open: searching || filter !== "all" || openGroups.has(key),
        lines: [],
      };
      groups.set(key, group);
    }
    group.lines.push({
      item: t,
      depth: 0,
      context: !self,
      crumb: !!t.parentTitle,
      kids: kids.length,
    });
    const shown = searching ? hitKids : expanded.has(t.id) ? kids : [];
    for (const k of shown) {
      group.lines.push({
        item: k,
        depth: 1,
        context: false,
        crumb: false,
        kids: 0,
      });
    }
  }
  // The task's own project first, then the app's order.
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.key === (ownProject ?? "")) -
      Number(a.key === (ownProject ?? "")),
  );
}
