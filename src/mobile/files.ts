/**
 * Attachment files of the web app, site and phone (Taido V2.7 bis
 * task 4). The same rules as the Mac (src-tauri/src/sync/files.rs), with a browser's means:
 *
 * - **Adding** (`add`): a file over 100 MB is refused before it is read; the others are hashed
 *   (Web Crypto SHA-256), kept in IndexedDB (`todo-files`, one entry per attachment: blob,
 *   hash, size) and added to the task: their row goes out with the next sync. Without an
 *   account they simply stay here (the phone keeps all its data without an account) and leave
 *   once it is linked.
 * - **Sending** (`run`, after each successful sync, one job at a time): a kept file whose row
 *   the server has (no outbox entry) is sent in chunks of 8 MiB. The status says where to
 *   start (a cut or a reload resumes from the bytes received); a fresh upload opens with an
 *   empty chunk, so that the server's limits answer before any byte; a chunk refused for its
 *   offset re-reads the status. Too large or account full: the tile says so, tried again at
 *   each sync, the tasks keep syncing. Once sent, the kept copy is dropped (a few recent files
 *   stay in memory for this session).
 * - **Downloading** (`open`, « Télécharger »): from this device, else downloaded on demand
 *   (« Téléchargement… ») and checked (size, SHA-256); the UI saves it, images included
 *   (src/lib/web-files.ts, review point 2). `preview` gives a raster image's bytes to its
 *   tile's thumbnail the same way.
 * - **Content never changes once hashed**: a pulled hash that differs from the kept copy's
 *   means the copy is not this file (dropped, downloaded from the server); a deleted attachment
 *   drops its copy (`sweep`).
 *
 * Indicators (`viewOf`, only with an account, as on the Mac): « Sur cet appareil seulement »
 * (kept here, not sent yet), « Envoi… », « Téléchargement… », « Trop gros (100 Mo max) »,
 * « Espace du compte plein ». A file on the server and not here shows nothing: on the web it
 * is the normal state (no « À télécharger »).
 */

import type { Attachment, AttachmentRemote } from "../bindings";
import { type AttachmentRec, isPageImage, mimeOf } from "../lib/mock-links";
import { DEFAULT_MAX_FILE_BYTES, MAX_CHUNK_BYTES } from "../lib/sync-proto";
import {
  type AddedFiles,
  type AddedPageFiles,
  hasPreview,
  type OpenedFile,
  type WebAttachmentFiles,
  WebFileError,
} from "../lib/web-files";
import type { MobileBackend } from "./backend";
import { FileRefused, type SyncClient, SyncHttpError } from "./sync/client";
import { isImageMime } from "./wire";

/** A file kept on this device until it is sent. */
export interface StoredFile {
  blob: Blob;
  sha256: string;
  size: number;
}

/** Where the kept files live (IndexedDB in the app, memory in tests). */
export interface FileStore {
  get(id: string): Promise<StoredFile | null>;
  put(id: string, file: StoredFile): Promise<void>;
  delete(id: string): Promise<void>;
  ids(): Promise<string[]>;
}

/** Its own database: the persisted set's `todo` (store.ts) never has to be upgraded. */
export const FILES_DB_NAME = "todo-files";
export const FILES_DB_VERSION = 1;
export const FILES_STORE = "files";

/**
 * The connection is gone: closed under the page (`InvalidStateError` when a transaction
 * starts) or lost by the browser (`UnknownError`, Safari after a while in the background).
 */
const lostConnection = (error: unknown): boolean => {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "InvalidStateError" || name === "UnknownError";
};

/**
 * IndexedDB implementation; the factory is read when first used (absent in some tests). A
 * connection that closes or is lost is opened again by the next operation (retried once).
 */
