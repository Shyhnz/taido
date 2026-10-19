/**
 * One page of the project notebook: its title, where it
 * sits and when it changed, its text in the editor (`editor/NoteEditor.tsx`), then
 * « Mentionné dans » (pages and tasks that link it). Large screen: beside the list; phone: the
 * full-screen sheet (`NotePageSheet`), which never opens the keyboard by itself.
 */

import { ChevronLeft, CircleCheck, Ellipsis, FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { NotebookView, NoteLinkRef, NotePage } from "../../bindings";
import { Button } from "../../components/Button";
import { openMenuAt } from "../../components/Menu";
import { showToast } from "../../components/Toast";
import { t } from "../../i18n";
import { formatShortDate } from "../../lib/dates";
import { commands, isNotFound } from "../../lib/ipc";
import { useSubjects } from "../../lib/queries";
import { run } from "../../lib/run";
import { IS_MOBILE } from "../../lib/target";
import { useUi } from "../../stores/ui";
import { openLinkedPage } from "./editor/LinkChip";
import { NoteEditor } from "./editor/NoteEditor";
import { noteDraft } from "./editor/pendingEdits";
import { pageMenuItems, useFreshNotePage, wasDeletedHere } from "./noteActions";
import { placeOf, useNoteBacklinks, useNotebook, useNotePage } from "./queries";

/** Name of the block a page sits in, for its subtitle; `null` outside any group. */
function placeName(
  page: NotePage,
  nb: NotebookView | undefined,
): string | null {
  if (page.groupId !== null) {
    return (
      nb?.groups.find((g) => g.group.id === page.groupId)?.group.name ?? null
    );
  }
  return page.kind === "summary" ? t.notes.summaries : null;
}

/** Longest title (bytes of UTF-8, like the core and the sync). */
const MAX_TITLE_BYTES = 500;

/** `text` cut on a character so it fits `MAX_TITLE_BYTES` (accents take 2 bytes or more). */
export function fitTitle(text: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= MAX_TITLE_BYTES) return text;
  let bytes = 0;
  let out = "";
  for (const ch of text) {
    bytes += encoder.encode(ch).length;
    if (bytes > MAX_TITLE_BYTES) break;
    out += ch;
  }
  return out;
}

/** Puts the caret at the start of the page's text (Enter in the title). */
function focusText(from: HTMLElement): void {
  const text = from.closest("section")?.querySelector<
    HTMLElement & {
      editor?: { commands: { focus: (at: "start") => boolean } };
    }
  >(".note-editor");
  text?.editor?.commands.focus("start");
}

/**
 * The page's title, edited in place: Enter saves it and goes on with the text, leaving the
 * field saves, Escape restores.
 */
function TitleField({ page, sheet }: { page: NotePage; sheet: boolean }) {
  const [value, setValue] = useState(page.title);
  const ref = useRef<HTMLInputElement>(null);
  const fresh = useFreshNotePage((s) => s.id === page.id);

  // A title changed elsewhere (another device, the list) shows unless the field is in use.
  useEffect(() => {
    if (document.activeElement !== ref.current) setValue(page.title);
  }, [page.title]);

  // A new page: its title is selected, ready to type (the keyboard opens on the phone).
  useEffect(() => {
    if (!fresh) return;
    ref.current?.focus();
    ref.current?.select();
    useFreshNotePage.setState({ id: null });
  }, [fresh]);

  const save = () => {
    const title = value.trim();
    if (title.length === 0) {
      setValue(page.title);
      return;
    }
    if (title === page.title) return;
    void run(
      commands.updateNotePage({ id: page.id, title, body: null }),
      t.notes.errors.updatePage,
    );
  };

  return (
    <input
      ref={ref}
      aria-label={t.notes.titleLabel}
      placeholder={t.notes.untitled}
      value={value}
      onChange={(e) => setValue(fitTitle(e.target.value))}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          const field = e.currentTarget;
          field.blur();
          focusText(field);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setValue(page.title);
          requestAnimationFrame(() => ref.current?.blur());
        }
      }}
      className={`w-full min-w-0 bg-transparent font-bold text-text outline-none placeholder:text-text-3 ${
        sheet ? "text-[22px] leading-8" : "text-[26px] leading-9"
      }`}
    />
  );
}

