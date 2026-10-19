/**
 * What the phone keeps in IndexedDB (docs/SYNC.md § 6.2): one consistent set of five keys,
 * written in a single transaction. Plain JSON-compatible data only. Since V2.7 bis `sync` is
 * stored under `SYNC_KEY` (below), renamed again by V2.8, so that older builds refuse the set.
 */

import type { AccountInfo, Settings, SyncErrorKind } from "../bindings";
import type { SectionRec, SubjectRec, TaskRec } from "../lib/mock-backend";
import type { ColumnRec } from "../lib/mock-board";
import type { SegmentRec } from "../lib/mock-chrono";
import type { AttachmentRec, RelationRec } from "../lib/mock-links";
import type { NoteGroupRec, NotePageRec } from "../lib/mock-notes";
import { DEFAULT_SYNC_INTERVAL } from "../lib/mock-sync";
import type { Change } from "../lib/sync-proto";

/** Records of the mock state that are persisted (the journal is not, § 6.2). */
export interface PersistedState {
  subjects: SubjectRec[];
  sections: SectionRec[];
  tasks: TaskRec[];
  /** `colorTheme`, `syncTheme` and `language`: absent in a set saved before the colour themes. */
  settings: Pick<Settings, "theme"> &
    Partial<Pick<Settings, "colorTheme" | "syncTheme" | "language">>;
  /**
   * Shared settings synced between devices (`MockState.syncedSettings`), by key. Optional:
   * a set saved before protocol 2 has none (read as `{}`).
   */
  syncedSettings?: Record<string, unknown>;
  /**
   * Attachments (Taido V2.7 bis): synced rows plus where their file stands here (`file`); the
   * files themselves are in the IndexedDB database `todo-files` (src/mobile/files.ts).
   * Optional: absent in a set saved before; a linked one then pulls everything again once.
   */
  attachments?: AttachmentRec[];
  /**
   * Kanban columns, time segments and task relations (Taido V2.8). Optional: absent in a set
   * saved before; a linked one then pulls everything again once (the earlier build ignored
   * their rows).
   */
  boardColumns?: ColumnRec[];
  timeSegments?: SegmentRec[];
  relations?: RelationRec[];
  /**
   * The project notebook: groups and pages (the images are
   * in `attachments`, with their page as owner). Optional: absent in a set saved before; its
   * rows come with the pull that the declaration of the entities (`knownEntities`) starts.
   */
  noteGroups?: NoteGroupRec[];
  notePages?: NotePageRec[];
}

/** Known version of a row: its wire data as last pushed or applied, and its stamp. */
export interface SnapshotEntry {
  /** `JSON.stringify` of the wire data of the row (`SubjectData`, `TaskData`…). */
  json: string;
  /** The row's known version (§ 2.6). */
  stamp: string;
}

/** A row to push: its conflict stamp, and whether it is gone (tombstone). */
export interface OutboxEntry {
  changed_at: string;
  purged: boolean;
}

export interface PersistedSync {
  serverUrl: string | null;
  token: string | null;
  deviceId: string | null;
  serverEpoch: string | null;
  cursor: number;
  intervalMinutes: number;
  lastSyncAt: string | null;
  errorKind: SyncErrorKind | null;
  /** The device's last stamp (§ 2.6), `null` before the first local change. */
  lastStamp: string | null;
  /** Keys whose deletion waits for the user's confirmation (deletion guard, § 6.2). */
  heldDeletions: string[];
  /**
   * The linked account (`GET /api/account`, Taido V2.7), read after login and after each
   * successful sync, `null` when unlinked or not read yet. Optional: absent in a set saved
   * before V2.7.
   */
  account?: AccountInfo | null;
  /**
   * V2.7 bis: the set was last written by a build that did not keep attachments (its
   * `state.attachments` was missing). Until the first successful sync of this link, kept
   * attachment files are never dropped; that run then gives back the copies that are still the
   * only ones (`MobileBackend.endFilesRecovery`). Absent otherwise.
   */
  filesRecovery?: boolean;
  /**
   * V2.8: a whole pull of this link has succeeded (set at the end of each successful run,
   * cleared at login and when a set from before V2.8 is pulled again). While linked and not
   * set, the default Kanban columns are not created: they may still come from the Mac
   * (docs/SYNC.md § 0.7). Absent: not yet.
   */
  pulledOnce?: boolean;
  /**
   * The entities this phone declared to the server in its last request (`known_entities`): the
   * server only sends the notebook's rows to a client that declares them. When this build knows
   * a name the list lacks (or none is stored), the pull cursor goes back to 0 once and the list
   * is stored, so that the rows created before reach it (core `store::declare_entities`).
   */
  knownEntities?: string[];
}

/** Map keys are `entity:id` (`changeKey`). */
export interface Persisted {
  state: PersistedState;
  snapshot: Record<string, SnapshotEntry>;
  outbox: Record<string, OutboxEntry>;
  parked: Record<string, Change>;
  sync: PersistedSync;
}

export const PERSISTED_KEYS = [
  "state",
  "snapshot",
  "outbox",
  "parked",
  "sync",
] as const satisfies readonly (keyof Persisted)[];

/**
 * Key of `sync` in the store since the project notebook (`sync.3` in V2.8, `sync.2` in V2.7
 * bis, `sync` before). Older builds
 * read `sync` under one of `LEGACY_SYNC_KEYS`: once this build has saved, they find four parts
 * out of five, refuse the set (`InconsistentStoreError`) and never save nor sync. An older web
 * app served from the service worker's cache would otherwise send a deletion of every row it
 * does not know (attachments before V2.7 bis, docs/SYNC.md § 0.13 « Rollback »; Kanban
 * columns, time segments and relations before V2.8).
 */
export const SYNC_KEY = "sync.4";
/**
 * Where V2.8 keeps `sync`. A V2.8 build that loads a set holding notebook rows would diff them
 * as « rows of an entity I do not know that vanished » and send their tombstones.
 */
export const V28_SYNC_KEY = "sync.3";
/** Where V2.7 bis keeps `sync`. */
export const V27_SYNC_KEY = "sync.2";
/** Where builds before V2.7 bis keep `sync`. */
export const LEGACY_SYNC_KEY = "sync";
/** Older keys of `sync`, newest first; the first load moves the set to `SYNC_KEY`. */
export const LEGACY_SYNC_KEYS = [
  V28_SYNC_KEY,
  V27_SYNC_KEY,
  LEGACY_SYNC_KEY,
] as const;

/** Store key of each part. */
export const STORAGE_KEYS: Record<keyof Persisted, string> = {
  state: "state",
  snapshot: "snapshot",
  outbox: "outbox",
  parked: "parked",
  sync: SYNC_KEY,
};

export const initialPersistedSync = (): PersistedSync => ({
  serverUrl: null,
  token: null,
  deviceId: null,
  serverEpoch: null,
  cursor: 0,
  intervalMinutes: DEFAULT_SYNC_INTERVAL,
  lastSyncAt: null,
  errorKind: null,
  lastStamp: null,
  heldDeletions: [],
  account: null,
});

export const emptyPersisted = (): Persisted => ({
  state: {
    subjects: [],
    sections: [],
    tasks: [],
    settings: { theme: "system" },
    syncedSettings: {},
    attachments: [],
    boardColumns: [],
    timeSegments: [],
    relations: [],
    noteGroups: [],
    notePages: [],
  },
  snapshot: {},
  outbox: {},
  parked: {},
  sync: initialPersistedSync(),
});