export class IndexedDbFileStore implements FileStore {
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory?: IDBFactory) {}

  private forget(opening: Promise<IDBDatabase>): void {
    if (this.db === opening) this.db = null;
  }

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      const opening: Promise<IDBDatabase> = new Promise((resolve, reject) => {
        const factory = this.factory ?? globalThis.indexedDB;
        if (!factory) {
          reject(new Error("indexedDB unavailable"));
          return;
        }
        const request = factory.open(FILES_DB_NAME, FILES_DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(FILES_STORE)) {
            db.createObjectStore(FILES_STORE);
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          // A later version elsewhere: let it upgrade, reopen on the next use.
          db.onversionchange = () => {
            db.close();
            this.forget(opening);
          };
          // Closed by the browser (storage cleared, connection lost).
          db.onclose = () => this.forget(opening);
          resolve(db);
        };
        request.onerror = () => reject(request.error);
      });
      opening.catch(() => this.forget(opening));
      this.db = opening;
    }
    return this.db;
  }

  private async run<T>(
    mode: IDBTransactionMode,
    op: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const opening = this.open();
      const db = await opening;
      try {
        return await new Promise<T>((resolve, reject) => {
          let tx: IDBTransaction;
          try {
            tx = db.transaction(FILES_STORE, mode);
          } catch (error) {
            reject(error);
            return;
          }
          const request = op(tx.objectStore(FILES_STORE));
          tx.oncomplete = () => resolve(request.result);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error ?? new Error("aborted"));
        });
      } catch (error) {
        if (!lostConnection(error)) throw error;
        this.forget(opening);
        // Every operation is idempotent (get, put, delete, list): one more try.
        if (attempt > 0) throw error;
      }
    }
  }

  async get(id: string): Promise<StoredFile | null> {
    const value = await this.run("readonly", (s) => s.get(id));
    return (value as StoredFile | undefined) ?? null;
  }

  async put(id: string, file: StoredFile): Promise<void> {
    await this.run("readwrite", (s) => s.put(file, id));
  }

  async delete(id: string): Promise<void> {
    await this.run("readwrite", (s) => s.delete(id));
  }

  async ids(): Promise<string[]> {
    const keys = await this.run("readonly", (s) => s.getAllKeys());
    return keys.map(String);
  }
}

/** In memory, for tests; `failNextPut` simulates a full device. */
export class MemoryFileStore implements FileStore {
  files = new Map<string, StoredFile>();
  failNextPut = false;

  async get(id: string): Promise<StoredFile | null> {
    return this.files.get(id) ?? null;
  }

  async put(id: string, file: StoredFile): Promise<void> {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("quota exceeded (simulated)");
    }
    this.files.set(id, file);
  }

  async delete(id: string): Promise<void> {
    this.files.delete(id);
  }

  async ids(): Promise<string[]> {
    return [...this.files.keys()];
  }
}

/** Lowercase hexadecimal SHA-256 (Web Crypto: HTTPS or localhost, like the app). */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Recently sent or downloaded files kept in memory for this session, at most this much. */
export const CACHE_MAX_BYTES = 32 * 1024 * 1024;
/** Status re-reads after refused chunks, per file and per job (as the Mac). */
const MAX_REREADS = 3;

const MAX_NAME_BYTES = 255;
const encoder = new TextEncoder();

/**
 * A file name the protocol accepts: no `/` nor `\`, not blank, at most 255 bytes (the stem is
 * shortened, the extension kept).
 */
export function safeFileName(name: string): string {
  const clean = name.replace(/[/\\]/g, "_").trim() || "fichier";
  if (encoder.encode(clean).length <= MAX_NAME_BYTES) return clean;
  const dot = clean.lastIndexOf(".");
  const ext = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : "";
  let stem = [...clean.slice(0, clean.length - ext.length)];
  while (
    stem.length > 0 &&
    encoder.encode(stem.join("") + ext).length > MAX_NAME_BYTES
  ) {
    stem = stem.slice(0, -1);
  }
  return stem.join("") + ext;
}

type Outcome =
  | "sent"
  | "too_large"
  | "quota_exceeded"
  /** The server refused the bytes received (their SHA-256 is not the announced one). */
  | "hash_mismatch"
  | "later";

/** Files that may be sent: kept here, or refused before (tried again). */
const TO_SEND = new Set(["local", "too_large", "quota_exceeded"]);
/** Files whose copy here is kept: those to send, and those that can never be sent. */
const KEEP = new Set([...TO_SEND, "unsendable"]);

export interface PhoneFilesOptions {
  /** Upload chunk size (tests use a few bytes). */
  chunkBytes?: number;
}

