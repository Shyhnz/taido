/**
 * The phone's sync (docs/SYNC.md § 2.6–2.7, § 6.3): login (e-mail and password, protocol 3)
 * and unlink, the account, one run (chunked push, pull pages, apply, epoch change), the
 * status, and the triggers (after load, every `intervalMinutes`, back to the foreground,
 * network back, 3 s after a local change, the button). One run at a time. After each
 * successful run, the attachment files waiting here are sent (src/mobile/files.ts), apart from
 * the run: a long upload never holds the tasks' sync.
 */

import type {
  AccountInfo,
  AccountInput,
  ErrorPayload,
  SyncStatus,
} from "../../bindings";
import {
  ALREADY_LINKED,
  normalizeServerUrl,
  SYNC_INTERVALS,
} from "../../lib/mock-sync";
import {
  ALL_ENTITIES,
  type Change,
  changeKey,
  EPOCH_STAMP,
  MAX_PUSH_BYTES,
  MAX_PUSH_CHANGES,
  PROTOCOL_VERSION,
  validateChange,
} from "../../lib/sync-proto";
import type { MobileBackend } from "../backend";
import { assertNever } from "../wire";
import { type SyncClient, SyncHttpError } from "./client";

/** A local change is pushed this long after the last one (debounced). */
export const POKE_DELAY_MS = 3_000;
/** At most this many requests per run (§ 2.7). */
export const MAX_REQUESTS_PER_RUN = 1000;

type Outcome = "idle" | "offline" | "error";

const fail = (kind: ErrorPayload["kind"], message: string): ErrorPayload => ({
  kind,
  message,
});

const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

/** A failed login as the Mac's account error kinds (docs/SYNC.md § 3.5). */
function loginError(error: unknown): ErrorPayload {
  if (!(error instanceof SyncHttpError)) {
    return fail("sync_server", String(error));
  }
  switch (error.kind) {
    case "unauthorized":
      return fail("sync_auth", error.message);
    case "rate_limited":
      return fail("sync_rate_limited", error.message);
    case "offline":
      return fail("sync_offline", error.message);
    case "unsupported_protocol":
    case "too_large":
    case "server":
      return fail("sync_server", error.message);
    default:
      return assertNever(error.kind);
  }
}

/** What the page gives the triggers (a `window` in the app, a fake in tests). */
export interface TriggerTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface TriggerEnv {
  window: TriggerTarget;
  document: TriggerTarget & { visibilityState: string };
}

export class MobileSyncEngine {
  private outcome: Outcome;
  private running: Promise<void> | null = null;
  private purgedThisSession = false;
  private pokeTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private stopTriggers: (() => void) | null = null;

  constructor(
    private readonly backend: MobileBackend,
    private readonly clientFor: (baseUrl: string) => SyncClient,
  ) {
    this.outcome = backend.syncData.errorKind ? "error" : "idle";
  }

  private get data() {
    return this.backend.syncData;
  }

  private linked(): boolean {
    return this.data.token !== null && this.data.serverUrl !== null;
  }

  status(): SyncStatus {
    const d = this.data;
    const held = this.backend.heldDeletions.size > 0;
    let state: SyncStatus["state"];
    if (!this.linked()) state = "unlinked";
    else if (this.running) state = "syncing";
    else if (held) state = "error";
    else state = this.outcome;
    return {
      state,
      serverUrl: d.serverUrl,
      intervalMinutes: d.intervalMinutes,
      lastSyncAt: d.lastSyncAt,
      errorKind:
        state === "error"
          ? held
            ? "deletions_held"
            : (d.errorKind ?? "internal")
          : null,
      pending: this.backend.pendingCount(),
    };
  }

  emit(): void {
    void this.backend.events.syncChanged.emit({ status: this.status() });
  }

  // --- commands --------------------------------------------------------------------------

