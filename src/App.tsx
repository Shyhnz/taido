import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PanelLeftOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { IconButton } from "./components/Button";
import { DialogHost } from "./components/Dialog";
import { LiveRegion } from "./components/LiveRegion";
import { MenuHost } from "./components/Menu";
import { ToastHost } from "./components/Toast";
import { AskPanel } from "./features/ask/AskPanel";
import { AppDialogs } from "./features/dialogs/AppDialogs";
import { DndProvider } from "./features/dnd/DndProvider";
import {
  FirstLaunch,
  isFirstLaunch,
} from "./features/first-launch/FirstLaunch";
import { useShortcuts } from "./features/keyboard/useShortcuts";
import { useNotifications } from "./features/notifications/useNotifications";
import { Sidebar, withShortcut } from "./features/sidebar/Sidebar";
import { TaskPanel } from "./features/task-panel/TaskPanel";
import { TerminalsHost } from "./features/terminals/TerminalsHost";
import { useTutorialAutoStart } from "./features/tutorial/TutorialDriver";
import { TutorialLayer } from "./features/tutorial/TutorialLayer";
import { ViewScreen } from "./features/views/ViewScreen";
import { fr } from "./i18n/fr";
import { useDay } from "./lib/clock";
import {
  createQueryClient,
  subscribeToCoreEvents,
  useHasNoProjectTasks,
  useSettings,
  useSubjects,
  watchDayChange,
} from "./lib/queries";
import { useApplyTheme } from "./lib/theme";
import { useUi } from "./stores/ui";

function Shell() {
  const openTaskId = useUi((s) => s.openTaskId);
  const askSubjectId = useUi((s) => s.askSubjectId);
  const focusMode = useUi((s) => s.focusMode) && openTaskId !== null;
  const setListFocused = useUi((s) => s.setListFocused);
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  // Taido V2.2: the kanban takes the whole width of the window, so do the calendar of
  // « Prochainement » (2026-10-12) and a project's notebook.
  const boardShown = useUi(
    (s) =>
      s.view.kind === "portfolio" ||
      (s.view.kind === "upcoming" && s.upcomingMode === "calendar") ||
      (s.view.kind === "subject" && s.projectTab !== "list") ||
      // « Sans projet » has no notebook: a remembered Notes tab shows its list.
      (s.view.kind === "inbox" &&
        s.projectTab !== "list" &&
        s.projectTab !== "notes"),
  );
  // Re-renders the whole tree at midnight: relative dates are computed at render (bug #13).
  useDay((s) => s.day);
  const settings = useSettings().data;
  const theme = settings?.theme ?? "system";
  const color = settings?.colorTheme ?? "taido";
  const firstLaunch = isFirstLaunch(useSubjects().data, useHasNoProjectTasks());
  useApplyTheme(theme, color);
  useShortcuts();
  useNotifications();
  useTutorialAutoStart();

  return (
    <div className="flex h-full min-w-0 bg-bg text-text">
      {/* Focus mode hides the sidebar and the list, without unmounting them:
          leaving it gives back the same scroll position and selection. */}
      <DndProvider>
        <div hidden={focusMode || !sidebarOpen} className="contents">
          <Sidebar />
        </div>
        <main
          hidden={focusMode}
          className="relative min-w-0 flex-1 overflow-y-auto"
          onFocusCapture={() => setListFocused(true)}
          onBlurCapture={() => setListFocused(false)}
        >
          {!sidebarOpen && (
            <IconButton
              label={fr.sidebar.expand}
              title={withShortcut(fr.sidebar.expand, "M")}
              className="absolute top-3 left-3 z-10"
              onClick={() => useUi.getState().toggleSidebar(true)}
            >
              <PanelLeftOpen size={16} aria-hidden />
            </IconButton>
          )}
          <div
            className={
              openTaskId || askSubjectId || boardShown
                ? "px-8"
                : "mx-auto w-full max-w-[800px] px-10"
            }
          >
            {firstLaunch ? <FirstLaunch /> : <ViewScreen />}
          </div>
        </main>
      </DndProvider>
      {openTaskId && <TaskPanel key={openTaskId} taskId={openTaskId} />}
      {/* « Demander au projet »: hidden, not closed, while a task (a source) is open. */}
      {askSubjectId && !focusMode && (
        <div hidden={openTaskId !== null} className="contents">
          <AskPanel key={askSubjectId} subjectId={askSubjectId} />
        </div>
      )}
      <TerminalsHost />
      <AppDialogs />
      <DialogHost />
      <MenuHost />
      <TutorialLayer />
      <ToastHost />
      <LiveRegion />
    </div>
  );
}

export default function App({ client }: { client?: QueryClient }) {
  const [queryClient] = useState(() => client ?? createQueryClient());
  useEffect(() => subscribeToCoreEvents(queryClient), [queryClient]);
  useEffect(() => watchDayChange(queryClient), [queryClient]);
  return (
    <QueryClientProvider client={queryClient}>
      <Shell />
    </QueryClientProvider>
  );
}
