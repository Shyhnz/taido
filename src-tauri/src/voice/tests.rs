use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use super::model::ModelSpec;
use super::*;

#[derive(Default)]
struct Log {
    asked: bool,
    preloaded: usize,
    transcribed: Vec<usize>,
    events: Vec<VoiceEvent>,
}

struct FakeMic {
    log: Arc<Mutex<Log>>,
    permission: Permission,
    grant: bool,
    heard: Vec<f32>,
}

impl Microphone for FakeMic {
    fn permission(&self) -> Permission {
        self.permission
    }
    fn request_permission(&self) -> bool {
        self.log.lock().unwrap().asked = true;
        self.grant
    }
    fn start(&self, on_level: Box<dyn Fn(f32) + Send>) -> AppResult<Box<dyn Capture>> {
        on_level(0.5);
        Ok(Box::new(FakeCapture(self.heard.clone())))
    }
}

struct FakeCapture(Vec<f32>);

impl Capture for FakeCapture {
    fn stop(self: Box<Self>) -> Vec<f32> {
        self.0
    }
}

struct FakeEngine(Arc<Mutex<Log>>);

impl Engine for FakeEngine {
    fn preload(&self, _: PathBuf) {
        self.0.lock().unwrap().preloaded += 1;
    }
    fn transcribe(&self, _: PathBuf, pcm: &[f32]) -> AppResult<String> {
        self.0.lock().unwrap().transcribed.push(pcm.len());
        Ok("  Bonjour Claude.  ".into())
    }
}

const SPEC: ModelSpec = ModelSpec {
    file_name: "m.gguf",
    url: "https://example.invalid/m.gguf",
    size: 4,
    sha256: "",
};

fn speech() -> Vec<f32> {
    vec![0.2; audio::MIN_SAMPLES * 2]
}

fn service(
    dir: &Path,
    installed: bool,
    permission: Permission,
    grant: bool,
    heard: Vec<f32>,
) -> (VoiceService, Arc<Mutex<Log>>) {
    let path = SPEC.path_in(dir);
    if installed {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"gguf").unwrap();
    }
    let log = Arc::new(Mutex::new(Log::default()));
    let events = Arc::clone(&log);
    let mic = FakeMic {
        log: Arc::clone(&log),
        permission,
        grant,
        heard,
    };
    let service = VoiceService::new(
        SPEC,
        path,
        true,
        Box::new(mic),
        Box::new(FakeEngine(Arc::clone(&log))),
        Arc::new(move |e| events.lock().unwrap().events.push(e)),
    );
    (service, log)
}

#[test]
fn status_follows_the_model_file() {
    let dir = tempfile::tempdir().unwrap();
    let (missing, _) = service(dir.path(), false, Permission::Granted, true, speech());
    assert_eq!(missing.status().model, VoiceModelState::Missing);
    assert_eq!(missing.status().model_size, 4.0);
    let (ready, _) = service(dir.path(), true, Permission::Granted, true, speech());
    assert_eq!(ready.status().model, VoiceModelState::Ready);
}

#[test]
fn unavailable_off_macos() {
    let dir = tempfile::tempdir().unwrap();
    let log = Arc::new(Mutex::new(Log::default()));
    let mic = FakeMic {
        log: Arc::clone(&log),
        permission: Permission::Granted,
        grant: true,
        heard: speech(),
    };
    let s = VoiceService::new(
        SPEC,
        SPEC.path_in(dir.path()),
        false,
        Box::new(mic),
        Box::new(FakeEngine(log)),
        Arc::new(|_| {}),
    );
    assert_eq!(s.status().model, VoiceModelState::Unavailable);
    assert!(matches!(s.start("t1"), Err(AppError::VoiceUnavailable(_))));
}

#[test]
fn dictation_records_then_returns_trimmed_text() {
    let dir = tempfile::tempdir().unwrap();
    let (s, log) = service(dir.path(), true, Permission::Granted, true, speech());
    s.start("t1").unwrap();
    assert_eq!(s.status().recording.as_deref(), Some("t1"));
    assert_eq!(s.stop().unwrap(), "Bonjour Claude.");
    assert_eq!(s.status().recording, None);
    let log = log.lock().unwrap();
    assert_eq!(log.preloaded, 1);
    assert_eq!(log.transcribed, vec![audio::MIN_SAMPLES * 2]);
    assert!(log.events.contains(&VoiceEvent::Level(0.5)));
}

#[test]
fn silence_is_not_transcribed() {
    let dir = tempfile::tempdir().unwrap();
    let (s, log) = service(
        dir.path(),
        true,
        Permission::Granted,
        true,
        vec![0.0; 50_000],
    );
    s.start("t1").unwrap();
    assert_eq!(s.stop().unwrap(), "");
    assert!(log.lock().unwrap().transcribed.is_empty());
}

#[test]
fn cancel_drops_the_recording() {
    let dir = tempfile::tempdir().unwrap();
    let (s, log) = service(dir.path(), true, Permission::Granted, true, speech());
    s.start("t1").unwrap();
    s.cancel();
    assert_eq!(s.status().recording, None);
    assert_eq!(s.stop().unwrap(), "");
    assert!(log.lock().unwrap().transcribed.is_empty());
}

#[test]
fn no_model_no_dictation() {
    let dir = tempfile::tempdir().unwrap();
    let (s, _) = service(dir.path(), false, Permission::Granted, true, speech());
    assert!(matches!(s.start("t1"), Err(AppError::VoiceUnavailable(_))));
}

#[test]
fn permission_is_asked_once_then_respected() {
    let dir = tempfile::tempdir().unwrap();
    let (s, log) = service(dir.path(), true, Permission::NotAsked, true, speech());
    s.start("t1").unwrap();
    assert!(log.lock().unwrap().asked);

    let (refused, _) = service(dir.path(), true, Permission::NotAsked, false, speech());
    assert!(matches!(refused.start("t1"), Err(AppError::MicDenied)));
    assert_eq!(refused.status().recording, None);

    let (denied, log) = service(dir.path(), true, Permission::Denied, true, speech());
    assert!(matches!(denied.start("t1"), Err(AppError::MicDenied)));
    assert!(!log.lock().unwrap().asked);
}

#[test]
fn a_new_dictation_replaces_the_previous_one() {
    let dir = tempfile::tempdir().unwrap();
    let (s, _) = service(dir.path(), true, Permission::Granted, true, speech());
    s.start("t1").unwrap();
    s.start("t2").unwrap();
    assert_eq!(s.status().recording.as_deref(), Some("t2"));
}
