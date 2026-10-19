/**
 * A `[[page:…]]` or `[[task:…]]` link shown as a chip: the
 * item's current title, not the copy in the Markdown; a page opens, a task opens its panel;
 * a link to something deleted is struck through and says « introuvable ».
 */

import {
  NodeViewWrapper,
  type ReactNodeViewProps,
  ReactNodeViewRenderer,
} from "@tiptap/react";
import { CircleCheck, FileText } from "lucide-react";
import { fr } from "../../../i18n/fr";
import { commands, isNotFound } from "../../../lib/ipc";
import { useTask } from "../../../lib/queries";
import { useUi } from "../../../stores/ui";
import { notesWideNow, useNotePage } from "../queries";
import { WikiLink, type WikiLinkKind } from "./wikiLink";

/** Opens a linked page in its project's notebook (the sheet on a phone). */
export async function openLinkedPage(id: string): Promise<void> {
  const page = await commands.getNotePage(id);
  const ui = useUi.getState();
  if (ui.view.kind !== "subject" || ui.view.subjectId !== page.subjectId) {
    ui.setView({ kind: "subject", subjectId: page.subjectId });
  }
  if (ui.projectTab !== "notes") useUi.getState().setProjectTab("notes");
  useUi.getState().openNotePage(page.subjectId, page.id, !notesWideNow());
}

function useLinked(kind: WikiLinkKind, id: string) {
  const page = useNotePage(id, kind === "page");
  const task = useTask(kind === "task" ? id : null);
  const q = kind === "page" ? page : task;
  return {
    title: q.data?.title,
    dead: q.error !== null && isNotFound(q.error),
  };
}

function Chip({ node, selected }: ReactNodeViewProps) {
  const kind = node.attrs.kind as WikiLinkKind;
  const id = String(node.attrs.id);
  const label = (node.attrs.label as string | null) ?? "";
  const { title, dead } = useLinked(kind, id);
  const shown = title ?? label;
  const Icon = kind === "page" ? FileText : CircleCheck;
  const look = `inline-flex max-w-full items-baseline gap-1 rounded px-1 align-baseline ${
    selected ? "ring-2 ring-accent" : ""
  }`;
  if (dead) {
    return (
      <NodeViewWrapper
        as="span"
        data-wiki-link=""
        className={`${look} bg-hover text-text-3 line-through`}
      >
        {fr.notes.editor.linkDead(label || id.slice(0, 8))}
      </NodeViewWrapper>
    );
  }
  return (
    <NodeViewWrapper
      as="span"
      data-wiki-link=""
      className={`${look} bg-accent/10 text-accent`}
    >
      <button
        type="button"
        aria-label={`${kind === "page" ? fr.notes.mentionPage : fr.notes.mentionTask} : ${shown}`}
        contentEditable={false}
        onClick={() => {
          if (kind === "task") useUi.getState().openTask(id);
          else void openLinkedPage(id);
        }}
        className="inline-flex min-w-0 cursor-pointer items-baseline gap-1 font-medium underline-offset-2 hover:underline"
      >
        <Icon size={13} aria-hidden className="shrink-0 self-center" />
        <span className="truncate">{shown}</span>
      </button>
    </NodeViewWrapper>
  );
}

/** `wikiLink` with its chip: the editor's version (the Markdown tests use the bare node). */
export const WikiLinkChip = WikiLink.extend({
  addNodeView() {
    return ReactNodeViewRenderer(Chip, { as: "span" });
  },
});
