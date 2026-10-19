/**
 * The phone's layout (docs/SYNC.md § 6.4), composed of the desktop components: a top bar
 * (menu, view title, sync button), the sidebar (open by default, foldable, remembered: a
 * left drawer on a phone, a column on a wide screen), the list full width, the
 * task panel as a full-screen sheet, a floating « + » for the quick add, and the banners
 * (storage error, deletions held, offline, not linked, update ready).
 */

import { Menu, PanelLeftOpen, Plus } from "lucide-react";
import { type ReactNode, useEffect, useRef, useSyncExternalStore } from "react";
import { IconButton } from "../components/Button";
import { DialogHost } from "../components/Dialog";
import { LiveRegion } from "../components/LiveRegion";
import { MenuHost } from "../components/Menu";
import { ToastHost } from "../components/Toast";
import { AppDialogs } from "../features/dialogs/AppDialogs";
import { DndProvider } from "../features/dnd/DndProvider";
import {
  FirstLaunch,
  isFirstLaunch,
} from "../features/first-launch/FirstLaunch";
import { NotePageSheet } from "../features/notes/NotePage";
import { NewNotePageFab } from "../features/notes/NotesView";
import { Sidebar } from "../features/sidebar/Sidebar";
import { TaskPanel } from "../features/task-panel/TaskPanel";
import { openAddTaskForView } from "../features/views/addTarget";
import { ViewScreen } from "../features/views/ViewScreen";
import { t } from "../i18n";
import { useLanguageSync } from "../i18n/useLanguageSync";
import { useDay } from "../lib/clock";
import { useHasNoProjectTasks, useSettings, useSubjects } from "../lib/queries";
import { useMediaQuery } from "../lib/screen";
import { useApplyTheme } from "../lib/theme";
import { useUi } from "../stores/ui";
import type { MobileBackend } from "./backend";
import { applyUpdate, useSwUpdate } from "./swUpdate";
import { SyncButton, useSyncStatus } from "./sync-ui";
import { useBackCloses } from "./useBackCloses";

/** Width from which the sidebar is a column beside the list instead of a drawer. */
const WIDE_QUERY = "(min-width: 768px)";

/** True on a wide screen (a computer's browser, a tablet). */
function useWide(): boolean {
  return useMediaQuery(WIDE_QUERY);
}

function useViewTitle(): string {
  const view = useUi((s) => s.view);
  const subjects = useSubjects().data;
  switch (view.kind) {
    case "today":
      return t.sidebar.today;
    case "upcoming":
      return t.upcoming.title;
    case "all":
      return t.all.title;
    case "inbox":
      return t.sidebar.noProject;
    case "subject":
      return subjects?.find((s) => s.id === view.subjectId)?.name ?? "";
    case "portfolio":
      return t.portfolio.title;
  }
}

function Banner({
  children,
  actions,
  tone = "info",
}: {
  children: ReactNode;
  actions?: ReactNode;
  tone?: "info" | "alert";
}) {
  return (
    <div
      role={tone === "alert" ? "alert" : "status"}
      className="mobile-banner flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-aside px-4 py-2.5 text-[14px] text-text"
    >
      <p className="min-w-0 flex-1">{children}</p>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  );
}

const bannerButton =
  "h-11 rounded-md border border-border bg-bg px-3 text-[14px] font-medium";

function Banners({ backend }: { backend: MobileBackend }) {
  const status = useSyncStatus().data;
  const waiting = useSwUpdate((s) => s.waiting);
  const openDialog = useUi((s) => s.openDialog);
  const held = useSyncExternalStore(
    backend.subscribeHeld,
    () => backend.heldDeletions.size,
  );
  return (
    <>
      {backend.storageBroken && (
        <Banner tone="alert">{t.mobile.storageError}</Banner>
      )}
      {held > 0 && (
        <Banner
          tone="alert"
          actions={
            <>
              <button
                type="button"
                className={bannerButton}
                onClick={() => backend.restoreHeldDeletions()}
              >
                {t.mobile.deletionsHeldRestore}
              </button>
              <button
                type="button"
                className={bannerButton}
                onClick={() => backend.confirmHeldDeletions()}
              >
                {t.mobile.deletionsHeldConfirm}
              </button>
            </>
          }
        >
          {t.mobile.deletionsHeld(held)}
        </Banner>
      )}
      {status?.state === "offline" && <Banner>{t.mobile.offlineBanner}</Banner>}
      {status?.state === "unlinked" && !backend.storageBroken && (
        <Banner
          actions={
            <button
              type="button"
              className={bannerButton}
              onClick={() => openDialog({ type: "settings", tab: "sync" })}
            >
              {t.sync.link}
            </button>
          }
        >
          {t.mobile.linkFirst}
        </Banner>
      )}
      {waiting && (
        <Banner
          actions={
            <button
              type="button"
              className={bannerButton}
              onClick={applyUpdate}
            >
              {t.mobile.reload}
            </button>
          }
        >
          {t.mobile.updateReady}
        </Banner>
      )}
    </>
  );
}

