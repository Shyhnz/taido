/**
 * Simulated sync and account of the mock backend (docs/SYNC.md
 * § Mock backend). No network: signup, login and the forgotten password succeed at once
 * except for the reserved inputs below, `sync_now` goes `syncing` → `idle`. Tests drive other
 * states with `set`. The PWA replaces the sync commands by its real client (src/mobile/).
 */

import type {
  AccountInfo,
  AccountInput,
  ErrorPayload,
  ForgotInput,
  ResetInput,
  SyncStatus,
} from "../bindings";

/** Password refused at login with `sync_auth`. */
export const MOCK_SYNC_WRONG_PASSWORD = "mauvais";
/** A server address containing this is unreachable (`sync_offline`). */
export const MOCK_SYNC_UNREACHABLE = "injoignable";
/** A server address containing this cannot send e-mails (`sync_mail_unavailable`). */
export const MOCK_SYNC_NO_MAIL = "sans-mail";
/** Signup with this address: `sync_email_taken`. */
export const MOCK_SYNC_TAKEN_EMAIL = "pris@exemple.fr";
/** Login, forgotten password or reset with this address: `sync_rate_limited`. */
export const MOCK_SYNC_LIMITED_EMAIL = "bloque@exemple.fr";
/** The only reset code accepted (else `sync_invalid_code`). */
export const MOCK_SYNC_RESET_CODE = "123456";
/**
 * Detail of the `invalid` refusal of a signup or login while linked (core
 * `engine::ALREADY_LINKED`); the UI matches it to show `fr.sync.accountError.alreadyLinked`.
 */
export const ALREADY_LINKED = "already linked to an account: log out first";
/**
 * Detail of the `invalid` refusal of the account commands the phone does not offer in V2.7
 * (signup, forgotten password, reset): they are done from the Mac. The UI matches it to show
 * `fr.sync.accountError.notOnPhone`.
 */
export const NOT_ON_THE_PHONE = "not available on the phone: use the Mac";

/** Shortest password of a new account (same as the server). */
export const MIN_PASSWORD_CHARS = 10;
/** Accepted automatic intervals, in minutes (same as the core). */
export const SYNC_INTERVALS: readonly number[] = [1, 5, 15, 30, 60];
export const DEFAULT_SYNC_INTERVAL = 5;

const HTTPS_RE = /^https:\/\/[^/\s]+(\/\S*)?$/;
const LOCAL_HTTP_RE = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/\S*)?$/;

