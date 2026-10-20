/**
 * « Réglages », opened by the gear of the sidebar and ⌘,: the tabs
 * on the left, one panel on the right.
 *
 * - Général: the app's folder and « Revoir le tutoriel ».
 * - Thème (2026-10-11, like Todoist): clair / sombre / système, the colour theme (each one
 *   previewed by a small app drawn with its own tokens) and « Même thème sur tous mes
 *   appareils ».
 * - Compte on the Mac, Synchro on the phone: the account and the
 *   sync (src/features/sync/, src/features/account/).
 * - Claude Code: the path of the binary (empty = found automatically) and what `check_claude`
 *   finds (path, version, logged in), with « Vérifier ».
 * - Diagnostic: `get_app_status` (versions, hooks port, resolved PATH, log and data folders)
 *   and the last hook events.
 *
 * Choices are saved as soon as they are made, like the rest of the app; only the path of the
 * binary has « Enregistrer », since a half-typed path must not be checked.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Check,
  CircleAlert,
  FolderOpen,
  type LucideIcon,
  Palette,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";
import type {
  Agent,
  AgentStatus,
  ColorTheme,
  Settings,
  SettingsPatch,
} from "../../bindings";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import {
  agentProduct,
  currentLanguage,
  type Language,
  setLanguage,
  t as strings,
} from "../../i18n";
import { features } from "../../lib/features";
import { commands, errorKind, errorMessage } from "../../lib/ipc";
import { queryKeys, useSettings } from "../../lib/queries";
import { readableError, run } from "../../lib/run";
import { settingsPatch } from "../../lib/settingsPatch";
import { IS_MOBILE } from "../../lib/target";
import { COLOR_THEMES, THEMES, useResolvedTheme } from "../../lib/theme";
import { type SettingsTab, useUi } from "../../stores/ui";
import { checkAgentStatus } from "../claude-check/claudeCheck";
import { SyncSettings } from "../sync";
import { useTutorial } from "../tutorial/store";
import { HookEvents } from "./HookEvents";

/**
 * Tabs, in order. « Synchro » right after « Général »; « Thème » right after
 * « Général » (2026-10-11). The Mac-only tabs (agents, diagnostic) only where terminals exist;
 * « Général » holds the language, plus the app's folder and the guide where they exist.
 */
export function settingsTabs(): { tab: SettingsTab; icon: LucideIcon }[] {
  return [
    { tab: "general" as const, icon: SlidersHorizontal },
    { tab: "theme", icon: Palette },
    { tab: "sync", icon: RefreshCw },
    ...(features.terminals
      ? [
          { tab: "agents" as const, icon: Sparkles },
          { tab: "diagnostic" as const, icon: Activity },
        ]
      : []),
  ];
}

/** The « sync » tab is « Compte » on the Mac, « Synchro » on the phone. */
export function tabLabel(tab: SettingsTab): string {
  return tab === "sync" && !IS_MOBILE
    ? strings.settings.tabs.account
    : strings.settings.tabs[tab];
}

