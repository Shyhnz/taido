/**
 * Simulated terminals of the mock backend (browser `pnpm dev`, tests). No process runs: each
 * terminal is a tiny line-echoing shell, enough to see the panel, the tabs, the replay on
 * re-attach and the exit of a process. Typing `exit` ends the "process" (code 0).
 *
 * Claude terminals hand their lines (and a lone Escape) to the simulated sessions of
 * src/lib/mock-sessions.ts instead of echoing them.
 *
 * Mirrors the core rules: one subscriber per terminal (attaching replaces it), the
 * buffer is replayed on attach, an exited terminal keeps its tab until it is closed.
 */

import type { TerminalInfo, TerminalSize } from "../bindings";
import { activeLanguage } from "../i18n";

const encoder = new TextEncoder();

interface MockTerminal {
  info: TerminalInfo;
  size: TerminalSize;
  /** Everything "printed" so far, replayed on attach. */
  buffer: string;
  /** Line being typed. */
  line: string;
  subscriber: ((bytes: Uint8Array) => void) | null;
}

const SHELL_PROMPT = "\x1b[1;34m~\x1b[0m $ ";
/** Prompt of a simulated Claude Code. */
export const CLAUDE_PROMPT = "\x1b[2m›\x1b[0m ";

const promptOf = (info: TerminalInfo) =>
  info.kind === "agent" ? CLAUDE_PROMPT : SHELL_PROMPT;

export interface MockTerminalHooks {
  /** A process ended (typed `exit`, or `exitProcess`). */
  onExit: (info: TerminalInfo) => void;
  /** A line typed in a Claude terminal (Enter). The handler prints its own output. */
  onClaudeLine?: (info: TerminalInfo, line: string) => void;
  /** A lone Escape typed in a Claude terminal. */
  onClaudeEscape?: (info: TerminalInfo) => void;
}

export class MockTerminals {
  private terms = new Map<string, MockTerminal>();
  private hooks: MockTerminalHooks;

  constructor(hooks: MockTerminalHooks | ((info: TerminalInfo) => void)) {
    this.hooks = typeof hooks === "function" ? { onExit: hooks } : hooks;
  }

  /** Sets the Claude handlers (the sessions are created after the terminals). */
  setClaudeHandlers(
    handlers: Pick<MockTerminalHooks, "onClaudeLine" | "onClaudeEscape">,
  ): void {
    this.hooks = { ...this.hooks, ...handlers };
  }

  reset(): void {
    this.terms.clear();
  }

  list(): TerminalInfo[] {
    return [...this.terms.values()].map((t) => structuredClone(t.info));
  }

  forTask(taskId: string): TerminalInfo[] {
    return this.list().filter((t) => t.taskId === taskId);
  }

  /** The terminal, or `null` when it is not kept anymore. */
  find(id: string): TerminalInfo | null {
    const t = this.terms.get(id);
    return t ? structuredClone(t.info) : null;
  }

  /** A conversation change (`/clear`) attaches another session to the same terminal. */
  setAgentSession(id: string, agentSessionId: string): void {
    const t = this.terms.get(id);
    if (t) t.info.agentSessionId = agentSessionId;
  }

  open(info: TerminalInfo, size: TerminalSize, banner: string): TerminalInfo {
    const term: MockTerminal = {
      info,
      size,
      buffer: `${banner}\r\n${promptOf(info)}`,
      line: "",
      subscriber: null,
    };
    this.terms.set(info.id, term);
    return structuredClone(info);
  }

  private get(id: string): MockTerminal {
    const t = this.terms.get(id);
    if (!t) {
      throw { kind: "not_found", message: `terminal introuvable : ${id}` };
    }
    return t;
  }

  private emit(t: MockTerminal, text: string): void {
    t.buffer += text;
    t.subscriber?.(encoder.encode(text));
  }

  /** Prints text in a running terminal (simulated program output). */
  print(id: string, text: string): void {
    const t = this.terms.get(id);
    if (t?.info.running) this.emit(t, text);
  }

  /** Prints the prompt again after a simulated output. */
  prompt(id: string): void {
    const t = this.terms.get(id);
    if (t?.info.running) this.emit(t, promptOf(t.info));
  }

  attach(id: string, onData: (bytes: Uint8Array) => void): TerminalSize {
    const t = this.get(id);
    t.subscriber = onData;
    if (t.buffer.length > 0) onData(encoder.encode(t.buffer));
    return { ...t.size };
  }

  detach(id: string): void {
    const t = this.terms.get(id);
    if (t) t.subscriber = null;
  }

  resize(id: string, size: TerminalSize): void {
    this.get(id).size = { ...size };
  }

  write(id: string, data: string): void {
    const t = this.get(id);
    if (!t.info.running) return;
    const claude = t.info.kind === "agent";
    if (claude && data === "\x1b") {
      this.hooks.onClaudeEscape?.(structuredClone(t.info));
      return;
    }
    for (const ch of data) {
      if (ch === "\r") {
        const cmd = t.line.trim();
        t.line = "";
        this.emit(t, "\r\n");
        if (claude && this.hooks.onClaudeLine) {
          if (cmd.length === 0) this.emit(t, promptOf(t.info));
          else this.hooks.onClaudeLine(structuredClone(t.info), cmd);
          if (!t.info.running) return;
          continue;
        }
        if (cmd === "exit") {
          this.exit(t, 0);
          return;
        }
        if (cmd.length > 0) {
          this.emit(
            t,
            `(${activeLanguage === "fr" ? "simulé" : "simulated"}) ${cmd}\r\n`,
          );
        }
        this.emit(t, promptOf(t.info));
      } else if (ch === "\x7f") {
        if (t.line.length > 0) {
          t.line = t.line.slice(0, -1);
          this.emit(t, "\b \b");
        }
      } else if (ch >= " " || ch === "\n") {
        t.line += ch;
        this.emit(t, ch === "\n" ? "\r\n" : ch);
      }
    }
  }

  /** Ends the simulated process of a terminal (its tab stays). */
  exitProcess(id: string, code: number | null): void {
    const t = this.terms.get(id);
    if (t?.info.running) this.exit(t, code);
  }

  private exit(t: MockTerminal, code: number | null): void {
    t.info.running = false;
    t.info.exitCode = code;
    this.emit(t, `\r\n[Processus terminé, code ${code ?? "?"}]\r\n`);
    this.hooks.onExit(structuredClone(t.info));
  }

  /** Forgets the terminal (its tab); a running one is "killed" first. */
  close(id: string): TerminalInfo | null {
    const t = this.terms.get(id);
    if (!t) return null;
    this.terms.delete(id);
    return t.info;
  }

  /** Closes every terminal of a task (completion, deletion). */
  closeTask(taskId: string): TerminalInfo[] {
    const closed: TerminalInfo[] = [];
    for (const t of [...this.terms.values()]) {
      if (t.info.taskId === taskId) {
        this.terms.delete(t.info.id);
        closed.push(t.info);
      }
    }
    return closed;
  }
}
