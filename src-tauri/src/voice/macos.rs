//! macOS side of the dictation: CoreAudio capture through cpal, the microphone permission
//! through AVFoundation, Parakeet v3 through transcribe-cpp (ggml on Metal).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use block2::RcBlock;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use objc2::runtime::Bool;
use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
use transcribe_cpp::{Model, RunOptions, Session};

use super::audio::{self, MODEL_RATE};
use super::{Capture, Engine, Microphone, Permission};
use crate::error::{AppError, AppResult};

/// A dictation longer than this is cut (the model handles it, the user surely forgot).
const MAX_SECONDS: usize = 5 * 60;
/// How often the level meter moves.
const LEVEL_EVERY: Duration = Duration::from_millis(60);
/// The model (about 600 MB of memory) is unloaded after this long without dictation.
const IDLE_UNLOAD: Duration = Duration::from_secs(10 * 60);

pub struct CpalMicrophone;

impl Microphone for CpalMicrophone {
    fn permission(&self) -> Permission {
        let Some(audio) = (unsafe { AVMediaTypeAudio }) else {
            return Permission::Denied;
        };
        // SAFETY: a valid media type constant; the call has no other precondition.
        let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) };
        if status == AVAuthorizationStatus::Authorized {
            Permission::Granted
        } else if status == AVAuthorizationStatus::NotDetermined {
            Permission::NotAsked
        } else {
            Permission::Denied
        }
    }

    fn request_permission(&self) -> bool {
        let Some(audio) = (unsafe { AVMediaTypeAudio }) else {
            return false;
        };
        let (tx, rx) = mpsc::channel();
        let handler = RcBlock::new(move |granted: Bool| {
            let _ = tx.send(granted.as_bool());
        });
        // SAFETY: valid media type; the handler is called once, on a framework queue.
        unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &handler) };
        // The user reads the system prompt: give them time, but never block forever.
        rx.recv_timeout(Duration::from_secs(120)).unwrap_or(false)
    }

    fn start(&self, on_level: Box<dyn Fn(f32) + Send>) -> AppResult<Box<dyn Capture>> {
        let (ready_tx, ready_rx) = mpsc::channel::<AppResult<u32>>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
        let level = Arc::new(AtomicU32::new(0));
        let (shared, peak) = (Arc::clone(&samples), Arc::clone(&level));
        // cpal streams are not `Send`: the stream lives and dies on its own thread.
        let thread = std::thread::Builder::new()
            .name("voice-capture".into())
            .spawn(move || {
                let stream = match open_stream(shared, peak) {
                    Ok((stream, rate)) => {
                        let _ = ready_tx.send(Ok(rate));
                        stream
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                // Until « stop » (or the capture dropped): report the loudest block heard.
                while let Err(RecvTimeoutError::Timeout) = stop_rx.recv_timeout(LEVEL_EVERY) {
                    on_level(f32::from_bits(level.swap(0, Ordering::Relaxed)));
                }
                drop(stream);
            })
            .map_err(|e| AppError::Internal(format!("cannot start the capture thread: {e}")))?;
        let rate = ready_rx
            .recv()
            .map_err(|_| AppError::Internal("the capture thread stopped".into()))??;
        Ok(Box::new(CpalCapture {
            stop: stop_tx,
            thread: Some(thread),
            samples,
            rate,
        }))
    }
}

/// Opens the default input; returns the playing stream and its sample rate.
fn open_stream(
    samples: Arc<Mutex<Vec<f32>>>,
    level: Arc<AtomicU32>,
) -> AppResult<(cpal::Stream, u32)> {
    let device = cpal::default_host()
        .default_input_device()
        .ok_or_else(|| AppError::VoiceUnavailable("no microphone found".into()))?;
    let config = device
        .default_input_config()
        .map_err(|e| AppError::VoiceUnavailable(format!("microphone unavailable: {e}")))?;
    let rate = config.sample_rate();
    let channels = config.channels() as usize;
    let format = config.sample_format();
    let stream_config = config.config();
    let stream = match format {
        SampleFormat::F32 => build::<f32>(&device, stream_config, channels, rate, samples, level),
        SampleFormat::I16 => build::<i16>(&device, stream_config, channels, rate, samples, level),
        SampleFormat::I32 => build::<i32>(&device, stream_config, channels, rate, samples, level),
        SampleFormat::U8 => build::<u8>(&device, stream_config, channels, rate, samples, level),
        other => {
            return Err(AppError::VoiceUnavailable(format!(
                "unsupported microphone format {other:?}"
            )))
        }
    }?;
    stream
        .play()
        .map_err(|e| AppError::VoiceUnavailable(format!("cannot start the microphone: {e}")))?;
    Ok((stream, rate))
}

fn build<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    channels: usize,
    rate: u32,
    samples: Arc<Mutex<Vec<f32>>>,
    level: Arc<AtomicU32>,
) -> AppResult<cpal::Stream>
where
    T: SizedSample + Send + 'static,
    f32: FromSample<T>,
{
    let cap = rate as usize * MAX_SECONDS;
    device
        .build_input_stream::<T, _, _>(
            config,
            move |data: &[T], _| {
                let floats: Vec<f32> = data.iter().map(|s| s.to_sample::<f32>()).collect();
                let mono = audio::to_mono(&floats, channels);
                let block_level = audio::level(&mono);
                let _ = level.fetch_max(block_level.to_bits(), Ordering::Relaxed);
                if let Ok(mut all) = samples.lock() {
                    let room = cap.saturating_sub(all.len());
                    all.extend(mono.into_iter().take(room));
                }
            },
            |e| log::warn!("microphone stream error: {e}"),
            None,
        )
        .map_err(|e| AppError::VoiceUnavailable(format!("cannot open the microphone: {e}")))
}