  /**
   * « Se connecter » (docs/SYNC.md § 3.5, the Mac's rules): e-mail and password, then this
   * phone is linked. While linked, only a login to the same account is accepted (a re-login
   * after a refused token): another one would merge this phone's rows into it. On success,
   * what the previous link learnt from its server is forgotten (cursor, epoch, known versions,
   * parked rows; the outbox stays), every row is re-enqueued, the account is read (best
   * effort) and a run starts.
   */
  async link(input: AccountInput): Promise<SyncStatus> {
    const url = normalizeServerUrl(input.serverUrl);
    if (url === null) {
      throw fail("invalid", `bad server url: ${input.serverUrl}`);
    }
    if (this.backend.storageBroken) {
      throw fail("internal", "storage unavailable");
    }
    const email = input.email.trim();
    this.checkCanJoin(email);
    let login: Awaited<ReturnType<SyncClient["login"]>>;
    try {
      login = await this.clientFor(url).login(email, input.password);
    } catch (error) {
      throw loginError(error);
    }
    if (this.running) await this.running;
    this.backend.forgetServerState();
    this.backend.files.afterLink();
    Object.assign(this.data, {
      serverUrl: url,
      token: login.token,
      deviceId: login.device_id,
      serverEpoch: login.server_epoch,
      cursor: 0,
      lastSyncAt: null,
      errorKind: null,
      account: null,
    });
    // No default Kanban column before this link's first whole pull (docs/SYNC.md § 0.7).
    delete this.data.pulledOnce;
    this.outcome = "idle";
    this.purgedThisSession = false;
    this.backend.reenqueue(EPOCH_STAMP);
    await this.backend.saveNow();
    // Read before telling the UI: the linked screen then shows the e-mail at once.
    await this.refreshAccount();
    this.emit();
    this.armInterval();
    void this.trigger();
    return this.status();
  }

  /**
   * Linked: a login only to the cached account, compared trimmed and lowercased (core
   * `engine::check_can_join`).
   */
  private checkCanJoin(email: string): void {
    if (!this.linked()) return;
    const linkedTo = this.data.account?.email.trim().toLowerCase();
    if (linkedTo === undefined || linkedTo !== email.toLowerCase()) {
      throw fail("invalid", `invalid input: ${ALREADY_LINKED}`);
    }
  }

  /** The linked account as last read, `null` when unlinked or never read. */
  account(): AccountInfo | null {
    return this.linked() ? (this.data.account ?? null) : null;
  }

  /**
   * Reads the account (`GET /api/account`, 10 s) and caches it. Best effort: a failure keeps
   * the cached value; the answer for an older link is dropped.
   */
  private async refreshAccount(): Promise<void> {
    const { token, serverUrl } = this.data;
    if (!token || !serverUrl) return;
    let account: AccountInfo;
    try {
      account = await this.clientFor(serverUrl).account(token);
    } catch (error) {
      const kind = error instanceof SyncHttpError ? error.kind : "unexpected";
      console.warn(`sync: cannot read the account: ${kind}`);
      return;
    }
    if (this.data.token !== token) return;
    const cached = this.data.account;
    if (
      cached?.email === account.email &&
      cached.emailVerified === account.emailVerified
    ) {
      return;
    }
    this.data.account = account;
    await this.backend.saveNow();
  }

  /** « Renvoyer le mail » (`POST /api/email/resend`), errors as the Mac's account kinds. */
  async resendConfirmation(): Promise<null> {
    const { token, serverUrl } = this.data;
    if (!token || !serverUrl) throw fail("sync_auth", "not linked");
    try {
      await this.clientFor(serverUrl).resendConfirmation(token);
    } catch (error) {
      throw loginError(error);
    }
    return null;
  }

  async unlink(): Promise<SyncStatus> {
    if (this.running) await this.running;
    const { token, serverUrl } = this.data;
    if (token && serverUrl) {
      try {
        await this.clientFor(serverUrl).logout(token);
      } catch {
        // Best effort (§ 3.5): the server forgets the device on its own terms.
      }
    }
    Object.assign(this.data, {
      token: null,
      deviceId: null,
      serverEpoch: null,
      cursor: 0,
      lastSyncAt: null,
      errorKind: null,
      account: null,
    });
    this.outcome = "idle";
    this.clearTimers();
    await this.backend.saveNow();
    this.emit();
    return this.status();
  }

  async setInterval(minutes: number): Promise<SyncStatus> {
    if (!SYNC_INTERVALS.includes(minutes)) {
      throw fail("invalid", `sync interval must be one of ${SYNC_INTERVALS}`);
    }
    this.data.intervalMinutes = minutes;
    this.armInterval();
    await this.backend.saveNow();
    this.emit();
    return this.status();
  }

  /** Waits for the running sync, then runs one and returns the final status. */
  async syncNow(): Promise<SyncStatus> {
    if (this.running) await this.running;
    await this.trigger();
    return this.status();
  }

  // --- triggers --------------------------------------------------------------------------

  /** Starts a run unless one is in flight (single flight); resolves when it ends. */
  trigger(): Promise<void> {
    if (this.running) return this.running;
    if (
      !this.linked() ||
      this.backend.storageBroken ||
      this.backend.suspended
    ) {
      return Promise.resolve();
    }
    const run = this.runOnce().finally(() => {
      this.running = null;
      this.emit();
      // Edits made during the run (not part of it) go out a little later.
      if (this.outcome === "idle") this.poke();
    });
    this.running = run;
    this.emit();
    return run;
  }

