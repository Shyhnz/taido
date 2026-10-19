/**
 * The phone's backend (docs/SYNC.md § 6.1–6.2): the mock backend's commands and rules on a
 * state persisted in IndexedDB, with change tracking by snapshot diff, a deletion guard, and
 * the real sync client in place of the simulated one.
 *
 * Every `data-changed` touching projects or tasks diffs the state against `snapshot` (the
 * known version of each row): a changed row gets an outbox entry stamped by `nextStamp`, a
 * vanished row a tombstone. Pulled rows update the snapshot as they are applied, so they are
 * never queued back; normalisation corrections are not, so the diff queues them.
 *
 * V2.7 bis: attachments are synced rows too (`links.attachments`); their files are kept,
 * sent and opened by `files` (src/mobile/files.ts), which the UI reaches as `webFiles`.
 *
 * V2.8: so are Kanban columns (`board.columns`), time segments (`chrono.segments`) and task
 * relations (`links.relations`). A linked phone makes the default columns only after its first
 * whole pull (`pulledOnce`), with the Mac's fixed ids, queued at their known stamp else
 * `EPOCH_STAMP` (docs/SYNC.md § 0.7).
 */

import type {
  AccountInfo,
  AccountInput,
  AddAttachmentDataInput,
  AddNoteAttachmentDataInput,
  CopyNoteAttachmentInput,
  ErrorPayload,
  NoteAttachment,
  PruneNoteImagesInput,
  SyncStatus,
  TaskDetail,
} from "../bindings";
import {
  MockBackend,
  type MockBackendOptions,
  type SubjectRec,
  type TaskRec,
} from "../lib/mock-backend";
import type { ColumnRec } from "../lib/mock-board";
import { NOT_ON_THE_PHONE } from "../lib/mock-sync";
import {
  type AttachmentData,
  type BoardColumnData,
  type Change,
  changeKey,
  EPOCH_STAMP,
  type NoteAttachmentData,
  type NoteGroupData,
  type NotePageData,
  nextStamp,
  type RelationData,
  type SectionData,
  type SubjectData,
  type TaskData,
  type TimeSegmentData,
} from "../lib/sync-proto";
import {
  type ApplyResult,
  applyChanges,
  dedupeRelations,
  normalise,
} from "./apply";
import { type FileStore, IndexedDbFileStore, PhoneFiles } from "./files";
import {
  emptyPersisted,
  type OutboxEntry,
  type Persisted,
  type PersistedSync,
  type SnapshotEntry,
} from "./persisted";
import { IndexedDbStore, type MobileStore } from "./store";
import { type FetchFn, SyncClient } from "./sync/client";
import { MobileSyncEngine } from "./sync/engine";
import {
  columnToWire,
  type SyncedRecs,
  upsertAttachment,
  upsertColumn,
  upsertNoteAttachment,
  upsertNoteGroup,
  upsertNotePage,
  upsertRelation,
  upsertSection,
  upsertSegment,
  upsertSubject,
  upsertTask,
  wireRows,
} from "./wire";

/**
 * Refusal of the account commands the phone does not offer in V2.7 (signup, forgotten
 * password, reset: done from the Mac); the UI says so (`fr.sync.accountError.notOnPhone`).
 */
const notOnThePhone = (): ErrorPayload => ({
  kind: "invalid",
  message: `invalid input: ${NOT_ON_THE_PHONE}`,
});

/** Soft-deleted rows are purged after this long (core `trash::RETENTION`). */
export const RETENTION_MS = 24 * 60 * 60 * 1000;
/** Save this long after the last change (§ 6.2). */
export const SAVE_DEBOUNCE_MS = 300;
/** Deletion guard (§ 6.2): more than this many live rows vanishing at once… */
export const GUARD_MAX = 25;
/**
 * …or at least this many and more than `GUARD_RATIO` of one class, each on its own: projects,
 * tasks, Kanban columns and relations; attachments; time segments.
 */
export const GUARD_MIN = 5;
export const GUARD_RATIO = 0.2;

