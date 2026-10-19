/**
 * How a page's image shows: at its
 * width in % of the text column; a click (a tap on the phone) shows the sizes « 25 % · 50 % ·
 * 75 % · 100 % · Retirer », each applied at once; on a large screen a handle in the bottom
 * right corner resizes it live, rounded to 5 %, written once let go (one change to undo).
 * A file not on this device yet is a grey frame « Image en cours de téléchargement »; an image
 * with no preview (HEIC, too large) shows its name and « Ouvrir ».
 */

import { useQuery } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import {
  NodeViewWrapper,
  type ReactNodeViewProps,
  ReactNodeViewRenderer,
} from "@tiptap/react";
import { ImageIcon, ImageOff } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { NoteAttachment } from "../../../bindings";
import { showToast } from "../../../components/Toast";
import { t } from "../../../i18n";
import { commands, errorMessage, webFiles } from "../../../lib/ipc";
import { run } from "../../../lib/run";
import { hasPreview, saveBlob } from "../../../lib/web-files";
import { useSyncStatus } from "../../sync/useSyncStatus";
import {
  NoteImage,
  type NoteImageOptions,
  shownWidth,
  snapWidth,
  widthAfterDrag,
} from "./noteImage";

const SIZES = [25, 50, 75, 100];

/** The page's images (under `notebook`: the `notes` scope refreshes them). */
export const noteImagesKey = (pageId: string) =>
  ["notebook", "images", pageId] as const;

/** What the view needs of an image's attachment, this page's or another's. */
type ImageFile = Pick<
  NoteAttachment,
  "id" | "fileName" | "path" | "mimeType" | "size" | "exists" | "remote"
>;

/**
 * The image's attachment: from the page's list, else read by its id (an image of another page
 * or a task's); `undefined` while reading, `null` when this device has none.
 */
function useAttachment(
  pageId: string,
  id: string,
): ImageFile | null | undefined {
  const list = useQuery({
    queryKey: noteImagesKey(pageId),
    queryFn: () => commands.listNoteAttachments(pageId),
    enabled: pageId.length > 0,
  });
  const own = list.data?.find((a) => a.id === id);
  // Under `notebook` too: the `notes` scope reads it again (the file arrived, another device).
  const other = useQuery({
    queryKey: ["notebook", "attachmentInfo", id],
    queryFn: () => commands.attachmentInfo(id),
    enabled: list.data !== undefined && own === undefined,
    retry: false,
  });
  if (list.data === undefined) return undefined;
  if (own) return own;
  if (other.isPending) return undefined;
  return other.data ?? null;
}

type Shown =
  | { kind: "image"; src: string }
  | { kind: "file"; attachment: ImageFile }
  /** The file is on its way to this device. */
  | { kind: "pending" }
  /** The image's data is being read: a plain frame, no message. */
  | { kind: "loading" }
  /** No attachment has this id here, and the sync has nothing more to bring. */
  | { kind: "missing" };

/** The sync may still bring an unknown image: not while idle or with no account. */
function useSyncBusy(): boolean {
  const state = useSyncStatus().data?.state;
  return state !== undefined && state !== "idle" && state !== "unlinked";
}

/**
 * What the image shows. The preview is read again when the file arrives (`exists`, `remote`
 * in the key), not at every save of the page.
 */
