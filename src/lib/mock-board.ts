/**
 * Kanban columns of the mock backend, following the core's `db::board_columns`:
 * per project (and « Sans projet », `null`), created on first use with the defaults, the done
 * column last. A task without column, or with another board's column, is in the first one.
 *
 * A task's column is its `TaskRec.boardColumnId` (synced); the default columns have
 * the core's fixed ids (`defaultColumnId`, docs/SYNC.md § 0.7). The web app tells when the
 * defaults may be made (`canCreateDefaults`: not while a linked device has never pulled, the
 * Mac's may be on their way) and queues those it makes (`onDefaultsCreated`).
 */

import { activeLanguage } from "../i18n";

export interface ColumnRec {
  id: string;
  subjectId: string | null;
  name: string;
  position: number;
  isDone: boolean;
  /** Synced (`BoardColumnData.created_at`). Optional: absent in a set saved by an older build. */
  createdAt?: string;
}

/** A task as the board needs it: its synced column. */
export interface BoardTask {
  boardColumnId?: string | null;
}

/** Id of a default column, like the core's `board_columns::default_id`. */
export const defaultColumnId = (subjectId: string | null, index: number) =>
  `col-${subjectId ?? "inbox"}-${index}`;

export interface MockBoardOptions {
  newId: () => string;
  now: () => string;
  /** Whether a board without columns gets the defaults now (else it stays empty). */
  canCreateDefaults?: () => boolean;
  /** Called with the default columns `ensure` just made. */
  onDefaultsCreated?: (columns: ColumnRec[]) => void;
}

export const DEFAULT_COLUMNS =
  activeLanguage === "fr"
    ? ["À faire", "En cours", "À valider", "Terminé"]
    : ["To do", "In progress", "To review", "Done"];

function invalid(message: string) {
  return { kind: "invalid", message };
}

export class MockBoard {
  columns: ColumnRec[] = [];
  canCreateDefaults: () => boolean;
  onDefaultsCreated: (columns: ColumnRec[]) => void;
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(options: MockBoardOptions) {
    this.newId = options.newId;
    this.now = options.now;
    this.canCreateDefaults = options.canCreateDefaults ?? (() => true);
    this.onDefaultsCreated = options.onDefaultsCreated ?? (() => {});
  }

  reset(): void {
    this.columns = [];
  }

  private list(subjectId: string | null): ColumnRec[] {
    return this.columns
      .filter((c) => c.subjectId === subjectId)
      .sort((a, b) =>
        a.isDone !== b.isDone
          ? Number(a.isDone) - Number(b.isDone)
          : a.position - b.position || a.id.localeCompare(b.id),
      );
  }

  /**
   * The board's columns, made with the defaults the first time (fixed ids; an id already here
   * is kept as it is). Empty while `canCreateDefaults` says no.
   */
  ensure(subjectId: string | null): ColumnRec[] {
    if (this.list(subjectId).length === 0 && this.canCreateDefaults()) {
      const now = this.now();
      const made: ColumnRec[] = [];
      DEFAULT_COLUMNS.forEach((name, i) => {
        const id = defaultColumnId(subjectId, i);
        if (this.columns.some((c) => c.id === id)) return;
        const rec: ColumnRec = {
          id,
          subjectId,
          name,
          position: i,
          isDone: i === DEFAULT_COLUMNS.length - 1,
          createdAt: now,
        };
        this.columns.push(rec);
        made.push(rec);
      });
      if (made.length > 0) this.onDefaultsCreated(made);
    }
    return this.list(subjectId);
  }

  /** Whether a column with this id is here. */
  has(id: string): boolean {
    return this.columns.some((c) => c.id === id);
  }

  get(id: string): ColumnRec {
    const c = this.columns.find((x) => x.id === id);
    if (!c) throw { kind: "not_found", message: `board column ${id}` };
    return c;
  }

  /** Index of a task's column on a board (core `board_columns::index_of`). */
  indexOf(
    columns: ColumnRec[],
    columnId: string | null | undefined,
    completed: boolean,
  ): number {
    if (completed) {
      const done = columns.findIndex((c) => c.isDone);
      if (done >= 0) return done;
    }
    const i = columns.findIndex((c) => c.id === columnId && !c.isDone);
    return i >= 0 ? i : 0;
  }

  create(subjectId: string | null, name: string): string {
    const trimmed = name.trim();
    if (!trimmed) throw invalid("column name must not be empty");
    const work = this.ensure(subjectId).filter((c) => !c.isDone);
    // Defaults not made yet (a linked device before its first pull): a lone column would
    // stop them for good.
    if (work.length === 0) throw invalid("the board is not ready yet");
    const id = this.newId();
    this.columns.push({
      id,
      subjectId,
      name: trimmed,
      position: Math.max(0, ...work.map((c) => c.position)) + 1,
      isDone: false,
      createdAt: this.now(),
    });
    return id;
  }

  rename(id: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) throw invalid("column name must not be empty");
    this.get(id).name = trimmed;
  }

  /** Removes a column; its tasks fall back to the first one (`ON DELETE SET NULL`). */
  delete(id: string, tasks: readonly BoardTask[]): void {
    const c = this.get(id);
    if (c.isDone) throw invalid("the done column cannot be removed");
    if (this.list(c.subjectId).filter((x) => !x.isDone).length <= 1) {
      throw invalid("a board keeps one column of work");
    }
    this.columns = this.columns.filter((x) => x.id !== id);
    for (const t of tasks) {
      if (t.boardColumnId === id) t.boardColumnId = null;
    }
  }

  move(id: string, index: number): void {
    const c = this.get(id);
    if (c.isDone) throw invalid("the done column stays last");
    const work = this.list(c.subjectId).filter((x) => !x.isDone && x.id !== id);
    work.splice(Math.min(index, work.length), 0, c);
    work.forEach((x, i) => {
      x.position = i;
    });
  }

  /** Claude starts on a task: from the first column to the second, once. */
  advanceOnClaude(task: BoardTask & { subjectId: string | null }): void {
    const columns = this.ensure(task.subjectId);
    if (columns.length === 0) return;
    if (this.indexOf(columns, task.boardColumnId, false) !== 0) return;
    const next = columns[1];
    if (next && !next.isDone) task.boardColumnId = next.id;
  }
}