export interface MobileBackendOptions {
  store: MobileStore;
  persisted: Persisted | null;
  /** The stored set could not be read: start empty, never save nor sync (§ 6.2). */
  storageBroken?: boolean;
  now?: () => Date;
  fetch?: FetchFn;
  /** Called when a save fails (the app shows `fr.mobile.storageError`). */
  onStorageError?: () => void;
  /** Builds the HTTP client for a server address (tests inject a fake). */
  clientFor?: (baseUrl: string) => SyncClient;
  /** Where attachment files are kept until sent (IndexedDB `todo-files` by default). */
  fileStore?: FileStore;
  /** Upload chunk size (tests; 8 MiB by default). */
  chunkBytes?: number;
}

/**
 * A random (v4) UUID. `crypto.randomUUID` only exists in secure contexts (HTTPS, localhost):
 * the dev server opened from the phone over the LAN (`http://192.168…`) builds it from
 * `crypto.getRandomValues`, which exists everywhere.
 */
export function randomUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4),
    hex.slice(4, 6),
    hex.slice(6, 8),
    hex.slice(8, 10),
    hex.slice(10),
  ]
    .map((part) => part.join(""))
    .join("-");
}

const isLive = (json: string): boolean => {
  try {
    return (JSON.parse(json) as { deleted_at?: unknown }).deleted_at === null;
  } catch {
    return false;
  }
};