function useShown(attachment: ImageFile | null | undefined): Shown {
  const files = webFiles();
  const onMac = files === null;
  const a = attachment ?? null;
  const syncBusy = useSyncBusy();
  const mac = useQuery({
    queryKey: ["noteImagePreview", a?.id, a?.exists],
    queryFn: () => commands.attachmentPreview(a?.id ?? ""),
    enabled: onMac && a?.exists === true,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const webShows = a !== null && hasPreview(a.mimeType, a.size);
  const web = useQuery({
    queryKey: ["noteImageWebPreview", a?.id, a?.remote],
    queryFn: async () => (await files?.preview(a?.id ?? "")) ?? null,
    enabled: !onMac && webShows,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const blob = web.data;
    if (!blob) return;
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [web.data]);

  if (attachment === undefined) return { kind: "loading" };
  if (a === null) return syncBusy ? { kind: "pending" } : { kind: "missing" };
  const coming =
    !a.exists || a.remote === "to_download" || a.remote === "downloading";
  if (onMac) {
    if (!a.exists) return { kind: "pending" };
    if (mac.data) return { kind: "image", src: mac.data };
    // No preview (HEIC, too large) or it failed: the file, to open.
    if (mac.isSuccess || mac.isError) return { kind: "file", attachment: a };
    return { kind: "loading" };
  }
  if (url) return { kind: "image", src: url };
  if (!webShows) return { kind: "file", attachment: a };
  if (web.isPending) return coming ? { kind: "pending" } : { kind: "loading" };
  return coming ? { kind: "pending" } : { kind: "file", attachment: a };
}

/** « Ouvrir »: the Mac opens the file in its app; the web app saves it (never shown). */
async function openFile(a: ImageFile): Promise<void> {
  const files = webFiles();
  if (!files) {
    await run(commands.openPath({ path: a.path, with: null, editor: null }));
    return;
  }
  try {
    const opened = await files.open(a.id);
    saveBlob(opened.blob, opened.fileName);
  } catch (error) {
    console.error(errorMessage(error), error);
  }
}

/** The block the image's width is a share of: its paragraph, list item or quote. */
function column(el: HTMLElement): HTMLElement | null {
  return (
    el.parentElement?.closest<HTMLElement>(
      "p, li, blockquote, td, .ProseMirror",
    ) ?? null
  );
}

function ImageView({
  node,
  editor,
  extension,
  updateAttributes,
  deleteNode,
  getPos,
}: ReactNodeViewProps) {
  const { pageId, phone } = extension.options as NoteImageOptions;
  const id = String(node.attrs.id);
  const width = shownWidth(node.attrs.width as number | null);
  const attachment = useAttachment(pageId, id);
  const shown = useShown(attachment);
  const [open, setOpen] = useState(false);
  /** Width while the handle is held (written once let go). */
  const [live, setLive] = useState<number | null>(null);
  const drag = useRef<{ x: number; px: number; column: number } | null>(null);
  const root = useRef<HTMLElement | null>(null);
  const sizes = useRef<HTMLSpanElement | null>(null);
  /** Shift of the sizes bar so that it stays inside the text column (px, ≤ 0). */
  const [shift, setShift] = useState(0);
  const editable = (editor as Editor).isEditable;
  const now = live ?? width;
  const name = attachment?.fileName ?? null;

  // The sizes close on a tap elsewhere, or Échap.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !root.current?.contains(e.target)) {
        setOpen(false);
      }
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  // The sizes bar starts at the image's left edge: on a narrow screen, a small image on the
  // right would push it past the column; it moves left just enough to stay inside.
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again when the image's width changes
  useLayoutEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    const bar = sizes.current;
    const img = root.current;
    const col = img?.closest<HTMLElement>(".ProseMirror") ?? null;
    if (!bar || !img || !col) return;
    const colBox = col.getBoundingClientRect();
    const imgBox = img.getBoundingClientRect();
    const width = bar.getBoundingClientRect().width;
    const over = imgBox.left + width - colBox.right;
    setShift(over > 0 ? Math.max(colBox.left - imgBox.left, -over) : 0);
  }, [open, now]);

  const setWidth = (next: number) => {
    if (next !== node.attrs.width || node.attrs.raw !== null) {
      updateAttributes({ width: next, raw: null });
    }
  };

  /**
   * Out of the text, with its line when it was alone on it (one change to undo). Returns what
   * puts the image back (the toast's « Annuler »): the same node at the place it left, followed
   * through what is typed since, whatever that is (a plain undo would take the typing away).
   */
  const removeImage = (): (() => void) => {
    const pos = getPos();
    const ed = editor as Editor;
    const node = typeof pos === "number" ? ed.state.doc.nodeAt(pos) : null;
    if (typeof pos !== "number" || !node) {
      deleteNode();
      return () => undefined;
    }
    const $pos = ed.state.doc.resolve(pos);
    const alone = $pos.depth > 0 && $pos.parent.childCount === 1;
    let at = alone ? $pos.before() : pos;
    const follow = ({ transaction }: { transaction: Transaction }) => {
      at = transaction.mapping.map(at, -1);
    };
    ed.on("transaction", follow);
    if (alone) {
      ed.chain().deleteRange({ from: $pos.before(), to: $pos.after() }).run();
    } else {
      deleteNode();
    }
    return () => {
      ed.off("transaction", follow);
      if (ed.isDestroyed) return;
      const block = { type: "paragraph", content: [node.toJSON()] };
      const end = ed.state.doc.content.size;
      const place = Math.min(at, end);
      const inline = !alone && ed.state.doc.resolve(place).parent.inlineContent;
      // Its place is a spot of text, else (the line's place, or a place gone) a line of its own;
      // if the text refuses it there, at the end of the page.
      const tries = [
        { pos: place, content: inline ? node.toJSON() : block },
        { pos: end, content: block },
      ];
      for (const t of tries) {
        if (ed.chain().insertContentAt(t.pos, t.content).run()) {
          const now = ed.getMarkdown();
          if (now.includes(`file:${node.attrs.id}`)) return;
        }
      }
    };
  };

  const onHandleDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const el = root.current;
    const col = el ? column(el) : null;
    if (!el || !col) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = {
      x: e.clientX,
      px: el.getBoundingClientRect().width,
      column: col.getBoundingClientRect().width,
    };
    setLive(width);
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    setLive(widthAfterDrag(d.px, e.clientX - d.x, d.column));
  };
  const onHandleUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const next = widthAfterDrag(d.px, e.clientX - d.x, d.column);
    setLive(null);
    if (next !== width) setWidth(next);
  };

  const button = phone
    ? "h-11 min-w-11 px-2.5 text-[15px]"
    : "h-8 px-2 text-[13px]";

  return (
    <NodeViewWrapper
      as="span"
      ref={root}
      data-note-image=""
      data-id={id}
      className={`note-image ${open ? "is-open" : ""} ${live !== null ? "is-resizing" : ""}`}
      style={{ width: `${now}%` }}
    >
      <button
        type="button"
        aria-label={t.notes.image.label(name, now)}
        aria-expanded={editable ? open : undefined}
        disabled={!editable}
        onClick={() => setOpen((o) => !o)}
        className="note-image-body"
      >
        {shown.kind === "image" && (
          <img src={shown.src} alt={name ?? ""} draggable={false} />
        )}
        {shown.kind === "pending" && (
          <span className="note-image-frame">
            <ImageIcon size={20} aria-hidden />
            <span>{t.notes.image.downloading}</span>
          </span>
        )}
        {shown.kind === "missing" && (
          <span className="note-image-frame">
            <ImageOff size={20} aria-hidden />
            <span>{t.notes.image.missing}</span>
          </span>
        )}
        {shown.kind === "loading" && (
          <span className="note-image-frame" aria-busy="true" />
        )}
        {shown.kind === "file" && (
          <span className="note-image-frame is-file">
            <ImageIcon size={20} aria-hidden />
            <span className="truncate">{shown.attachment.fileName}</span>
          </span>
        )}
      </button>
      {shown.kind === "file" && (
        <button
          type="button"
          onClick={() => void openFile(shown.attachment)}
          className={`note-image-open ${phone ? "min-h-11 px-3" : "px-2 py-1"}`}
        >
          {t.notes.image.open}
        </button>
      )}
      {editable && !phone && (
        <button
          type="button"
          aria-label={t.notes.image.resize}
          title={t.notes.image.resize}
          className="note-image-handle"
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={() => {
            drag.current = null;
            setLive(null);
          }}
          onKeyDown={(e) => {
            // The handle by keyboard: ← → by 5 %.
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              setWidth(snapWidth(width + (e.key === "ArrowLeft" ? -5 : 5)));
            }
          }}
        />
      )}
      {editable && open && (
        <span
          ref={sizes}
          role="toolbar"
          aria-label={t.notes.image.sizes}
          className="note-image-sizes"
          style={shift !== 0 ? { left: `${shift}px` } : undefined}
        >
          {SIZES.map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={w === width}
              onClick={() => setWidth(w)}
              className={`${button} rounded-md ${
                w === width
                  ? "bg-selected text-text"
                  : "text-text-2 hover:bg-hover hover:text-text"
              }`}
            >
              {t.notes.image.size(w)}
            </button>
          ))}
          <span aria-hidden className="mx-0.5 h-5 w-px self-center bg-border" />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              // No confirmation: an undo, like the page's other edits (⌘Z works too). Shown
              // first: a toast the removal raises (a too-long draft dropped, with its own
              // « Annuler ») takes its place.
              let putBack: () => void = () => undefined;
              showToast({
                message: t.notes.image.removed,
                action: {
                  label: t.toast.undo,
                  onAction: () => putBack(),
                },
              });
              putBack = removeImage();
            }}
            className={`${button} rounded-md text-[var(--due-overdue)] hover:bg-hover`}
          >
            {t.notes.image.remove}
          </button>
        </span>
      )}
    </NodeViewWrapper>
  );
}

/** `noteImage` with its view: the editor's version (the Markdown tests use the bare node). */
export const NoteImageView = NoteImage.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ImageView, {
      as: "span",
      // Clicks, the handle and the sizes are the view's: the text never takes them (and the
      // phone's keyboard does not open on a tap on an image).
      stopEvent: () => true,
    });
  },
});
