/**
 * Applying the server's rows to the phone's state (docs/SYNC.md § 2.5): ordered groups with
 * in-group retries, parking of rows whose parent is missing, tombstones that first delete
 * their uncovered local descendants as local changes, then the normalisation N1–N8.
 *
 * Applied rows update the snapshot (their known version), so the diff never queues them back.
 * Normalisation corrections only change `state`: the snapshot diff that follows queues them
 * as local edits, which every device then receives (convergence).
 *
 * Protocol 3 (docs/SYNC.md § 0.6): Kanban columns come after the sections (they wait for their
 * project); time segments, relations and attachments after the tasks (they wait for their
 * tasks, both of them for a relation). A task never waits for its column: it keeps the id as
 * it came (the board shows it in the first column until the column is here). A task tombstone
 * deletes its segments, relations (either side) and attachments; a project tombstone its
 * columns; a column tombstone moves its tasks to no column, silently. A row of an entity this
 * build does not know is ignored (`isShownChange`).
 *
 * The project notebook (docs/SYNC.md § 0.5–0.6): note groups come with the sections, note pages
 * after the child tasks (a page waits for its project), page images with the attachments (they
 * wait for their page). A page whose group or source task is not here is applied without it and
 * kept parked until it arrives (like a task's section); a page in a group of another project is
 * applied as is, then N11 takes it out of the group. A group tombstone leaves its pages without
 * group and a task tombstone unlinks its summaries, silently; a page tombstone deletes its
 * images and a project tombstone its notebook, as local tombstones.
 */

import type {
  MockState,
  SectionRec,
  SubjectRec,
  TaskRec,
} from "../lib/mock-backend";
import type { ColumnRec } from "../lib/mock-board";
import type { SegmentRec } from "../lib/mock-chrono";
import type { AttachmentRec, RelationRec } from "../lib/mock-links";
import type { NoteGroupRec, NotePageRec } from "../lib/mock-notes";
import { type Change, changeKey, validateChange } from "../lib/sync-proto";
import type { OutboxEntry, SnapshotEntry } from "./persisted";
import {
  assertNever,
  hasSetting,
  isShownChange,
  type ShownChange,
  type ShownEntity,
  type SyncedRecs,
  upsertAttachment,
  upsertColumn,
  upsertNoteAttachment,
  upsertNoteGroup,
  upsertNotePage,
  upsertRelation,
  upsertSection,
  upsertSegment,
  upsertSetting,
  upsertSubject,
  upsertTask,
  wireJsonOf,
} from "./wire";

export interface ApplyContext {
  state: MockState;
  /** Attachments, columns, segments, relations: rows are written and removed in place. */
  recs: SyncedRecs;
  snapshot: Record<string, SnapshotEntry>;
  outbox: Record<string, OutboxEntry>;
  parked: Record<string, Change>;
  heldDeletions: Set<string>;
  /** Stamp of a new local change of a row whose known stamp is `known` (§ 2.6). */
  localStamp: (known: string | undefined) => string;
}

export interface ApplyResult {
  /** Rows written or deleted as the server sent them. */
  applied: number;
  /** Rows kept for a later apply (parent still missing). */
  parked: number;
  /** Local descendants deleted by a tombstone (queued as tombstones). */
  cascaded: number;
}

const key = (entity: ShownEntity, id: string) => changeKey({ entity, id });

/** Removes in place the items of `list` that `drop` selects. */
function removeWhere<T>(list: T[], drop: (x: T) => boolean): void {
  let kept = 0;
  for (const x of list) if (!drop(x)) list[kept++] = x;
  list.length = kept;
}

/** Indexes of the state, kept up to date while applying. */
class Present {
  subjects = new Map<string, SubjectRec>();
  sections = new Map<string, SectionRec>();
  tasks = new Map<string, TaskRec>();
  columns = new Map<string, ColumnRec>();
  segments = new Map<string, SegmentRec>();
  relations = new Map<string, RelationRec>();
  attachments = new Map<string, AttachmentRec>();
  noteGroups = new Map<string, NoteGroupRec>();
  notePages = new Map<string, NotePageRec>();
  noteImages = new Map<string, AttachmentRec>();