/**
 * One page: title, where it sits, when it changed, its text. `onGone`: the page no longer
 * exists (deleted on another device: said in a toast).
 */
export function NotePagePane({
  subjectId,
  pageId,
  sheet,
  onGone,
}: {
  subjectId: string;
  pageId: string;
  /** Phone: inside the full-screen sheet (bigger text, no breadcrumb). */
  sheet: boolean;
  onGone?: () => void;
}) {
  const { data: page, error, isFetching, refetch } = useNotePage(pageId);
  // The page as read once this pane opened: a kept draft is compared with that, not with a
  // cached copy. Later refreshes never hide the editor (focus, caret and history stay).
  const [readFor, setReadFor] = useState<string | null>(null);
  useEffect(() => {
    if (!isFetching) setReadFor(pageId);
  }, [isFetching, pageId]);
  const nb = useNotebook(subjectId).data;
  const subjectName =
    useSubjects().data?.find((s) => s.id === subjectId)?.name ?? "";
  const gone = error !== null && isNotFound(error);

  useEffect(() => {
    if (!gone) return;
    // The large screen's list says it itself (`NotesView`); the sheet says it here.
    if (onGone && !wasDeletedHere(pageId)) {
      showToast({ message: t.notes.deletedElsewhere });
    }
    onGone?.();
  }, [gone, pageId, onGone]);

  if (error && !gone) {
    return (
      <div role="alert" className="flex flex-col items-start gap-3 py-6">
        <p className="text-[14px] text-text-2">{t.notes.pageError}</p>
        <Button
          className={sheet ? "min-h-11" : undefined}
          onClick={() => void refetch()}
        >
          {t.list.retry}
        </Button>
      </div>
    );
  }
  if (!page) return gone ? null : <PageSkeleton sheet={sheet} />;
  const where = placeName(page, nb);
  const modified = formatShortDate(new Date(page.updatedAt));

  return (
    <section
      aria-label={t.notes.pageLabel}
      className={`flex min-w-0 flex-col ${sheet ? "pt-4" : "max-w-[680px]"}`}
    >
      {!sheet && (
        <p className="mb-1 truncate text-[12.5px] text-text-3">
          {where ? `${subjectName} › ${where}` : subjectName}
        </p>
      )}
      {/* The size sits on the wrapper too: the web app's inputs take max(16 px, 1em). */}
      <div className={sheet ? "text-[22px]" : "text-[26px]"}>
        <TitleField key={page.id} page={page} sheet={sheet} />
      </div>
      <p
        className={`mt-1 text-text-3 ${sheet ? "text-[14px]" : "text-[12.5px]"}`}
      >
        {sheet && where ? `${where} · ${modified}` : t.notes.modified(modified)}
      </p>
      <div className="mt-4">
        {/* A kept draft is compared with the stored text: wait for the latest one. */}
        {readFor !== pageId && isFetching && noteDraft(page.id) !== null ? (
          <p role="status" className="text-[14px] text-text-3">
            {t.common.loading}
          </p>
        ) : (
          <NoteEditor
            key={page.id}
            page={page}
            subjectId={subjectId}
            phone={sheet}
          />
        )}
      </div>
      <MentionedIn pageId={page.id} />
    </section>
  );
}

/** While the page is read: its title and a few lines, where they will be. */
function PageSkeleton({ sheet }: { sheet: boolean }) {
  return (
    <div
      role="status"
      aria-label={t.common.loading}
      className={`flex flex-col gap-3 ${sheet ? "pt-5" : "max-w-[680px] pt-5"}`}
    >
      <div className="h-7 w-2/3 rounded-md bg-hover" />
      <div className="h-3.5 w-24 rounded bg-hover" />
      <div className="mt-3 h-3.5 w-full rounded bg-hover" />
      <div className="h-3.5 w-11/12 rounded bg-hover" />
      <div className="h-3.5 w-4/5 rounded bg-hover" />
    </div>
  );
}