  /** A local change: push it 3 s later (debounced), when linked and something waits. */
  poke(): void {
    if (!this.started || !this.linked()) return;
    if (this.backend.pendingCount() === 0) return;
    if (this.pokeTimer !== null) clearTimeout(this.pokeTimer);
    this.pokeTimer = setTimeout(() => {
      this.pokeTimer = null;
      void this.trigger();
    }, POKE_DELAY_MS);
  }

  private armInterval(): void {
    if (this.intervalTimer !== null) clearInterval(this.intervalTimer);
    this.intervalTimer = null;
    if (!this.started || !this.linked()) return;
    this.intervalTimer = setInterval(
      () => void this.trigger(),
      this.data.intervalMinutes * 60_000,
    );
  }

  private clearTimers(): void {
    if (this.pokeTimer !== null) clearTimeout(this.pokeTimer);
    if (this.intervalTimer !== null) clearInterval(this.intervalTimer);
    this.pokeTimer = null;
    this.intervalTimer = null;
  }

  /**
   * Wires the triggers and runs once (after load). Saves at once when the page is hidden or
   * closed. Returns the cleanup.
   */
  start(env: TriggerEnv): () => void {
    this.started = true;
    const onVisibility = () => {
      if (env.document.visibilityState === "hidden") {
        void this.backend.saveNow();
      } else if (env.document.visibilityState === "visible") {
        void this.trigger();
      }
    };
    const onPageHide = () => void this.backend.saveNow();
    const onOnline = () => void this.trigger();
    env.document.addEventListener("visibilitychange", onVisibility);
    env.window.addEventListener("pagehide", onPageHide);
    env.window.addEventListener("online", onOnline);
    this.armInterval();
    this.emit();
    void this.trigger();
    this.stopTriggers = () => {
      env.document.removeEventListener("visibilitychange", onVisibility);
      env.window.removeEventListener("pagehide", onPageHide);
      env.window.removeEventListener("online", onOnline);
    };
    return () => this.stop();
  }

  stop(): void {
    this.started = false;
    this.clearTimers();
    this.stopTriggers?.();
    this.stopTriggers = null;
  }

  // --- one run ---------------------------------------------------------------------------

  /** One outbox entry as a wire change (tombstone when purged or gone). */
  private buildChange(key: string): Change | null {
    const entry = this.backend.outbox[key];
    if (!entry) return null;
    const at = key.indexOf(":");
    const entity = key.slice(0, at) as Change["entity"];
    const id = key.slice(at + 1);
    const known = this.backend.snapshot[key];
    let data: unknown = null;
    if (!entry.purged && known) {
      try {
        data = JSON.parse(known.json);
      } catch {
        data = null;
      }
    }
    return {
      entity,
      id,
      updated_at: entry.changed_at,
      device_id: this.data.deviceId ?? "",
      data,
    } as Change;
  }

  /**
   * The phone reads every entity of this build, the notebook's included (it applies them), and
   * says so in each request (`known_entities`); the server only sends the notebook's rows to a
   * client that does. When this build knows a name the stored list lacks (or none is stored: a
   * phone that updated), the pull cursor goes back to 0 once, so that the rows created before
   * reach it; unsent edits stay in the outbox (core `store::declare_entities`).
   */
  private declareEntities(): void {
    const stored = this.data.knownEntities;
    if (stored !== undefined && ALL_ENTITIES.every((e) => stored.includes(e))) {
      return;
    }
    this.data.cursor = 0;
    this.data.knownEntities = [...ALL_ENTITIES];
  }

