/**
 * The first-launch guide on screen:
 * the welcome card, a bubble per step pointing at what to use, and the closing card.
 *
 * The veil around the pointed element never blocks a click: the user may go anywhere, the
 * guide follows what happens. « Passer cette étape » and « Quitter le guide » are always there.
 * The bubble never steals the keyboard focus (the user types in the app), and keeps out of the
 * way of the dialogs except ⌘N, which it explains.
 */

import { X } from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Ring } from "../../bindings";
import { Button, IconButton } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { announce } from "../../components/LiveRegion";
import { showToast } from "../../components/Toast";
import { t as strings } from "../../i18n";
import { useDefaultAgent } from "../../lib/agent";
import { features } from "../../lib/features";
import { errorMessage } from "../../lib/ipc";
import { useSettings, useSubjects, useTask } from "../../lib/queries";
import { type ClaudeProblem, type DialogState, useUi } from "../../stores/ui";
import { useBoard } from "../board/BoardView";
import { checkAgentStatus, claudeProblem } from "../claude-check/claudeCheck";
import { useSyncStatus } from "../sync/useSyncStatus";
import { PriorityRing } from "../task-row/PriorityRing";
import { StateDot } from "../task-row/StateDot";
import { AgentChoiceCard } from "./AgentChoiceCard";
import {
  type Box,
  boardColumnOf,
  placeBubble,
  type Side,
  STEP_COUNT,
  type StepId,
  stepNumber,
  type TutorialRun,
  talkPhase,
} from "./model";
import { PromptBox } from "./PromptBox";
import { useTutorial } from "./store";
import { TutorialDriver } from "./TutorialDriver";
import { stepTitle, useTutorialTexts } from "./texts";

const BUBBLE_WIDTH = 340;
/** How often the bubble follows its element (it moves with scrolling, panels, typing). */
const FOLLOW_MS = 150;
/** Room left around the highlighted element. */
const SPOTLIGHT_PAD = 4;

export function TutorialLayer() {
  const run = useTutorial((s) => s.run);
  if (!features.tutorial || run === null) return null;
  return (
    <>
      <TutorialDriver run={run} />
      {run.step === "welcome" ? (
        <WelcomeOrAgentChoice />
      ) : run.step === "done" ? (
        <DoneCard />
      ) : (
        <StepBubble run={run} />
      )}
    </>
  );
}

/** The AI is asked first, once; then the welcome card. */
function WelcomeOrAgentChoice() {
  const settings = useSettings().data;
  if (!settings) return null;
  return settings.agentChosen ? <WelcomeCard /> : <AgentChoiceCard />;
}