struct CpalCapture {
    stop: mpsc::Sender<()>,
    thread: Option<JoinHandle<()>>,
    samples: Arc<Mutex<Vec<f32>>>,
    rate: u32,
}

impl Capture for CpalCapture {
    fn stop(mut self: Box<Self>) -> Vec<f32> {
        let _ = self.stop.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        let raw = std::mem::take(&mut *self.samples.lock().unwrap_or_else(|e| e.into_inner()));
        audio::resample(&raw, self.rate, MODEL_RATE)
    }
}

struct Loaded {
    session: Session,
    last_used: Instant,
}

/// Parakeet v3, loaded on the first dictation and kept while it is used.
pub struct ParakeetEngine {
    slot: Arc<Mutex<Option<Loaded>>>,
}

impl ParakeetEngine {
    pub fn new() -> Self {
        transcribe_cpp::disable_logging();
        let slot: Arc<Mutex<Option<Loaded>>> = Arc::new(Mutex::new(None));
        let weak = Arc::downgrade(&slot);
        let spawned = std::thread::Builder::new()
            .name("voice-unload".into())
            .spawn(move || loop {
                std::thread::sleep(Duration::from_secs(60));
                let Some(slot) = weak.upgrade() else { return };
                // `try_lock`: a dictation in progress keeps the model.
                let unloaded = match slot.try_lock() {
                    Ok(mut loaded)
                        if loaded
                            .as_ref()
                            .is_some_and(|l| l.last_used.elapsed() > IDLE_UNLOAD) =>
                    {
                        *loaded = None;
                        true
                    }
                    _ => false,
                };
                if unloaded {
                    log::info!("voice model unloaded after {IDLE_UNLOAD:?} idle");
                }
            });
        if let Err(e) = spawned {
            log::warn!("cannot start the voice model unloader: {e}");
        }
        ParakeetEngine { slot }
    }
}

fn ensure_loaded<'a>(slot: &'a mut Option<Loaded>, path: &Path) -> AppResult<&'a mut Loaded> {
    if slot.is_none() {
        let started = Instant::now();
        let model = Model::load(path)
            .map_err(|e| AppError::VoiceUnavailable(format!("cannot load the voice model: {e}")))?;
        let session = model.session().map_err(|e| {
            AppError::VoiceUnavailable(format!("cannot start the voice model: {e}"))
        })?;
        log::info!("voice model loaded in {:?}", started.elapsed());
        *slot = Some(Loaded {
            session,
            last_used: Instant::now(),
        });
    }
    slot.as_mut()
        .ok_or_else(|| AppError::Internal("voice model slot empty".into()))
}

impl Engine for ParakeetEngine {
    fn preload(&self, path: PathBuf) {
        let slot = Arc::clone(&self.slot);
        let spawned = std::thread::Builder::new()
            .name("voice-preload".into())
            .spawn(move || {
                let mut loaded = slot.lock().unwrap_or_else(|e| e.into_inner());
                match ensure_loaded(&mut loaded, &path) {
                    Ok(l) => l.last_used = Instant::now(),
                    Err(e) => log::warn!("voice model preload failed: {e}"),
                }
            });
        if let Err(e) = spawned {
            log::warn!("cannot preload the voice model: {e}");
        }
    }

    fn transcribe(&self, path: PathBuf, pcm: &[f32]) -> AppResult<String> {
        // Waits for a preload still running.
        let mut loaded = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        let l = ensure_loaded(&mut loaded, &path)?;
        let started = Instant::now();
        let result = l
            .session
            .run(pcm, &RunOptions::default())
            .map_err(|e| AppError::Internal(format!("transcription failed: {e}")))?;
        l.last_used = Instant::now();
        log::info!(
            "dictation: {:.1} s of audio transcribed in {:?}",
            pcm.len() as f32 / MODEL_RATE as f32,
            started.elapsed()
        );
        Ok(result.text)
    }
}
