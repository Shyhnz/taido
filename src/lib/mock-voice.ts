/**
 * Simulated dictation of the mock backend. No microphone: the
 * model starts missing and its download runs in a moment; `voice_stop` returns the next
 * sample sentence. Tests drive other cases with `state`.
 */

import type { ErrorPayload, VoiceModelState, VoiceStatus } from "../bindings";

/** Size of the real model download (core `voice::model::PARAKEET_V3`). */
export const MOCK_VOICE_MODEL_SIZE = 548_946_272;

/** Sentences `voice_stop` returns, in turn. */
export const MOCK_VOICE_SENTENCES = [
  "Peux-tu ajouter un bouton pour exporter les temps en CSV dans l'onglet projet ?",
  "Could you check why the terminal flickers when the app starts?",
];

export class MockVoice {
  model: VoiceModelState = { state: "missing" };
  recording: string | null = null;
  /** Tests: `voice_start` refuses with `mic_denied`. */
  micDenied = false;
  /** Tests: `voice_stop` returns "" (nothing heard). */
  silent = false;
  private next = 0;
  private levelTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly onChange: (status: VoiceStatus) => void,
    private readonly onLevel: (level: number) => void,
    /** Delay between download steps; 0 in tests. */
    private readonly stepMs = 80,
  ) {}

  reset(): void {
    this.stopLevels();
    this.model = { state: "missing" };
    this.recording = null;
    this.micDenied = false;
    this.silent = false;
    this.next = 0;
  }

  status(): VoiceStatus {
    return {
      model: this.model,
      modelSize: MOCK_VOICE_MODEL_SIZE,
      recording: this.recording,
    };
  }

  private changed(): void {
    this.onChange(this.status());
  }

  async download(): Promise<null> {
    if (this.model.state === "ready" || this.model.state === "downloading")
      return null;
    const total = MOCK_VOICE_MODEL_SIZE;
    for (let step = 0; step <= 10; step++) {
      this.model = {
        state: "downloading",
        received: (total * step) / 10,
        total,
      };
      this.changed();
      if (this.stepMs > 0)
        await new Promise((resolve) => setTimeout(resolve, this.stepMs));
    }
    this.model = { state: "ready" };
    this.changed();
    return null;
  }

  async start(terminalId: string): Promise<null> {
    if (this.model.state !== "ready") throw voiceUnavailable();
    if (this.micDenied) {
      const error: ErrorPayload = {
        kind: "mic_denied",
        message: "microphone access refused",
      };
      throw error;
    }
    this.recording = terminalId;
    this.changed();
    this.stopLevels();
    if (this.stepMs > 0) {
      this.levelTimer = setInterval(
        () => this.onLevel(0.2 + Math.random() * 0.6),
        60,
      );
    }
    return null;
  }

  async stop(): Promise<string> {
    if (this.recording === null) return "";
    this.recording = null;
    this.stopLevels();
    this.changed();
    if (this.silent) return "";
    const text = MOCK_VOICE_SENTENCES[this.next % MOCK_VOICE_SENTENCES.length];
    this.next++;
    return text;
  }

  async cancel(): Promise<null> {
    if (this.recording === null) return null;
    this.recording = null;
    this.stopLevels();
    this.changed();
    return null;
  }

  private stopLevels(): void {
    if (this.levelTimer !== null) clearInterval(this.levelTimer);
    this.levelTimer = null;
  }
}

function voiceUnavailable(): ErrorPayload {
  return {
    kind: "voice_unavailable",
    message: "dictation unavailable: the voice model is not downloaded",
  };
}
