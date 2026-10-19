//! macOS notifications through the UserNotifications framework: unlike
//! tauri-plugin-notification on desktop, it says which notification was clicked. It needs an
//! app bundle, so it is off under `pnpm tauri dev` (a bare binary).
//!
//! The framework's objects are not `Send`: every call goes through the main thread, except
//! the completion handlers, which the framework calls on its own queue.

use std::sync::Arc;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread, DefinedClass};
use objc2_foundation::{NSArray, NSBundle, NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
    UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions,
    UNNotificationRequest, UNNotificationResponse, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};
use tauri::AppHandle;

use super::{Banner, Notice};

/// Request identifier of a task's notification: a new one replaces the last.
const ID_PREFIX: &str = "task:";
/// The app's notifications are grouped together in the notification center.
const THREAD: &str = "claude";

/// Called with the task of a clicked notification.
pub type ClickHook = Arc<dyn Fn(String) + Send + Sync>;

struct Ivars {
    on_click: ClickHook,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements; `Delegate` does not implement Drop.
    #[unsafe(super(NSObject))]
    #[name = "TaidoNotificationDelegate"]
    #[ivars = Ivars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        // The app is in front on another task: the banner shows anyway (macOS hides those
        // of the frontmost app by default), still without sound.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            handler
                .call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List,));
        }

        // A click on the notification itself (not a dismissal).
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            handler: &block2::DynBlock<dyn Fn()>,
        ) {
            // SAFETY: a constant of the framework, which is linked.
            let default = unsafe { UNNotificationDefaultActionIdentifier };
            if &*response.actionIdentifier() == default {
                let id = response.notification().request().identifier().to_string();
                if let Some(task_id) = id.strip_prefix(ID_PREFIX) {
                    (self.ivars().on_click)(task_id.to_string());
                }
            }
            handler.call(());
        }
    }
);

impl Delegate {
    fn new(on_click: ClickHook) -> Retained<Self> {
        let this = Self::alloc().set_ivars(Ivars { on_click });
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

pub struct MacBanner {
    app: AppHandle,
    /// The notification center keeps only a weak reference to its delegate.
    _delegate: Retained<Delegate>,
}

/// The notifications of the installed app; `None` outside an app bundle. Call on the main
/// thread (Tauri's `setup`), before any notification is clicked.
pub fn banner(app: &AppHandle, on_click: ClickHook) -> Option<MacBanner> {
    let bundle = NSBundle::mainBundle();
    if bundle.bundleIdentifier().is_none() || !bundle.bundlePath().to_string().ends_with(".app") {
        log::info!("notifications are off outside the installed app");
        return None;
    }
    let delegate = Delegate::new(on_click);
    UNUserNotificationCenter::currentNotificationCenter()
        .setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    Some(MacBanner {
        app: app.clone(),
        _delegate: delegate,
    })
}

impl Banner for MacBanner {
    fn show(&self, notice: &Notice) {
        let notice = notice.clone();
        if let Err(e) = self.app.run_on_main_thread(move || post(&notice)) {
            log::warn!("cannot show a notification: {e}");
        }
    }

    fn withdraw(&self, task_id: &str) {
        let id = format!("{ID_PREFIX}{task_id}");
        let withdrawn = self.app.run_on_main_thread(move || {
            let ids = NSArray::from_retained_slice(&[NSString::from_str(&id)]);
            UNUserNotificationCenter::currentNotificationCenter()
                .removeDeliveredNotificationsWithIdentifiers(&ids);
        });
        if let Err(e) = withdrawn {
            log::warn!("cannot withdraw a notification: {e}");
        }
    }
}

/// Asks for the right to show alerts (no sound, no badge; macOS asks the user only the first
/// time), then posts the notification, which replaces the task's previous one.
fn post(notice: &Notice) {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(&notice.title));
    content.setBody(&NSString::from_str(&notice.body));
    content.setThreadIdentifier(&NSString::from_str(THREAD));
    let id = NSString::from_str(&format!("{ID_PREFIX}{}", notice.task_id));
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&id, &content, None);
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let target = center.clone();
    let then_post = RcBlock::new(move |granted: Bool, error: *mut NSError| {
        if !granted.as_bool() {
            log::info!("notifications not allowed {}", describe(error));
            return;
        }
        let added = RcBlock::new(|error: *mut NSError| {
            if !error.is_null() {
                log::warn!("cannot post a notification: {}", describe(error));
            }
        });
        target.addNotificationRequest_withCompletionHandler(&request, Some(&added));
    });
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert,
        &then_post,
    );
}

fn describe(error: *mut NSError) -> String {
    // SAFETY: the framework passes null or a valid error for the handler's duration.
    unsafe { error.as_ref() }
        .map(|e| e.localizedDescription().to_string())
        .unwrap_or_default()
}
