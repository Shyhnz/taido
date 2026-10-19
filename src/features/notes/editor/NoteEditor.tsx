/**
 * The text of a notebook page: Tiptap 3 stored as
 * Markdown. Saved 600 ms after the last change, and right away when the page closes, another
 * page opens or the app goes to the background. A page opened and closed without a change is
 * never written (§ 5.1): what is sent is compared with the stored text read back by the
 * editor, so the editor's way of writing Markdown alone never counts as a change.
 *
 * Images (task 8): pasted, dropped (the Finder's drop on the Mac comes through `noteDrop`) or
 * picked with the toolbar's button. An image taken out of the text keeps its file while the
 * page is open, so « Annuler » can bring it back; the file goes when the page closes, once the
 * text without it is saved.
 */

import type { Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { NotePage } from "../../../bindings";
import { Button } from "../../../components/Button";
import { showToast } from "../../../components/Toast";
import { fr } from "../../../i18n/fr";
import { commands, errorMessage, webFiles } from "../../../lib/ipc";
import { useView } from "../../../lib/queries";
import { run } from "../../../lib/run";
import { MAX_NOTE_BODY_BYTES } from "../../../lib/sync-proto";
import { useDebouncedSave } from "../../task-panel/debouncedSave";
import { wasDeletedHere } from "../noteActions";
import { notePages, useNotebook } from "../queries";
import {
  addImagesToPage,
  type ImageSource,
  insertNoteImages,
} from "./addImages";
import { noteExtensions } from "./extensions";
import {
  noteClipboard,
  pruneImages,
  pruneOrDefer,
  registerShownImages,
} from "./imageClipboard";
import { WikiLinkChip } from "./LinkChip";
import { type LinkItem, type LinkSource, LinkSuggest } from "./linkSuggest";
import { MobileToolbar } from "./MobileToolbar";
import { NoteImageView } from "./NoteImageView";
import { registerNoteDrop } from "./noteDrop";
import { imageIdsIn } from "./noteImage";
import {
  dropNoteDraft,
  editorMounted,
  isEditorMounted,
  keepNoteDraft,
  noteDraft,
  registerNoteFlush,
  trackNoteSave,
} from "./pendingEdits";
import { Toolbar } from "./Toolbar";
import "./noteEditor.css";

const encoder = new TextEncoder();

/** The project's pages (not `pageId`) and open tasks, for `[[`. */
function useLinkSource(subjectId: string, pageId: string): LinkSource {
  const nb = useNotebook(subjectId).data;
  const view = useView("subject", subjectId).data;
  const latest = useRef<ReturnType<LinkSource>>({ pages: [], tasks: [] });
  latest.current = {
    pages: (nb ? notePages(nb) : [])
      .filter((p) => p.id !== pageId)
      .map((p): LinkItem => ({ kind: "page", id: p.id, title: p.title })),
    tasks: (view?.groups ?? []).flatMap((g) =>
      g.tasks.map(
        (t): LinkItem => ({ kind: "task", id: t.id, title: t.title }),
      ),
    ),
  };
  return useMemo(() => () => latest.current, []);
}

/** The Tiptap editor of a ProseMirror view. */
const editorOf = (view: { dom: Element }): Editor =>
  (view.dom as HTMLElement & { editor: Editor }).editor;

/** Markdown of a document, written the way `getMarkdown()` writes it. */
function markdownOf(editor: Editor, doc: PmNode): string {
  const manager = (
    editor as unknown as { markdown?: { serialize: (json: unknown) => string } }
  ).markdown;
  return manager ? manager.serialize(doc.toJSON()) : editor.getMarkdown();
}

/** Adds the page's images in a document to `into`; returns those it did not hold yet. */
function imagesOf(doc: PmNode, into: Set<string>): string[] {
  const fresh: string[] = [];
  doc.descendants((n) => {
    if (n.type.name === "noteImage") {
      const id = String(n.attrs.id);
      if (!into.has(id)) fresh.push(id);
      into.add(id);
    }
    return n.isBlock;
  });
  return fresh;
}

/** How many times each image shows in a document. */
function imageCounts(doc: PmNode): Map<string, number> {
  const out = new Map<string, number>();
  doc.descendants((n) => {
    if (n.type.name === "noteImage") {
      const id = String(n.attrs.id);
      out.set(id, (out.get(id) ?? 0) + 1);
    }
    return n.isBlock;
  });
  return out;
}

/** Points every image `from` at `to` (its own copy), out of the undo history. */
function replaceImageId(editor: Editor, from: string, to: string): void {
  if (editor.isDestroyed) return;
  const { tr } = editor.state;
  let changed = false;
  editor.state.doc.descendants((n, pos) => {
    if (n.type.name !== "noteImage" || n.attrs.id !== from) return;
    const raw = n.attrs.raw as string | null;
    tr.setNodeMarkup(pos, undefined, {
      ...n.attrs,
      id: to,
      raw: raw === null ? null : raw.replace(from, to),
    });
    changed = true;
  });
  if (!changed) return;
  tr.setMeta("addToHistory", false);
  editor.view.dispatch(tr);
}

/** The image ids in the part of the page a copy or a cut takes. */
function selectedImages(editor: Editor): string[] {
  const ids: string[] = [];
  editor.state.selection.content().content.descendants((n) => {
    if (n.type.name === "noteImage") ids.push(String(n.attrs.id));
    return true;
  });
  return ids;
}

const hasFiles = (dt: DataTransfer | null): boolean =>
  Array.from(dt?.types ?? []).includes("Files");

/** Where the « too long » message shows: in the toolbar, where the user is looking. */
export function TooLongNotice() {
  return (
    <p
      role="alert"
      className="w-full rounded-md border border-[var(--due-overdue)] bg-bg px-3 py-2 text-[13.5px] text-[var(--due-overdue)]"
    >
      {fr.notes.editor.tooLong}
    </p>
  );
}

export function NoteEditor({
  page,
  subjectId,
  phone,
}: {
  page: NotePage;
  subjectId: string;
  /** The phone's sheet: the bar above the keyboard, bigger text. */
  phone: boolean;
}) {
  const source = useLinkSource(subjectId, page.id);
  /** Text kept from an earlier visit, too long to be saved. */
  const [kept] = useState(() => noteDraft(page.id));
  /**
   * Shown instead of the stored text only when written over that very text; a page changed
   * since (another device, Claude) shows as stored, and the user chooses (`conflict`).
   */
  const draft = kept !== null && kept.base === page.body ? kept.markdown : null;
  const [conflict, setConflictState] = useState(
    kept !== null && draft === null,
  );
  const conflictRef = useRef(conflict);
  const setConflict = (on: boolean) => {
    conflictRef.current = on;
    setConflictState(on);
  };
  const [tooLong, setTooLong] = useState(draft !== null);
  const tooLongRef = useRef(draft !== null);
  /** The text as stored, read back by the editor: the reference for « changed ». */
  const saved = useRef<string | null>(null);
  /** The document as last changed (still readable once the editor is gone). */
  const doc = useRef<PmNode | null>(null);
  /** Changed since the last save that went through (true while a draft is too long). */
  const dirty = useRef(draft !== null);
  /** The stored body last shown, to tell another device's change from our own echo. */
  const shownBody = useRef(page.body);
  const lastSave = useRef<Promise<unknown> | null>(null);
  /** Images shown since the page opened (to delete those that left it, at close). */
  const seenImages = useRef(new Set<string>());
  /** Images of too-long drafts dropped here: their « Annuler » can bring them back. */
  const draftImages = useRef(new Set<string>());
  /** The editor is on screen (an upload that ends after it closed cleans up). */
  const alive = useRef(true);
  /** How many times each image shows, to tell what an edit brought in. */
  const imageCount = useRef(new Map<string, number>());
  /** Images of another page pasted here: copied as this page's own. */
  const adoptRef = useRef<(ids: string[]) => void>(() => {});
  const [adding, setAdding] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  /** Adds images where they were pasted, dropped, or at the selection. */
  const addImagesRef = useRef<(source: ImageSource, at?: number) => void>(
    () => {},
  );

  const markTooLong = (on: boolean) => {
    tooLongRef.current = on;
    setTooLong(on);
  };

  const editor = useEditor({
    extensions: noteExtensions({
      placeholder: fr.notes.editor.placeholder,
      wikiLink: WikiLinkChip,
      noteImage: NoteImageView.configure({ pageId: page.id, phone }),
      extra: [LinkSuggest.configure({ source })],
    }),
    content: draft ?? page.body,
    contentType: "markdown",
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": fr.notes.editor.bodyLabel,
        class: `note-editor ${phone ? "text-[16px] leading-7" : "text-[15px] leading-7"}`,
        autocapitalize: "sentences",
      },
      // Keep the caret clear of the phone's bar above the keyboard.
      scrollMargin: phone ? { top: 16, bottom: 72, left: 0, right: 0 } : 16,
      scrollThreshold: phone ? { top: 16, bottom: 72, left: 0, right: 0 } : 16,
      handlePaste: (_view, event) => {
        const data = event.clipboardData;
        const files = Array.from(data?.files ?? []);
        if (files.length === 0) return false;
        // Text copied from Word or Excel comes with a picture of itself: it stays text.
        if ((data?.getData("text/plain") ?? "").trim().length > 0) return false;
        event.preventDefault();
        addImagesRef.current({ files });
        return true;
      },
      handleDOMEvents: {
        copy: (view) => {
          noteClipboard(selectedImages(editorOf(view)));
          return false;
        },
        cut: (view) => {
          noteClipboard(selectedImages(editorOf(view)));
          return false;
        },
      },
    },
    onCreate: ({ editor: e }) => {
      doc.current = e.state.doc;
      imageCount.current = imageCounts(e.state.doc);
      imagesOf(e.state.doc, seenImages.current);
      // A draft differs from the stored text by definition.
      saved.current = draft === null ? e.getMarkdown() : null;
    },
    onUpdate: ({ editor: e }) => {
      doc.current = e.state.doc;
      imagesOf(e.state.doc, seenImages.current);
      // An image the edit brought in (a paste, a drop) that is not this page's: copied here.
      const before = imageCount.current;
      const now = imageCounts(e.state.doc);
      imageCount.current = now;
      const added = [...now].filter(([id, n]) => n > (before.get(id) ?? 0));
      if (added.length > 0) adoptRef.current(added.map(([id]) => id));
      dirty.current = true;
      // Typing while the choice is offered chooses the current version.
      if (conflictRef.current) abandonDraftRef.current();
      save.schedule("");
    },
  });

  /** Sends the text if it changed; keeps it as a draft if it is too long. */
  const send = () => {
    const ed = editor;
    const current = doc.current;
    if (!ed || !current || !dirty.current) return;
    const body = markdownOf(ed, current);
    if (body === saved.current) {
      dirty.current = false;
      markTooLong(false);
      dropNoteDraft(page.id);
      return;
    }
    if (encoder.encode(body).length > MAX_NOTE_BODY_BYTES) {
      // Not sent (the core and the sync would refuse it), not lost: kept on this device.
      markTooLong(true);
      keepNoteDraft(page.id, { markdown: body, base: shownBody.current });
      return;
    }
    dirty.current = false;
    markTooLong(false);
    const before = saved.current;
    saved.current = body;
    shownBody.current = body;
    const sent = run(
      commands.updateNotePage({ id: page.id, title: null, body }),
      fr.notes.errors.updatePage,
    ).then((done) => {
      if (done !== undefined) {
        // In the core now: a draft kept earlier is no longer needed (unless a newer one).
        if (!tooLongRef.current) dropNoteDraft(page.id);
        return;
      }
      // Failed: still to send, at the next change, page switch or close.
      if (saved.current === body) saved.current = before;
      dirty.current = true;
    });
    lastSave.current = sent;
    trackNoteSave(sent);
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  const save = useDebouncedSave(() => sendRef.current());

  // Leaving the page (another page, the tab, the sheet closing): send what is left, and say
  // so when the text could only be kept as a draft.
  // Not for a page deleted here (its last text went before the delete), and not when React
  // mounts the editor again at once.
  useEffect(() => {
    const unmounted = editorMounted(page.id);
    return () => {
      unmounted();
      if (wasDeletedHere(page.id)) return;
      sendRef.current();
      // Images taken out: offered to the core's cleanup once the text without them is in
      // the core; it keeps whatever a live page shows. A draft kept or dropped here (its
      // « Annuler ») and the clipboard keep theirs too.
      void Promise.resolve(lastSave.current).then(() => {
        if (wasDeletedHere(page.id) || dirty.current || tooLongRef.current) {
          return;
        }
        if (saved.current === null) return;
        const kept = imageIdsIn(saved.current);
        for (const id of imageIdsIn(noteDraft(page.id)?.markdown ?? "")) {
          kept.add(id);
        }
        for (const id of draftImages.current) kept.add(id);
        const gone = [...seenImages.current].filter((id) => !kept.has(id));
        pruneOrDefer(page.id, gone);
      });
      if (!tooLongRef.current) return;
      setTimeout(() => {
        if (!isEditorMounted(page.id) && !wasDeletedHere(page.id)) {
          showToast({ message: fr.notes.editor.draftKept });
        }
      }, 0);
    };
  }, [page.id]);

  /** « Reprendre mon brouillon »: the draft replaces the text, as if typed now. */
  const resumeDraft = () => {
    setConflict(false);
    const latest = noteDraft(page.id);
    if (!editor || latest === null) return;
    editor.commands.setContent(latest.markdown, {
      contentType: "markdown",
      emitUpdate: true,
    });
    save.flush();
  };
  /**
   * Typing during the choice: the current version is kept, the draft goes, and the toast's
   * « Annuler » brings the draft and the choice back.
   */
  const abandonDraft = () => {
    const dropped = noteDraft(page.id);
    for (const id of imageIdsIn(dropped?.markdown ?? "")) {
      draftImages.current.add(id);
    }
    setConflict(false);
    dropNoteDraft(page.id);
    if (dropped === null) return;
    showToast({
      message: fr.notes.editor.draftDropped,
      action: {
        label: fr.toast.undo,
        onAction: () => {
          keepNoteDraft(page.id, dropped);
          setConflict(true);
        },
      },
    });
  };
  const abandonDraftRef = useRef(abandonDraft);
  abandonDraftRef.current = abandonDraft;

  /** « Garder la version actuelle »: the draft goes, nothing is written. */
  const keepCurrent = () => {
    setConflict(false);
    dropNoteDraft(page.id);
  };

  // Delete, duplicate, move: send first and wait for the core.
  useEffect(
    () =>
      registerNoteFlush(async () => {
        save.cancel();
        sendRef.current();
        await lastSave.current;
      }),
    [save],
  );

  // The app goes to the background (phone: another app, the screen off): send now.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState !== "hidden") return;
      save.cancel();
      sendRef.current();
    };
    const onLeave = () => {
      save.cancel();
      sendRef.current();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onLeave);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onLeave);
    };
  }, [save]);

  // Changed on another device (or by Claude): shown at once, even while the page has the
  // focus, so the user never types over a version they have not seen; the caret stays where
  // it was. Only a pending edit of the user wins (last writer wins, like a task's note).
  useEffect(() => {
    if (!editor || page.body === shownBody.current) return;
    if (dirty.current) {
      // A pending edit of the user wins (last writer wins)…
      if (!tooLongRef.current || !doc.current) return;
      // …but a draft too long to save never silently wins over a newer stored text: it
      // stays kept (with the text it was written over) and the user chooses.
      keepNoteDraft(page.id, {
        markdown: markdownOf(editor, doc.current),
        base: noteDraft(page.id)?.base ?? shownBody.current,
      });
      save.cancel();
      dirty.current = false;
      tooLongRef.current = false;
      setTooLong(false);
      conflictRef.current = true;
      setConflictState(true);
    }
    shownBody.current = page.body;
    const { from, to } = editor.state.selection;
    const focused = editor.isFocused;
    editor.commands.setContent(page.body, {
      contentType: "markdown",
      emitUpdate: false,
    });
    if (focused) {
      const end = editor.state.doc.content.size;
      editor.commands.setTextSelection({
        from: Math.min(from, end),
        to: Math.min(to, end),
      });
    }
    doc.current = editor.state.doc;
    imagesOf(editor.state.doc, seenImages.current);
    imageCount.current = imageCounts(editor.state.doc);
    saved.current = editor.getMarkdown();
  }, [editor, page.body, page.id, save]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  addImagesRef.current = (source, at) => {
    const ed = editor;
    if (!ed) return;
    const where = at ?? ed.state.selection.to;
    setAdding(true);
    void addImagesToPage(page.id, source)
      .then((ids) => {
        // The page closed meanwhile: nothing shows them, they go.
        if (!alive.current || ed.isDestroyed) {
          pruneImages(page.id, ids);
          return;
        }
        insertNoteImages(ed, ids, where);
      })
      .finally(() => {
        if (alive.current) setAdding(false);
      });
  };

  adoptRef.current = (ids) => {
    const ed = editor;
    if (!ed) return;
    void (async () => {
      let own: Set<string>;
      try {
        own = new Set(
          (await commands.listNoteAttachments(page.id)).map((a) => a.id),
        );
      } catch {
        return;
      }
      for (const id of ids) {
        if (own.has(id)) continue;
        let copy: { id: string };
        try {
          copy = await commands.copyNoteAttachment({ id, toPageId: page.id });
        } catch (error) {
          // Not on this device (or gone): the page keeps the id, shown by it.
          console.error(errorMessage(error), error);
          continue;
        }
        if (!alive.current || ed.isDestroyed) {
          pruneImages(page.id, [copy.id]);
          continue;
        }
        replaceImageId(ed, id, copy.id);
      }
    })();
  };

  /** Files dropped from the browser on the page (the site, the phone, `pnpm dev`). */
  const onDragOver = (e: React.DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0 || !editor) return;
    e.preventDefault();
    e.stopPropagation();
    const at = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
    addImagesRef.current({ files }, at?.pos);
  };

  // What this page shows, saved or not: the cleanup never takes it.
  useEffect(
    () =>
      registerShownImages(() => {
        const now = new Set<string>();
        if (doc.current) imagesOf(doc.current, now);
        return now;
      }),
    [],
  );

  // The Finder's files dropped on this page's text (Mac).
  useEffect(() => {
    if (!editor) return;
    return registerNoteDrop(page.id, (paths, x, y) => {
      const at = editor.view.posAtCoords({ left: x, top: y });
      addImagesRef.current({ paths }, at?.pos);
    });
  }, [editor, page.id]);

  /** The toolbar's image button: the phone's photos and camera, the Mac's picker. */
  const pickImages = () => {
    if (webFiles()) {
      picker.current?.click();
      return;
    }
    void run(commands.pickFiles(fr.notes.image.pickTitle)).then((paths) => {
      if (paths && paths.length > 0) addImagesRef.current({ paths });
    });
  };

  if (!editor) return null;
  return (
    <div
      className="flex min-w-0 flex-col"
      data-note-drop={page.id}
      // `guardStrayDrops` lets files land here.
      data-drop-zone
      onDragOverCapture={onDragOver}
      onDropCapture={onDrop}
    >
      {!phone && (
        <Toolbar
          editor={editor}
          onImage={pickImages}
          notice={tooLong ? <TooLongNotice /> : null}
        />
      )}
      <input
        ref={picker}
        type="file"
        accept="image/*"
        multiple
        hidden
        tabIndex={-1}
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          e.currentTarget.value = "";
          if (files.length > 0) addImagesRef.current({ files });
        }}
      />
      <p
        role="status"
        className={adding ? "mb-2 text-[13px] text-text-3" : "sr-only"}
      >
        {adding ? fr.notes.image.adding : ""}
      </p>
      {phone && tooLong && (
        // Also in the bar above the keyboard; here for a page read with the keyboard closed.
        <p className="mb-3 rounded-md border border-[var(--due-overdue)] px-3 py-2 text-[14px] text-[var(--due-overdue)]">
          {fr.notes.editor.tooLong}
        </p>
      )}
      {conflict && (
        <div
          role="alert"
          className="mb-3 flex flex-col gap-2 rounded-md border border-[var(--due-overdue)] px-3 py-2.5 text-[14px] text-text"
        >
          <p>{fr.notes.editor.draftConflict}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              className={phone ? "min-h-11" : undefined}
              onClick={resumeDraft}
            >
              {fr.notes.editor.draftResume}
            </Button>
            <Button
              className={phone ? "min-h-11" : undefined}
              onClick={keepCurrent}
            >
              {fr.notes.editor.draftKeepCurrent}
            </Button>
          </div>
        </div>
      )}
      <EditorContent editor={editor} />
      {phone && (
        <MobileToolbar
          editor={editor}
          onImage={pickImages}
          notice={tooLong ? <TooLongNotice /> : null}
        />
      )}
    </div>
  );
}
