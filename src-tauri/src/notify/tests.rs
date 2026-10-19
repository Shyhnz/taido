use super::*;
use crate::i18n::Language;
use crate::model::Agent;

/// Records what the notifier shows and withdraws.
#[derive(Default)]
struct FakeBanner {
    calls: Mutex<Vec<String>>,
}

impl Banner for FakeBanner {
    fn show(&self, notice: &Notice) {
        self.calls
            .lock()
            .expect("lock")
            .push(format!("show {} {}", notice.task_id, notice.body));
    }

    fn withdraw(&self, task_id: &str) {
        self.calls
            .lock()
            .expect("lock")
            .push(format!("withdraw {task_id}"));
    }
}

fn notifier() -> (Notifier, Arc<FakeBanner>) {
    let banner = Arc::new(FakeBanner::default());
    let as_banner: Arc<dyn Banner> = banner.clone();
    (Notifier::new(Some(as_banner)), banner)
}

fn notice(task_id: &str, body: &str) -> Notice {
    Notice {
        task_id: task_id.into(),
        terminal_id: Some(format!("term-{task_id}")),
        title: "Globex · Export CSV".into(),
        body: body.into(),
    }
}

fn calls(banner: &FakeBanner) -> Vec<String> {
    banner.calls.lock().expect("lock").clone()
}

fn session(state: SessionState, error_kind: Option<&str>) -> Session {
    let mut s = Session::starting("sid", "2026-10-05T10:00:00.000Z");
    s.state = state;
    s.error_kind = error_kind.map(str::to_string);
    s
}

#[test]
fn quiet_only_when_the_task_is_in_front_of_the_user() {
    let mut gate = Gate::default();
    let now = Instant::now();
    // Window in the background: the open task notifies.
    gate.set_open_task(Some("a".into()));
    assert!(gate.admit("a", now));
    // Window in front, another task open: notifies.
    let mut gate = Gate::default();
    gate.set_focused(true);
    gate.set_open_task(Some("b".into()));
    assert!(gate.admit("a", now));
    // Window in front on that task: quiet.
    gate.set_open_task(Some("a".into()));
    assert!(!gate.admit("a", now + PER_TASK_INTERVAL));
    // No task open: notifies.
    gate.set_open_task(None);
    assert!(gate.admit("a", now + PER_TASK_INTERVAL));
}

#[test]
fn one_notification_per_task_every_ten_seconds() {
    let mut gate = Gate::default();
    let now = Instant::now();
    assert!(gate.admit("a", now));
    assert!(!gate.admit("a", now + Duration::from_secs(9)));
    assert!(
        gate.admit("b", now + Duration::from_secs(9)),
        "other tasks are free"
    );
    assert!(gate.admit("a", now + PER_TASK_INTERVAL));
}

#[test]
fn shows_then_withdraws_once_the_user_looks_at_the_task() {
    let (notifier, banner) = notifier();
    notifier.set_focused(false);
    notifier.notify(notice("a", "Claude a fini"));
    assert_eq!(calls(&banner), ["show a Claude a fini"]);
    // Opening the task while the window is in the background is not looking at it.
    notifier.set_open_task(Some("a".into()));
    assert_eq!(calls(&banner).len(), 1);
    // The window comes forward on the task: the notification leaves the center, once.
    notifier.set_focused(true);
    notifier.set_open_task(Some("a".into()));
    assert_eq!(calls(&banner), ["show a Claude a fini", "withdraw a"]);
}

#[test]
fn opening_a_task_never_notified_withdraws_nothing() {
    let (notifier, banner) = notifier();
    notifier.set_focused(true);
    notifier.set_open_task(Some("a".into()));
    assert!(calls(&banner).is_empty());
}

#[test]
fn quiet_on_the_task_in_front() {
    let (notifier, banner) = notifier();
    notifier.set_focused(true);
    notifier.set_open_task(Some("a".into()));
    notifier.notify(notice("a", "Claude a fini"));
    notifier.notify(notice("b", "Claude attend ta réponse"));
    assert_eq!(calls(&banner), ["show b Claude attend ta réponse"]);
}

#[test]
fn a_click_returns_the_terminal_of_the_session() {
    let (notifier, _banner) = notifier();
    notifier.notify(notice("a", "Claude a fini"));
    assert_eq!(notifier.clicked("a").as_deref(), Some("term-a"));
    assert_eq!(notifier.clicked("unknown"), None);
}

#[test]
fn without_banner_nothing_breaks() {
    let notifier = Notifier::new(None);
    notifier.notify(notice("a", "Claude a fini"));
    notifier.set_focused(true);
    notifier.set_open_task(Some("a".into()));
    assert_eq!(notifier.clicked("a"), None, "forgotten once seen");
}

#[test]
fn notification_texts_follow_the_language() {
    let waiting = session(SessionState::Waiting, None);
    assert_eq!(
        body(Language::En, Agent::Claude, &waiting),
        "Claude is waiting for you"
    );
    assert_eq!(
        body(Language::Fr, Agent::Claude, &waiting),
        "Claude attend ta réponse"
    );
    assert_eq!(
        body(
            Language::En,
            Agent::Codex,
            &session(SessionState::Done, None)
        ),
        "Codex is done"
    );
    assert_eq!(
        body(
            Language::En,
            Agent::Claude,
            &session(SessionState::Error, Some("billing_error"))
        ),
        "Billing problem"
    );
}

#[test]
fn title_and_body() {
    assert_eq!(title(Some("Globex"), "Export CSV"), "Globex · Export CSV");
    assert_eq!(title(None, "Export CSV"), "Export CSV");
    assert_eq!(
        body(
            Language::Fr,
            Agent::Claude,
            &session(SessionState::Waiting, None)
        ),
        "Claude attend ta réponse"
    );
    assert_eq!(
        body(
            Language::Fr,
            Agent::Claude,
            &session(SessionState::Done, None)
        ),
        "Claude a fini"
    );
    assert_eq!(
        body(
            Language::Fr,
            Agent::Claude,
            &session(SessionState::Crashed, None)
        ),
        "Session arrêtée"
    );
    assert_eq!(
        body(
            Language::Fr,
            Agent::Claude,
            &session(SessionState::Error, Some("rate_limit"))
        ),
        "Limite d'usage atteinte"
    );
    assert_eq!(
        body(
            Language::Fr,
            Agent::Claude,
            &session(SessionState::Error, Some("account_on_hold"))
        ),
        "Erreur : account_on_hold"
    );
    assert_eq!(
        body(
            Language::Fr,
            Agent::Codex,
            &session(SessionState::Waiting, None)
        ),
        "Codex attend ta réponse"
    );
    assert_eq!(
        body(
            Language::Fr,
            Agent::Codex,
            &session(SessionState::Done, None)
        ),
        "Codex a fini"
    );
}