/** « Quitter le guide », « Non merci »: over, with where to find it again. */
function leave() {
  useTutorial.getState().finish();
  showToast({ message: strings.tutorial.left });
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

const PREVIEW_RINGS: Ring[] = ["working", "waiting", "done"];

function WelcomeCard() {
  const t = useTutorialTexts().welcome;
  const agent = useDefaultAgent();
  const dispatch = useTutorial((s) => s.dispatch);
  const dialog = useUi((s) => s.dialog);
  // Another dialog (Réglages after « Revoir le guide ») goes first.
  if (dialog !== null) return null;
  return (
    <Dialog
      title={t.title(strings.appName)}
      hideTitle
      onClose={leave}
      width={460}
    >
      <div className="px-6 pt-6 pb-5">
        <p aria-hidden className="text-[22px] leading-7 font-bold">
          {t.title(strings.appName)}
        </p>
        <p className="mt-2 text-body text-text-2">{t.text}</p>
        <ul className="mt-4 flex flex-col gap-1 rounded-lg border border-border bg-bg px-3 py-2">
          {PREVIEW_RINGS.map((ring, i) => (
            <li key={ring} className="flex h-7 items-center gap-2.5">
              <PriorityRing priority={1} completed={false} size={20} />
              <span className="text-[13.5px]">{t.examples[i]}</span>
              <StateDot ring={ring} agent={agent} />
              <span className="ml-auto text-[12px] text-text-3">
                {strings.ring.state(ring, agent)}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-body font-medium">{t.ask}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={leave}>
            {t.decline}
          </Button>
          <Button
            variant="primary"
            data-autofocus
            onClick={() => dispatch({ type: "start" })}
          >
            {t.start}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function DoneCard() {
  const t = useTutorialTexts().done;
  const finish = useTutorial((s) => s.finish);
  const dialog = useUi((s) => s.dialog);
  // « Créer mon compte » opened the settings: the card waits for them.
  if (dialog !== null) return null;
  return (
    <Dialog title={t.title} onClose={finish} width={460}>
      <div className="px-5 pt-1 pb-5">
        <p className="text-body text-text-2">{t.text}</p>
        <dl className="mt-3 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2">
          {t.shortcuts.map(([keys, label]) => (
            <div key={keys} className="contents">
              <dt>
                <kbd className="rounded border border-border bg-bg px-1.5 py-0.5 font-sans text-[12px] text-text-2">
                  {keys}
                </kbd>
              </dt>
              <dd className="text-[13.5px]">{label}</dd>
            </div>
          ))}
        </dl>
        <h3 className="mt-5 text-[13.5px] font-semibold">{t.more.title}</h3>
        <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5 text-[13.5px] text-text-2">
          {t.more.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <div className="mt-5 flex justify-end">
          <Button variant="primary" data-autofocus onClick={finish}>
            {t.finish}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Bubble
// ---------------------------------------------------------------------------

interface Target {
  /** Highlighted element, tried in order; `[]` docks the bubble at the bottom of the window. */
  selectors: string[];
  /**
   * The bubble goes above or under this element (a whole row), while its arrow points at the
   * highlighted one (a dot, a ring in that row).
   */
  around?: string;
  /** Sides tried in order. */
  sides: Side[];
  /** Dims the rest of the window (never blocks it). */
  veil: boolean;
}

// Task ids come from the core (UUIDs): safe inside the quotes.
const rowOf = (taskId: string | null) =>
  taskId ? `[data-task-id="${taskId}"]` : "[data-task-id]";
/** The task's card on the kanban. */
const cardOf = (taskId: string | null) =>
  taskId ? `[data-card="${taskId}"]` : "[data-card]";

function targetOf(run: TutorialRun): Target {
  const row = rowOf(run.taskId);
  switch (run.step) {
    case "project":
      return {
        selectors: ['[data-tutorial="new-project"]'],
        sides: ["right", "bottom"],
        veil: true,
      };
    case "task":
      return {
        selectors: ['[data-tutorial="add-task"]'],
        sides: ["bottom", "top", "right"],
        veil: true,
      };
    case "open":
      return { selectors: [row], sides: ["bottom", "top"], veil: true };
    case "claude":
      return {
        selectors: ['[data-tutorial="launch-claude"]'],
        sides: ["left", "bottom", "top"],
        veil: true,
      };
    case "talk":
      // Under the row, never over the terminal; no veil, the terminal stays bright.
      return {
        selectors: [`${row} [data-state-dot]`, row],
        around: row,
        sides: ["bottom", "top"],
        veil: false,
      };
    case "kanban":
      // The card once the kanban shows, else the « Kanban » tab.
      return {
        selectors: [cardOf(run.taskId), '[data-tutorial="board-tab"]'],
        sides: ["right", "bottom", "left"],
        veil: false,
      };
    case "file": {
      // The « Pièces jointes » zone of the open panel, else the task in the list or kanban.
      const zone = run.taskId
        ? `[data-attach-task="${run.taskId}"]`
        : "[data-attach-task]";
      return {
        selectors: [`${zone} [data-drop-zone]`, zone, row, cardOf(run.taskId)],
        sides: ["left", "bottom", "top"],
        veil: false,
      };
    }
    case "complete":
      return {
        selectors: [`${row} [data-priority-ring]`],
        around: row,
        sides: ["bottom", "top"],
        veil: true,
      };
    case "account":
      return {
        selectors: ['[data-tutorial="settings"]'],
        sides: ["right", "bottom"],
        veil: true,
      };
    default:
      return { selectors: [], sides: [], veil: false };
  }
}

/** The dialog a step is about (⌘N): the bubble stays over it, docked at the bottom. */
function isStepDialog(step: StepId, dialog: DialogState | null): boolean {
  if (dialog?.type === "addTask") return step === "task" || step === "quickAdd";
  return false;
}

function sameBox(a: Box | null, b: Box | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height
  );
}

interface Screen {
  /** Where the first element matching the selectors is, `null` when not shown. */
  box: Box | null;
  /** Where the `around` element is. */
  around: Box | null;
  /** A modal dialog is open (Réglages, a confirmation, ⌘N…). */
  modal: boolean;
}

function boxOf(el: Element | null): Box | null {
  const r = el?.getBoundingClientRect();
  return r && r.width > 0 && r.height > 0
    ? { left: r.left, top: r.top, width: r.width, height: r.height }
    : null;
}

/** Follows the pointed element (scrolled into view once) and the modal dialogs. */
function useScreen(selectors: string[], around: string | undefined): Screen {
  const [screen, setScreen] = useState<Screen>({
    box: null,
    around: null,
    modal: false,
  });
  const key = selectors.join("\n");

  useEffect(() => {
    let scrolled = false;
    const read = () => {
      let el: Element | null = null;
      for (const selector of key ? key.split("\n") : []) {
        el = document.querySelector(selector);
        if (el) break;
      }
      const box = boxOf(el);
      const aroundBox = around ? boxOf(document.querySelector(around)) : null;
      if (el && box && !scrolled) {
        scrolled = true;
        if (box.top < 0 || box.top + box.height > window.innerHeight) {
          el.scrollIntoView?.({ block: "center" });
        }
      }
      const modal = document.querySelector('[aria-modal="true"]') !== null;
      setScreen((prev) =>
        prev.modal === modal &&
        sameBox(prev.box, box) &&
        sameBox(prev.around, aroundBox)
          ? prev
          : { box, around: aroundBox, modal },
      );
    };
    read();
    const timer = setInterval(read, FOLLOW_MS);
    window.addEventListener("resize", read);
    return () => {
      clearInterval(timer);
      window.removeEventListener("resize", read);
    };
  }, [key, around]);

  return screen;
}

function useViewport() {
  const [size, setSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useEffect(() => {
    const onResize = () =>
      setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

function StepBubble({ run }: { run: TutorialRun }) {
  const agent = useDefaultAgent();
  const stepDialog = useUi((s) => isStepDialog(run.step, s.dialog));
  const target = targetOf(run);
  const screen = useScreen(target.selectors, target.around);
  // Over its own dialog the bubble docks; any other dialog (a confirmation…) goes first.
  const box = screen.modal ? null : screen.box;
  // Above or under the whole `around` element, the arrow on the highlighted one.
  const anchor =
    box && screen.around
      ? {
          left: box.left,
          width: box.width,
          top: screen.around.top,
          height: screen.around.height,
        }
      : box;
  const viewport = useViewport();
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const titleId = useId();

  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0;
    if (h !== height) setHeight(h);
  });

  if (screen.modal && !stepDialog) return null;

  const n = stepNumber(run.step) ?? 0;
  const placement = anchor
    ? placeBubble(
        anchor,
        { width: BUBBLE_WIDTH, height },
        viewport,
        target.sides,
      )
    : null;
  const style: CSSProperties = placement
    ? { left: placement.left, top: placement.top, width: BUBBLE_WIDTH }
    : {
        left: Math.max(12, (viewport.width - BUBBLE_WIDTH) / 2),
        bottom: 24,
        width: BUBBLE_WIDTH,
      };

  return (
    <>
      {box && (
        <div
          aria-hidden
          data-tutorial-spotlight
          className="pointer-events-none fixed z-50 rounded-[10px] motion-safe:transition-all motion-safe:duration-200"
          style={{
            left: box.left - SPOTLIGHT_PAD,
            top: box.top - SPOTLIGHT_PAD,
            width: box.width + SPOTLIGHT_PAD * 2,
            height: box.height + SPOTLIGHT_PAD * 2,
            outline: "2px solid var(--accent)",
            outlineOffset: 0,
            boxShadow: target.veil ? "0 0 0 200vmax var(--overlay)" : undefined,
          }}
        />
      )}
      <div
        ref={ref}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        data-tutorial-bubble={run.step}
        className="fixed z-50 motion-safe:transition-[left,top] motion-safe:duration-200"
        style={style}
      >
        {placement && <Arrow side={placement.side} at={placement.arrow} />}
        <div className="relative rounded-xl border border-border bg-elevated px-4 pt-3 pb-3 shadow-pop">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-medium text-text-3">
              {strings.tutorial.stepOf(n, STEP_COUNT)}
            </span>
            <IconButton
              label={strings.tutorial.quit}
              size={24}
              className="-mr-1.5"
              onClick={leave}
            >
              <X size={14} aria-hidden />
            </IconButton>
          </div>
          <h2 id={titleId} className="text-[15px] leading-5 font-semibold">
            {stepTitle(run.step, agent)}
          </h2>
          <StepBody run={run} />
        </div>
      </div>
    </>
  );
}

/** The bubble's tip: a diamond half hidden under the bubble, on the side facing the element. */
function Arrow({ side, at }: { side: Side; at: number }) {
  const half = 6;
  const style: CSSProperties =
    side === "right"
      ? { left: -half, top: at - half }
      : side === "left"
        ? { right: -half, top: at - half }
        : side === "bottom"
          ? { top: -half, left: at - half }
          : { bottom: -half, left: at - half };
  return (
    <span
      aria-hidden
      className="absolute h-3 w-3 rotate-45 border border-border bg-elevated"
      style={style}
    />
  );
}

function Text({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1.5 text-[13.5px] leading-5 text-text-2">{children}</p>
  );
}

function Footer({ children }: { children?: ReactNode }) {
  const dispatch = useTutorial((s) => s.dispatch);
  return (
    <div className="mt-3 flex items-center justify-end gap-1.5">
      {children ?? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => dispatch({ type: "next" })}
        >
          {strings.tutorial.skip}
        </Button>
      )}
    </div>
  );
}

function StepBody({ run }: { run: TutorialRun }) {
  const t = useTutorialTexts();
  switch (run.step) {
    case "project":
      return (
        <>
          <Text>{t.project.text}</Text>
          <Footer />
        </>
      );
    case "task":
      return (
        <>
          <Text>{t.task.text}</Text>
          <Footer />
        </>
      );
    case "open":
      return (
        <>
          <Text>{t.open.text}</Text>
          <Footer />
        </>
      );
    case "claude":
      return <ClaudeBody />;
    case "talk":
      return <TalkBody run={run} />;
    case "kanban":
      return <KanbanBody taskId={run.taskId} />;
    case "file":
      return (
        <>
          <Text>{t.file.text}</Text>
          <Footer />
        </>
      );
    case "quickAdd":
      return <QuickAddBody subjectId={run.subjectId} />;
    case "complete":
      return <CompleteBody taskId={run.taskId} />;
    case "account":
      return <AccountBody />;
    default:
      return null;
  }
}

type ClaudeCheck = "checking" | "ready" | ClaudeProblem;

/** « Lance Claude »: Claude Code is checked first, so a missing one is explained right here. */
function ClaudeBody() {
  const t = useTutorialTexts().claude;
  const agent = useDefaultAgent();
  const dispatch = useTutorial((s) => s.dispatch);
  const [check, setCheck] = useState<ClaudeCheck>("checking");

  const run = useCallback(async () => {
    setCheck("checking");
    try {
      const status = await checkAgentStatus(agent);
      setCheck(claudeProblem(status) ?? "ready");
    } catch (error) {
      // A check that fails by itself does not block (as before any Claude launch).
      console.error(errorMessage(error), error);
      setCheck("ready");
    }
  }, [agent]);

  useEffect(() => {
    void run();
  }, [run]);

  useEffect(() => {
    if (check === "missing") announce(t.missing);
    if (check === "notLoggedIn") announce(t.notLoggedIn);
  }, [check, t]);

  if (check === "checking" || check === "ready") {
    return (
      <>
        <Text>{check === "checking" ? t.checking : t.ready}</Text>
        <Footer />
      </>
    );
  }
  return (
    <>
      <Text>{check === "missing" ? t.missing : t.notLoggedIn}</Text>
      <Footer>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => dispatch({ type: "skipClaude" })}
        >
          {t.skipPart}
        </Button>
        <Button variant="primary" size="sm" onClick={() => void run()}>
          {t.retry}
        </Button>
      </Footer>
    </>
  );
}

/** « Parle à Claude »: what to write, then each colour of the dot as it shows. */
function TalkBody({ run }: { run: TutorialRun }) {
  const t = useTutorialTexts().talk;
  const agent = useDefaultAgent();
  const dispatch = useTutorial((s) => s.dispatch);
  const phase = talkPhase(run.ring);
  const said: Record<typeof phase, string | null> = {
    ask: null,
    working: t.working,
    waiting: t.waiting,
    done: t.done,
    error: t.error,
  };
  const message = said[phase];

  useEffect(() => {
    if (message) announce(message);
  }, [message]);

  if (phase === "ask") {
    return (
      <>
        <Text>{t.ask}</Text>
        <PromptBox text={t.prompt} />
        <Text>{t.watch}</Text>
        <Footer />
      </>
    );
  }
  const ring: Ring | null = phase === "error" ? null : phase;
  const over = phase === "done" || phase === "error";
  return (
    <>
      <p className="mt-1.5 flex gap-2 text-[13.5px] leading-5 text-text">
        {ring && (
          <span className="mt-1 shrink-0">
            <StateDot ring={ring} agent={agent} />
          </span>
        )}
        <span>{message}</span>
      </p>
      {phase === "done" && !run.sawWaiting && <Text>{t.noRed}</Text>}
      {over ? (
        <Footer>
          <Button
            variant="primary"
            size="sm"
            onClick={() => dispatch({ type: "next" })}
          >
            {t.next}
          </Button>
        </Footer>
      ) : (
        <Footer />
      )}
    </>
  );
}

function QuickAddBody({ subjectId }: { subjectId: string | null }) {
  const t = useTutorialTexts().quickAdd;
  const subjects = useSubjects().data;
  const name = subjects?.find((s) => s.id === subjectId)?.name ?? null;
  return (
    <>
      <Text>{t.text(name)}</Text>
      <Text>{t.hint}</Text>
      <Footer />
    </>
  );
}

function KanbanBody({ taskId }: { taskId: string | null }) {
  const t = useTutorialTexts().kanban;
  const task = useTask(taskId).data;
  const mine = task && task.id === taskId ? task : null;
  const title = mine?.title ?? null;
  const board = useBoard(mine?.subject?.id ?? null).data;
  // Where the card is now (Claude moves it when it starts) and the next column to try.
  const columns = board?.columns ?? [];
  const column =
    board && mine
      ? boardColumnOf(board, mine.id, mine.completedAt != null)
      : null;
  const at = columns.findIndex((c) => c.id === column);
  const moved = at > 0 && !columns[at].isDone;
  // Already in the last column of a custom board: no column to suggest.
  const target = moved
    ? (columns[at + 1]?.name ?? null)
    : (columns[1]?.name ?? t.fallbackTarget);
  return (
    <>
      {moved && <Text>{t.already(columns[at].name)}</Text>}
      {target !== null && <Text>{t.text(title, target)}</Text>}
      <Text>{t.hint}</Text>
      <Footer />
    </>
  );
}

function CompleteBody({ taskId }: { taskId: string | null }) {
  const task = useTask(taskId).data;
  const title = task && task.id === taskId ? task.title : null;
  const t = useTutorialTexts();
  return (
    <>
      <Text>{t.complete.text(title)}</Text>
      <Footer />
    </>
  );
}

/** « Crée ton compte »: Réglages › Compte, or « Continuer » when an account is linked. */
function AccountBody() {
  const t = useTutorialTexts().account;
  const dispatch = useTutorial((s) => s.dispatch);
  const state = useSyncStatus().data?.state;
  const next = () => dispatch({ type: "next" });
  // Nothing until the status is known: never the wrong version first.
  if (state === undefined) return null;
  if (state !== "unlinked") {
    return (
      <>
        <Text>{t.linked}</Text>
        <Footer>
          <Button variant="primary" size="sm" onClick={next}>
            {t.next}
          </Button>
        </Footer>
      </>
    );
  }
  return (
    <>
      <Text>{t.text}</Text>
      <Footer>
        <Button variant="ghost" size="sm" onClick={next}>
          {t.later}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            next();
            useUi.getState().openDialog({ type: "settings", tab: "sync" });
          }}
        >
          {t.open}
        </Button>
      </Footer>
    </>
  );
}
