//! Windows notifications: Tauri's notification plugin 2.7.0 (WinRT toasts through
//! notify-rust), without sound. A click on a toast still on screen brings the app forward on
//! the task; once a toast has moved to the Action Center the plugin reports no click. Toasts
//! cannot be withdrawn through the plugin: `withdraw` does nothing.

use std::sync::Arc;

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use super::{Banner, Notice};

/// Called with the task id of a clicked notification.
pub type ClickHook = Arc<dyn Fn(String) + Send + Sync>;

/// Key of the task id in a notification's extra payload.
const TASK_KEY: &str = "taskId";

pub struct WinBanner {
    app: AppHandle,
}

/// The banner, with `on_click` called for a click on one of its toasts.
pub fn banner(app: &AppHandle, on_click: ClickHook) -> WinBanner {
    let registered = app.notification().on_action(move |performed| {
        if performed.action_id() != "tap" {
            return;
        }
        let task_id = performed
            .notification()
            .and_then(|n| n.extra().get(TASK_KEY))
            .and_then(|v| v.as_str());
        if let Some(task_id) = task_id {
            on_click(task_id.to_string());
        }
    });
    if let Err(e) = registered {
        log::warn!("notification clicks are not reported: {e}");
    }
    WinBanner { app: app.clone() }
}

impl Banner for WinBanner {
    fn show(&self, notice: &Notice) {
        let shown = self
            .app
            .notification()
            .builder()
            .title(&notice.title)
            .body(&notice.body)
            .extra(TASK_KEY, &notice.task_id)
            .show();
        if let Err(e) = shown {
            log::warn!("cannot show a notification: {e}");
        }
    }

    fn withdraw(&self, _task_id: &str) {}
}
