import { useEffect } from "react";
import type { NotificationOpened } from "../../bindings";
import { commands, errorMessage, events } from "../../lib/ipc";
import { useUi } from "../../stores/ui";
import { showTab } from "../terminals/actions";

/**
 * The core's notifications: it learns which task is open (no notification for it
 * while the window has the focus, and its notification leaves the notification center), and
 * a click on a notification opens the task on the terminal of its session.
 */
export function useNotifications(): void {
  const openTaskId = useUi((s) => s.openTaskId);

  useEffect(() => {
    // In the background: a failure only means one notification too many.
    commands.setOpenTask(openTaskId).catch((error: unknown) => {
      console.error(errorMessage(error), error);
    });
  }, [openTaskId]);

  useEffect(() => {
    const unlisten = events.notificationOpened.listen(({ payload }) =>
      openFromNotification(payload),
    );
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);
}

/** The terminal of the session when known (a closed one falls back to the last tab). */
export function openFromNotification({
  taskId,
  terminalId,
}: NotificationOpened): void {
  if (terminalId) showTab(taskId, terminalId);
  else useUi.getState().openTask(taskId);
}
