/**
 * Attachment files in the web app (site and phone): what the UI asks of the
 * phone's backend (`WebAttachmentFiles`, implemented by src/mobile/files.ts), and the security
 * rule of a web app that shares its origin, hence its token, with the API
 *: a file is **saved**, never shown, navigated to, opened in a tab
 * or put in an iframe (`saveBlob`: an `application/octet-stream` blob behind a temporary
 * `<a download>`); an HTML page opened from a `blob:` URL would run on the app's origin and
 * could read the token. Since « Télécharger » (2026-10-10) images are saved too.
 *
 * The one exception (2026-10-12, by design: the tiles had no preview on the site and the phone):
 * a raster image (`PREVIEW_MIMES`, never SVG) is shown as the tile's thumbnail, in an `<img>`
 * only, which runs no script and never navigates.
 *
 * The server's content type is never consulted (it always says `application/octet-stream`).
 */

/**
 * A saved file's `blob:` URL is revoked this long after the click: the browser may read it
 * well after (Chrome on Android's download manager; iOS Safari asks « Télécharger ? » first),
 * and nothing else ever uses it.
 */
export const REVOKE_AFTER_MS = 5 * 60_000;

/** Raster image types shown as a thumbnail (`preview`): no SVG, which can carry script. */
export const PREVIEW_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
]);

/** An image larger than this is not downloaded for its thumbnail (the phone's data). */
export const PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

/** Whether the tile of a file of this type and size shows a thumbnail. */
export const hasPreview = (mimeType: string, size: number): boolean =>
  PREVIEW_MIMES.has(mimeType.toLowerCase()) && size <= PREVIEW_MAX_BYTES;

/** Why a file could not be added or downloaded (the UI says it in its language). */
export type WebFileErrorKind =
  /** Not on this device and no account to fetch it from. */
  | "unlinked"
  /** The server does not have it (yet): the device that added it has not sent it. */
  | "not_on_server"
  /** No network, or the server could not be reached. */
  | "offline"
  /** The bytes received are not the attachment's (size or SHA-256). */
  | "corrupt"
  /** This device could not keep the file (storage full or unavailable). */
  | "storage"
  /** The attachment is gone. */
  | "not_found";

export class WebFileError extends Error {
  constructor(
    readonly kind: WebFileErrorKind,
    message: string = kind,
  ) {
    super(message);
    this.name = "WebFileError";
  }
}

/** A file ready to be saved (`saveBlob`). */
export interface OpenedFile {
  fileName: string;
  /** Its bytes, typed `application/octet-stream`. */
  blob: Blob;
}

export interface AddedFiles {
  added: number;
}

/** Files added as images of a notebook page: the new attachments' ids, in order. */
export interface AddedPageFiles extends AddedFiles {
  ids: string[];
}

/** The web app's attachment files (the phone's backend; `null` on the Mac and in the mock). */
export interface WebAttachmentFiles {
  /** Keeps the files on this device, hashes them and adds them to the task. */
  add(taskId: string, files: readonly File[]): Promise<AddedFiles>;
  /**
   * Keeps files as images of a notebook page (a picked file, a photo): hashed, kept here and
   * added to the page; their ids go in the page's `![[file:<id>|…]]`.
   */
  addToPage(pageId: string, files: readonly File[]): Promise<AddedPageFiles>;
  /** The file's bytes, from this device or downloaded from the server, ready to save. */
  open(id: string): Promise<OpenedFile>;
  /**
   * The bytes of an image's thumbnail, typed with its image type (`hasPreview`), from this
   * device or downloaded; `null` for another file or when it cannot be had.
   */
  preview(id: string): Promise<Blob | null>;
}

/**
 * Keeps a file dropped beside the drop zones (`[data-drop-zone]`) from making the browser open
 * it in place of the app: `dragover` says « not here » and `drop` is cancelled, for drags that
 * carry files only. Returns the cleanup.
 */
export function guardStrayDrops(target: Window): () => void {
  const carriesFiles = (e: DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const inZone = (e: Event) =>
    e.target instanceof Element &&
    e.target.closest("[data-drop-zone]") !== null;
  const onDragOver = (e: DragEvent) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    if (!inZone(e) && e.dataTransfer) e.dataTransfer.dropEffect = "none";
  };
  const onDrop = (e: DragEvent) => {
    if (carriesFiles(e)) e.preventDefault();
  };
  target.addEventListener("dragover", onDragOver);
  target.addEventListener("drop", onDrop);
  return () => {
    target.removeEventListener("dragover", onDragOver);
    target.removeEventListener("drop", onDrop);
  };
}

/**
 * Saves `blob` on the device as `fileName`: a temporary `<a download>` on an
 * `application/octet-stream` copy (never rendered, even if `download` were ignored), clicked,
 * removed at once; its URL is revoked `REVOKE_AFTER_MS` later.
 */
export function saveBlob(blob: Blob, fileName: string): void {
  const safe = new Blob([blob], { type: "application/octet-stream" });
  const url = URL.createObjectURL(safe);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  }
}