export class PhoneFiles implements WebAttachmentFiles {
  private readonly uploading = new Set<string>();
  /** Files stored, their attachment not added yet: a sweep leaves them alone. */
  private readonly keeping = new Set<string>();
  /**
   * Files the server refused for their hash while the copy here is right (bytes damaged on the
   * way): not sent again before the page is reloaded, so that a whole file is not sent again
   * at every sync.
   */
  private readonly refusedThisSession = new Set<string>();
  private readonly downloading = new Map<string, Promise<Blob>>();
  private readonly cache = new Map<
    string,
    { blob: Blob; sha256: string | null }
  >();
  private running: Promise<void> | null = null;
  private again = false;
  /** Sweeps and other background work `whenIdle` waits for. */
  private pending = new Set<Promise<unknown>>();
  private readonly chunkBytes: number;

  constructor(
    private readonly backend: MobileBackend,
    readonly store: FileStore,
    private readonly clientFor: (baseUrl: string) => SyncClient,
    options: PhoneFilesOptions = {},
  ) {
    this.chunkBytes = options.chunkBytes ?? MAX_CHUNK_BYTES;
  }

  private linked(): boolean {
    return this.backend.syncData.token !== null;
  }

  private live(id: string): AttachmentRec | undefined {
    return this.backend.links.attachments.find(
      (a) => a.id === id && a.deletedAt === null,
    );
  }

  /** The tile's indicator; nothing without an account (everything is here by definition). */
  viewOf(a: AttachmentRec): Pick<Attachment, "remote" | "exists"> {
    let remote: AttachmentRemote = "none";
    if (this.linked()) {
      if (this.uploading.has(a.id)) remote = "uploading";
      else if (this.downloading.has(a.id)) remote = "downloading";
      else if (a.file === "too_large") remote = "too_large";
      else if (a.file === "quota_exceeded") remote = "quota_full";
      else if (a.file === "local" || a.file === "unsendable") {
        remote = "local_only";
      }
    }
    return { remote, exists: true };
  }