/** Saves a setting and shows it at once (the `data-changed` refetch follows). */
function useSaveSetting() {
  const client = useQueryClient();
  return async (change: Partial<SettingsPatch>) => {
    const next = await run(
      commands.updateSettings(settingsPatch(change)),
      strings.errors.action.settings,
    );
    if (next) client.setQueryData<Settings>(queryKeys.settings, next);
  };
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** A group of radio buttons with its visible legend and help. */
function Choice({
  legend,
  help,
  children,
}: {
  legend: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="border-b border-border-row py-4 first:pt-1 last:border-b-0">
      <legend className="float-left w-full text-[13.5px] font-medium">
        {legend}
      </legend>
      {help && (
        <p className="clear-left pt-0.5 text-[12.5px] text-text-2">{help}</p>
      )}
      <div className="clear-left pt-2.5">{children}</div>
    </fieldset>
  );
}

/** Label / value rows of the Claude Code and Diagnostic tabs. */
function Facts({ children }: { children: ReactNode }) {
  return (
    <dl className="grid grid-cols-[148px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-[13px]">
      {children}
    </dl>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-text-2">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[12.5px] break-all text-text">
      {children}
    </span>
  );
}

function SectionTitle({
  id,
  children,
  action,
}: {
  id: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-8 items-center gap-3 pb-2">
      <h3 id={id} className="min-w-0 flex-1 text-[13.5px] font-semibold">
        {children}
      </h3>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/** Each language is written in itself, so it can be found from the wrong one. */
const LANGUAGE_NAMES: Record<Language, string> = {
  en: "English",
  fr: "Français",
};

/** « Language / Langue »: saved here and in the core, then the window reloads. */
function LanguageSelect() {
  const id = useId();
  const current = currentLanguage();
  return (
    <Choice
      legend={strings.settings.language}
      help={strings.settings.languageHelp}
    >
      <select
        id={id}
        aria-label={strings.settings.language}
        value={current}
        onChange={(e) => void setLanguage(e.target.value as Language)}
        className="h-8 rounded-md border border-border bg-bg px-2 text-[13px] text-text focus-visible:outline-2 focus-visible:outline-[var(--focus)]"
      >
        {(Object.keys(LANGUAGE_NAMES) as Language[]).map((lang) => (
          <option key={lang} value={lang}>
            {LANGUAGE_NAMES[lang]}
          </option>
        ))}
      </select>
    </Choice>
  );
}

function GeneralTab() {
  const workspace = useSettings().data?.workspaceRoot ?? null;
  return (
    <>
      <LanguageSelect />
      {/* by design: every project's folder lives here, automatically. */}
      {workspace && (
        <div className="mb-6">
          <Facts>
            <FolderFact label={strings.settings.workspace} path={workspace} />
          </Facts>
          <p className="mt-1.5 text-[12.5px] text-text-3">
            {strings.settings.workspaceHelp}
          </p>
        </div>
      )}
      {features.tutorial && (
        <Choice
          legend={strings.tutorial.replayLegend}
          help={strings.tutorial.replayHelp}
        >
          <Button
            size="sm"
            onClick={() => {
              useUi.getState().closeDialog();
              useTutorial.getState().begin();
            }}
          >
            {strings.tutorial.replay}
          </Button>
        </Choice>
      )}
    </>
  );
}

/** « Thème »: clair / sombre / système, the colour, and the shared theme switch. */
function ThemeTab() {
  const settings = useSettings().data;
  const theme = settings?.theme ?? "system";
  const color = settings?.colorTheme ?? "taido";
  const syncTheme = settings?.syncTheme ?? true;
  const shown = useResolvedTheme(theme);
  const save = useSaveSetting();
  return (
    <>
      <Choice
        legend={strings.settings.theme}
        help={
          IS_MOBILE
            ? strings.settings.themeHelpMobile
            : strings.settings.themeHelp
        }
      >
        <div className="inline-flex rounded-md border border-border bg-aside p-0.5">
          {THEMES.map((t) => (
            <label key={t} className="relative">
              <input
                type="radio"
                name="theme"
                value={t}
                checked={theme === t}
                onChange={() => void save({ theme: t })}
                className="peer sr-only"
              />
              <span className="block cursor-pointer rounded-[5px] px-3.5 py-1 text-[13px] text-text-2 peer-checked:bg-bg peer-checked:font-medium peer-checked:text-text peer-checked:shadow-[0_1px_2px_rgba(0,0,0,0.08)] peer-focus-visible:outline-2 peer-focus-visible:outline-[var(--focus)]">
                {strings.theme[t]}
              </span>
            </label>
          ))}
        </div>
      </Choice>
      <Choice legend={strings.settings.color} help={strings.settings.colorHelp}>
        <div className="grid grid-cols-2 gap-x-3 gap-y-3.5 sm:grid-cols-5">
          {COLOR_THEMES.map((c) => (
            <label
              key={c}
              className="group relative block min-w-0 cursor-pointer"
            >
              <input
                type="radio"
                name="color-theme"
                value={c}
                checked={color === c}
                onChange={() => void save({ colorTheme: c })}
                className="peer sr-only"
              />
              <ThemePreview color={c} mode={shown} selected={color === c} />
              <span className="mt-1.5 block truncate text-[12.5px] text-text-2 peer-checked:font-medium peer-checked:text-text">
                {strings.colorTheme[c]}
              </span>
            </label>
          ))}
        </div>
      </Choice>
      <div className="pt-4">
        <SettingSwitch
          on={syncTheme}
          label={strings.settings.syncTheme}
          help={
            IS_MOBILE
              ? strings.settings.syncThemeHelpMobile
              : strings.settings.syncThemeHelp
          }
          onToggle={() => void save({ syncTheme: !syncTheme })}
        />
      </div>
    </>
  );
}

/**
 * A small app (sidebar, active item, tasks) drawn with the theme's own tokens: the
 * `data-theme` / `data-color` blocks of tokens.css apply to any element, not only <html>.
 */
function ThemePreview({
  color,
  mode,
  selected,
}: {
  color: ColorTheme;
  mode: "light" | "dark";
  selected: boolean;
}) {
  return (
    <span
      aria-hidden
      data-theme={mode}
      data-color={color}
      className={`relative flex aspect-[4/3] overflow-hidden rounded-lg border border-border bg-bg group-hover:border-border-input peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--focus)] ${
        selected ? "outline-2 outline-offset-2 outline-[var(--accent)]" : ""
      }`}
    >
      <span className="flex w-[34%] flex-col gap-1 bg-sidebar px-1 py-1.5">
        <span className="h-1 rounded-sm bg-accent" />
        <span className="h-1.5 rounded-sm bg-nav-active" />
        <span className="h-1 rounded-sm bg-text-3 opacity-50" />
        <span className="h-1 rounded-sm bg-text-3 opacity-50" />
      </span>
      <span className="flex flex-1 flex-col gap-1.5 px-1.5 py-2">
        <span className="h-1.5 w-3/5 rounded-sm bg-text" />
        {[0, 1, 2].map((i) => (
          <span key={i} className="flex items-center gap-1">
            <span className="size-1.5 shrink-0 rounded-full border border-text-3" />
            <span className="h-1 flex-1 rounded-sm bg-text-3 opacity-40" />
          </span>
        ))}
      </span>
      {selected && (
        <span className="absolute right-1 bottom-1 grid size-4 place-items-center rounded-full bg-accent text-on-accent">
          <Check size={10} strokeWidth={3} />
        </span>
      )}
    </span>
  );
}

/** Path of the `claude` binary: empty means found automatically. */
function AgentPathForm({
  agent,
  saved,
  onSaved,
}: {
  agent: Agent;
  saved: string | null;
  onSaved: () => void;
}) {
  const client = useQueryClient();
  const [value, setValue] = useState(saved ?? "");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const helpId = useId();
  const errorId = useId();
  const dirty = value.trim() !== (saved ?? "");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || busy) return;
    const path = value.trim();
    setNotice(null);
    if (path && !path.startsWith("/")) {
      setError(strings.settings.agentPathInvalid(agent));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await commands.updateSettings(
        settingsPatch(
          agent === "codex" ? { codexPath: path } : { claudePath: path },
        ),
      );
      client.setQueryData<Settings>(queryKeys.settings, next);
      const stored = agent === "codex" ? next.codexPath : next.claudePath;
      setValue(stored ?? "");
      setNotice(
        stored
          ? strings.settings.claudePathSaved
          : strings.settings.claudePathCleared,
      );
      onSaved();
    } catch (err) {
      console.error(errorMessage(err), err);
      setError(
        errorKind(err) === "invalid"
          ? strings.settings.agentPathInvalid(agent)
          : readableError(err, strings.errors.action.settings),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="border-b border-border-row pt-1 pb-4"
    >
      <label htmlFor={inputId} className="text-[13.5px] font-medium">
        {strings.settings.agentPath(agent)}
      </label>
      <div className="flex gap-2 pt-2">
        <input
          id={inputId}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
            setNotice(null);
          }}
          placeholder={strings.settings.claudePathPlaceholder}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${errorId} ${helpId}` : helpId}
          className="h-8 min-w-0 flex-1 rounded-md border border-border bg-bg px-2.5 font-mono text-[12.5px] outline-none placeholder:font-sans placeholder:text-[13px] placeholder:text-text-3 focus:border-accent"
        />
        <Button type="submit" disabled={!dirty || busy}>
          {strings.common.save}
        </Button>
      </div>
      {error && (
        <p
          id={errorId}
          role="alert"
          className="flex items-center gap-1.5 pt-1.5 text-[12.5px] font-medium text-text"
        >
          <CircleAlert size={14} aria-hidden className="shrink-0" />
          {error}
        </p>
      )}
      <p id={helpId} className="pt-1.5 text-[12.5px] text-text-2">
        {strings.settings.claudePathHelp}
      </p>
      <p role="status" className="text-[12.5px] text-text-2">
        {notice}
      </p>
    </form>
  );
}

/**
 * An on/off setting with its help: « Résumer les sessions avec Claude Haiku » (
 * option 4), « Me prévenir quand Claude a fini ou m'attend ».
 */
function SettingSwitch({
  on,
  label,
  help,
  onToggle,
}: {
  on: boolean;
  label: string;
  help: string;
  onToggle: () => void;
}) {
  const helpId = useId();
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border-row py-4 first:pt-0">
      <div className="min-w-0">
        <p className="text-[13.5px] font-medium">{label}</p>
        <p id={helpId} className="pt-0.5 text-[12.5px] text-text-2">
          {help}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        aria-describedby={helpId}
        onClick={onToggle}
        className={`relative mt-0.5 h-[22px] w-[38px] shrink-0 rounded-full transition-colors ${
          on ? "bg-accent" : "bg-border-input"
        }`}
      >
        <span
          aria-hidden
          className={`absolute top-[3px] left-[3px] h-4 w-4 rounded-full bg-bg transition-transform ${
            on ? "translate-x-4" : ""
          }`}
        />
      </button>
    </div>
  );
}

const AGENTS: readonly Agent[] = ["claude", "codex"];

/** `check_agent` of one agent, fresh each time the tab opens. */
function useAgentStatus(agent: Agent) {
  return useQuery({
    queryKey: queryKeys.agentStatus(agent),
    queryFn: () => checkAgentStatus(agent),
    staleTime: 0,
    refetchOnMount: "always",
  });
}

/** « Prête · 0.162.1 », « Pas connectée », « Pas installée »: one line under each choice. */
function agentShortStatus(status: AgentStatus | undefined, pending: boolean) {
  if (pending || !status) return strings.settings.agentCheckingShort;
  if (!status.path) return strings.settings.agentMissingShort;
  if (status.loggedIn === false) return strings.settings.agentLoggedOutShort;
  return strings.settings.agentReady(status.version);
}

/** Réglages › Agents: the default agent, the session switches, then each agent's details. */
function AgentsTab() {
  const settings = useSettings().data;
  const save = useSaveSetting();
  const claude = useAgentStatus("claude");
  const codex = useAgentStatus("codex");
  const statuses = { claude, codex };

  return (
    <div>
      {settings && (
        <>
          <Choice
            legend={strings.settings.defaultAgent}
            help={strings.settings.defaultAgentHelp}
          >
            <div className="flex flex-col gap-1.5 sm:flex-row">
              {AGENTS.map((agent) => (
                <label key={agent} className="relative flex-1">
                  <input
                    type="radio"
                    name="default-agent"
                    value={agent}
                    checked={settings.defaultAgent === agent}
                    onChange={() =>
                      void save({ defaultAgent: agent, agentChosen: true })
                    }
                    className="peer sr-only"
                  />
                  <span className="flex cursor-pointer flex-col rounded-md border border-border px-3 py-2 peer-checked:border-accent peer-checked:bg-aside peer-focus-visible:outline-2 peer-focus-visible:outline-[var(--focus)]">
                    <span className="text-[13.5px] font-medium">
                      {agentProduct(agent)}
                    </span>
                    <span className="text-[12px] text-text-2">
                      {agentShortStatus(
                        statuses[agent].data,
                        statuses[agent].isPending,
                      )}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </Choice>
          <SettingSwitch
            on={settings.summarizeSessions}
            label={strings.settings.summarize}
            help={strings.settings.summarizeHelp}
            onToggle={() =>
              void save({ summarizeSessions: !settings.summarizeSessions })
            }
          />
          <SettingSwitch
            on={settings.notifications}
            label={strings.settings.notify(settings.defaultAgent)}
            help={strings.settings.notifyHelp}
            onToggle={() =>
              void save({ notifications: !settings.notifications })
            }
          />
          <SettingSwitch
            on={settings.voiceSpaceHold}
            label={strings.settings.voiceSpaceHold}
            help={strings.settings.voiceSpaceHoldHelp}
            onToggle={() =>
              void save({ voiceSpaceHold: !settings.voiceSpaceHold })
            }
          />
          <SettingSwitch
            on={settings.chronoCountsWaiting}
            label={strings.chrono.settingWaiting}
            help={strings.chrono.settingWaitingHint(settings.defaultAgent)}
            onToggle={() =>
              void save({ chronoCountsWaiting: !settings.chronoCountsWaiting })
            }
          />
        </>
      )}
      {AGENTS.map((agent) => (
        <AgentSection
          key={agent}
          agent={agent}
          saved={
            (agent === "codex" ? settings?.codexPath : settings?.claudePath) ??
            null
          }
          status={statuses[agent]}
          ready={settings !== undefined}
        />
      ))}
    </div>
  );
}

/** One agent: its path, then what the check found, with « Vérifier ». */
function AgentSection({
  agent,
  saved,
  status,
  ready,
}: {
  agent: Agent;
  saved: string | null;
  status: ReturnType<typeof useAgentStatus>;
  ready: boolean;
}) {
  const titleId = useId();
  const s = status.data;
  let body: ReactNode;
  if (status.isPending) {
    body = (
      <p role="status" className="text-[13px] text-text-2">
        {strings.settings.claudeChecking}
      </p>
    );
  } else if (status.isError) {
    body = (
      <p role="alert" className="text-[13px] text-text">
        {strings.settings.agentCheckError(agent)}
      </p>
    );
  } else if (s) {
    const login =
      s.loggedIn === true ? (
        <span className="inline-flex items-center gap-1.5">
          <Check size={14} aria-hidden className="text-text-2" />
          {strings.settings.claudeLoggedIn}
        </span>
      ) : s.loggedIn === false ? (
        <span className="inline-flex items-start gap-1.5 font-medium">
          <CircleAlert size={14} aria-hidden className="mt-0.5 shrink-0" />
          {strings.settings.agentLoggedOut(agent)}
        </span>
      ) : (
        strings.settings.claudeLoginUnknown
      );
    body = (
      <Facts>
        <Fact label={strings.settings.claudeProgram}>
          {s.path ? (
            <Mono>{s.path}</Mono>
          ) : (
            <span className="flex flex-col gap-0.5">
              <span className="inline-flex items-center gap-1.5 font-medium">
                <CircleAlert size={14} aria-hidden />
                {strings.settings.claudeNotFound}
              </span>
              <span className="text-[12.5px] text-text-2">
                {strings.settings.agentInstall(agent)}
              </span>
            </span>
          )}
        </Fact>
        {s.path && (
          <>
            <Fact label={strings.settings.claudeVersion}>
              {s.version ?? strings.settings.unknown}
            </Fact>
            <Fact label={strings.settings.claudeLogin}>{login}</Fact>
          </>
        )}
      </Facts>
    );
  }
  return (
    <section aria-labelledby={titleId} className="pt-5">
      <SectionTitle
        id={titleId}
        action={
          <Button
            size="sm"
            aria-label={strings.settings.agentCheckLabel(agent)}
            onClick={() => void status.refetch()}
            disabled={status.isFetching}
          >
            <RefreshCw
              size={14}
              aria-hidden
              className={status.isFetching ? "motion-safe:animate-spin" : ""}
            />
            {strings.settings.claudeCheck}
          </Button>
        }
      >
        {agentProduct(agent)}
      </SectionTitle>
      {ready && (
        <AgentPathForm
          agent={agent}
          saved={saved}
          onSaved={() => void status.refetch()}
        />
      )}
      {body}
    </section>
  );
}

function FolderFact({ label, path }: { label: string; path: string }) {
  return (
    <Fact label={label}>
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 pt-0.5">
          <Mono>{path}</Mono>
        </span>
        <Button
          size="sm"
          variant="ghost"
          aria-label={strings.settings.openFolderLabel(label)}
          onClick={() =>
            void run(
              commands.openPath({ path, with: "finder", editor: null }),
              strings.app.openFolderError,
            )
          }
        >
          <FolderOpen size={14} aria-hidden />
          {strings.settings.openFolder}
        </Button>
      </div>
    </Fact>
  );
}

function DiagnosticTab() {
  const query = useQuery({
    queryKey: queryKeys.appStatus,
    queryFn: commands.getAppStatus,
    staleTime: 0,
    refetchOnMount: "always",
  });
  const s = query.data;

  let facts: ReactNode;
  if (query.isPending) {
    facts = (
      <p role="status" className="text-[13px] text-text-2">
        {strings.settings.statusLoading}
      </p>
    );
  } else if (query.isError || !s) {
    facts = (
      <div role="alert" className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-text">{strings.settings.statusError}</p>
        <Button size="sm" onClick={() => void query.refetch()}>
          {strings.common.retry}
        </Button>
      </div>
    );
  } else {
    facts = (
      <Facts>
        <Fact label={strings.settings.appVersion}>{s.appVersion}</Fact>
        <Fact label={strings.terminals.agent("claude")}>
          {s.claude.path ? (
            <>
              {s.claude.version ?? strings.settings.unknown} ·{" "}
              <Mono>{s.claude.path}</Mono>
            </>
          ) : (
            strings.settings.claudeNotFound
          )}
        </Fact>
        <Fact label={strings.settings.hooksPort}>
          <Mono>{s.hooksPort}</Mono>
        </Fact>
        <Fact label={strings.settings.envPath}>
          <Mono>{s.envPath}</Mono>
          {!s.envFromLoginShell && (
            <p className="pt-1 text-[12.5px] text-text-2">
              {strings.settings.envFallback}
            </p>
          )}
        </Fact>
        <FolderFact label={strings.settings.logDir} path={s.logDir} />
        <FolderFact label={strings.settings.dataDir} path={s.dataDir} />
      </Facts>
    );
  }

  return (
    <div className="flex flex-col gap-5 pt-1">
      {facts}
      <div className="border-t border-border-row pt-4">
        <HookEvents />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function SettingsDialog({
  tab: initialTab,
  onClose,
}: {
  tab?: SettingsTab;
  onClose: () => void;
}) {
  const TABS = settingsTabs();
  // No tab asked, or one missing on this device (e.g. « Agents » on the phone): the first.
  const [tab, setTab] = useState<SettingsTab>(
    initialTab && TABS.some((t) => t.tab === initialTab)
      ? initialTab
      : TABS[0].tab,
  );
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const tabId = (t: SettingsTab) => `${baseId}-tab-${t}`;
  const panelId = `${baseId}-panel`;

  // The phone has no room for a side column: the tabs go on top (Todoist does the same).
  const horizontal = IS_MOBILE;
  const nextKey = horizontal ? "ArrowRight" : "ArrowDown";
  const previousKey = horizontal ? "ArrowLeft" : "ArrowUp";

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = [nextKey, previousKey, "Home", "End"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.tab === tab);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? TABS.length - 1
          : (i + (e.key === nextKey ? 1 : -1) + TABS.length) % TABS.length;
    setTab(TABS[next].tab);
    listRef.current
      ?.querySelector<HTMLElement>(`#${CSS.escape(tabId(TABS[next].tab))}`)
      ?.focus();
  };

  return (
    <Dialog title={strings.settings.title} onClose={onClose} width={780}>
      <div
        className={
          horizontal
            ? "flex h-[min(560px,calc(100dvh-180px))] min-h-[320px] flex-col pt-1"
            : "flex h-[min(520px,calc(100vh-260px))] min-h-[320px] pt-3"
        }
      >
        <div
          ref={listRef}
          role="tablist"
          aria-orientation={horizontal ? "horizontal" : "vertical"}
          aria-label={strings.settings.tabsLabel}
          onKeyDown={onTabKey}
          className={
            horizontal
              ? "flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3 pb-2"
              : "flex w-[184px] shrink-0 flex-col gap-0.5 border-r border-border px-2.5"
          }
        >
          {TABS.map(({ tab: t, icon: Icon }) => {
            const selected = t === tab;
            return (
              <button
                key={t}
                id={tabId(t)}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                data-autofocus={selected || undefined}
                onClick={() => setTab(t)}
                className={`flex ${horizontal ? "h-11 shrink-0 px-3" : "h-8 px-2"} items-center gap-2.5 rounded-md text-left text-[13.5px] ${
                  selected
                    ? "bg-nav-active font-medium text-text-nav-active"
                    : "text-text hover:bg-hover"
                }`}
              >
                <Icon size={15} aria-hidden strokeWidth={1.75} />
                {tabLabel(t)}
              </button>
            );
          })}
        </div>
        <div
          id={panelId}
          role="tabpanel"
          aria-labelledby={tabId(tab)}
          className={`min-w-0 flex-1 overflow-y-auto pb-4 ${horizontal ? "px-4 pt-4" : "px-6"}`}
        >
          {tab === "general" && <GeneralTab />}
          {tab === "theme" && <ThemeTab />}
          {tab === "sync" && (
            <SyncSettings
              defaultServerUrl={
                IS_MOBILE ? globalThis.location?.origin : undefined
              }
            />
          )}
          {tab === "agents" && <AgentsTab />}
          {tab === "diagnostic" && <DiagnosticTab />}
        </div>
      </div>
      <div className="flex justify-end border-t border-border px-5 py-3">
        <Button onClick={onClose}>{strings.common.close}</Button>
      </div>
    </Dialog>
  );
}
