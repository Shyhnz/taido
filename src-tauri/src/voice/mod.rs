//! Voice dictation in Claude and Codex terminals.
//!
//! The UI says « start » (mic button or Space held) and « stop »; the core records the
//! microphone, transcribes on this Mac with Parakeet v3 and returns the text, which the UI
//! pastes into the terminal without Enter. Nothing leaves the Mac except the one-time model
//! download. The microphone, the engine and the permission sit behind traits so the service is
//! tested without hardware.

pub mod audio;
#[cfg(target_os = "macos")]
pub mod macos;
pub mod model;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::{AppError, AppResult};
use model::{ModelSpec, ModelWriter};

/// State of the transcription model on this Mac.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum VoiceModelState {
    /// Dictation does not exist on this system (only macOS for now).
    Unavailable,
    /// To download before the first dictation.
    Missing,
    /// Download in progress, in bytes.
    Downloading {
        received: f64,
        total: f64,
    },
    Ready,
    /// The last download failed; the UI offers to retry.
    Failed {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub model: VoiceModelState,
    /// Size of the model download, in bytes (shown before downloading).
    pub model_size: f64,
    /// Terminal being dictated into, when recording.
    pub recording: Option<String>,
}

/// Microphone permission, as macOS reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    Granted,
    Denied,
    /// Never asked: asking shows the system prompt.
    NotAsked,
}

/// The microphone: starts a capture that reports its level as it goes.
pub trait Microphone: Send + Sync {
    fn permission(&self) -> Permission;
    /// Shows the system prompt and waits for the answer.
    fn request_permission(&self) -> bool;
    fn start(&self, on_level: Box<dyn Fn(f32) + Send>) -> AppResult<Box<dyn Capture>>;
}

/// A running capture.
pub trait Capture: Send {
    /// Stops the microphone and returns what it heard, mono at 16 kHz.
    fn stop(self: Box<Self>) -> Vec<f32>;
}

/// Speech to text.
pub trait Engine: Send + Sync {
    /// Loads the model in the background so it is ready when the user stops talking.
    fn preload(&self, path: PathBuf);
    fn transcribe(&self, path: PathBuf, pcm: &[f32]) -> AppResult<String>;
}

/// What the service tells the UI.
#[derive(Debug, Clone, PartialEq)]
pub enum VoiceEvent {
    Changed(VoiceStatus),
    Level(f32),
}

pub type VoiceSink = Arc<dyn Fn(VoiceEvent) + Send + Sync>;

struct Recording {
    terminal_id: String,
    capture: Box<dyn Capture>,
}

#[derive(Default)]
struct Inner {
    downloading: Option<(u64, u64)>,
    failed: Option<String>,
    recording: Option<Recording>,
}

pub struct VoiceService {
    spec: ModelSpec,
    model_path: PathBuf,
    available: bool,
    mic: Box<dyn Microphone>,
    engine: Box<dyn Engine>,
    sink: VoiceSink,
    inner: Mutex<Inner>,
}

