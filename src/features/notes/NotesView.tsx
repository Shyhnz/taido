/**
 * The « Notes » tab of a project. Large screen: the page list
 * (260 px) and the open page beside it, the last one opened in this project or the first.
 * Phone: the list full width; a page opens as a full-screen sheet (`NotePageSheet`, mounted by
 * the phone's shell). The page itself is `NotePage.tsx`.
 */

import { Plus } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "../../components/Button";
import { showToast } from "../../components/Toast";
import { fr } from "../../i18n/fr";
import { features } from "../../lib/features";
import { noteFoldKey, useUi } from "../../stores/ui";
import { NoteList } from "./NoteList";
import { NotePagePane } from "./NotePage";
import { createNotePage, wasDeletedHere } from "./noteActions";
import { notePages, useNotebook, useNotesWide } from "./queries";

/**
 * The phone's floating « + » on the Notes tab: a new page in the topmost unfolded group
 * (outside any group when there is none), opened with its title ready to type.
 */
export function NewNotePageFab({ subjectId }: { subjectId: string }) {
  const nb = useNotebook(subjectId).data;
  const folded = useUi((s) => s.foldedNoteGroups);
  const wide = useNotesWide();
  const onClick = () => {
    const group = nb?.groups.find(
      (g) => folded[noteFoldKey(subjectId, { group: g.group.id })] !== true,
    );
    void createNotePage(subjectId, group?.group.id ?? null, !wide);
  };
  return (
    <button
      type="button"
      aria-label={fr.notes.newPage}
      onClick={onClick}
      className="mobile-fab fixed right-4 bottom-4 z-20 inline-flex h-14 w-14 items-center justify-center rounded-full bg-accent text-on-accent shadow-pop"
    >
      <Plus size={26} aria-hidden />
    </button>
  );
}

function EmptyNotebook({
  subjectId,
  wide,
}: {
  subjectId: string;
  wide: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 py-12 text-center">
      <p className="text-[15px] font-semibold">{fr.notes.emptyTitle}</p>
      <p className="max-w-[360px] text-[13.5px] text-text-2">
        {fr.notes.emptyText}
      </p>
      {/* Claude writes in the notebook from the Mac only. */}
      {features.terminals && (
        <p className="max-w-[360px] text-[13px] text-text-3">
          {fr.notes.emptyClaude}
        </p>
      )}
      {/* On the phone the floating « + » is the one way to add a page. */}
      {wide && (
        <Button
          variant="primary"
          className="mt-3"
          onClick={() => void createNotePage(subjectId, null, false)}
        >
          {fr.notes.newPage}
        </Button>
      )}
    </div>
  );
}

/** While the notebook is read: the list (and, on a large screen, the page beside it). */
function ListSkeleton({ wide }: { wide: boolean }) {
  const list = (
    <div className="flex flex-col gap-2 pt-1">
      <div className="h-8 w-full rounded-md bg-hover" />
      {[70, 55, 62].map((w) => (
        <div
          key={w}
          className="h-3 rounded bg-hover"
          style={{ width: `${w}%` }}
        />
      ))}
    </div>
  );
  return (
    <div role="status" aria-label={fr.common.loading}>
      {wide ? (
        <div className="flex items-start gap-10">
          <div className="w-[260px] shrink-0">{list}</div>
          <div className="flex max-w-[680px] min-w-0 flex-1 flex-col gap-3 pt-6">
            <div className="h-7 w-2/3 rounded-md bg-hover" />
            <div className="mt-3 h-3.5 w-full rounded bg-hover" />
            <div className="h-3.5 w-11/12 rounded bg-hover" />
          </div>
        </div>
      ) : (
        list
      )}
    </div>
  );
}

export function NotesView({ subjectId }: { subjectId: string }) {
  const { data: nb, error, refetch } = useNotebook(subjectId);
  const wide = useNotesWide();
  const remembered = useUi((s) => s.lastNotePage[subjectId] ?? null);
  const openNotePage = useUi((s) => s.openNotePage);
  const sheet = useUi((s) => s.notePageSheet);
  const closeSheet = useUi((s) => s.closeNotePageSheet);

  // A window widened past 768 px shows the page beside the list instead of the sheet.
  useEffect(() => {
    if (wide && sheet !== null) closeSheet();
  }, [wide, sheet, closeSheet]);

  const pages = nb ? notePages(nb) : [];
  const selectedId =
    remembered !== null && pages.some((p) => p.id === remembered)
      ? remembered
      : (pages[0]?.id ?? null);

  // The page shown vanished from the notebook without this window deleting it.
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!nb || !wide) return;
    const before = shown.current;
    if (
      before !== null &&
      before !== selectedId &&
      before === remembered &&
      !pages.some((p) => p.id === before) &&
      !wasDeletedHere(before)
    ) {
      showToast({ message: fr.notes.deletedElsewhere });
    }
    shown.current = selectedId;
  });

  if (error) {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 pt-16">
        <p className="text-[14px] text-text-2">{fr.notes.loadError}</p>
        <Button onClick={() => void refetch()}>{fr.list.retry}</Button>
      </div>
    );
  }
  if (!nb) return <ListSkeleton wide={wide} />;
  if (pages.length === 0 && nb.groups.length === 0) {
    return <EmptyNotebook subjectId={subjectId} wide={wide} />;
  }

  const list = (
    <NoteList
      subjectId={subjectId}
      notebook={nb}
      selectedId={wide ? selectedId : null}
      wide={wide}
      onOpen={(id) => openNotePage(subjectId, id, !wide)}
    />
  );
  if (!wide) return <div className="pb-24">{list}</div>;
  return (
    <div className="flex items-start gap-10 pb-16">
      <div className="sticky top-4 max-h-[calc(100vh-2rem)] w-[260px] shrink-0 overflow-y-auto">
        {list}
      </div>
      <div className="min-w-0 flex-1">
        {selectedId ? (
          <NotePagePane
            key={selectedId}
            subjectId={subjectId}
            pageId={selectedId}
            sheet={false}
          />
        ) : (
          // Groups but no page yet: the right side says what to do instead of staying blank.
          <div className="flex flex-col items-start gap-3 pt-6">
            <p className="text-[14px] text-text-2">{fr.notes.noPageOpen}</p>
            <Button
              variant="primary"
              onClick={() => void createNotePage(subjectId, null, false)}
            >
              {fr.notes.newPage}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
