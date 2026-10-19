/**
 * Attachments and relations of the mock backend (Taido V2.3), following the core's
 * `db::attachments` and `db::relations`. No file is copied in a browser: an attachment keeps
 * its name, a fake path in the task's folder and, for a pasted image, its data URL.
 *
 * V2.7 bis: `remote` (the tile's indicator, computed by the core) starts `local_only`; a
 * successful `sync_now` while linked turns it to `none` (« sent »). Without an account every
 * tile shows `none` (as in the core). Tests set any other state with `setRemote`.
 *
 * The web app (src/mobile/) keeps its real attachments here too: their rows are synced, their
 * files kept in IndexedDB (`sha256`, `file`), and their tiles computed by `viewOf`.
 */

import type {
  AddRelationInput,
  Attachment,
  AttachmentInfo,
  AttachmentRemote,
  NoteAttachment,
  RelatedTask,
  TaskRelations,
} from "../bindings";

/**
 * Where an attachment's file stands on the web app's device (src/mobile/files.ts), never
 * synced: `local` kept here, not sent yet; `sent` on the server (its copy here may be gone);
 * `missing` not here (the normal state of a file added elsewhere: opened on demand);
 * `too_large` / `quota_exceeded` refused by the server, tried again at each sync;
 * `unsendable` the copy kept here no longer has its recorded hash (damaged): kept and
 * openable here, never sent.
 */
export type PhoneFileState =
  | "local"
  | "sent"
  | "missing"
  | "too_large"
  | "quota_exceeded"
  | "unsendable";

export interface AttachmentRec extends Attachment {
  /**
   * Notebook: set on an image of a page, whose owner is
   * the page and whose `taskId` is then empty. A task's attachment never has it.
   */
  notePageId?: string;
  dataUrl: string | null;
  deletedAt: string | null;
  /** Web app only: SHA-256 of the file (synced, absent when unknown). */
  sha256?: string;
  /** Web app only: where the file stands on this device. */
  file?: PhoneFileState;
}

export interface RelationRec {
  id: string;
  from: string;
  to: string;
  kind: "blocks" | "relates_to";
  createdAt: string;
  deletedAt: string | null;
}

/** What the relations need to know about a task. */
export interface LinkedTask {
  id: string;
  title: string;
  parentTitle: string | null;
  project: string | null;
  completed: boolean;
  deleted: boolean;
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg|heic|heif|avif|bmp|tiff?)$/i;

/** The image formats a notebook page takes: the core's `mime_of` images, no other. */
export const PAGE_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/heic",
  "image/heif",
  "image/avif",
  "image/bmp",
  "image/tiff",
]);

/** Image formats a page does not take, named by their extension. */
const OTHER_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ico",
  "icns",
  "psd",
  "xcf",
  "jxl",
  "jp2",
  "svgz",
  "eps",
  "raw",
  "cr2",
  "cr3",
  "nef",
  "arw",
  "dng",
]);

const extensionOf = (name: string): string | null =>
  /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase() ?? null;

/**
 * Why a file cannot go in a page (`attachments::ensure_owner_takes`, which goes by the name):
 * `null` when it can, `format` for an image of another format, `other` for a file that is
 * not an image. The browser's type only decides for a name without an extension.
 */
export function pageImageRefusal(
  name: string,
  type = "",
): "format" | "other" | null {
  const t = type.trim().toLowerCase();
  const ext = extensionOf(name);
  if (ext === null) {
    if (PAGE_IMAGE_MIMES.has(t)) return null;
    return t.startsWith("image/") ? "format" : "other";
  }
  const mime = mimeOf(name);
  if (PAGE_IMAGE_MIMES.has(mime)) return null;
  if (OTHER_IMAGE_EXTENSIONS.has(ext)) return "format";
  // A known type that is not an image (`devis.pdf`), whatever the browser says.
  if (mime !== "application/octet-stream") return "other";
  return t.startsWith("image/") ? "format" : "other";
}

const EXTENSION_OF_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
};

/** A name the core reads as the image it is: an extension from the type when it has none. */
export function imageFileName(name: string, type: string): string {
  if (extensionOf(name) !== null) return name;
  const ext = EXTENSION_OF_MIME[type.trim().toLowerCase()];
  return ext ? `${name || "image"}.${ext}` : name;
}

export const isPageImage = (name: string, type = ""): boolean =>
  pageImageRefusal(name, type) === null;

export function mimeOf(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "svg") return "image/svg+xml";
  if (ext === "heic") return "image/heic";
  if (ext === "heif") return "image/heif";
  if (ext === "avif") return "image/avif";
  if (ext === "bmp") return "image/bmp";
  if (ext === "tif" || ext === "tiff") return "image/tiff";
  if (ext === "pdf") return "application/pdf";
  if (ext === "eml") return "message/rfc822";
  if (["txt", "md", "csv", "log"].includes(ext)) return "text/plain";
  return "application/octet-stream";
}

function invalid(message: string) {
  return { kind: "invalid", message };
}