impl VoiceService {
    pub fn new(
        spec: ModelSpec,
        model_path: PathBuf,
        available: bool,
        mic: Box<dyn Microphone>,
        engine: Box<dyn Engine>,
        sink: VoiceSink,
    ) -> Self {
        VoiceService {
            spec,
            model_path,
            available,
            mic,
            engine,
            sink,
            inner: Mutex::new(Inner::default()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A panic while holding the lock leaves plain data: keep going with it.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn status_of(&self, inner: &Inner) -> VoiceStatus {
        let model = if !self.available {
            VoiceModelState::Unavailable
        } else if let Some((received, total)) = inner.downloading {
            VoiceModelState::Downloading {
                received: received as f64,
                total: total as f64,
            }
        } else if self.spec.is_installed(&self.model_path) {
            VoiceModelState::Ready
        } else if let Some(message) = &inner.failed {
            VoiceModelState::Failed {
                message: message.clone(),
            }
        } else {
            VoiceModelState::Missing
        };
        VoiceStatus {
            model,
            model_size: self.spec.size as f64,
            recording: inner.recording.as_ref().map(|r| r.terminal_id.clone()),
        }
    }

    pub fn status(&self) -> VoiceStatus {
        self.status_of(&self.lock())
    }

    fn changed(&self) {
        let status = self.status();
        (self.sink)(VoiceEvent::Changed(status));
    }

    /// Starts listening for `terminal_id`. A dictation already running elsewhere is dropped.
    pub fn start(&self, terminal_id: &str) -> AppResult<()> {
        if !self.available {
            return Err(AppError::VoiceUnavailable(
                "dictation is only available on macOS".into(),
            ));
        }
        if !self.spec.is_installed(&self.model_path) {
            return Err(AppError::VoiceUnavailable(
                "the voice model is not downloaded".into(),
            ));
        }
        match self.mic.permission() {
            Permission::Granted => {}
            Permission::Denied => return Err(AppError::MicDenied),
            Permission::NotAsked => {
                if !self.mic.request_permission() {
                    return Err(AppError::MicDenied);
                }
            }
        }
        if let Some(previous) = self.lock().recording.take() {
            drop(previous.capture.stop());
        }
        self.engine.preload(self.model_path.clone());
        let sink = Arc::clone(&self.sink);
        let capture = self
            .mic
            .start(Box::new(move |level| sink(VoiceEvent::Level(level))))?;
        self.lock().recording = Some(Recording {
            terminal_id: terminal_id.to_string(),
            capture,
        });
        self.changed();
        Ok(())
    }

    /// Stops listening and returns the text heard (empty when nothing was said). Blocking:
    /// the transcription takes a fraction of a second once the model is loaded.
    pub fn stop(&self) -> AppResult<String> {
        let Some(recording) = self.lock().recording.take() else {
            return Ok(String::new());
        };
        self.changed();
        let pcm = recording.capture.stop();
        if !audio::has_speech(&pcm) {
            return Ok(String::new());
        }
        let text = self.engine.transcribe(self.model_path.clone(), &pcm)?;
        Ok(text.trim().to_string())
    }

    /// Stops listening and forgets what was heard (Échap).
    pub fn cancel(&self) {
        let recording = self.lock().recording.take();
        if let Some(recording) = recording {
            drop(recording.capture.stop());
            self.changed();
        }
    }

    /// Downloads the model (once; a second call while it runs does nothing).
    pub async fn download(&self, client: &reqwest::Client) -> AppResult<()> {
        if !self.available {
            return Err(AppError::VoiceUnavailable(
                "dictation is only available on macOS".into(),
            ));
        }
        {
            let mut inner = self.lock();
            if inner.downloading.is_some() || self.spec.is_installed(&self.model_path) {
                return Ok(());
            }
            inner.downloading = Some((0, self.spec.size));
            inner.failed = None;
        }
        self.changed();
        let result = self.fetch(client).await;
        {
            let mut inner = self.lock();
            inner.downloading = None;
            if let Err(e) = &result {
                log::warn!("voice model download failed: {e}");
                inner.failed = Some(e.to_string());
            }
        }
        self.changed();
        result
    }

    async fn fetch(&self, client: &reqwest::Client) -> AppResult<()> {
        let offline = |e: reqwest::Error| AppError::SyncOffline(e.to_string());
        let mut response = client
            .get(self.spec.url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(offline)?;
        let mut writer = ModelWriter::create(&self.spec, &self.model_path)?;
        let step = (self.spec.size / 200).max(1);
        let mut next = step;
        while let Some(chunk) = response.chunk().await.map_err(offline)? {
            writer.write(&chunk)?;
            if writer.written() >= next {
                next = writer.written() + step;
                self.lock().downloading = Some((writer.written(), self.spec.size));
                self.changed();
            }
        }
        // Hashing is done; the final sync and rename can block for a moment.
        tokio::task::spawn_blocking(move || writer.finish())
            .await
            .map_err(|e| AppError::Internal(format!("model check task failed: {e}")))?
    }
}

/// Stand-ins where dictation does not exist yet (not macOS): never called, `start` refuses.
#[cfg(not(target_os = "macos"))]
pub struct NoMicrophone;

#[cfg(not(target_os = "macos"))]
impl Microphone for NoMicrophone {
    fn permission(&self) -> Permission {
        Permission::Denied
    }
    fn request_permission(&self) -> bool {
        false
    }
    fn start(&self, _: Box<dyn Fn(f32) + Send>) -> AppResult<Box<dyn Capture>> {
        Err(AppError::VoiceUnavailable("no microphone support".into()))
    }
}

#[cfg(not(target_os = "macos"))]
pub struct NoEngine;

#[cfg(not(target_os = "macos"))]
impl Engine for NoEngine {
    fn preload(&self, _: PathBuf) {}
    fn transcribe(&self, _: PathBuf, _: &[f32]) -> AppResult<String> {
        Err(AppError::VoiceUnavailable("no transcription engine".into()))
    }
}

#[cfg(test)]
mod tests;
