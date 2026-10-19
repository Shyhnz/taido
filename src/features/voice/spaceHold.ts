/**
 * « Garder Espace enfoncée pour dicter ». The space is held back
 * instead of typed: released within `HOLD_MS` it is typed as usual, held longer it starts the
 * dictation, which stops on release. Nothing is typed then removed. Another key pressed while
 * the space waits types the space first, so fast typing keeps its order.
 */

/** How long Space must be held before it means « dicter ». */
export const HOLD_MS = 300;

export interface KeyLike {
  type: string;
  key: string;
  code: string;
  repeat: boolean;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
}

export interface SpaceHoldActions {
  start: (terminalId: string) => void;
  stop: () => void;
  typeSpace: (terminalId: string) => void;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
}

type Phase = "idle" | "pending" | "held" | "typed";

export class SpaceHold {
  private phase: Phase = "idle";
  private terminalId: string | null = null;
  private timer: unknown = null;

  constructor(private readonly actions: SpaceHoldActions) {}

  get holding(): boolean {
    return this.phase === "held";
  }

  /**
   * Called with every key event of a terminal. `enabled`: an agent terminal, the setting on,
   * the model ready. Returns true when the event is consumed (xterm must ignore it).
   */
  handle(terminalId: string, e: KeyLike, enabled: boolean): boolean {
    const isSpace = e.code === "Space" || e.key === " ";
    if (!isSpace) {
      if (e.type === "keydown" && this.phase === "pending") this.typeNow();
      return false;
    }
    if (this.phase === "idle") {
      const plain =
        !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing;
      if (e.type !== "keydown" || e.repeat || !enabled || !plain) return false;
      this.phase = "pending";
      this.terminalId = terminalId;
      this.timer = this.actions.setTimer(() => {
        this.timer = null;
        this.phase = "held";
        this.actions.start(terminalId);
      }, HOLD_MS);
      return true;
    }
    // Waiting, held or already typed: repeats and keypress are swallowed until release.
    if (e.type === "keyup") this.release();
    return true;
  }

  /** The window lost the focus: a release will not come. */
  blur(): void {
    if (this.phase === "pending") this.typeNow();
    if (this.phase !== "idle") this.release();
  }

  private typeNow(): void {
    this.clear();
    if (this.terminalId !== null) this.actions.typeSpace(this.terminalId);
    this.phase = "typed";
  }

  private release(): void {
    const was = this.phase;
    this.clear();
    if (was === "pending" && this.terminalId !== null)
      this.actions.typeSpace(this.terminalId);
    if (was === "held") this.actions.stop();
    this.phase = "idle";
    this.terminalId = null;
  }

  private clear(): void {
    if (this.timer !== null) this.actions.clearTimer(this.timer);
    this.timer = null;
  }
}
