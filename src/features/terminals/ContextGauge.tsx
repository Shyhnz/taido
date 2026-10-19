/**
 * The tab's context gauge, option C « le fil sous l'onglet » (2026-10-11): the line
 * under the active tab fills as the conversation's memory (context window) fills. The
 * percentage shows on hover, and stays from 70 % on, when the agent will soon summarise the
 * conversation. Hovering the tab opens a bubble with the details. Grey, then the overdue
 * orange: red stays for « Claude attend » (tokens.css, D8).
 */

import {
  type FocusEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { Agent, ContextUsage } from "../../bindings";
import { agentName, t as strings } from "../../i18n";

/** From here the gauge turns orange and keeps its percentage. */
export const CONTEXT_HIGH = 70;
/** Hover delay before the bubble, like a native tooltip but shorter. */
const BUBBLE_DELAY = 300;
const GAP = 8;
const MARGIN = 8;
const BUBBLE_WIDTH = 248;

export const isHigh = (u: ContextUsage) => u.percent >= CONTEXT_HIGH;

/** « 149 k », « 1 M », « 258 k ». */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1).replace(".", ",")} M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)} k`;
  return String(n);
}

/** The 2 px line under the tab, filled up to the usage. Its parent is `relative`. */
export function ContextThread({ usage }: { usage: ContextUsage }) {
  return (
    <span
      aria-hidden
      data-testid="context-thread"
      className="pointer-events-none absolute inset-x-2 -bottom-px h-0.5 overflow-hidden rounded-full bg-border-terminal"
    >
      <span
        className={`block h-full rounded-full transition-[width,background-color] duration-300 motion-reduce:transition-none ${
          isHigh(usage) ? "bg-due-overdue" : "bg-[var(--state-idle)]"
        }`}
        style={{ width: `${Math.max(usage.percent, 2)}%` }}
      />
    </span>
  );
}

/**
 * The percentage after the label: on hover or focus of the tab, always from 70 %. Its
 * place is kept while hidden so the tab does not move. The spoken name is the label's.
 */
export function ContextPeek({
  usage,
  agent,
}: {
  usage: ContextUsage;
  agent: Agent;
}) {
  const high = isHigh(usage);
  return (
    <>
      <span
        aria-hidden
        data-testid="context-peek"
        className={`shrink-0 text-[12px] tabular-nums transition-opacity duration-150 motion-reduce:transition-none ${
          high
            ? "text-due-overdue"
            : "text-text-3 opacity-0 group-focus-within/tab:opacity-100 group-hover/tab:opacity-100"
        }`}
      >
        {usage.percent} %
      </span>
      <span className="sr-only">
        , {strings.terminals.context.label(agent, usage.percent)}
      </span>
    </>
  );
}

function Bubble({
  anchor,
  usage,
  agent,
}: {
  anchor: HTMLElement;
  usage: ContextUsage;
  agent: Agent;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const t = strings.terminals.context;

  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect();
    const h = ref.current?.offsetHeight ?? 0;
    const left = Math.min(
      Math.max(MARGIN, a.left),
      window.innerWidth - BUBBLE_WIDTH - MARGIN,
    );
    const below = a.bottom + GAP;
    const top =
      below + h > window.innerHeight - MARGIN ? a.top - GAP - h : below;
    setPos({ left, top: Math.max(MARGIN, top) });
  }, [anchor]);

  const high = isHigh(usage);
  const rows: [string, ReactNode][] = [
    [t.left, formatTokens(Math.max(usage.limit - usage.used, 0))],
  ];
  if (usage.planPercent !== null) {
    rows.push([t.plan, t.planUsed(usage.planPercent)]);
  }

  return createPortal(
    <div
      ref={ref}
      aria-hidden
      data-testid="context-bubble"
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        width: BUBBLE_WIDTH,
        visibility: pos ? "visible" : "hidden",
      }}
      className="pointer-events-none fixed z-50 rounded-[10px] border border-border bg-elevated px-3.5 py-3 text-[12.5px] text-text-2 shadow-pop"
    >
      <div>
        <span className="font-medium text-text">{agentName(agent)}</span>
        {usage.model && <> · {usage.model}</>}
      </div>
      <div className="mt-0.5 mb-2 flex items-baseline gap-1.5 text-text">
        <span className="text-[15px] tabular-nums">
          {formatTokens(usage.used)}
        </span>
        <span className="text-text-2">{t.of(formatTokens(usage.limit))}</span>
        <span
          className={`ml-auto tabular-nums ${high ? "text-due-overdue" : ""}`}
        >
          {usage.percent} %
        </span>
      </div>
      <div className="mb-2.5 h-1 overflow-hidden rounded-full bg-border-terminal">
        <div
          className={`h-full rounded-full ${high ? "bg-due-overdue" : "bg-[var(--state-idle)]"}`}
          style={{ width: `${Math.max(usage.percent, 2)}%` }}
        />
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-text-3">{k}</dt>
            <dd className="text-right text-text tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {high && <p className="mt-2 text-due-overdue">{t.nearlyFull(agent)}</p>}
    </div>,
    document.body,
  );
}

/** Keyboard focus only: a click focuses the tab too, and must not open the bubble. */
function focusVisible(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

/**
 * The bubble of a tab: `bind` goes on the tab's container, `bubble` anywhere in it. Shown
 * after a short hover, or at once when the keyboard focuses the tab; hidden on leave, blur,
 * a click or Escape.
 */
export function useContextBubble(
  usage: ContextUsage | null,
  agent: Agent | undefined,
) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const clear = () => window.clearTimeout(timer.current);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    if (!anchor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAnchor(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anchor]);

  const hide = () => {
    clear();
    setAnchor(null);
  };
  const bind = usage
    ? {
        onMouseEnter: (e: { currentTarget: HTMLElement }) => {
          const el = e.currentTarget;
          clear();
          timer.current = window.setTimeout(() => setAnchor(el), BUBBLE_DELAY);
        },
        onMouseLeave: hide,
        onMouseDown: hide,
        onFocus: (e: FocusEvent<HTMLElement>) => {
          if (focusVisible(e.target)) setAnchor(e.currentTarget);
        },
        onBlur: hide,
      }
    : {};
  const bubble =
    usage && agent && anchor ? (
      <Bubble anchor={anchor} usage={usage} agent={agent} />
    ) : null;
  return { bind, bubble };
}