/** A string field of a row's wire JSON (`task_id`, `subject_id`…), else `null`. */
const fieldOf = (json: string, field: string): string | null => {
  try {
    const value = (JSON.parse(json) as Record<string, unknown>)[field];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
};

/** Entities of V2.8: a set saved before has none of their rows. */
const V28_PREFIXES = ["board_column:", "time_segment:", "relation:"];

const splitKey = (key: string): { entity: string; id: string } => {
  const at = key.indexOf(":");
  return { entity: key.slice(0, at), id: key.slice(at + 1) };
};

export class MobileBackend extends MockBackend {
  snapshot: Record<string, SnapshotEntry>;
  outbox: Record<string, OutboxEntry>;
  parked: Record<string, Change>;
  syncData: PersistedSync;
  readonly heldDeletions: Set<string>;
  readonly storageBroken: boolean;
  /**
   * Another page of the app took over (Web Locks, `instanceLock.ts`): this one never saves
   * nor syncs again, so it cannot overwrite the other page's persisted set.
   */
  suspended = false;
  readonly engine: MobileSyncEngine;
  /** Attachment files: kept, sent, opened (src/mobile/files.ts). */
  readonly files: PhoneFiles;
  private readonly store: MobileStore;
  private readonly onStorageError: () => void;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private readonly heldListeners = new Set<() => void>();

  /** Subscribes to changes of the held deletions (banner, `useSyncExternalStore`). */
  subscribeHeld = (listener: () => void): (() => void) => {
    this.heldListeners.add(listener);
    return () => {
      this.heldListeners.delete(listener);
    };
  };

  private heldChanged(): void {
    this.engine.emit();
    for (const listener of [...this.heldListeners]) listener();
  }

  constructor(options: MobileBackendOptions) {
    const base: MockBackendOptions = { seed: false };
    if (options.now) base.now = options.now;
    super(base);
    const p = options.persisted ?? emptyPersisted();
    this.state.subjects = p.state.subjects;
    this.state.sections = p.state.sections;
    this.state.tasks = p.state.tasks;
    this.state.settings.theme = p.state.settings.theme;
    // A set saved before the colour themes has neither: the defaults.
    this.state.settings.colorTheme = p.state.settings.colorTheme ?? "taido";
    this.state.settings.syncTheme = p.state.settings.syncTheme ?? true;
    this.state.settings.language = p.state.settings.language ?? null;
    // A set saved before protocol 2 has no shared settings.
    this.state.syncedSettings = p.state.syncedSettings ?? {};
    this.links.attachments = p.state.attachments ?? [];
    this.board.columns = p.state.boardColumns ?? [];
    this.chrono.segments = p.state.timeSegments ?? [];
    this.links.relations = p.state.relations ?? [];
    this.notes.groups = p.state.noteGroups ?? [];
    this.notes.pages = p.state.notePages ?? [];
    this.snapshot = p.snapshot;
    this.outbox = p.outbox;
    this.parked = p.parked;
    this.syncData = p.sync;
    if (p.state.attachments === undefined) {
      // Written by a build before V2.7 bis, which skipped the attachment rows: anything it
      // left under an attachment key is not this state's (a deletion of every attachment
      // queued by its diff, a snapshot entry the next diff would delete).
      const notAttachment = (k: string) => !k.startsWith("attachment:");
      this.snapshot = Object.fromEntries(
        Object.entries(this.snapshot).filter(([k]) => notAttachment(k)),
      );
      this.outbox = Object.fromEntries(
        Object.entries(this.outbox).filter(([k]) => notAttachment(k)),
      );
      this.syncData.heldDeletions =
        this.syncData.heldDeletions.filter(notAttachment);
      if (p.sync.token !== null) {
        // Pull everything again once (rows waiting in the outbox still go out first), and
        // keep every file kept here until then: the attachments come back with that pull.
        this.syncData.cursor = 0;
        this.syncData.filesRecovery = true;
      }
    }
    if (
      p.state.boardColumns === undefined ||
      p.state.timeSegments === undefined ||
      p.state.relations === undefined
    ) {
      // Written by a build before V2.8, which ignored these rows: nothing it kept under their
      // keys is this state's. Linked, the next run pulls everything again (cursor 0) and only
      // then makes default columns (the Mac's may be among the rows it skipped).
      const notV28 = (k: string) => !V28_PREFIXES.some((x) => k.startsWith(x));
      this.snapshot = Object.fromEntries(
        Object.entries(this.snapshot).filter(([k]) => notV28(k)),
      );
      this.outbox = Object.fromEntries(
        Object.entries(this.outbox).filter(([k]) => notV28(k)),
      );
      this.syncData.heldDeletions = this.syncData.heldDeletions.filter(notV28);
      delete this.syncData.pulledOnce;
      if (p.sync.token !== null) this.syncData.cursor = 0;
    }
    this.heldDeletions = new Set(this.syncData.heldDeletions);
    this.storageBroken = options.storageBroken ?? false;
    this.board.canCreateDefaults = () =>
      this.syncData.token === null || this.syncData.pulledOnce === true;
    this.board.onDefaultsCreated = (columns) => this.queueDefaults(columns);
    this.store = options.store;
    this.onStorageError = options.onStorageError ?? (() => {});
    const fetchFn = options.fetch;
    const clientFor =
      options.clientFor ?? ((url: string) => new SyncClient(url, fetchFn));
    this.engine = new MobileSyncEngine(this, clientFor);
    this.files = new PhoneFiles(
      this,
      options.fileStore ?? new IndexedDbFileStore(),
      clientFor,
      options.chunkBytes ? { chunkBytes: options.chunkBytes } : {},
    );
    this.links.viewOf = (a) => this.files.viewOf(a);
    this.webFiles = this.files;
    const deleteAttachment = this.commands.deleteAttachment;
    const deleteNoteAttachment = this.commands.deleteNoteAttachment;
    const pruneNoteImages = this.commands.pruneNoteImages;
    Object.assign(this.commands, {
      // Attachments (V2.7 bis): files come from the browser (`webFiles`), not from paths.
      addAttachments: (): Promise<TaskDetail> =>
        Promise.reject(notOnThePhone()),
      pickFiles: (): Promise<string[]> => Promise.reject(notOnThePhone()),
      revealAttachment: (): Promise<null> => Promise.reject(notOnThePhone()),
      downloadAttachment: (): Promise<string> =>
        Promise.reject(notOnThePhone()),
      revealPath: (): Promise<null> => Promise.reject(notOnThePhone()),
      attachmentPreview: async (): Promise<string | null> => null,
      // A page's images (the notebook): same transport as the task's attachments.
      addNoteAttachments: (): Promise<NoteAttachment[]> =>
        Promise.reject(notOnThePhone()),
      addNoteAttachmentData: async (
        input: AddNoteAttachmentDataInput,
      ): Promise<NoteAttachment> => {
        let bytes: Uint8Array<ArrayBuffer>;
        try {
          const binary = atob(input.base64.replace(/\s/g, ""));
          bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        } catch {
          throw { kind: "invalid", message: "invalid input: bad base64" };
        }
        const name = input.name.trim() || "capture.png";
        const id = await this.files.addDataToPage(
          input.notePageId,
          name,
          new Blob([bytes]),
        );
        const added = (
          await this.commands.listNoteAttachments(input.notePageId)
        ).find((a) => a.id === id);
        if (!added) throw { kind: "not_found", message: `image ${id}` };
        return added;
      },
      deleteNoteAttachment: async (id: string): Promise<null> => {
        const done = await deleteNoteAttachment(id);
        void this.files.sweep();
        return done;
      },
      copyNoteAttachment: async (
        input: CopyNoteAttachmentInput,
      ): Promise<NoteAttachment> => {
        const id = await this.files.copyToPage(input.id, input.toPageId);
        const added = (
          await this.commands.listNoteAttachments(input.toPageId)
        ).find((a) => a.id === id);
        if (!added) throw { kind: "not_found", message: `image ${id}` };
        return added;
      },
      pruneNoteImages: async (
        input: PruneNoteImagesInput,
      ): Promise<string[]> => {
        const gone = await pruneNoteImages(input);
        if (gone.length > 0) void this.files.sweep();
        return gone;
      },
      addAttachmentData: async (
        input: AddAttachmentDataInput,
      ): Promise<TaskDetail> => {
        let bytes: Uint8Array<ArrayBuffer>;
        try {
          const binary = atob(input.base64.replace(/\s/g, ""));
          bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        } catch {
          throw { kind: "invalid", message: "invalid input: bad base64" };
        }
        const name = input.name.trim() || "capture.png";
        await this.files.addData(input.taskId, name, new Blob([bytes]));
        return this.commands.getTask(input.taskId);
      },
      deleteAttachment: async (id: string): Promise<TaskDetail> => {
        const detail = await deleteAttachment(id);
        void this.files.sweep();
        return detail;
      },
      syncStatus: async (): Promise<SyncStatus> => this.engine.status(),
      syncNow: (): Promise<SyncStatus> => this.engine.syncNow(),
      syncLogin: (input: AccountInput): Promise<SyncStatus> =>
        this.engine.link(input),
      // Accounts are created and reset from the Mac in V2.7: the phone only logs in.
      syncSignup: (): Promise<SyncStatus> => Promise.reject(notOnThePhone()),
      syncForgotPassword: (): Promise<null> => Promise.reject(notOnThePhone()),
      syncResetPassword: (): Promise<null> => Promise.reject(notOnThePhone()),
      syncAccount: async (): Promise<AccountInfo | null> =>
        this.engine.account(),
      syncResendConfirmation: (): Promise<null> =>
        this.engine.resendConfirmation(),
      syncUnlink: (): Promise<SyncStatus> => this.engine.unlink(),
      syncSetInterval: (minutes: number): Promise<SyncStatus> =>
        this.engine.setInterval(minutes),
    });
    void this.events.dataChanged.listen((e) => {
      const { scopes } = e.payload;
      // Settings: the shared theme (synced setting `appearance`).
      if (
        scopes.includes("subjects") ||
        scopes.includes("tasks") ||
        scopes.includes("settings") ||
        scopes.includes("notes")
      ) {
        this.diff();
        this.engine.poke();
      }
      this.scheduleSave();
    });
  }

  /** Ids must be unique across devices (§ 6.1). */
  override newId(_prefix: string): string {
    return randomUuid();
  }

  nowIsoString(): string {
    return this.now().toISOString();
  }

  /** Stamp of a new local change of a row known at `known` (§ 2.6); advances `lastStamp`. */
  localStamp(known: string | undefined): string {
    const stamp = nextStamp(
      this.nowIsoString(),
      known,
      this.syncData.lastStamp,
    );
    this.syncData.lastStamp = stamp;
    return stamp;
  }

  /** The synced records kept by the mock's helpers (live arrays). */
  syncedRecs(): SyncedRecs {
    return {
      attachments: this.links.attachments,
      noteGroups: this.notes.groups,
      notePages: this.notes.pages,
      boardColumns: this.board.columns,
      timeSegments: this.chrono.segments,
      relations: this.links.relations,
    };
  }

  // --- change tracking -------------------------------------------------------------------

  /**
   * Default columns just made (§ 0.7): queued at their known stamp, else `EPOCH_STAMP`, so
   * that they lose to any real version (a rename elsewhere) and never undo a tombstone.
   */
  private queueDefaults(columns: readonly ColumnRec[]): void {
    if (this.storageBroken) return;
    for (const c of columns) {
      const key = changeKey({ entity: "board_column", id: c.id });
      // A held deletion is settled by the user's choice, never by a default (§ 6.2).
      if (this.outbox[key] || this.heldDeletions.has(key)) continue;
      const stamp = this.snapshot[key]?.stamp ?? EPOCH_STAMP;
      this.snapshot[key] = { json: JSON.stringify(columnToWire(c)), stamp };
      this.outbox[key] = { changed_at: stamp, purged: false };
    }
    this.scheduleSave();
    this.engine.poke();
  }

  /** Queues every row whose wire data differs from its snapshot (§ 6.2). */
  diff(): void {
    if (this.storageBroken) return;
    const rows = wireRows(this.state, this.syncedRecs());
    let heldChanged = false;
    for (const [key, row] of rows) {
      if (this.heldDeletions.delete(key)) heldChanged = true;
      const known = this.snapshot[key];
      if (known?.json === row.json) continue;
      const stamp = this.localStamp(known?.stamp);
      this.outbox[key] = { changed_at: stamp, purged: false };
      this.snapshot[key] = { json: row.json, stamp };
    }
    const vanished = Object.keys(this.snapshot).filter(
      (k) => !rows.has(k) && !this.heldDeletions.has(k),
    );
    if (vanished.length > 0) {
      // Three classes, each with its own ratio, so that one never dilutes another (V2.8):
      // projects and tasks (sections follow their project, settings never vanish), with the
      // Kanban columns and relations; attachments; time segments (recorded time). A column,
      // relation, attachment or segment is counted only while what it hangs on is still here
      // and live (one purged with its task or project is that deletion, already counted).
      // The notebook is a class of its own too (pages and groups; its images count with the
      // attachments, hanging on their page). Held when any class trips, or when more than
      // `GUARD_MAX` live rows vanish in all.
      const prefixed =
        (...prefixes: string[]) =>
        (k: string) =>
          prefixes.some((x) => k.startsWith(x));
      const isRow = prefixed("subject:", "task:", "board_column:", "relation:");
      const isAttachment = prefixed("attachment:", "note_attachment:");
      const isSegment = prefixed("time_segment:");
      const isNote = prefixed("note_page:", "note_group:");
      const liveTasks = new Set(
        this.state.tasks.filter((t) => t.deletedAt === null).map((t) => t.id),
      );
      const liveSubjects = new Set(
        this.state.subjects
          .filter((s) => s.deletedAt === null)
          .map((s) => s.id),
      );
      const livePages = new Set(
        this.notes.pages.filter((p) => p.deletedAt === null).map((p) => p.id),
      );
      const json = (k: string) => this.snapshot[k].json;
      const ofLiveTask = (k: string, field = "task_id") =>
        liveTasks.has(fieldOf(json(k), field) ?? "");
      const counts = (k: string): boolean => {
        if (k.startsWith("board_column:")) {
          // Hard-deleted: no `deleted_at`. « Sans projet » is always here.
          const subject = fieldOf(json(k), "subject_id");
          return subject === null || liveSubjects.has(subject);
        }
        if (k.startsWith("note_group:")) {
          // Hard-deleted: no `deleted_at`; counted while its project is here.
          return liveSubjects.has(fieldOf(json(k), "subject_id") ?? "");
        }
        if (!isLive(json(k))) return false;
        if (k.startsWith("note_page:")) {
          return liveSubjects.has(fieldOf(json(k), "subject_id") ?? "");
        }
        if (k.startsWith("note_attachment:")) {
          return livePages.has(fieldOf(json(k), "note_page_id") ?? "");
        }
        if (k.startsWith("relation:")) {
          return ofLiveTask(k, "from_task_id") && ofLiveTask(k, "to_task_id");
        }
        if (isAttachment(k) || isSegment(k)) return ofLiveTask(k);
        return true;
      };
      const liveOf = (inClass: (k: string) => boolean) =>
        vanished.filter((k) => inClass(k) && counts(k)).length;
      const liveRows = liveOf(isRow);
      const liveAttachments = liveOf(isAttachment);
      const liveSegments = liveOf(isSegment);
      const liveNotes = liveOf(isNote);
      const known = Object.keys(this.snapshot);
      const trips = (live: number, inClass: (k: string) => boolean) =>
        live >= GUARD_MIN && live > GUARD_RATIO * known.filter(inClass).length;
      const live = liveRows + liveAttachments + liveSegments + liveNotes;
      if (
        live > GUARD_MAX ||
        trips(liveRows, isRow) ||
        trips(liveAttachments, isAttachment) ||
        trips(liveSegments, isSegment) ||
        trips(liveNotes, isNote)
      ) {
        for (const k of vanished) this.heldDeletions.add(k);
        heldChanged = true;
        console.warn(
          `sync: ${live} live rows vanished at once, deletions held for confirmation`,
        );
      } else {
        for (const k of vanished) this.queueTombstone(k);
      }
    }
    if (heldChanged) this.heldChanged();
  }

  private queueTombstone(key: string): void {
    const stamp = this.localStamp(this.snapshot[key]?.stamp);
    this.outbox[key] = { changed_at: stamp, purged: true };
    delete this.snapshot[key];
  }

  /** « Supprimer partout »: the held deletions leave as tombstones. */
  confirmHeldDeletions(): void {
    for (const k of this.heldDeletions) {
      if (this.snapshot[k]) this.queueTombstone(k);
    }
    this.heldDeletions.clear();
    this.heldChanged();
    this.scheduleSave();
    this.engine.poke();
    // The copies kept for the deleted attachments go too.
    void this.files.sweep();
  }

  /** « Les remettre »: the vanished rows come back from their snapshot data. */
  restoreHeldDeletions(): void {
    const entries = [...this.heldDeletions]
      .map((k) => ({ ...splitKey(k), known: this.snapshot[k] }))
      .filter((x) => x.known !== undefined);
    const rank = (x: (typeof entries)[number]) => {
      const data = JSON.parse(x.known.json) as { parent_id?: string | null };
      if (x.entity === "subject") return data.parent_id ? 1 : 0;
      if (x.entity === "section" || x.entity === "note_group") return 2;
      if (x.entity === "board_column") return 3;
      if (x.entity === "task") return data.parent_id ? 5 : 4;
      if (x.entity === "note_page") return 6;
      return 7;
    };
    entries.sort((a, b) => rank(a) - rank(b));
    const attachments: string[] = [];
    for (const { entity, id, known } of entries) {
      const data: unknown = JSON.parse(known.json);
      if (entity === "subject") {
        upsertSubject(this.state, id, data as SubjectData, known.stamp);
      } else if (entity === "section") {
        upsertSection(this.state, id, data as SectionData, known.stamp);
      } else if (entity === "task") {
        upsertTask(this.state, id, data as TaskData, known.stamp);
      } else if (entity === "board_column") {
        upsertColumn(this.board.columns, id, data as BoardColumnData);
      } else if (entity === "time_segment") {
        upsertSegment(this.chrono.segments, id, data as TimeSegmentData);
      } else if (entity === "relation") {
        upsertRelation(this.links.relations, id, data as RelationData);
      } else if (entity === "attachment") {
        upsertAttachment(this.links.attachments, id, data as AttachmentData);
        attachments.push(id);
      } else if (entity === "note_group") {
        upsertNoteGroup(
          this.notes.groups,
          id,
          data as NoteGroupData,
          known.stamp,
        );
      } else if (entity === "note_page") {
        upsertNotePage(this.notes.pages, id, data as NotePageData, known.stamp);
      } else if (entity === "note_attachment") {
        upsertNoteAttachment(
          this.links.attachments,
          id,
          data as NoteAttachmentData,
        );
        attachments.push(id);
      }
    }
    // Those whose copy is still here are to send again (they come back `missing`).
    void this.files.reclaim(attachments);
    this.heldDeletions.clear();
    this.heldChanged();
    this.emitDataChanged(["subjects", "tasks", "notes"]);
  }

  /**
   * At login (§ 3.5): forgets what a previous link learnt from its server, a V1 server or
   * another account. Parked rows go; every known version goes back to `EPOCH_STAMP` (the
   * snapshot keeps its data, the diff's baseline), so the re-enqueue that follows sends every
   * row without an outbox entry at `EPOCH_STAMP`: any version the account holds wins. The
   * outbox stays: it holds real edits.
   */
  forgetServerState(): void {
    for (const k of Object.keys(this.parked)) delete this.parked[k];
    for (const entry of Object.values(this.snapshot)) entry.stamp = EPOCH_STAMP;
  }

  /** Applies pulled rows (§ 2.5) then normalises; the caller emits `data-changed`. */
  applyPulled(changes: readonly Change[]): ApplyResult & { corrected: number } {
    const result = applyChanges(
      {
        state: this.state,
        recs: this.syncedRecs(),
        snapshot: this.snapshot,
        outbox: this.outbox,
        parked: this.parked,
        heldDeletions: this.heldDeletions,
        localStamp: (known) => this.localStamp(known),
      },
      changes,
    );
    const corrected =
      normalise(this.state, {
        groups: this.notes.groups,
        pages: this.notes.pages,
      }) + dedupeRelations(this.links.relations, this.nowIsoString());
    // Copies of deleted attachments, or of files that changed elsewhere, are dropped.
    void this.files.sweep();
    return { ...result, corrected };
  }

  /**
   * Re-enqueue at link and on an epoch change (§ 2.6): every row without an outbox entry
   * goes out with its known stamp, or `EPOCH_STAMP` when none is known.
   */
  reenqueue(epochStamp: string): number {
    let n = 0;
    for (const [key, row] of wireRows(this.state, this.syncedRecs())) {
      if (this.outbox[key]) continue;
      let known = this.snapshot[key];
      if (!known) {
        known = { json: row.json, stamp: epochStamp };
        this.snapshot[key] = known;
      }
      this.outbox[key] = { changed_at: known.stamp, purged: false };
      n += 1;
    }
    return n;
  }

  /**
   * After the first successful sync of a set written by a build before V2.7 bis
   * (`filesRecovery`): the attachments are back from the server, and those whose copy is still
   * kept here (never sent) are to send again; only then may kept files be dropped.
   */
  async endFilesRecovery(): Promise<void> {
    if (!this.syncData.filesRecovery) return;
    const ids = this.links.attachments
      .filter((a) => a.deletedAt === null && a.file === "missing")
      .map((a) => a.id);
    await this.files.reclaim(ids);
    delete this.syncData.filesRecovery;
    await this.saveNow();
  }

  /** Deletes for good the rows soft-deleted more than 24 h ago (core `trash::purge`). */
  purge(): number {
    const cutoff = new Date(this.now().getTime() - RETENTION_MS).toISOString();
    const old = (x: { deletedAt: string | null }) =>
      x.deletedAt !== null && x.deletedAt < cutoff;
    const subjects = new Set(this.state.subjects.filter(old).map((s) => s.id));
    // Sub-projects follow their parent (ON DELETE CASCADE).
    let grew = true;
    while (grew) {
      grew = false;
      for (const s of this.state.subjects) {
        if (s.parentId && subjects.has(s.parentId) && !subjects.has(s.id)) {
          subjects.add(s.id);
          grew = true;
        }
      }
    }
    const tasks = new Set(
      this.state.tasks
        .filter(
          (t: TaskRec) =>
            old(t) || (t.subjectId !== null && subjects.has(t.subjectId)),
        )
        .map((t) => t.id),
    );
    grew = true;
    while (grew) {
      grew = false;
      for (const t of this.state.tasks) {
        if (t.parentId && tasks.has(t.parentId) && !tasks.has(t.id)) {
          tasks.add(t.id);
          grew = true;
        }
      }
    }
    // The notebook (core `trash::purge_rows`): the pages deleted long ago, those of a purged
    // project and its groups; their images follow (ON DELETE CASCADE).
    const pages = new Set(
      this.notes.pages
        .filter((p) => old(p) || subjects.has(p.subjectId))
        .map((p) => p.id),
    );
    const removed = subjects.size + tasks.size + pages.size;
    if (removed === 0) return 0;
    // Their images still shown by another page become that page's (a change, not a tombstone).
    for (const a of this.links.attachments) {
      if (a.notePageId === undefined || !pages.has(a.notePageId)) continue;
      const holder = this.notes.imageHolder(a.id, pages);
      if (holder !== null) a.notePageId = holder;
    }
    this.state.subjects = this.state.subjects.filter(
      (s: SubjectRec) => !subjects.has(s.id),
    );
    this.state.sections = this.state.sections.filter(
      (s) => !subjects.has(s.subjectId),
    );
    this.state.tasks = this.state.tasks.filter((t) => !tasks.has(t.id));
    this.notes.groups = this.notes.groups.filter(
      (g) => !subjects.has(g.subjectId),
    );
    this.notes.pages = this.notes.pages.filter((p) => !pages.has(p.id));
    // A summary whose task is gone is only unlinked (ON DELETE SET NULL).
    for (const p of this.notes.pages) {
      if (p.sourceTaskId !== null && tasks.has(p.sourceTaskId)) {
        p.sourceTaskId = null;
      }
    }
    // Their attachments, time segments and relations (either side) follow them, and the
    // projects' columns (ON DELETE CASCADE): tombstones, copies dropped.
    this.links.attachments = this.links.attachments.filter((a) =>
      a.notePageId !== undefined
        ? !pages.has(a.notePageId)
        : !tasks.has(a.taskId),
    );
    this.chrono.dropTasks(tasks);
    this.links.dropTasks(tasks);
    this.board.columns = this.board.columns.filter(
      (c) => c.subjectId === null || !subjects.has(c.subjectId),
    );
    this.emitDataChanged(["subjects", "tasks", "notes"]);
    void this.files.sweep();
    return removed;
  }

  // --- persistence -----------------------------------------------------------------------

  /** A consistent copy of everything to persist. */
  persisted(): Persisted {
    return structuredClone({
      state: {
        subjects: this.state.subjects,
        sections: this.state.sections,
        tasks: this.state.tasks,
        settings: {
          theme: this.state.settings.theme,
          colorTheme: this.state.settings.colorTheme,
          syncTheme: this.state.settings.syncTheme,
          language: this.state.settings.language,
        },
        syncedSettings: this.state.syncedSettings,
        attachments: this.links.attachments,
        boardColumns: this.board.columns,
        timeSegments: this.chrono.segments,
        relations: this.links.relations,
        noteGroups: this.notes.groups,
        notePages: this.notes.pages,
      },
      snapshot: this.snapshot,
      outbox: this.outbox,
      parked: this.parked,
      sync: { ...this.syncData, heldDeletions: [...this.heldDeletions] },
    });
  }

  /** Stops saving and syncing for good (another page of the app took over). */
  suspend(): void {
    this.suspended = true;
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.engine.stop();
  }

  scheduleSave(): void {
    if (this.storageBroken || this.suspended) return;
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Saves at once (after a sync chunk, when the page is hidden or closed). */
  saveNow(): Promise<void> {
    if (this.storageBroken || this.suspended) return Promise.resolve();
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const set = this.persisted();
    // Saves stay in order: a later set never lands before an earlier one.
    this.saving = this.saving.then(async () => {
      try {
        await this.store.save(set);
      } catch (error) {
        console.error("storage: save failed", error);
        this.onStorageError();
      }
    });
    return this.saving;
  }

  /** Pending outbox entries (status `pending`). */
  pendingCount(): number {
    return Object.keys(this.outbox).length;
  }
}

export interface CreateMobileBackendOptions
  extends Omit<MobileBackendOptions, "store" | "persisted" | "storageBroken"> {
  store?: MobileStore;
}

/**
 * Loads the persisted set and builds the backend. A set that cannot be read (inconsistent,
 * or IndexedDB unavailable) gives an empty backend that never saves nor syncs. When unlinked,
 * old soft-deleted rows are purged at once; when linked, after the first successful run.
 */
export async function createMobileBackend(
  options: CreateMobileBackendOptions = {},
): Promise<MobileBackend> {
  const store = options.store ?? new IndexedDbStore();
  let persisted: Persisted | null = null;
  let storageBroken = false;
  try {
    persisted = await store.load();
  } catch (error) {
    console.error("storage: cannot load the persisted set", error);
    storageBroken = true;
  }
  const backend = new MobileBackend({
    ...options,
    store,
    persisted,
    storageBroken,
  });
  if (!storageBroken && backend.syncData.token === null) backend.purge();
  // Copies kept for attachments that are gone (a crash between keeping and saving).
  if (!storageBroken) void backend.files.sweep();
  return backend;
}
