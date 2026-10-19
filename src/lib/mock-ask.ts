/**
 * Simulated « Demander au projet » of the mock backend.
 * No agent: the question's words are looked up in the project's pages; the line holding
 * most of them is the answer, the page its source (always found). Without a match: « rien
 * trouvé ». The steps and the answer arrive as `ask_updated` events after a short delay.
 * Tests drive other cases with `fail` and `hang`.
 */

import type {
  Agent,
  AskEntry,
  AskInput,
  AskOverview,
  AskStarted,
  AskThread,
  AskUpdate,
  ErrorPayload,
} from "../bindings";
import type { NotePageRec } from "./mock-notes";

export const MOCK_NOTHING_FOUND =
  "Je n'ai rien trouvé dans le projet à ce sujet.";

interface Deps {
  /** Live pages of a project. */
  pages: (subjectId: string) => NotePageRec[];
  hasFolder: (subjectId: string) => boolean;
  /** The agent that would answer, `null` when none is installed. */
  agent: () => Agent | null;
  emit: (askId: string, update: AskUpdate) => void;
  now: () => string;
  /** Delay before each update; 0 in tests. */
  stepMs: number;
}

interface StoredQuestion extends AskEntry {
  subjectId: string;
}

const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const words = (q: string) =>
  fold(q)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4);

/** The page text without its Markdown marks. */
const plain = (line: string) =>
  line
    .replace(/\[\[(?:page|task):[^|\]]+\|([^\]]*)\]\]/g, "$1")
    .replace(/[*_=~`#>]/g, "")
    .trim();

export class MockAsk {
  questions: StoredQuestion[] = [];
  /** Tests: the next question fails (the agent stopped on an error). */
  fail = false;
  /** Tests: the next question never ends until `ask_stop`. */
  hang = false;
  private running = new Map<string, string>();
  private seq = 0;

  constructor(private readonly deps: Deps) {}

  reset(): void {
    this.questions = [];
    this.fail = false;
    this.hang = false;
    this.running.clear();
    this.seq = 0;
  }

  overview(subjectId: string): AskOverview {
    return {
      hasFolder: this.deps.hasFolder(subjectId),
      agent: this.deps.agent(),
      threads: this.threads(subjectId),
    };
  }

  threads(subjectId: string): AskThread[] {
    const byThread = new Map<string, StoredQuestion[]>();
    for (const q of this.questions) {
      if (q.subjectId !== subjectId) continue;
      byThread.set(q.threadId, [...(byThread.get(q.threadId) ?? []), q]);
    }
    return [...byThread.entries()]
      .map(([threadId, qs]) => ({
        threadId,
        question: qs[0].question,
        count: qs.length,
        askedAt: qs[qs.length - 1].askedAt,
      }))
      .sort((a, b) => b.askedAt.localeCompare(a.askedAt));
  }

  thread(threadId: string): AskEntry[] {
    return this.questions
      .filter((q) => q.threadId === threadId)
      .map(({ subjectId: _, ...e }) => structuredClone(e));
  }

  question(id: string): StoredQuestion {
    const q = this.questions.find((x) => x.id === id);
    if (!q) {
      throw {
        kind: "not_found",
        message: `question introuvable : ${id}`,
      } satisfies ErrorPayload;
    }
    return q;
  }

  async ask(input: AskInput): Promise<AskStarted> {
    const question = input.question.trim();
    if (!question) {
      throw {
        kind: "invalid",
        message: "empty question",
      } satisfies ErrorPayload;
    }
    const agent = this.deps.agent();
    if (!agent) {
      throw {
        kind: "claude_missing",
        message: "claude binary not found",
      } satisfies ErrorPayload;
    }
    if ([...this.running.values()].includes(input.subjectId)) {
      throw {
        kind: "invalid",
        message: "a question about this project is already running",
      } satisfies ErrorPayload;
    }
    this.seq += 1;
    const askId = `ask-${this.seq}`;
    const threadId = input.threadId ?? `thread-${this.seq}`;
    this.running.set(askId, input.subjectId);
    const fail = this.fail;
    const hang = this.hang;
    this.fail = false;
    this.hang = false;
    const later = (f: () => void) => setTimeout(f, this.deps.stepMs);
    later(() => {
      if (!this.running.has(askId)) return;
      this.deps.emit(askId, {
        kind: "step",
        step: { kind: "searchNotes", query: words(question).join(" ") },
      });
      if (hang) return;
      later(() => {
        if (!this.running.has(askId)) return;
        this.running.delete(askId);
        if (fail) {
          this.deps.emit(askId, {
            kind: "failed",
            message: "agent error",
            timedOut: false,
          });
          return;
        }
        const entry = this.answer(input.subjectId, threadId, agent, question);
        this.deps.emit(askId, { kind: "answer", entry });
      });
    });
    return { askId, threadId };
  }

  stop(askId: string): void {
    if (!this.running.delete(askId)) return;
    setTimeout(() => this.deps.emit(askId, { kind: "stopped" }), 0);
  }

  private answer(
    subjectId: string,
    threadId: string,
    agent: Agent,
    question: string,
  ): AskEntry {
    const ws = words(question);
    let best: { page: NotePageRec; line: string; score: number } | null = null;
    for (const page of this.deps.pages(subjectId)) {
      for (const raw of [page.title, ...page.body.split("\n")]) {
        const line = plain(raw);
        const score = ws.filter((w) => fold(line).includes(w)).length;
        if (line && score > 0 && (!best || score > best.score)) {
          best = { page, line, score };
        }
      }
    }
    const entry: StoredQuestion = {
      id: `question-${this.seq}`,
      threadId,
      agent,
      question,
      answer: best ? best.line : MOCK_NOTHING_FOUND,
      sources: best
        ? [
            {
              kind: "page",
              reference: best.page.id,
              quote: best.line,
              label: best.page.title,
              at: best.page.updatedAt,
              taskId: null,
              found: true,
            },
          ]
        : [],
      askedAt: this.deps.now(),
      subjectId,
    };
    this.questions.push(entry);
    const { subjectId: _, ...out } = entry;
    return structuredClone(out);
  }
}

/** Markdown of an answer for a page or a task's note, like the core's `ask::as_markdown`. */
export function askMarkdown(entry: AskEntry): string {
  const found = entry.sources.filter((s) => s.found);
  if (found.length === 0) return entry.answer;
  const lines = found.map((s) => {
    const label = s.label.replace(/[|[\]]/g, " ");
    const link =
      s.kind === "page"
        ? `[[page:${s.reference}|${label}]]`
        : s.kind === "task"
          ? `[[task:${s.reference}|${label}]]`
          : s.kind === "conversation" && s.taskId
            ? `Conversation de [[task:${s.taskId}|${label}]]`
            : `\`${s.reference}\``;
    return `- ${link} : « ${s.quote.trim()} »`;
  });
  return `${entry.answer}\n\n**Sources**\n${lines.join("\n")}\n`;
}
