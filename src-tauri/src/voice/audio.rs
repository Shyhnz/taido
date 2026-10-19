//! Audio helpers of the dictation, pure so they are tested without a microphone.

/// Sample rate the transcription model expects (mono f32 in [-1, 1]).
pub const MODEL_RATE: u32 = 16_000;

/// Below this many samples at 16 kHz (0.3 s), a recording is a slip of the finger.
pub const MIN_SAMPLES: usize = (MODEL_RATE as usize * 3) / 10;

/// Peak under which a recording is silence (nothing said, or a muted microphone).
pub const SILENCE_PEAK: f32 = 0.01;

/// Averages interleaved frames of `channels` samples into one mono sample each.
pub fn to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

/// Resamples mono audio from `from` Hz to `to` Hz. Each output sample is the mean of the input
/// samples it covers (a box filter), which keeps speech clean when downsampling 48 kHz → 16 kHz
/// without the aliasing of plain decimation; upsampling interpolates linearly.
pub fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() || from == 0 || to == 0 {
        return input.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let out_len = ((input.len() as f64) / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let start = i as f64 * ratio;
        if ratio > 1.0 {
            let a = start.floor() as usize;
            let b = ((start + ratio).ceil() as usize)
                .min(input.len())
                .max(a + 1);
            let window = &input[a..b];
            out.push(window.iter().sum::<f32>() / window.len() as f32);
        } else {
            let a = start.floor() as usize;
            let t = (start - a as f64) as f32;
            let x0 = input[a];
            let x1 = input.get(a + 1).copied().unwrap_or(x0);
            out.push(x0 + (x1 - x0) * t);
        }
    }
    out
}

/// Loudness of a block for the level meter, 0 to 1 (RMS scaled so normal speech fills it).
pub fn level(block: &[f32]) -> f32 {
    if block.is_empty() {
        return 0.0;
    }
    let rms = (block.iter().map(|s| s * s).sum::<f32>() / block.len() as f32).sqrt();
    (rms * 6.0).clamp(0.0, 1.0)
}

/// Whether a 16 kHz recording holds something worth transcribing.
pub fn has_speech(pcm: &[f32]) -> bool {
    pcm.len() >= MIN_SAMPLES && pcm.iter().any(|s| s.abs() >= SILENCE_PEAK)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_averages_channels() {
        assert_eq!(to_mono(&[1.0, 0.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
        assert_eq!(to_mono(&[0.2, 0.4], 1), vec![0.2, 0.4]);
    }

    #[test]
    fn downsampling_48k_keeps_length_and_dc() {
        let input = vec![0.25; 48_000];
        let out = resample(&input, 48_000, MODEL_RATE);
        assert_eq!(out.len(), 16_000);
        assert!(out.iter().all(|s| (s - 0.25).abs() < 1e-6));
    }

    #[test]
    fn downsampling_44k1_has_the_right_length() {
        let out = resample(&vec![0.0; 44_100], 44_100, MODEL_RATE);
        assert_eq!(out.len(), 16_000);
    }

    #[test]
    fn downsampling_filters_the_highest_frequency() {
        // A 24 kHz square wave at 48 kHz: plain decimation would keep it, the box filter not.
        let input: Vec<f32> = (0..4_800)
            .map(|i| if i % 2 == 0 { 1.0 } else { -1.0 })
            .collect();
        let out = resample(&input, 48_000, MODEL_RATE);
        assert!(out.iter().all(|s| s.abs() < 0.34));
    }

    #[test]
    fn upsampling_interpolates() {
        assert_eq!(
            resample(&[0.0, 1.0], 8_000, 16_000),
            vec![0.0, 0.5, 1.0, 1.0]
        );
    }

    #[test]
    fn speech_needs_length_and_sound() {
        assert!(!has_speech(&vec![0.5; 100]));
        assert!(!has_speech(&vec![0.001; MIN_SAMPLES * 2]));
        let mut pcm = vec![0.0; MIN_SAMPLES];
        pcm[10] = 0.2;
        assert!(has_speech(&pcm));
    }

    #[test]
    fn level_is_bounded() {
        assert_eq!(level(&[]), 0.0);
        assert_eq!(level(&[1.0, -1.0]), 1.0);
        assert!(level(&[0.01; 10]) < 0.1);
    }
}