  private async runOnce(): Promise<void> {
    const token = this.data.token;
    const serverUrl = this.data.serverUrl;
    if (!token || !serverUrl) return;
    const client = this.clientFor(serverUrl);
    let pendingKeys = new Set(Object.keys(this.backend.outbox));
    const sent = new Set<string>();
    let limit = MAX_PUSH_CHANGES;
    let epochReset = false;
    let pulledAll = false;
    this.declareEntities();

    try {
      for (let requests = 0; requests < MAX_REQUESTS_PER_RUN; requests += 1) {
        const outbox = this.backend.outbox;
        const candidates = [...pendingKeys]
          .filter((k) => !sent.has(k) && outbox[k] !== undefined)
          .sort(
            (a, b) =>
              outbox[a].changed_at.localeCompare(outbox[b].changed_at) ||
              (a < b ? -1 : a > b ? 1 : 0),
          );
        const chunk: Change[] = [];
        const sentStamps = new Map<string, string>();
        let bytes = 0;
        for (const key of candidates) {
          if (chunk.length >= limit) break;
          const change = this.buildChange(key);
          if (!change) continue;
          const invalid = validateChange(change);
          if (invalid) {
            // Never block the sync on a row the server would refuse (logged, dropped).
            console.warn(`sync: dropping invalid change ${key}: ${invalid}`);
            delete outbox[key];
            sent.add(key);
            continue;
          }
          const size = utf8Length(JSON.stringify(change));
          if (chunk.length > 0 && bytes + size > MAX_PUSH_BYTES) break;
          chunk.push(change);
          sentStamps.set(key, change.updated_at);
          bytes += size;
        }

        let response: Awaited<ReturnType<SyncClient["sync"]>>;
        try {
          response = await client.sync(token, {
            protocol: PROTOCOL_VERSION,
            cursor: this.data.cursor,
            changes: chunk,
            known_entities: [...ALL_ENTITIES],
          });
        } catch (error) {
          if (error instanceof SyncHttpError && error.kind === "too_large") {
            if (chunk.length <= 1) {
              throw new SyncHttpError("server", "a single change is too large");
            }
            limit = Math.max(1, Math.floor(chunk.length / 2));
            continue;
          }
          throw error;
        }

        // Another server database (reset or restore): rebuild the union (§ 2.6), once.
        if (response.server_epoch !== this.data.serverEpoch) {
          if (epochReset) {
            throw new SyncHttpError("server", "server epoch changed twice");
          }
          epochReset = true;
          this.data.cursor = 0;
          this.data.serverEpoch = response.server_epoch;
          this.backend.reenqueue(EPOCH_STAMP);
          this.backend.files.afterLink();
          pendingKeys = new Set(Object.keys(this.backend.outbox));
          sent.clear();
          limit = MAX_PUSH_CHANGES;
          await this.backend.saveNow();
          continue;
        }

        const unchangedSinceSent = (k: string) =>
          sentStamps.has(k) &&
          this.backend.outbox[k]?.changed_at === sentStamps.get(k);
        // A row still waiting to be pushed is pushed later: the server decides then.
        const pulled = response.changes.filter((c) => {
          const k = changeKey(c);
          return this.backend.outbox[k] === undefined || unchangedSinceSent(k);
        });
        const result = this.backend.applyPulled(pulled);

        const rejected = new Set(response.rejected.map((r) => changeKey(r)));
        for (const k of rejected) {
          console.warn(`sync: change rejected by the server: ${k}`);
        }
        const returned = new Set(response.changes.map((c) => changeKey(c)));
        for (const [k, stamp] of sentStamps) {
          // Known stamp of a stored push (§ 2.6).
          const known = this.backend.snapshot[k];
          if (
            known &&
            !rejected.has(k) &&
            !returned.has(k) &&
            known.stamp < stamp
          ) {
            known.stamp = stamp;
          }
          if (unchangedSinceSent(k)) delete this.backend.outbox[k];
          sent.add(k);
        }
        this.data.cursor = response.cursor;
        if (
          result.applied + result.parked + result.cascaded + result.corrected >
          0
        ) {
          // Settings: a pulled shared theme (synced setting `appearance`).
          this.backend.emitDataChanged([
            "subjects",
            "tasks",
            "settings",
            "notes",
          ]);
        }
        await this.backend.saveNow();

        const allSent = [...pendingKeys].every(
          (k) => sent.has(k) || this.backend.outbox[k] === undefined,
        );
        if (allSent && !response.has_more) {
          pulledAll = true;
          break;
        }
      }
      this.data.lastSyncAt = this.backend.nowIsoString();
      this.data.errorKind = null;
      // Everything the account holds is here: default columns may be made now.
      if (pulledAll) this.data.pulledOnce = true;
      this.outcome = "idle";
      await this.backend.saveNow();
      // A set written by an older build: its attachments are back, kept files reclaimed.
      await this.backend.endFilesRecovery();
      if (!this.purgedThisSession) {
        // A row revived elsewhere while the phone was closed is pulled before the purge.
        this.purgedThisSession = true;
        this.backend.purge();
      }
      // The account may have changed (docs/SYNC.md § 3.5); never fails the run.
      await this.refreshAccount();
      // The files whose rows the server now has (V2.7 bis), in the background.
      void this.backend.files.run();
    } catch (error) {
      this.recordFailure(error);
      await this.backend.saveNow();
    }
  }

  private recordFailure(error: unknown): void {
    if (error instanceof SyncHttpError) {
      console.warn(`sync: ${error.kind}: ${error.message}`);
      switch (error.kind) {
        case "offline":
          this.outcome = "offline";
          return;
        case "unauthorized":
          this.outcome = "error";
          this.data.errorKind = "unauthorized";
          return;
        case "unsupported_protocol":
          this.outcome = "error";
          this.data.errorKind = "unsupported_protocol";
          return;
        default:
          this.outcome = "error";
          this.data.errorKind = "server";
          return;
      }
    }
    console.error("sync: run failed", error);
    this.outcome = "error";
    this.data.errorKind = "internal";
  }
}