export function MobileShell({ backend }: { backend: MobileBackend }) {
  const openTaskId = useUi((s) => s.openTaskId);
  // The project whose « Notes » tab is shown (its « + » adds a page, not a task).
  const notesOf = useUi((s) =>
    s.view.kind === "subject" && s.projectTab === "notes"
      ? s.view.subjectId
      : null,
  );
  const notePageSheet = useUi((s) => s.notePageSheet);
  const dialog = useUi((s) => s.dialog);
  const newProjectRequest = useUi((s) => s.newProjectRequest);
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const wide = useWide();
  // On a phone the sidebar is a drawer over the list; on a wide screen, a column.
  const drawerOpen = sidebarOpen && !wide;
  // On a phone a notebook page is a full-screen sheet; on a wide screen, beside the list.
  const noteSheet =
    notesOf !== null && notePageSheet !== null && !wide && !openTaskId
      ? notePageSheet
      : null;
  useDay((s) => s.day);
  const settings = useSettings().data;
  useLanguageSync(settings);
  const theme = settings?.theme ?? "system";
  const color = settings?.colorTheme ?? "taido";
  const firstLaunch = isFirstLaunch(useSubjects().data, useHasNoProjectTasks());
  useApplyTheme(theme, color);
  const title = useViewTitle();

  // « Créer un projet » (first launch, ⌘⇧N): the project input lives in the sidebar, so the
  // sidebar opens to show it.
  const seenProjectRequest = useRef(newProjectRequest);
  useEffect(() => {
    if (newProjectRequest === seenProjectRequest.current) return;
    seenProjectRequest.current = newProjectRequest;
    toggleSidebar(true);
  }, [newProjectRequest, toggleSidebar]);

  // The Android back button closes the dialog, then the task or note page sheet, then the
  // drawer.
  const depth =
    (dialog !== null ? 1 : 0) +
    (openTaskId !== null ? 1 : 0) +
    (noteSheet !== null ? 1 : 0) +
    (drawerOpen ? 1 : 0);
  useBackCloses(depth, () => {
    const ui = useUi.getState();
    if (ui.dialog !== null) ui.closeDialog();
    else if (ui.openTaskId !== null) ui.openTask(null);
    else if (ui.notePageSheet !== null) ui.closeNotePageSheet();
    else ui.toggleSidebar(false);
  });

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") toggleSidebar(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen, toggleSidebar]);

  return (
    <div className="mobile flex h-full min-w-0 flex-col bg-bg text-text">
      <DndProvider>
        {/* A wide screen has no top bar: the sidebar holds the title, sync and fold buttons. */}
        {!wide && (
          <header className="mobile-topbar flex h-14 shrink-0 items-center gap-1 border-b border-border px-1">
            <button
              type="button"
              aria-label={t.mobile.menu}
              aria-expanded={sidebarOpen}
              onClick={() => toggleSidebar()}
              className="inline-flex h-11 w-11 items-center justify-center rounded-md text-text-2"
            >
              <Menu size={20} aria-hidden />
            </button>
            <span className="min-w-0 flex-1 truncate text-[16px] font-semibold">
              {title}
            </span>
            <SyncButton variant="topbar" />
          </header>
        )}
        <div className="flex min-h-0 flex-1">
          {wide && sidebarOpen && <Sidebar />}
          <div className="flex min-w-0 flex-1 flex-col">
            <Banners backend={backend} />
            <main
              hidden={openTaskId !== null || noteSheet !== null}
              className="mobile-main relative min-h-0 flex-1 overflow-y-auto px-4"
            >
              {wide && !sidebarOpen && (
                <IconButton
                  label={t.sidebar.expand}
                  className="absolute top-3 left-3 z-10"
                  onClick={() => toggleSidebar(true)}
                >
                  <PanelLeftOpen size={16} aria-hidden />
                </IconButton>
              )}
              {firstLaunch ? <FirstLaunch /> : <ViewScreen />}
            </main>
          </div>
        </div>
        {!openTaskId && noteSheet === null && notesOf !== null && (
          <NewNotePageFab subjectId={notesOf} />
        )}
        {!openTaskId && notesOf === null && (
          <button
            type="button"
            aria-label={t.sidebar.newTask}
            onClick={openAddTaskForView}
            className="mobile-fab fixed right-4 bottom-4 z-20 inline-flex h-14 w-14 items-center justify-center rounded-full bg-accent text-on-accent shadow-pop"
          >
            <Plus size={26} aria-hidden />
          </button>
        )}
        {drawerOpen && (
          <div className="fixed inset-0 z-30 flex">
            <div
              role="dialog"
              aria-modal="true"
              aria-label={t.sidebar.navLabel}
              className="mobile-drawer relative h-full max-w-[85vw] shadow-pop"
            >
              <Sidebar />
            </div>
            <button
              type="button"
              aria-label={t.mobile.closeMenu}
              onClick={() => toggleSidebar(false)}
              className="h-full flex-1 bg-overlay"
            />
          </div>
        )}
        {notesOf !== null && noteSheet !== null && (
          <NotePageSheet
            key={noteSheet}
            subjectId={notesOf}
            pageId={noteSheet}
          />
        )}
        {openTaskId && (
          <div className="mobile-sheet fixed inset-0 z-[35] flex bg-bg">
            <TaskPanel key={openTaskId} taskId={openTaskId} />
          </div>
        )}
      </DndProvider>
      <AppDialogs />
      <DialogHost />
      <MenuHost />
      <ToastHost />
      <LiveRegion />
    </div>
  );
}