  constructor(
    private readonly state: MockState,
    recs: SyncedRecs,
  ) {
    for (const s of state.subjects) this.subjects.set(s.id, s);
    for (const s of state.sections) this.sections.set(s.id, s);
    for (const t of state.tasks) this.tasks.set(t.id, t);
    for (const c of recs.boardColumns) this.columns.set(c.id, c);
    for (const x of recs.timeSegments) this.segments.set(x.id, x);
    for (const r of recs.relations) this.relations.set(r.id, r);
    for (const a of recs.attachments) {
      if (a.notePageId === undefined) this.attachments.set(a.id, a);
      else this.noteImages.set(a.id, a);
    }
    for (const g of recs.noteGroups) this.noteGroups.set(g.id, g);
    for (const p of recs.notePages) this.notePages.set(p.id, p);
  }

  has(entity: ShownEntity, id: string): boolean {
    switch (entity) {
      case "subject":
        return this.subjects.has(id);
      case "section":
        return this.sections.has(id);
      case "task":
        return this.tasks.has(id);
      case "setting":
        return hasSetting(this.state, id);
      case "board_column":
        return this.columns.has(id);
      case "time_segment":
        return this.segments.has(id);
      case "relation":
        return this.relations.has(id);
      case "attachment":
        return this.attachments.has(id);
      case "note_group":
        return this.noteGroups.has(id);
      case "note_page":
        return this.notePages.has(id);
      case "note_attachment":
        return this.noteImages.has(id);
      default:
        return assertNever(entity);
    }
  }
}

/** Index of the tombstones' group (§ 2.5). */
const TOMBSTONES = 9;

/**
 * Group of § 2.5 and § 0.6 (0–8: data, 9: tombstones). Settings come first: they reference
 * nothing. Columns come after the sections, segments, relations and attachments after the
 * tasks they hang on; note groups come with the sections, note pages after the child tasks,
 * page images with the attachments (core `apply::group_of`).
 */
function groupOf(c: ShownChange): number {
  if (c.data === null) return TOMBSTONES;
  switch (c.entity) {
    case "setting":
      return 0;
    case "subject":
      return c.data.parent_id === null ? 1 : 2;
    case "section":
    case "note_group":
      return 3;
    case "board_column":
      return 4;
    case "task":
      return c.data.parent_id === null ? 5 : 6;
    case "note_page":
      return 7;
    case "time_segment":
    case "relation":
    case "attachment":
    case "note_attachment":
      return 8;
    default:
      return assertNever(c);
  }
}

/**
 * Tombstones (§ 0.6): attachments and page images, relations, segments, note pages, tasks with
 * a parent, tasks, sections, note groups, columns, sub-projects, projects.
 */
function tombstoneRank(c: ShownChange, present: Present): number {
  switch (c.entity) {
    case "attachment":
    case "note_attachment":
      return 0;
    case "relation":
      return 1;
    case "time_segment":
      return 2;
    case "note_page":
      return 3;
    case "task":
      return present.tasks.get(c.id)?.parentId ? 4 : 5;
    case "section":
      return 6;
    case "note_group":
      return 7;
    case "board_column":
      return 8;
    case "subject":
      return present.subjects.get(c.id)?.parentId ? 9 : 10;
    // Never reached: a setting tombstone is dropped before (a setting is never deleted).
    case "setting":
      return 11;
    default:
      return assertNever(c);
  }
}

/** A reference that must exist before the row can be written (else retry, then park). */
function blocked(c: ShownChange, present: Present): boolean {
  if (c.data === null) return false;
  switch (c.entity) {
    case "subject":
      return (
        c.data.parent_id !== null && !present.subjects.has(c.data.parent_id)
      );
    case "section":
      return !present.subjects.has(c.data.subject_id);
    case "task":
      return (
        (c.data.subject_id !== null &&
          !present.subjects.has(c.data.subject_id)) ||
        (c.data.parent_id !== null && !present.tasks.has(c.data.parent_id))
      );
    // A setting references nothing.
    case "setting":
      return false;
    case "board_column":
      return (
        c.data.subject_id !== null && !present.subjects.has(c.data.subject_id)
      );
    case "time_segment":
    case "attachment":
      return !present.tasks.has(c.data.task_id);
    case "note_group":
    case "note_page":
      return !present.subjects.has(c.data.subject_id);
    case "note_attachment":
      return !present.notePages.has(c.data.note_page_id);
    case "relation":
      return (
        !present.tasks.has(c.data.from_task_id) ||
        !present.tasks.has(c.data.to_task_id)
      );
    default:
      return assertNever(c);
  }
}

