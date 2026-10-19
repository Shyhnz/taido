/**
 * Adding images to a page (plan task 8): pasted, dropped or picked files become attachments
 * of the page, then `![[file:<id>|100%]]` where they landed. A page holds only images: other
 * files are left out with « Seules les images vont dans une page ». The size limit is the
 * attachments': the server's per-file limit, said plainly.
 */

import type { Editor } from "@tiptap/core";
import { showError } from "../../../components/Toast";
import { t } from "../../../i18n";
import { commands, errorMessage, webFiles } from "../../../lib/ipc";
import { run } from "../../../lib/run";
import { WebFileError } from "../../../lib/web-files";
import { pastedName, toBase64 } from "../../links/AttachmentsSection";
import { imageFileName, pageImageRefusal } from "./noteImage";

/** What is being added: files from the browser, or paths (the Mac's Finder, its picker). */
export type ImageSource = { files: File[] } | { paths: string[] };

const nameOf = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * Inserts the images at `at` (the selection when absent), each as its own paragraph: in an
 * empty line it takes the line, otherwise it goes right after the line. The page's text is
 * never focused (the phone's keyboard stays closed).
 */
export function insertNoteImages(
  editor: Editor,
  ids: string[],
  at?: number,
): void {
  if (ids.length === 0 || editor.isDestroyed) return;
  const { doc } = editor.state;
  const pos = Math.max(
    0,
    Math.min(at ?? editor.state.selection.to, doc.content.size),
  );
  const paragraphs = ids.map((id) => ({
    type: "paragraph",
    content: [{ type: "noteImage", attrs: { id, width: 100, raw: null } }],
  }));
  const $pos = doc.resolve(pos);
  if ($pos.depth === 0) {
    editor.chain().insertContentAt(pos, paragraphs).run();
    return;
  }
  const block = $pos.parent;
  if (block.isTextblock && block.content.size === 0) {
    editor
      .chain()
      .insertContentAt({ from: $pos.before(), to: $pos.after() }, paragraphs)
      .run();
    return;
  }
  editor.chain().insertContentAt($pos.after(), paragraphs).run();
}

/** The images a page takes among the files; says why the others are left out. */
function onlyImages(source: ImageSource): ImageSource | null {
  const refusals: ("format" | "other" | null)[] =
    "files" in source
      ? source.files.map((f) => pageImageRefusal(f.name, f.type))
      : source.paths.map((p) => pageImageRefusal(nameOf(p)));
  if (refusals.includes("format")) showError(t.notes.image.unsupportedFormat);
  if (refusals.includes("other")) showError(t.notes.image.onlyImages);
  const kept: ImageSource =
    "files" in source
      ? { files: source.files.filter((_, i) => refusals[i] === null) }
      : { paths: source.paths.filter((_, i) => refusals[i] === null) };
  const count = "files" in kept ? kept.files.length : kept.paths.length;
  return count > 0 ? kept : null;
}

/** Adds the images to the page; their new attachment ids, in order (none on failure). */
export async function addImagesToPage(
  pageId: string,
  source: ImageSource,
): Promise<string[]> {
  const kept = onlyImages(source);
  if (!kept) return [];
  if ("paths" in kept) {
    const added = await run(
      commands.addNoteAttachments({ notePageId: pageId, paths: kept.paths }),
      t.notes.image.addError,
    );
    return added?.map((a) => a.id) ?? [];
  }
  const files = webFiles();
  if (files) {
    try {
      const named = kept.files.map((f) => {
        const name = imageFileName(pastedName(f), f.type);
        return name === f.name ? f : new File([f], name, { type: f.type });
      });
      const { ids } = await files.addToPage(pageId, named);
      return ids;
    } catch (error) {
      console.error(errorMessage(error), error);
      showError(
        error instanceof WebFileError
          ? t.attachments.web.error[error.kind]
          : t.notes.image.addError,
      );
      return [];
    }
  }
  const ids: string[] = [];
  for (const file of kept.files) {
    const added = await run(
      commands.addNoteAttachmentData({
        notePageId: pageId,
        name: imageFileName(pastedName(file), file.type),
        base64: await toBase64(file),
      }),
      t.notes.image.addError,
    );
    if (added) ids.push(added.id);
  }
  return ids;
}
