/**
 * The mic at the bottom right of a Claude or Codex terminal.
 * Click: listen, click again: write the text. First time: a popover offers to download the
 * transcription model. While listening, a pill shows the level, the time and « Échap ».
 */

import { Loader2, Mic } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TerminalInfo, VoiceStatus } from "../../bindings";
import { Button } from "../../components/Button";
import { Popover } from "../../components/Popover";
import { t } from "../../i18n";
import { commands } from "../../lib/ipc";
import { run } from "../../lib/run";
import { useVoiceStatus } from "./useVoiceController";
import { canDictate, modelReady, toggleDictation, useVoice } from "./voice";

const BARS = 5;

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} Mo`;
}

/**
 * In a terminal (`terminal`), floating at its bottom right; in a text field (`targetId`, a
 * target registered with `setDictationTarget`), inline next to it.
 */
export function MicButton(
  props: { terminal: TerminalInfo } | { targetId: string },
) {
  const inTerminal = "terminal" in props;
  const id = inTerminal ? props.terminal.id : props.targetId;
  const status = useVoiceStatus();
  const phase = useVoice((s) => (s.terminalId === id ? s.phase : "idle"));
  const busyElsewhere = useVoice(
    (s) => s.phase !== "idle" && s.terminalId !== id,
  );
  const spaceHold = useVoice((s) => s.spaceHold);
  const [setupOpen, setSetupOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);

  const allowed = inTerminal
    ? canDictate(props.terminal, status)
    : status !== null && status.model.state !== "unavailable";
  if (!allowed) return null;
  const ready = modelReady(status);
  const listening = phase === "recording" || phase === "starting";

  const onClick = () => {
    if (!ready) setSetupOpen((open) => !open);
    else toggleDictation(id);
  };

  return (
    <div
      data-part="voice"
      className={`pointer-events-none flex items-center gap-2 ${
        inTerminal ? "absolute right-3 bottom-3 z-10" : "relative shrink-0"
      }`}
    >
      {/* Next to the button in a terminal; above it in a text field (no room beside). */}
      <div
        className={
          inTerminal
            ? "contents"
            : "absolute right-0 bottom-full mb-2 flex whitespace-nowrap"
        }
      >
        {listening && <ListeningPill />}
        {phase === "transcribing" && (
          <span className="flex items-center gap-2 rounded-full border border-border bg-elevated px-2.5 py-1 text-[12px] text-text-2 shadow-sm">
            <Loader2 aria-hidden size={12} className="animate-spin" />
            {t.voice.transcribing}
          </span>
        )}
      </div>
      <button
        ref={anchor}
        type="button"
        data-voice-button={id}
        data-listening={listening || undefined}
        aria-label={listening ? t.voice.stop : t.voice.dictate}
        aria-pressed={listening}
        title={listening ? t.voice.stop : t.voice.dictateHint(spaceHold)}
        disabled={busyElsewhere || phase === "transcribing"}
        // Keep the terminal (or the field) focused: Space must keep reaching it.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        className={`pointer-events-auto grid size-8 place-items-center rounded-full border shadow-sm transition-colors disabled:opacity-50 ${
          listening
            ? "border-accent bg-accent text-on-accent"
            : "border-border bg-elevated text-text-2 hover:text-text"
        }`}
      >
        <Mic aria-hidden size={15} />
      </button>
      {setupOpen && status && (
        <Popover
          anchorRef={anchor}
          label={t.voice.setupTitle}
          onClose={() => setSetupOpen(false)}
        >
          <Setup
            status={status}
            spaceHold={spaceHold}
            onDone={() => setSetupOpen(false)}
          />
        </Popover>
      )}
    </div>
  );
}

function ListeningPill() {
  const level = useVoice((s) => s.level);
  const startedAt = useVoice((s) => s.startedAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);
  const seconds = startedAt ? Math.max(0, (now - startedAt) / 1000) : 0;
  return (
    <span
      data-part="voice-listening"
      className="flex items-center gap-2 rounded-full border border-border bg-elevated px-2.5 py-1 text-[12px] text-text-2 shadow-sm"
    >
      <span
        aria-hidden
        className="size-1.5 animate-pulse rounded-full bg-accent"
      />
      <span aria-hidden className="flex h-3.5 items-center gap-[2px]">
        {Array.from({ length: BARS }, (_, i) => {
          // Middle bars move most, like a voice meter.
          const weight = 1 - Math.abs(i - (BARS - 1) / 2) / BARS;
          const height = 3 + Math.round(level * weight * 11);
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed bars
              key={i}
              className="w-[3px] rounded-full bg-accent transition-[height] duration-75"
              style={{ height }}
            />
          );
        })}
      </span>
      <span className="tabular-nums">
        {t.voice.listening} {seconds.toFixed(1).replace(".", ",")} s
      </span>
      <span className="text-text-3">· {t.voice.cancelHint}</span>
    </span>
  );
}

function Setup({
  status,
  spaceHold,
  onDone,
}: {
  status: VoiceStatus;
  spaceHold: boolean;
  onDone: () => void;
}) {
  const model = status.model;
  const percent =
    model.state === "downloading" && (model.total ?? 0) > 0
      ? Math.floor(((model.received ?? 0) / (model.total ?? 1)) * 100)
      : 0;
  return (
    <div className="flex w-[300px] flex-col gap-2.5 p-3.5 text-[13px]">
      <p className="font-medium text-text">{t.voice.setupTitle}</p>
      {model.state === "ready" ? (
        <>
          <p className="text-text-2">
            {spaceHold ? t.voice.ready : t.voice.readyNoSpace}
          </p>
          <div className="flex justify-end">
            <Button size="sm" variant="primary" onClick={onDone}>
              OK
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-text-2">
            {t.voice.setupBody(megabytes(status.modelSize ?? 0))}
          </p>
          <p className="text-[12px] text-text-3">{t.voice.setupLanguages}</p>
          {model.state === "failed" && (
            <p className="text-[12px] text-due-overdue">{t.voice.failed}</p>
          )}
          {model.state === "downloading" ? (
            <div className="flex flex-col gap-1.5">
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-label={t.voice.downloading(percent)}
                className="h-1.5 overflow-hidden rounded-full bg-hover"
              >
                <div
                  className="h-full rounded-full bg-accent transition-[width]"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <span className="text-[12px] text-text-3 tabular-nums">
                {t.voice.downloading(percent)}
              </span>
            </div>
          ) : (
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="primary"
                data-autofocus
                onClick={() => void run(commands.voiceDownloadModel())}
              >
                {model.state === "failed" ? t.voice.retry : t.voice.download}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