export function applyChanges(
  ctx: ApplyContext,
  changes: readonly Change[],
): ApplyResult {
  const result: ApplyResult = { applied: 0, parked: 0, cascaded: 0 };
  const { state, snapshot, outbox, parked } = ctx;

  // Parked rows first, a pulled version of the same key replacing the parked one. A parked
  // row whose key has a local change (outbox) is dropped: the local change goes out, and the
  // server sends its own version back if that one wins (§ 2.4 step 5).
  const merged = new Map<string, ShownChange>();
  for (const c of Object.values(parked)) {
    const k = changeKey(c);
    if (isShownChange(c) && outbox[k] === undefined) merged.set(k, c);
  }
  for (const c of changes) {
    if (!isShownChange(c)) continue;
    if (c.entity === "setting") {
      // The server refuses invalid settings and setting tombstones (a setting is never
      // deleted); one arriving anyway is ignored rather than applied.
      const invalid = validateChange(c);
      if (invalid !== null) {
        console.warn(`sync: ignoring pulled setting ${c.id}: ${invalid}`);
        continue;
      }
    }
    merged.set(changeKey(c), c);
  }
  for (const k of Object.keys(parked)) delete parked[k];
  /** Tasks applied without their missing section, kept to be re-applied when it arrives. */
  const waiting: ShownChange[] = [];

  const { recs } = ctx;
  const present = new Present(state, recs);
  const tombstoned = new Set<string>();
  const groups: ShownChange[][] = Array.from(
    { length: TOMBSTONES + 1 },
    (): ShownChange[] => [],
  );
  for (const c of merged.values()) {
    groups[groupOf(c)].push(c);
    if (c.data === null) tombstoned.add(changeKey(c));
  }

  const remember = (entity: ShownEntity, id: string, stamp: string) => {
    const json = wireJsonOf(state, recs, entity, id);
    const k = key(entity, id);
    if (json !== null) snapshot[k] = { json, stamp };
    ctx.heldDeletions.delete(k);
  };

  const write = (c: ShownChange) => {
    if (c.data === null) return;
    switch (c.entity) {
      case "setting":
        upsertSetting(state, c.id, c.data);
        break;
      case "subject": {
        const rec = upsertSubject(state, c.id, c.data, c.updated_at);
        present.subjects.set(rec.id, rec);
        break;
      }
      case "section": {
        const rec = upsertSection(state, c.id, c.data, c.updated_at);
        present.sections.set(rec.id, rec);
        break;
      }
      case "task": {
        let data = c.data;
        const section =
          data.section_id !== null
            ? present.sections.get(data.section_id)
            : undefined;
        if (data.section_id !== null && !section) {
          // Missing section (a later page, or parked behind its project): the task is
          // applied without it now, and kept to be applied again once it is here (§ 2.5).
          waiting.push(c);
          const k = key("task", c.id);
          if (snapshot[k]?.stamp === c.updated_at && present.tasks.has(c.id)) {
            return; // this version is already here, still waiting
          }
          data = { ...data, section_id: null };
        } else if (section && section.subjectId !== data.subject_id) {
          // A section of another project: no section (§ 2.5).
          data = { ...data, section_id: null };
        }
        const rec = upsertTask(state, c.id, data, c.updated_at);
        present.tasks.set(rec.id, rec);
        break;
      }
      case "board_column": {
        const rec = upsertColumn(recs.boardColumns, c.id, c.data);
        present.columns.set(rec.id, rec);
        break;
      }
      case "time_segment": {
        const rec = upsertSegment(recs.timeSegments, c.id, c.data);
        present.segments.set(rec.id, rec);
        break;
      }
      case "relation": {
        const rec = upsertRelation(recs.relations, c.id, c.data);
        present.relations.set(rec.id, rec);
        break;
      }
      case "attachment": {
        const rec = upsertAttachment(recs.attachments, c.id, c.data);
        present.attachments.set(rec.id, rec);
        break;
      }
      case "note_group": {
        const rec = upsertNoteGroup(
          recs.noteGroups,
          c.id,
          c.data,
          c.updated_at,
        );
        present.noteGroups.set(rec.id, rec);
        break;
      }
      case "note_page": {
        let data = c.data;
        const groupMissing =
          data.group_id !== null && !present.noteGroups.has(data.group_id);
        const taskMissing =
          data.source_task_id !== null &&
          !present.tasks.has(data.source_task_id);
        if (groupMissing || taskMissing) {
          // Missing group or source task (a later page, or parked behind its project): the
          // page is applied without it now, and kept to be applied again once it is here.
          waiting.push(c);
          const k = key("note_page", c.id);
          if (
            snapshot[k]?.stamp === c.updated_at &&
            present.notePages.has(c.id)
          ) {
            return; // this version is already here, still waiting
          }
          data = {
            ...data,
            group_id: groupMissing ? null : data.group_id,
            source_task_id: taskMissing ? null : data.source_task_id,
          };
        }
        const rec = upsertNotePage(recs.notePages, c.id, data, c.updated_at);
        present.notePages.set(rec.id, rec);
        break;
      }
      case "note_attachment": {
        const rec = upsertNoteAttachment(recs.attachments, c.id, c.data);
        present.noteImages.set(rec.id, rec);
        break;
      }
      default:
        assertNever(c);
    }
    remember(c.entity, c.id, c.updated_at);
    result.applied += 1;
  };

  for (let g = 0; g < TOMBSTONES; g += 1) {
    let pending = groups[g];
    while (pending.length > 0) {
      const next: ShownChange[] = [];
      for (const c of pending) {
        if (blocked(c, present)) next.push(c);
        else write(c);
      }
      if (next.length === pending.length) {
        for (const c of next) {
          parked[changeKey(c)] = c;
          result.parked += 1;
        }
        break;
      }
      pending = next;
    }
  }
  for (const c of waiting) parked[changeKey(c)] = c;

  // --- tombstones ------------------------------------------------------------------------
  const queueLocalTombstone = (k: string) => {
    const changedAt = ctx.localStamp(snapshot[k]?.stamp);
    outbox[k] = { changed_at: changedAt, purged: true };
    delete snapshot[k];
    ctx.heldDeletions.delete(k);
    result.cascaded += 1;
  };

  const removeRow = (entity: ShownEntity, id: string) => {
    switch (entity) {
      case "subject":
        state.subjects = state.subjects.filter((s) => s.id !== id);
        present.subjects.delete(id);
        return;
      case "section":
        state.sections = state.sections.filter((s) => s.id !== id);
        present.sections.delete(id);
        return;
      case "task":
        state.tasks = state.tasks.filter((t) => t.id !== id);
        present.tasks.delete(id);
        // ON DELETE SET NULL: the summaries written for it keep their text, unlinked.
        for (const p of present.notePages.values()) {
          if (p.sourceTaskId !== id) continue;
          p.sourceTaskId = null;
          const pk = key("note_page", p.id);
          const known = snapshot[pk];
          if (known) remember("note_page", p.id, known.stamp);
        }
        return;
      // A setting is never deleted.
      case "setting":
        return;
      case "board_column":
        removeWhere(recs.boardColumns, (c) => c.id === id);
        present.columns.delete(id);
        return;
      case "time_segment":
        removeWhere(recs.timeSegments, (x) => x.id === id);
        present.segments.delete(id);
        return;
      case "relation":
        removeWhere(recs.relations, (r) => r.id === id);
        present.relations.delete(id);
        return;
      case "attachment":
        removeWhere(recs.attachments, (a) => a.id === id);
        present.attachments.delete(id);
        return;
      case "note_attachment":
        removeWhere(recs.attachments, (a) => a.id === id);
        present.noteImages.delete(id);
        return;
      case "note_group":
        removeWhere(recs.noteGroups, (g) => g.id === id);
        present.noteGroups.delete(id);
        return;
      case "note_page":
        removeWhere(recs.notePages, (p) => p.id === id);
        present.notePages.delete(id);
        return;
      default:
        assertNever(entity);
    }
  };

  const descendants = (
    entity: ShownEntity,
    id: string,
  ): [ShownEntity, string][] => {
    const out: [ShownEntity, string][] = [];
    const taskSet = new Set<string>();
    /** The project's columns (its sub-projects' too), after the tasks that use them. */
    const columns: [ShownEntity, string][] = [];
    /** The notebook: images, then pages (before the tasks), then groups (after the sections). */
    const notebook: [ShownEntity, string][] = [];
    const groups: [ShownEntity, string][] = [];
    if (entity === "note_page") {
      for (const a of present.noteImages.values()) {
        if (a.notePageId === id) out.push(["note_attachment", a.id]);
      }
      return out;
    }
    if (entity === "subject") {
      const subjects = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const s of present.subjects.values()) {
          if (s.parentId && subjects.has(s.parentId) && !subjects.has(s.id)) {
            subjects.add(s.id);
            out.push(["subject", s.id]);
            grew = true;
          }
        }
      }
      for (const s of present.sections.values()) {
        if (subjects.has(s.subjectId)) out.push(["section", s.id]);
      }
      for (const c of present.columns.values()) {
        if (c.subjectId !== null && subjects.has(c.subjectId)) {
          columns.push(["board_column", c.id]);
        }
      }
      const pages = new Set<string>();
      for (const p of present.notePages.values()) {
        if (subjects.has(p.subjectId)) pages.add(p.id);
      }
      for (const a of present.noteImages.values()) {
        if (a.notePageId !== undefined && pages.has(a.notePageId)) {
          notebook.push(["note_attachment", a.id]);
        }
      }
      for (const p of pages) notebook.push(["note_page", p]);
      for (const g of present.noteGroups.values()) {
        if (subjects.has(g.subjectId)) groups.push(["note_group", g.id]);
      }
      for (const t of present.tasks.values()) {
        if (t.subjectId !== null && subjects.has(t.subjectId)) {
          taskSet.add(t.id);
        }
      }
    } else if (entity === "task") {
      taskSet.add(id);
    } else {
      return out;
    }
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of present.tasks.values()) {
        if (t.parentId && taskSet.has(t.parentId) && !taskSet.has(t.id)) {
          taskSet.add(t.id);
          grew = true;
        }
      }
    }
    // Deepest first: the attachments, relations (either side) and time segments of the
    // doomed tasks (the task's own included).
    const doomed: [ShownEntity, string][] = [];
    for (const a of present.attachments.values()) {
      if (taskSet.has(a.taskId)) doomed.push(["attachment", a.id]);
    }
    for (const r of present.relations.values()) {
      if (taskSet.has(r.from) || taskSet.has(r.to)) {
        doomed.push(["relation", r.id]);
      }
    }
    for (const x of present.segments.values()) {
      if (taskSet.has(x.taskId)) doomed.push(["time_segment", x.id]);
    }
    taskSet.delete(id);
    for (const t of taskSet) out.push(["task", t]);
    return [...doomed, ...notebook, ...out, ...columns, ...groups];
  };

  const tombstones = groups[TOMBSTONES]
    .map((c, i) => ({ c, i, rank: tombstoneRank(c, present) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.c);

  for (const c of tombstones) {
    const k = changeKey(c);
    if (!present.has(c.entity, c.id)) {
      // Unknown row: nothing to delete (a held deletion is settled by it).
      delete snapshot[k];
      ctx.heldDeletions.delete(k);
      continue;
    }
    for (const [e, id] of descendants(c.entity, c.id)) {
      const dk = key(e, id);
      if (tombstoned.has(dk) || !present.has(e, id)) continue;
      removeRow(e, id);
      queueLocalTombstone(dk);
    }
    if (c.entity === "note_group") {
      // ON DELETE SET NULL, as an applied write (the deleting device sends the pages).
      for (const p of present.notePages.values()) {
        if (p.groupId !== c.id) continue;
        p.groupId = null;
        const pk = key("note_page", p.id);
        const known = snapshot[pk];
        if (known) remember("note_page", p.id, known.stamp);
      }
    }
    if (c.entity === "section" || c.entity === "board_column") {
      // ON DELETE SET NULL, as an applied write (the deleting device sends the tasks).
      for (const t of present.tasks.values()) {
        if (c.entity === "section") {
          if (t.sectionId !== c.id) continue;
          t.sectionId = null;
        } else {
          if (t.boardColumnId !== c.id) continue;
          t.boardColumnId = null;
        }
        const tk = key("task", t.id);
        const known = snapshot[tk];
        if (known) remember("task", t.id, known.stamp);
      }
    }
    removeRow(c.entity, c.id);
    delete snapshot[k];
    ctx.heldDeletions.delete(k);
    result.applied += 1;
  }

  return result;
}

/**
 * Duplicate relations (§ 0.6): two live relations of the same kind between the same two tasks,
 * in either direction, keep the lowest id; the others are soft-deleted at `now`, as local
 * edits (the diff queues them). Returns how many went.
 */
export function dedupeRelations(relations: RelationRec[], now: string): number {
  const kept = new Map<string, RelationRec>();
  let n = 0;
  const live = relations
    .filter((r) => r.deletedAt === null)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const r of live) {
    const [x, y] = r.from < r.to ? [r.from, r.to] : [r.to, r.from];
    const pair = `${r.kind}\u0000${x}\u0000${y}`;
    if (kept.has(pair)) {
      r.deletedAt = now;
      n += 1;
    } else {
      kept.set(pair, r);
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Normalisation N1–N8 (§ 2.5) and N11 (§ 2.5 notebook), as local edits
// ---------------------------------------------------------------------------

interface Node {
  id: string;
  parentId: string | null;
  updatedAt: string;
}

/** Breaks one parent cycle (lowest (updatedAt, id) member loses its parent); 1 if fixed. */
function breakOneCycle<T extends Node>(items: T[]): number {
  const byId = new Map(items.map((x) => [x.id, x]));
  const done = new Set<string>();
  for (const start of items) {
    if (done.has(start.id)) continue;
    const path: T[] = [];
    const onPath = new Set<string>();
    let cur: T | undefined = start;
    while (cur && !done.has(cur.id)) {
      if (onPath.has(cur.id)) {
        const from = path.findIndex((x) => x.id === cur?.id);
        const cycle = path.slice(from);
        const loser = cycle.reduce((min, x) =>
          x.updatedAt < min.updatedAt ||
          (x.updatedAt === min.updatedAt && x.id < min.id)
            ? x
            : min,
        );
        loser.parentId = null;
        return 1;
      }
      onPath.add(cur.id);
      path.push(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    for (const x of path) done.add(x.id);
  }
  return 0;
}

/** A child of a child moves up to its grandparent (one level only). */
function flatten<T extends Node>(items: T[]): number {
  const byId = new Map(items.map((x) => [x.id, x]));
  let n = 0;
  for (const x of items) {
    const p = x.parentId ? byId.get(x.parentId) : undefined;
    if (p && p.parentId !== null && p.parentId !== x.id) {
      x.parentId = p.parentId;
      n += 1;
    }
  }
  return n;
}

/**
 * Runs N1–N8 until nothing changes; returns the number of corrections. With the notebook
 * (`notes`) it also runs N11: a page in a group of another project (or one that is not here)
 * leaves it.
 */
export function normalise(
  state: MockState,
  notes?: { groups: readonly NoteGroupRec[]; pages: readonly NotePageRec[] },
): number {
  let total = 0;
  for (let round = 0; round < 1000; round += 1) {
    let n = 0;
    n += breakOneCycle(state.subjects); // N1
    n += flatten(state.subjects); // N2
    n += breakOneCycle(state.tasks); // N3
    n += flatten(state.tasks); // N4
    const tasks = new Map(state.tasks.map((t) => [t.id, t]));
    const sections = new Map(state.sections.map((s) => [s.id, s]));
    const subjects = new Map(state.subjects.map((s) => [s.id, s]));
    for (const t of state.tasks) {
      // N5: a child task shares its parent's place.
      const p = t.parentId ? tasks.get(t.parentId) : undefined;
      if (p && (t.subjectId !== p.subjectId || t.sectionId !== p.sectionId)) {
        t.subjectId = p.subjectId;
        t.sectionId = p.sectionId;
        n += 1;
      }
    }
    for (const t of state.tasks) {
      // N6: a section of another project (or a missing one).
      if (t.sectionId === null) continue;
      const s = sections.get(t.sectionId);
      if (!s || s.subjectId !== t.subjectId) {
        t.sectionId = null;
        n += 1;
      }
    }
    for (const s of state.subjects) {
      // N7: delete wins, a live sub-project under a deleted parent.
      if (s.deletedAt !== null || s.parentId === null) continue;
      const p = subjects.get(s.parentId);
      if (p && p.deletedAt !== null) {
        s.deletedAt = p.deletedAt;
        n += 1;
      }
    }
    for (const t of state.tasks) {
      // N8: a live task in a deleted project or under a deleted parent task.
      if (t.deletedAt !== null) continue;
      const subject = t.subjectId ? subjects.get(t.subjectId) : undefined;
      const parent = t.parentId ? tasks.get(t.parentId) : undefined;
      const at = subject?.deletedAt ?? parent?.deletedAt ?? null;
      if (at !== null) {
        t.deletedAt = at;
        n += 1;
      }
    }
    if (notes) {
      const groups = new Map(notes.groups.map((g) => [g.id, g]));
      for (const p of notes.pages) {
        // N11: a notebook page in a group of another project leaves it.
        if (p.groupId === null) continue;
        const g = groups.get(p.groupId);
        if (!g || g.subjectId !== p.subjectId) {
          p.groupId = null;
          n += 1;
        }
      }
    }
    if (n === 0) break;
    total += n;
  }
  return total;
}