  /** Tells the views the tile changed (and saves the file state with the set). */
  private changed(a: AttachmentRec): void {
    if (a.notePageId !== undefined) {
      // An image of a page: the notebook's views.
      this.backend.emitDataChanged(["notes"]);
      return;
    }
    const parent = this.backend.state.tasks.find(
      (t) => t.id === a.taskId,
    )?.parentId;
    this.backend.emitDataChanged(
      ["tasks"],
      parent ? [a.taskId, parent] : [a.taskId],
    );
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p)).catch(() => {});
    return p;
  }

  /** Resolves once the job, the downloads and the sweeps in flight are over (tests). */
  async whenIdle(): Promise<void> {
    for (;;) {
      const waits = [
        ...this.pending,
        ...this.downloading.values(),
        ...(this.running ? [this.running] : []),
      ];
      if (waits.length === 0) return;
      await Promise.allSettled(waits);
    }
  }

  // --- adding ----------------------------------------------------------------------------

  async add(taskId: string, files: readonly File[]): Promise<AddedFiles> {
    const tooLarge: string[] = [];
    let added = 0;
    try {
      for (const file of files) {
        if (file.size > DEFAULT_MAX_FILE_BYTES) {
          tooLarge.push(file.name);
          continue;
        }
        await this.keep({ taskId }, file.name, file.type, file, false);
        added += 1;
      }
    } finally {
      const t = this.backend.state.tasks.find((x) => x.id === taskId);
      if (added > 0 && t) {
        this.backend.emitDataChanged(
          ["tasks"],
          t.parentId ? [t.id, t.parentId] : [t.id],
        );
      }
    }
    return { added, tooLarge };
  }

  /** Bytes pasted as base64 (`addAttachmentData`), through the same path. */
  async addData(taskId: string, name: string, blob: Blob): Promise<void> {
    await this.checkPasted(blob);
    await this.keep({ taskId }, name, blob.type, blob, true);
  }

  /** Never more than the hard limit. */
  private async checkPasted(blob: Blob): Promise<void> {
    if (blob.size > DEFAULT_MAX_FILE_BYTES) {
      throw new WebFileError(
        "too_large",
        `pasted data over ${DEFAULT_MAX_FILE_BYTES} bytes`,
      );
    }
  }

  /**
   * Keeps files as images of a notebook page (picked or taken with the camera); `ids` are the
   * new attachments, in order, for the `![[file:<id>|…]]` the editor writes.
   */
  async addToPage(
    pageId: string,
    files: readonly File[],
  ): Promise<AddedPageFiles> {
    const tooLarge: string[] = [];
    const ids: string[] = [];
    // A page holds only images (`attachments::ensure_owner_takes`): refused before any is kept.
    const other = files.find((f) => !isPageImage(f.name, f.type));
    if (other)
      throw { kind: "invalid", message: `not an image: ${other.name}` };
    try {
      for (const file of files) {
        if (file.size > DEFAULT_MAX_FILE_BYTES) {
          tooLarge.push(file.name);
          continue;
        }
        ids.push(
          await this.keep({ pageId }, file.name, file.type, file, false),
        );
      }
    } finally {
      if (ids.length > 0) this.backend.emitDataChanged(["notes"]);
    }
    return { added: ids.length, tooLarge, ids };
  }

  /** An image pasted into a page (`addNoteAttachmentData`): the new attachment's id. */
  async addDataToPage(
    pageId: string,
    name: string,
    blob: Blob,
  ): Promise<string> {
    if (!isPageImage(name, blob.type)) {
      throw { kind: "invalid", message: `not an image: ${name}` };
    }
    await this.checkPasted(blob);
    return this.keep({ pageId }, name, blob.type, blob, true);
  }

  /**
   * An image of another page (or a task's) pasted in a page: its bytes kept on this phone are
   * kept again as a new image of `pageId` (`attachments::copy_to_page`). `not_found` when the
   * file is not on this phone (the page then keeps the original id).
   */
  async copyToPage(id: string, pageId: string): Promise<string> {
    const rec = this.live(id);
    if (!rec) throw { kind: "not_found", message: `attachment ${id}` };
    if (!isPageImage(rec.fileName, rec.mimeType)) {
      throw { kind: "invalid", message: `not an image: ${rec.fileName}` };
    }
    const kept = await this.store.get(rec.id).catch(() => null);
    const blob =
      kept && kept.size === rec.size
        ? kept.blob
        : (this.cache.get(rec.id)?.blob ?? null);
    if (!blob) throw { kind: "not_found", message: `file of ${id} not here` };
    return this.keep({ pageId }, rec.fileName, rec.mimeType, blob, true);
  }

  /** Hashes and keeps one file, then adds its attachment (the caller tells the views). */
  private async keep(
    owner: { taskId: string } | { pageId: string },
    name: string,
    type: string,
    blob: Blob,
    notify: boolean,
  ): Promise<string> {
    const b = this.backend;
    if (b.storageBroken || b.suspended) throw new WebFileError("storage");
    if ("taskId" in owner) {
      if (!b.state.tasks.some((x) => x.id === owner.taskId)) {
        throw new WebFileError("not_found", `task ${owner.taskId}`);
      }
    } else if (!b.notes.pages.some((x) => x.id === owner.pageId)) {
      throw new WebFileError("not_found", `page ${owner.pageId}`);
    }
    // The very bytes hashed are kept (a picked file may change on the disk meanwhile).
    const bytes = await blob.arrayBuffer();
    const sha256 = await sha256Hex(bytes);
    const fileName = safeFileName(name);
    const mimeType = type.trim() || mimeOf(fileName);
    const copy = new Blob([bytes], { type: mimeType });
    const id = b.newId("att");
    this.keeping.add(id);
    try {
      await this.store.put(id, { blob: copy, sha256, size: copy.size });
    } catch (error) {
      this.keeping.delete(id);
      console.error("files: cannot keep a file", error);
      throw new WebFileError("storage");
    }
    this.keeping.delete(id);
    const extra = {
      id,
      mimeType,
      isImage: isImageMime(mimeType),
      sha256,
      file: "local" as const,
      remote: "none" as const,
    };
    const rec =
      "taskId" in owner
        ? b.links.add(
            owner.taskId,
            "",
            fileName,
            copy.size,
            b.nowIsoString(),
            null,
            extra,
          )
        : b.links.addForPage(
            owner.pageId,
            "",
            fileName,
            copy.size,
            b.nowIsoString(),
            null,
            extra,
          );
    rec.path = rec.fileName;
    if (notify) this.changed(rec);
    return rec.id;
  }

  // --- downloading (« Télécharger ») --------------------------------------------------------

  async open(id: string): Promise<OpenedFile> {
    const rec = this.live(id);
    if (!rec) throw new WebFileError("not_found", `attachment ${id}`);
    const bytes = await this.bytesOf(rec);
    return {
      fileName: rec.fileName,
      blob: new Blob([bytes], { type: "application/octet-stream" }),
    };
  }

  async preview(id: string): Promise<Blob | null> {
    const rec = this.live(id);
    if (!rec || !hasPreview(rec.mimeType, rec.size)) return null;
    try {
      const bytes = await this.bytesOf(rec);
      return new Blob([bytes], { type: rec.mimeType.toLowerCase() });
    } catch {
      return null;
    }
  }

  /** The kept copy, else the session's cache, else a download (checked). */
  private async bytesOf(rec: AttachmentRec): Promise<Blob> {
    const kept = await this.store.get(rec.id).catch(() => null);
    if (
      kept &&
      kept.size === rec.size &&
      (rec.sha256 === undefined || kept.sha256 === rec.sha256)
    ) {
      return kept.blob;
    }
    const cached = this.cache.get(rec.id);
    if (cached && cached.sha256 === (rec.sha256 ?? null)) return cached.blob;
    const inFlight = this.downloading.get(rec.id);
    if (inFlight) return inFlight;
    const { token, serverUrl } = this.backend.syncData;
    if (!token || !serverUrl) throw new WebFileError("unlinked");
    // The tile says « Téléchargement… » before the request leaves.
    let start = () => {};
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const download = started.then(() => this.download(rec, token, serverUrl));
    this.downloading.set(rec.id, download);
    this.changed(rec);
    start();
    try {
      return await download;
    } finally {
      this.downloading.delete(rec.id);
      this.changed(rec);
    }
  }

  private async download(
    rec: AttachmentRec,
    token: string,
    serverUrl: string,
  ): Promise<Blob> {
    const sha256 = rec.sha256 ?? null;
    let blob: Blob;
    try {
      blob = await this.clientFor(serverUrl).downloadFile(token, rec.id);
    } catch (error) {
      if (error instanceof FileRefused) {
        throw new WebFileError(
          error.code === "not_found" ? "not_on_server" : "offline",
        );
      }
      if (error instanceof SyncHttpError && error.kind === "unauthorized") {
        throw new WebFileError("unlinked");
      }
      throw new WebFileError("offline");
    }
    if (blob.size !== rec.size) {
      throw new WebFileError("corrupt", "size differs");
    }
    if (
      sha256 !== null &&
      (await sha256Hex(await blob.arrayBuffer())) !== sha256
    ) {
      throw new WebFileError("corrupt", "sha256 differs");
    }
    this.remember(rec.id, sha256, blob);
    return blob;
  }

  /** Keeps a file in memory for this session (above the cap, the oldest leave first). */
  private remember(id: string, sha256: string | null, blob: Blob): void {
    this.cache.delete(id);
    if (blob.size > CACHE_MAX_BYTES) return;
    this.cache.set(id, { blob, sha256 });
    let total = 0;
    for (const e of this.cache.values()) total += e.blob.size;
    for (const [key, e] of this.cache) {
      if (total <= CACHE_MAX_BYTES) break;
      this.cache.delete(key);
      total -= e.blob.size;
    }
  }

  // --- cleaning --------------------------------------------------------------------------

  /**
   * Drops the kept copies that are not needed any more: attachment gone or deleted (unless
   * its deletion is held), sent, or no longer that file (`missing` after a different hash was
   * pulled). Best effort. Nothing is dropped while the set written by an older build waits
   * for its first sync (`filesRecovery`).
   */
  sweep(): Promise<void> {
    return this.track(this.sweepNow());
  }

  private async sweepNow(): Promise<void> {
    const liveNow = () =>
      new Map(
        this.backend.links.attachments
          .filter((a) => a.deletedAt === null)
          .map((a) => [a.id, a]),
      );
    let live = liveNow();
    for (const [id, e] of this.cache) {
      const a = live.get(id);
      if (!a || e.sha256 !== (a.sha256 ?? null)) this.cache.delete(id);
    }
    // Saved by an older build: the attachments come back with the next sync, kept files stay
    // until then (`MobileBackend.endFilesRecovery`).
    if (this.backend.syncData.filesRecovery) return;
    let ids: string[];
    try {
      ids = await this.store.ids();
    } catch {
      return;
    }
    // Read after the ids: a file kept meanwhile has its attachment by now, or is `keeping`.
    live = liveNow();
    for (const id of ids) {
      const file = live.get(id)?.file;
      if (file !== undefined && KEEP.has(file)) continue;
      if (this.uploading.has(id) || this.keeping.has(id)) continue;
      // Held by the deletion guard: « Les remettre » brings it back with its copy.
      if (
        this.backend.heldDeletions.has(`attachment:${id}`) ||
        this.backend.heldDeletions.has(`note_attachment:${id}`)
      ) {
        continue;
      }
      try {
        await this.store.delete(id);
      } catch (error) {
        console.warn("files: cannot drop a kept file", error);
      }
    }
  }

  /**
   * Attachments brought back by « Les remettre » (their rows come back `missing`): those whose
   * copy is still here are to send again. Protected from the sweep until checked; a copy that
   * cannot be read counts as here (the job checks it again).
   */
  reclaim(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.keeping.add(id);
    return this.track(
      (async () => {
        for (const id of ids) {
          try {
            const rec = this.live(id);
            if (rec?.file !== "missing") continue;
            let here: boolean;
            try {
              const kept = await this.store.get(id);
              here =
                kept !== null &&
                kept.size === rec.size &&
                kept.sha256 === rec.sha256;
            } catch {
              here = true;
            }
            if (here) {
              rec.file = "local";
              this.changed(rec);
            }
          } finally {
            this.keeping.delete(id);
          }
        }
      })(),
    );
  }

  /**
   * At login or after the server's database changed: the refused files are tried again (the
   * new server may take them).
   */
  afterLink(): void {
    for (const a of this.backend.links.attachments) {
      if (a.file === "too_large" || a.file === "quota_exceeded") {
        a.file = "local";
      }
    }
  }

  // --- sending ---------------------------------------------------------------------------

  /** Sends the kept files whose row the server has; one job at a time (a call during it runs it again). */
  run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const job = (async () => {
      do {
        this.again = false;
        await this.pass();
      } while (this.again);
    })()
      .catch((error) => console.error("files: job failed", error))
      .finally(() => {
        this.running = null;
      });
    this.running = job;
    return job;
  }

  private async pass(): Promise<void> {
    await this.sweepNow();
    const b = this.backend;
    const { token, serverUrl } = b.syncData;
    if (!token || !serverUrl || b.storageBroken || b.suspended) return;
    const client = this.clientFor(serverUrl);
    for (const rec of [...b.links.attachments]) {
      if (
        rec.deletedAt !== null ||
        rec.sha256 === undefined ||
        rec.file === undefined ||
        !TO_SEND.has(rec.file) ||
        this.refusedThisSession.has(rec.id) ||
        // Its row is not on the server yet: the file would be refused (404).
        b.outbox[
          `${rec.notePageId === undefined ? "attachment" : "note_attachment"}:${rec.id}`
        ] !== undefined
      ) {
        continue;
      }
      let kept: StoredFile | null;
      try {
        kept = await this.store.get(rec.id);
      } catch (error) {
        // Not read is not absent: the copy may be the only one. The next sync tries again.
        console.warn("files: cannot read a kept file", error);
        continue;
      }
      if (!kept || kept.sha256 !== rec.sha256 || kept.size !== rec.size) {
        // Nothing here to send: the file is wherever another device put it.
        rec.file = "missing";
        this.changed(rec);
        continue;
      }
      const { sha256 } = rec;
      this.uploading.add(rec.id);
      this.changed(rec);
      let outcome: Outcome | "offline";
      try {
        outcome = await this.upload(client, token, rec, kept, sha256);
      } catch (error) {
        const kind =
          error instanceof SyncHttpError ? error.kind : String(error);
        console.warn(`files: upload of ${rec.id} stopped: ${kind}`);
        outcome = "offline";
      } finally {
        this.uploading.delete(rec.id);
      }
      // Unlinked or linked again meanwhile, or the file changed: record nothing.
      if (b.syncData.token !== token || this.live(rec.id)?.sha256 !== sha256) {
        this.changed(rec);
        return;
      }
      if (outcome === "sent") {
        rec.file = "sent";
        this.remember(rec.id, sha256, kept.blob);
        try {
          await this.store.delete(rec.id);
        } catch (error) {
          console.warn("files: cannot drop a sent file", error);
        }
      } else if (outcome === "too_large" || outcome === "quota_exceeded") {
        rec.file = outcome;
      } else if (outcome === "hash_mismatch") {
        await this.afterHashRefused(rec, kept, sha256);
      }
      this.changed(rec);
      // No network: the other files wait for the next sync too.
      if (outcome === "offline") return;
    }
  }

  /**
   * The server refused the bytes for their SHA-256: the copy is hashed again, once. Not the
   * recorded hash: the copy kept here is damaged (storage) and can never be this attachment's
   * file; it is never sent again but stays, openable, and the tile keeps saying « Sur cet
   * appareil seulement » (only here, and not elsewhere). Same hash: damaged on the way; not
   * sent again before the page is reloaded.
   */
  private async afterHashRefused(
    rec: AttachmentRec,
    kept: StoredFile,
    sha256: string,
  ): Promise<void> {
    let actual: string | null = null;
    try {
      actual = await sha256Hex(await kept.blob.arrayBuffer());
    } catch (error) {
      console.warn("files: cannot hash a kept file again", error);
    }
    if (actual !== null && actual !== sha256) {
      console.warn(`files: kept copy of ${rec.id} does not match its hash`);
      rec.file = "unsendable";
    } else {
      this.refusedThisSession.add(rec.id);
    }
  }

  /** One file: resumes where the server is, chunk after chunk, until it says complete. */
  private async upload(
    client: SyncClient,
    token: string,
    rec: AttachmentRec,
    kept: StoredFile,
    sha256: string,
  ): Promise<Outcome> {
    const { id, size } = rec;
    const query = { size, sha256 };
    let rereads = 0;
    let status = await this.status(client, token, id);
    if (status === null) return "later";
    for (;;) {
      if (status.complete && status.size === size) return "sent";
      let offset =
        status.size === size && status.received <= size ? status.received : 0;
      try {
        if (offset === 0) {
          // Opens the upload with an empty chunk: the limits answer before any byte.
          status = await client.putFileChunk(
            token,
            id,
            { offset: 0, ...query },
            new Blob([]),
          );
          if (status.complete) return "sent";
          offset = status.received;
        }
        for (;;) {
          const end = Math.min(offset + this.chunkBytes, size);
          status = await client.putFileChunk(
            token,
            id,
            { offset, ...query },
            kept.blob.slice(offset, end),
          );
          if (status.complete) return "sent";
          if (status.received !== end) {
            // The server disagrees: start again from what it says it holds.
            rereads += 1;
            if (rereads > MAX_REREADS) return "later";
            break;
          }
          offset = end;
        }
      } catch (error) {
        if (!(error instanceof FileRefused)) throw error;
        switch (error.code) {
          case "chunk_offset":
            rereads += 1;
            if (rereads > MAX_REREADS) return "later";
            break;
          case "file_too_large":
            return "too_large";
          case "quota_exceeded":
            return "quota_exceeded";
          case "hash_mismatch":
            return "hash_mismatch";
          default:
            // Row gone (404), malformed: the next sync decides again.
            console.warn(`files: upload of ${id} refused: ${error.code}`);
            return "later";
        }
      }
      const next = await this.status(client, token, id);
      if (next === null) return "later";
      status = next;
    }
  }

  /** The server's status of a file, `null` when it has no such live attachment (404). */
  private async status(client: SyncClient, token: string, id: string) {
    try {
      return await client.fileStatus(token, id);
    } catch (error) {
      if (error instanceof FileRefused) return null;
      throw error;
    }
  }
}
