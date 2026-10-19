//! The transcription model file: where it lives, how it is downloaded and checked.
//!
//! Parakeet TDT 0.6B v3 (NVIDIA, CC-BY-4.0, 25 European languages) converted to GGUF by the
//! Handy project, Q5_K_M quantization. The URL pins the Hugging Face revision and the file is
//! checked against its SHA-256 before it is used.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

/// A model file to download once.
#[derive(Debug, Clone)]
pub struct ModelSpec {
    pub file_name: &'static str,
    pub url: &'static str,
    pub size: u64,
    /// Lowercase hex.
    pub sha256: &'static str,
}

pub const PARAKEET_V3: ModelSpec = ModelSpec {
    file_name: "parakeet-tdt-0.6b-v3-Q5_K_M.gguf",
    url: "https://huggingface.co/handy-computer/parakeet-tdt-0.6b-v3-gguf/resolve/85ac09ea12fc4b1112fa76810059364bc6adc9de/parakeet-tdt-0.6b-v3-Q5_K_M.gguf",
    size: 548_946_272,
    sha256: "cc722e76adc1a629fc0b2535de879d99b8160d07ad4c0215e2ca7d7ea0ae4b8f",
};

impl ModelSpec {
    /// Where the model is kept: `<data dir>/models/<file>`.
    pub fn path_in(&self, data_dir: &Path) -> PathBuf {
        data_dir.join("models").join(self.file_name)
    }

    /// A complete file is there (its hash was checked when it was downloaded).
    pub fn is_installed(&self, path: &Path) -> bool {
        fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() == self.size)
    }
}

/// Writes a download to `<file>.part`, hashing as it goes; `finish` checks size and hash, then
/// moves it into place. Dropped unfinished, the partial file is removed.
pub struct ModelWriter {
    spec: ModelSpec,
    target: PathBuf,
    part: PathBuf,
    file: Option<File>,
    hasher: Sha256,
    written: u64,
}

impl ModelWriter {
    pub fn create(spec: &ModelSpec, target: &Path) -> AppResult<Self> {
        if let Some(dir) = target.parent() {
            fs::create_dir_all(dir)?;
        }
        let mut part = target.as_os_str().to_owned();
        part.push(".part");
        let part = PathBuf::from(part);
        let file = File::create(&part).map_err(map_disk_error)?;
        Ok(ModelWriter {
            spec: spec.clone(),
            target: target.to_path_buf(),
            part,
            file: Some(file),
            hasher: Sha256::new(),
            written: 0,
        })
    }

    pub fn write(&mut self, bytes: &[u8]) -> AppResult<()> {
        self.written += bytes.len() as u64;
        if self.written > self.spec.size {
            return Err(AppError::Internal(
                "the voice model download is larger than expected".into(),
            ));
        }
        self.hasher.update(bytes);
        match self.file.as_mut() {
            Some(file) => file.write_all(bytes).map_err(map_disk_error),
            None => Err(AppError::Internal("model file already closed".into())),
        }
    }

    pub fn written(&self) -> u64 {
        self.written
    }

    pub fn finish(mut self) -> AppResult<()> {
        let file = self
            .file
            .take()
            .ok_or_else(|| AppError::Internal("model file already closed".into()))?;
        file.sync_all().map_err(map_disk_error)?;
        drop(file);
        if self.written != self.spec.size {
            return Err(AppError::Internal(format!(
                "voice model download stopped at {} of {} bytes",
                self.written, self.spec.size
            )));
        }
        let hash = hex(&std::mem::take(&mut self.hasher).finalize());
        if hash != self.spec.sha256 {
            return Err(AppError::Internal(
                "the downloaded voice model is damaged (wrong SHA-256)".into(),
            ));
        }
        fs::rename(&self.part, &self.target)?;
        Ok(())
    }
}

impl Drop for ModelWriter {
    fn drop(&mut self) {
        self.file.take();
        if self.part.exists() {
            let _ = fs::remove_file(&self.part);
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn map_disk_error(e: std::io::Error) -> AppError {
    if e.raw_os_error() == Some(libc::ENOSPC) {
        AppError::DiskFull(e.to_string())
    } else {
        AppError::Io(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec_for(content: &[u8]) -> ModelSpec {
        let hash: &'static str = Box::leak(hex(&Sha256::digest(content)).into_boxed_str());
        ModelSpec {
            file_name: "m.gguf",
            url: "https://example.invalid/m.gguf",
            size: content.len() as u64,
            sha256: hash,
        }
    }

    #[test]
    fn a_complete_download_is_installed() {
        let dir = tempfile::tempdir().unwrap();
        let spec = spec_for(b"hello model");
        let path = spec.path_in(dir.path());
        let mut w = ModelWriter::create(&spec, &path).unwrap();
        w.write(b"hello ").unwrap();
        w.write(b"model").unwrap();
        assert!(!spec.is_installed(&path));
        w.finish().unwrap();
        assert!(spec.is_installed(&path));
        assert!(!dir.path().join("models/m.gguf.part").exists());
    }

    #[test]
    fn a_damaged_download_is_refused_and_removed() {
        let dir = tempfile::tempdir().unwrap();
        let spec = spec_for(b"hello model");
        let path = spec.path_in(dir.path());
        let mut w = ModelWriter::create(&spec, &path).unwrap();
        w.write(b"hello MODEL").unwrap();
        assert!(w.finish().is_err());
        assert!(!path.exists());
        assert!(!dir.path().join("models/m.gguf.part").exists());
    }

    #[test]
    fn a_short_or_long_download_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let spec = spec_for(b"hello model");
        let path = spec.path_in(dir.path());
        let mut w = ModelWriter::create(&spec, &path).unwrap();
        w.write(b"hello").unwrap();
        assert!(w.finish().is_err());
        let mut w = ModelWriter::create(&spec, &path).unwrap();
        assert!(w.write(b"hello model and more").is_err());
        drop(w);
        assert!(!dir.path().join("models/m.gguf.part").exists());
    }
}