/** One line of « Mentionné dans »: the page or task, which opens on a click. */
export function MentionLink({
  item,
  onOpen,
}: {
  item: NoteLinkRef;
  /** Called after the page or task opened. */
  onOpen?: () => void;
}) {
  const Icon = item.kind === "page" ? FileText : CircleCheck;
  const kind = item.kind === "page" ? t.notes.mentionPage : t.notes.mentionTask;
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          if (item.kind === "task") useUi.getState().openTask(item.id);
          else void openLinkedPage(item.id).then(onOpen);
        }}
        className={`flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-text hover:bg-hover ${
          IS_MOBILE ? "min-h-11 text-[15px]" : "min-h-9 text-[14px]"
        }`}
      >
        <Icon size={15} aria-hidden className="shrink-0 text-text-3" />
        <span className="shrink-0 text-text-3">{kind} :</span>
        <span className="min-w-0 truncate">{item.title}</span>
      </button>
    </li>
  );
}

/** Under the page: the pages and tasks that link it; nothing when none does. */
function MentionedIn({ pageId }: { pageId: string }) {
  const items = useNoteBacklinks(pageId).data ?? [];
  if (items.length === 0) return null;
  return (
    <section
      aria-labelledby={`mentions-${pageId}`}
      className="mt-10 border-t border-border pt-3"
    >
      <h2
        id={`mentions-${pageId}`}
        className="mb-1 text-[12px] font-semibold tracking-wide text-text-3 uppercase"
      >
        {t.notes.mentionedIn}
      </h2>
      <ul className="flex flex-col">
        {items.map((item) => (
          <MentionLink key={`${item.kind}:${item.id}`} item={item} />
        ))}
      </ul>
    </section>
  );
}

/** Phone: the page as a full-screen sheet, « ‹ Notes » on top (Android's back closes it too). */
export function NotePageSheet({
  subjectId,
  pageId,
}: {
  subjectId: string;
  pageId: string;
}) {
  const close = useUi((s) => s.closeNotePageSheet);
  const page = useNotePage(pageId).data;
  const groups = useNotebook(subjectId).data?.groups.map((g) => g.group) ?? [];
  const back = useRef<HTMLButtonElement>(null);

  // Opening: the focus goes to « ‹ Notes », not to a field (no keyboard on a page to read).
  // Closing: back on the page's row in the list, once the list shows again.
  useEffect(() => {
    back.current?.focus();
    return () => {
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>(`[data-note-row="${CSS.escape(pageId)}"]`)
          ?.focus(),
      );
    };
  }, [pageId]);
  const title = page?.title ?? "";
  const menuLabel = t.notes.pageMenu(title);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="mobile-sheet fixed inset-0 z-[35] flex flex-col bg-bg"
    >
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-1">
        <button
          ref={back}
          type="button"
          aria-label={t.notes.backLabel}
          onClick={close}
          className="inline-flex h-11 items-center gap-0.5 rounded-md pr-3 pl-1 text-[16px] font-medium text-accent"
        >
          <ChevronLeft size={22} aria-hidden />
          {t.notes.back}
        </button>
        <span className="flex-1" />
        {page && (
          <button
            type="button"
            aria-label={menuLabel}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              openMenuAt(
                e.currentTarget,
                pageMenuItems(
                  subjectId,
                  {
                    id: page.id,
                    title: page.title,
                    kind: page.kind,
                    place: placeOf(page),
                  },
                  groups,
                  { x: rect.right, y: rect.bottom + 4 },
                ),
                menuLabel,
                true,
              );
            }}
            className="inline-flex h-11 w-11 items-center justify-center rounded-md text-text-2"
          >
            <Ellipsis size={20} aria-hidden />
          </button>
        )}
      </header>
      {/* Room under the text for the keyboard and the bar above it (its measured height). */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(var(--note-keyboard,0px)+var(--note-toolbar,0px)+4rem)]">
        <NotePagePane
          subjectId={subjectId}
          pageId={pageId}
          sheet
          onGone={close}
        />
      </div>
    </div>
  );
}
