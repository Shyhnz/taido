//! Dictation commands: thin, they delegate to `VoiceService`.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, State};
use tauri_specta::Event;

use crate::error::{AppError, AppResult};
use crate::events::{VoiceChanged, VoiceLevel};
use crate::voice::{model, VoiceEvent, VoiceService, VoiceStatus};

/// Managed by Tauri next to `AppState`.
pub struct VoiceState {
    pub service: Arc<VoiceService>,
    pub http: reqwest::Client,
}

/// Builds the dictation service; its events go to the UI.
pub fn start_voice(app: &AppHandle, data_dir: &Path) -> VoiceState {
    let emitter = app.clone();
    let sink = Arc::new(move |event: VoiceEvent| {
        let sent = match event {
            VoiceEvent::Changed(status) => VoiceChanged { status }.emit(&emitter),
            VoiceEvent::Level(level) => VoiceLevel { level }.emit(&emitter),
        };
        if let Err(e) = sent {
            log::warn!("cannot emit a voice event: {e}");
        }
    });
    let spec = model::PARAKEET_V3;
    let path = spec.path_in(data_dir);
    #[cfg(target_os = "macos")]
    let service = VoiceService::new(
        spec,
        path,
        true,
        Box::new(crate::voice::macos::CpalMicrophone),
        Box::new(crate::voice::macos::ParakeetEngine::new()),
        sink,
    );
    #[cfg(not(target_os = "macos"))]
    let service = VoiceService::new(
        spec,
        path,
        false,
        Box::new(crate::voice::NoMicrophone),
        Box::new(crate::voice::NoEngine),
        sink,
    );
    // No overall timeout: the model is about 550 MB.
    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .user_agent(concat!("Taido/", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_else(|e| {
            log::warn!("voice: default HTTP client ({e})");
            reqwest::Client::new()
        });
    VoiceState {
        service: Arc::new(service),
        http,
    }
}

#[tauri::command]
#[specta::specta]
pub fn voice_status(state: State<'_, VoiceState>) -> VoiceStatus {
    state.service.status()
}

/// Downloads the model once (progress through `VoiceChanged`).
#[tauri::command]
#[specta::specta]
pub async fn voice_download_model(state: State<'_, VoiceState>) -> AppResult<()> {
    let service = Arc::clone(&state.service);
    let http = state.http.clone();
    service.download(&http).await
}

/// Starts listening for a terminal. May wait for the macOS microphone prompt.
#[tauri::command]
#[specta::specta]
pub async fn voice_start(state: State<'_, VoiceState>, terminal_id: String) -> AppResult<()> {
    let service = Arc::clone(&state.service);
    tauri::async_runtime::spawn_blocking(move || service.start(&terminal_id))
        .await
        .map_err(|e| AppError::Internal(format!("voice start task failed: {e}")))?
}

/// Stops listening and returns the text heard ("" when nothing was said).
#[tauri::command]
#[specta::specta]
pub async fn voice_stop(state: State<'_, VoiceState>) -> AppResult<String> {
    let service = Arc::clone(&state.service);
    tauri::async_runtime::spawn_blocking(move || service.stop())
        .await
        .map_err(|e| AppError::Internal(format!("voice stop task failed: {e}")))?
}

/// Stops listening without writing anything (Échap).
#[tauri::command]
#[specta::specta]
pub async fn voice_cancel(state: State<'_, VoiceState>) -> AppResult<()> {
    let service = Arc::clone(&state.service);
    tauri::async_runtime::spawn_blocking(move || service.cancel())
        .await
        .map_err(|e| AppError::Internal(format!("voice cancel task failed: {e}")))
}

/// Opens Réglages Système › Confidentialité › Micro, after a refusal.
#[tauri::command]
#[specta::specta]
pub fn voice_open_mic_settings(app: AppHandle) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
            None::<&str>,
        )
        .map_err(|e| AppError::Internal(format!("cannot open the system settings: {e}")))
}