/** Trimmed address without its trailing `/`, or `null` when refused (core rule). */
export function normalizeServerUrl(raw: string): string | null {
  const url = raw.trim().replace(/\/+$/, "");
  return HTTPS_RE.test(url) || LOCAL_HTTP_RE.test(url) ? url : null;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Trimmed lowercase address, or `null` when it is not `x@y.z` (≤ 254 characters). */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

export const initialSyncStatus = (): SyncStatus => ({
  state: "unlinked",
  serverUrl: null,
  intervalMinutes: DEFAULT_SYNC_INTERVAL,
  lastSyncAt: null,
  errorKind: null,
  pending: 0,
});

const fail = (kind: ErrorPayload["kind"], message: string): ErrorPayload => ({
  kind,
  message,
});

export class MockSync {
  private status: SyncStatus = initialSyncStatus();
  private linkedAccount: AccountInfo | null = null;

  constructor(
    private readonly nowIso: () => string,
    private readonly emit: (status: SyncStatus) => void,
  ) {}

  reset(): void {
    this.status = initialSyncStatus();
    this.linkedAccount = null;
  }

  get(): SyncStatus {
    return { ...this.status };
  }

  /** Tests: forces any status (e.g. `{ state: "offline" }`) and emits `sync-changed`. */
  set(patch: Partial<SyncStatus>): SyncStatus {
    this.status = { ...this.status, ...patch };
    this.emit(this.get());
    return this.get();
  }

  /** The linked account; `null` when unlinked. */
  account(): AccountInfo | null {
    return this.status.state === "unlinked" || this.linkedAccount === null
      ? null
      : { ...this.linkedAccount };
  }

  /** « Renvoyer le mail »: nothing to send once confirmed; `sync_auth` when unlinked. */
  async resendConfirmation(): Promise<null> {
    if (this.status.state === "unlinked" || this.linkedAccount === null) {
      throw fail("sync_auth", "not linked");
    }
    return null;
  }

  /** Tests: confirms (or not) the address of the linked account. */
  setEmailVerified(verified: boolean): void {
    if (this.linkedAccount) this.linkedAccount.emailVerified = verified;
  }

  /** The address, then the server: `invalid`, `sync_offline`. */
  private server(serverUrl: string): string {
    const url = normalizeServerUrl(serverUrl);
    if (url === null) throw fail("invalid", `bad server url: ${serverUrl}`);
    if (url.includes(MOCK_SYNC_UNREACHABLE)) {
      throw fail("sync_offline", "server unreachable");
    }
    return url;
  }

  /**
   * Linked: no signup, and a login only to the linked account (a re-login after a refused
   * token), like the core.
   */
  private checkCanJoin(email: string, login: boolean): void {
    if (this.status.state === "unlinked") return;
    const same =
      login &&
      this.linkedAccount !== null &&
      this.linkedAccount.email === email.trim().toLowerCase();
    if (!same) throw fail("invalid", `invalid input: ${ALREADY_LINKED}`);
  }

  /** `verified`: a signup leaves the address to confirm (a link went by mail). */
  private linkTo(url: string, email: string, verified = true): SyncStatus {
    this.linkedAccount = { email, emailVerified: verified };
    return this.set({
      state: "idle",
      serverUrl: url,
      lastSyncAt: this.nowIso(),
      errorKind: null,
      pending: 0,
    });
  }

  async signup(input: AccountInput): Promise<SyncStatus> {
    if (normalizeServerUrl(input.serverUrl) !== null) {
      this.checkCanJoin(input.email, false);
    }
    const url = this.server(input.serverUrl);
    const email = normalizeEmail(input.email);
    if (email === null)
      throw fail("sync_bad_email", "malformed e-mail address");
    if ([...input.password].length < MIN_PASSWORD_CHARS) {
      throw fail("sync_weak_password", "password too short");
    }
    if (email === MOCK_SYNC_TAKEN_EMAIL) {
      throw fail("sync_email_taken", "address taken");
    }
    return this.linkTo(url, email, false);
  }

  async login(input: AccountInput): Promise<SyncStatus> {
    if (normalizeServerUrl(input.serverUrl) !== null) {
      this.checkCanJoin(input.email, true);
    }
    const url = this.server(input.serverUrl);
    const email = normalizeEmail(input.email);
    if (email === MOCK_SYNC_LIMITED_EMAIL) {
      throw fail("sync_rate_limited", "too many attempts");
    }
    if (email === null || input.password === MOCK_SYNC_WRONG_PASSWORD) {
      throw fail("sync_auth", "wrong e-mail or password");
    }
    return this.linkTo(url, email);
  }

  async forgotPassword(input: ForgotInput): Promise<null> {
    const url = this.server(input.serverUrl);
    if (url.includes(MOCK_SYNC_NO_MAIL)) {
      throw fail("sync_mail_unavailable", "no e-mail sending");
    }
    const email = normalizeEmail(input.email);
    if (email === null)
      throw fail("sync_bad_email", "malformed e-mail address");
    if (email === MOCK_SYNC_LIMITED_EMAIL) {
      throw fail("sync_rate_limited", "too many code requests");
    }
    return null;
  }

  async resetPassword(input: ResetInput): Promise<null> {
    this.server(input.serverUrl);
    if ([...input.password].length < MIN_PASSWORD_CHARS) {
      throw fail("sync_weak_password", "password too short");
    }
    const email = normalizeEmail(input.email);
    if (email === MOCK_SYNC_LIMITED_EMAIL) {
      throw fail("sync_rate_limited", "too many wrong codes");
    }
    if (email === null || input.code.trim() !== MOCK_SYNC_RESET_CODE) {
      throw fail("sync_invalid_code", "wrong or expired code");
    }
    // Every device of the account is logged out, this one included when linked to it.
    if (this.linkedAccount?.email === email) {
      this.set({ state: "error", errorKind: "unauthorized" });
    }
    return null;
  }

  async now(): Promise<SyncStatus> {
    if (this.status.state === "unlinked") return this.get();
    this.set({ state: "syncing" });
    return this.set({
      state: "idle",
      lastSyncAt: this.nowIso(),
      errorKind: null,
      pending: 0,
    });
  }

  async unlink(): Promise<SyncStatus> {
    this.linkedAccount = null;
    return this.set({
      state: "unlinked",
      lastSyncAt: null,
      errorKind: null,
      pending: 0,
    });
  }

  async setInterval(minutes: number): Promise<SyncStatus> {
    if (!SYNC_INTERVALS.includes(minutes)) {
      throw fail("invalid", `sync interval must be one of ${SYNC_INTERVALS}`);
    }
    return this.set({ intervalMinutes: minutes });
  }
}