/** `name`, else `name (2).ext`… not in `taken` (the core's `free_name`). */
function freeAmong(taken: ReadonlySet<string>, name: string): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] =
    dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export class MockLinks {
  attachments: AttachmentRec[] = [];
  relations: RelationRec[] = [];
  /**
   * The web app computes each tile's indicator and presence itself (src/mobile/files.ts);
   * `null` in the Mac's mock.
   */
  viewOf: ((a: AttachmentRec) => Pick<Attachment, "remote" | "exists">) | null =
    null;

  constructor(
    private readonly newId: (prefix: string) => string,
    /** The device is linked to an account (the sync's state is not `unlinked`). */
    private readonly linked: () => boolean = () => false,
  ) {}

  reset(): void {
    this.attachments = [];
    this.relations = [];
    this.downloads.clear();
  }

  // --- attachments -------------------------------------------------------------

  private live(taskId: string): AttachmentRec[] {
    return this.attachments.filter(
      (a) =>
        a.notePageId === undefined &&
        a.taskId === taskId &&
        a.deletedAt === null,
    );
  }

  private livePage(pageId: string): AttachmentRec[] {
    return this.attachments.filter(
      (a) => a.notePageId === pageId && a.deletedAt === null,
    );
  }

  /** `name`, else `name (2).ext`… among the task's files. */
  private freeName(taskId: string, name: string): string {
    return freeAmong(new Set(this.live(taskId).map((a) => a.fileName)), name);
  }

  /** Names taken in the pretend Downloads folder (« Télécharger » on the Mac). */
  private downloads = new Set<string>();

  /**
   * « Télécharger » on the Mac, like the core's `save_copy`: a file not here is fetched first
   * when linked (`file_not_here` without an account); returns the copy's pretend path in the
   * Downloads folder, under a free name.
   */
  download(id: string): string {
    const a = this.get(id);
    if (!a.exists) {
      if (!this.linked()) {
        throw {
          kind: "file_not_here",
          message: `the file of attachment ${id} is not on this Mac and there is no account`,
        };
      }
      a.exists = true;
      a.remote = "none";
    }
    const name = freeAmong(this.downloads, a.fileName);
    this.downloads.add(name);
    return `/Users/user/Downloads/${name}`;
  }

  /** A new attachment named freely among the task's files; `extra` overrides its fields. */
  add(
    taskId: string,
    folder: string,
    name: string,
    size: number,
    now: string,
    dataUrl: string | null = null,
    extra: Partial<AttachmentRec> = {},
  ): AttachmentRec {
    const fileName = this.freeName(taskId, name);
    const mimeType = mimeOf(fileName);
    const rec: AttachmentRec = {
      id: this.newId("att"),
      taskId,
      fileName,
      path: `${folder}/${fileName}`,
      mimeType,
      isImage: IMAGE.test(fileName),
      size,
      addedAt: now,
      exists: true,
      remote: "local_only",
      dataUrl,
      deletedAt: null,
      ...extra,
    };
    this.attachments.push(rec);
    return rec;
  }

  /**
   * A new image of a notebook page, named freely among the page's images (the core's
   * `attachments::add_*` with `AttachmentOwner::NotePage`); `extra` overrides its fields.
   */
  addForPage(
    pageId: string,
    folder: string,
    name: string,
    size: number,
    now: string,
    dataUrl: string | null = null,
    extra: Partial<AttachmentRec> = {},
  ): AttachmentRec {
    const fileName = freeAmong(
      new Set(this.livePage(pageId).map((a) => a.fileName)),
      name,
    );
    const rec: AttachmentRec = {
      id: this.newId("att"),
      taskId: "",
      notePageId: pageId,
      fileName,
      path: `${folder}/${fileName}`,
      mimeType: mimeOf(fileName),
      isImage: IMAGE.test(fileName),
      size,
      addedAt: now,
      exists: true,
      remote: "local_only",
      dataUrl,
      deletedAt: null,
      ...extra,
    };
    this.attachments.push(rec);
    return rec;
  }

  /**
   * Tests: forces an attachment's indicator. A file to download (or being downloaded) is not
   * on this device yet (`exists: false`).
   */
  setRemote(id: string, remote: AttachmentRemote): void {
    const a = this.get(id);
    a.remote = remote;
    a.exists = remote !== "to_download" && remote !== "downloading";
  }

  /** After a successful sync while linked: the files that were only here are sent. */
  markSent(): boolean {
    let changed = false;
    for (const a of this.attachments) {
      if (a.deletedAt === null && a.remote === "local_only") {
        a.remote = "none";
        changed = true;
      }
    }
    return changed;
  }

  list(taskId: string): Attachment[] {
    const linked = this.linked();
    return this.live(taskId).map((rec) => {
      const { dataUrl: _d, deletedAt: _x, sha256: _h, file: _f, ...a } = rec;
      if (this.viewOf) return { ...a, ...this.viewOf(rec) };
      return { ...a, remote: linked ? a.remote : "none" };
    });
  }

  /** A live attachment by id, whoever owns it (`attachments::info`); `null` when none. */
  info(id: string): AttachmentInfo | null {
    const rec = this.attachments.find(
      (x) => x.id === id && x.deletedAt === null,
    );
    if (!rec) return null;
    const view = this.viewOf
      ? this.viewOf(rec)
      : { exists: rec.exists, remote: this.linked() ? rec.remote : "none" };
    return {
      id: rec.id,
      fileName: rec.fileName,
      path: rec.path,
      mimeType: rec.mimeType,
      size: rec.size,
      ...view,
    };
  }

  /** The live images of a page, in the order they were added. */
  listForPage(pageId: string): NoteAttachment[] {
    const linked = this.linked();
    return this.livePage(pageId).map((rec) => {
      const { id, fileName, path, mimeType, isImage, size, addedAt } = rec;
      const view = this.viewOf
        ? this.viewOf(rec)
        : { exists: rec.exists, remote: linked ? rec.remote : "none" };
      return {
        id,
        notePageId: pageId,
        fileName,
        path,
        mimeType,
        isImage,
        size,
        addedAt,
        ...view,
      };
    });
  }

  count(taskId: string): number {
    return this.live(taskId).length;
  }

  /** A live attachment of a task or an image of a page (the preview serves both). */
  get(id: string): AttachmentRec {
    const a = this.attachments.find((x) => x.id === id && x.deletedAt === null);
    if (!a) throw { kind: "not_found", message: `attachment ${id}` };
    return a;
  }

  /** A live attachment of a task (the core's `attachments::get`). */
  getTaskAttachment(id: string): AttachmentRec {
    const a = this.get(id);
    if (a.notePageId !== undefined) {
      throw { kind: "not_found", message: `attachment ${id}` };
    }
    return a;
  }

  /** A live image of a page (the core's `attachments::get_page_image`). */
  getPageImage(id: string): AttachmentRec {
    const a = this.get(id);
    if (a.notePageId === undefined) {
      throw { kind: "not_found", message: `page image ${id}` };
    }
    return a;
  }

  // --- relations ----------------------------------------------------------------

  addRelation(input: AddRelationInput, now: string): void {
    if (input.taskId === input.otherId) {
      throw invalid("a task cannot relate to itself");
    }
    const [from, to, kind] =
      input.kind === "blocked_by"
        ? [input.otherId, input.taskId, "blocks" as const]
        : input.kind === "blocks"
          ? [input.taskId, input.otherId, "blocks" as const]
          : [input.taskId, input.otherId, "relates_to" as const];
    const exists = this.relations.some(
      (r) =>
        r.deletedAt === null &&
        r.kind === kind &&
        ((r.from === from && r.to === to) || (r.from === to && r.to === from)),
    );
    if (exists) throw invalid("these tasks are already related");
    this.relations.push({
      id: this.newId("rel"),
      from,
      to,
      kind,
      createdAt: now,
      deletedAt: null,
    });
  }

  deleteRelation(id: string, now: string): [string, string] {
    const r = this.relations.find((x) => x.id === id && x.deletedAt === null);
    if (!r) throw { kind: "not_found", message: `relation ${id}` };
    r.deletedAt = now;
    return [r.from, r.to];
  }

  /**
   * Removes for good the relations touching these tasks, on either side (purge, `ON DELETE
   * CASCADE`).
   */
  dropTasks(taskIds: ReadonlySet<string>): void {
    this.relations = this.relations.filter(
      (r) => !taskIds.has(r.from) && !taskIds.has(r.to),
    );
  }

  of(taskId: string, task: (id: string) => LinkedTask | null): TaskRelations {
    const out: TaskRelations = { blocks: [], blockedBy: [], related: [] };
    for (const r of this.relations) {
      if (r.deletedAt !== null || (r.from !== taskId && r.to !== taskId)) {
        continue;
      }
      const other = task(r.from === taskId ? r.to : r.from);
      if (!other || other.deleted) continue;
      const related: RelatedTask = {
        relationId: r.id,
        taskId: other.id,
        title: other.title,
        parentTitle: other.parentTitle,
        project: other.project,
        completed: other.completed,
      };
      if (r.kind === "relates_to") out.related.push(related);
      else if (r.from === taskId) out.blocks.push(related);
      else out.blockedBy.push(related);
    }
    return out;
  }

  /** The relation badges of a row: blocks, blocked by (first title and count), related. */
  rowFacts(
    taskId: string,
    task: (id: string) => LinkedTask | null,
  ): {
    blocksCount: number;
    blockedBy: string | null;
    blockedByCount: number;
    relatedCount: number;
  } {
    const rel = this.of(taskId, task);
    const blockers = rel.blockedBy.filter((t) => !t.completed);
    return {
      blocksCount: rel.blocks.filter((t) => !t.completed).length,
      blockedBy: blockers[0]?.title ?? null,
      blockedByCount: blockers.length,
      relatedCount: rel.related.length,
    };
  }
}
