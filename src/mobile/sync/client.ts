/**
 * HTTP client of the phone (docs/SYNC.md § 6.3): `POST /api/login` (e-mail and password,
 * protocol 3), `/api/logout`, `/api/sync`, and `GET /api/account`, with the JSON of
 * src/lib/sync-proto.ts. `fetch` is injectable (tests), every request has a 60 s
 * `AbortController` timeout (10 s for the account, 5 s for the logout). Failures become a
 * `SyncHttpError` whose `kind` drives the status (same mapping as the Mac core, § 3.4–3.5).
 *
 * Attachment files (same timeouts as the Mac): `GET /api/files/{id}/status` (15 s),
 * `PUT /api/files/{id}?offset&size&sha256` with one chunk (5 min), `GET /api/files/{id}`
 * (30 min, body included). The server's refusals of a file are a `FileRefused`.
 */

import type { AccountInfo } from "../../bindings";
import { t } from "../../i18n";
import {
  type AccountResponse,
  type ErrorBody,
  type FileStatus,
  type LoginRequest,
  type LoginResponse,
  PROTOCOL_VERSION,
  type SyncRequest,
  type SyncResponse,
} from "../../lib/sync-proto";

export type FetchFn = (
  input: string,
  init: RequestInit & { signal: AbortSignal },
) => Promise<Response>;

export type SyncFailure =
  /** No network, DNS failure, timeout. */
  | "offline"
  /** 401: wrong password at login, revoked token afterwards. */
  | "unauthorized"
  /** 429 at login (too many attempts). */
  | "rate_limited"
  | "unsupported_protocol"
  /** 413: the chunk is too large. */
  | "too_large"
  /** Any other status, an HTML page (Cloudflare challenge) or unreadable JSON. */
  | "server";

export class SyncHttpError extends Error {
  constructor(
    readonly kind: SyncFailure,
    message: string,
  ) {
    super(message);
    this.name = "SyncHttpError";
  }
}

export const REQUEST_TIMEOUT_MS = 60_000;
export const LOGOUT_TIMEOUT_MS = 5_000;
/** Same as the Mac: the account read never holds a sync long. */
export const ACCOUNT_TIMEOUT_MS = 10_000;
/** `device_name` of the phone (§ 2.2), in the language of the app. */
export const PHONE_DEVICE_NAME = t.sync.phoneDeviceName;
export const FILE_STATUS_TIMEOUT_MS = 15_000;
export const FILE_CHUNK_TIMEOUT_MS = 5 * 60_000;
export const FILE_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

/** Why the server refused a file request (sync-server/src/files.rs). */
export type FileRefusal =
  /** 404: no live attachment of the account with this id, or (download) no complete file. */
  | "not_found"
  /** 409: the chunk does not start at the bytes received: read the status again. */
  | "chunk_offset"
  /** 413: over the server's largest file. */
  | "file_too_large"
  /** 507: the account's files would pass its quota. */
  | "quota_exceeded"
  /** 400: the bytes received do not have the announced SHA-256 (nothing kept). */
  | "hash_mismatch"
  /** Any other 4xx (malformed request, chunk over 8 MiB). */
  | "refused";

export class FileRefused extends Error {
  constructor(
    readonly code: FileRefusal,
    readonly status: number,
  ) {
    super(`file request refused: ${code} (${status})`);
    this.name = "FileRefused";
  }
}

export interface ChunkQuery {
  offset: number;
  size: number;
  sha256: string;
}

const isOffline = () =>
  typeof navigator !== "undefined" && navigator.onLine === false;

export class SyncClient {
  constructor(
    readonly baseUrl: string,
    private readonly fetchFn: FetchFn = (input, init) => fetch(input, init),
  ) {}

  private async request(
    path: string,
    body: unknown,
    token: string | null,
    timeoutMs = REQUEST_TIMEOUT_MS,
    method: "GET" | "POST" = "POST",
  ): Promise<Response> {
    if (isOffline()) throw new SyncHttpError("offline", "navigator offline");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      return await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
      });
    } catch (error) {
      // fetch rejects with a TypeError on network failures, an AbortError on timeout.
      throw new SyncHttpError(
        "offline",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Parses a JSON body; an HTML page or broken JSON is a server error. */
  private async json<T>(response: Response): Promise<T> {
    const type = response.headers.get("content-type") ?? "";
    if (type.includes("text/html")) {
      throw new SyncHttpError("server", `HTML body (${response.status})`);
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new SyncHttpError("server", `unreadable body (${response.status})`);
    }
  }

  private async fail(response: Response): Promise<never> {
    let code: string | null = null;
    try {
      const body = await this.json<ErrorBody>(response);
      code = typeof body?.error === "string" ? body.error : null;
    } catch {
      code = null;
    }
    if (response.status === 401) {
      throw new SyncHttpError("unauthorized", "unauthorized");
    }
    if (response.status === 429) {
      throw new SyncHttpError("rate_limited", "rate limited");
    }
    if (response.status === 413) {
      throw new SyncHttpError("too_large", "payload too large");
    }
    if (code === "unsupported_protocol") {
      throw new SyncHttpError("unsupported_protocol", "unsupported protocol");
    }
    throw new SyncHttpError("server", `HTTP ${response.status}`);
  }

  private checkProtocol(body: { protocol?: unknown }): void {
    if (body?.protocol !== PROTOCOL_VERSION) {
      throw new SyncHttpError(
        "unsupported_protocol",
        `server protocol ${String(body?.protocol)}`,
      );
    }
  }

  async login(email: string, password: string): Promise<LoginResponse> {
    const request: LoginRequest = {
      protocol: PROTOCOL_VERSION,
      email,
      password,
      device_name: PHONE_DEVICE_NAME,
    };
    const response = await this.request("/api/login", request, null);
    if (!response.ok) return this.fail(response);
    const body = await this.json<LoginResponse>(response);
    this.checkProtocol(body);
    if (
      typeof body.token !== "string" ||
      typeof body.device_id !== "string" ||
      typeof body.server_epoch !== "string"
    ) {
      throw new SyncHttpError("server", "bad login response");
    }
    return body;
  }

  /** The token's account (`GET /api/account`); the caller treats a failure as « not read ». */
  async account(token: string): Promise<AccountInfo> {
    const response = await this.request(
      "/api/account",
      undefined,
      token,
      ACCOUNT_TIMEOUT_MS,
      "GET",
    );
    if (!response.ok) return this.fail(response);
    const body = await this.json<AccountResponse>(response);
    this.checkProtocol(body);
    if (typeof body.email !== "string") {
      throw new SyncHttpError("server", "bad account response");
    }
    // An older server still sends `plan`: ignored.
    return {
      email: body.email,
      emailVerified: body.email_verified !== false,
    };
  }

  /** `POST /api/email/resend` (204): a new address-confirmation link by mail. */
  async resendConfirmation(token: string): Promise<void> {
    const response = await this.request(
      "/api/email/resend",
      {},
      token,
      ACCOUNT_TIMEOUT_MS,
    );
    if (!response.ok) await this.fail(response);
  }

  /** Best effort: errors are ignored by the caller. */
  async logout(token: string): Promise<void> {
    const response = await this.request(
      "/api/logout",
      undefined,
      token,
      LOGOUT_TIMEOUT_MS,
    );
    if (!response.ok) await this.fail(response);
  }

  /**
   * One file request with its own timeout, which also covers reading the body (`read`).
   * Network failures and timeouts are `offline`, 401 `unauthorized`, the file refusals a
   * `FileRefused`, anything else a server error.
   */
  private async fileRequest<T>(
    method: "GET" | "PUT",
    path: string,
    token: string,
    timeoutMs: number,
    read: (response: Response) => Promise<T>,
    body?: Blob,
  ): Promise<T> {
    if (isOffline()) throw new SyncHttpError("offline", "navigator offline");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: method === "PUT" ? "application/json" : "*/*",
    };
    if (body) headers["Content-Type"] = "application/octet-stream";
    try {
      let response: Response;
      try {
        response = await this.fetchFn(`${this.baseUrl}${path}`, {
          method,
          headers,
          body,
          signal: controller.signal,
          credentials: "omit",
          cache: "no-store",
        });
      } catch (error) {
        throw new SyncHttpError(
          "offline",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (!response.ok) await this.fileFailure(response);
      try {
        return await read(response);
      } catch (error) {
        if (error instanceof SyncHttpError || error instanceof FileRefused) {
          throw error;
        }
        // The body was cut (network, timeout).
        throw new SyncHttpError(
          "offline",
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async fileFailure(response: Response): Promise<never> {
    let code: string | null = null;
    try {
      const body = (await response.json()) as ErrorBody;
      code = typeof body?.error === "string" ? body.error : null;
    } catch {
      code = null;
    }
    const s = response.status;
    if (s === 401) throw new SyncHttpError("unauthorized", "unauthorized");
    if (s === 404) throw new FileRefused("not_found", s);
    if (s === 409) throw new FileRefused("chunk_offset", s);
    if (s === 507) throw new FileRefused("quota_exceeded", s);
    if (s === 413) {
      throw new FileRefused(
        code === "file_too_large" ? "file_too_large" : "refused",
        s,
      );
    }
    if (s === 400 && code === "hash_mismatch") {
      throw new FileRefused("hash_mismatch", s);
    }
    if (s >= 400 && s < 500) throw new FileRefused("refused", s);
    throw new SyncHttpError("server", `HTTP ${s}`);
  }

  private async fileStatusBody(response: Response): Promise<FileStatus> {
    const body = await this.json<FileStatus>(response);
    this.checkProtocol(body);
    if (
      !Number.isSafeInteger(body.received) ||
      !Number.isSafeInteger(body.size) ||
      typeof body.complete !== "boolean"
    ) {
      throw new SyncHttpError("server", "bad file status");
    }
    return body;
  }

  /** How much of the attachment's file the server holds. */
  fileStatus(token: string, id: string): Promise<FileStatus> {
    return this.fileRequest(
      "GET",
      `/api/files/${encodeURIComponent(id)}/status`,
      token,
      FILE_STATUS_TIMEOUT_MS,
      (r) => this.fileStatusBody(r),
    );
  }

  /** Sends one chunk (`body`, at most `MAX_CHUNK_BYTES`) at `query.offset`. */
  putFileChunk(
    token: string,
    id: string,
    query: ChunkQuery,
    body: Blob,
  ): Promise<FileStatus> {
    const q = new URLSearchParams({
      offset: String(query.offset),
      size: String(query.size),
      sha256: query.sha256,
    });
    return this.fileRequest(
      "PUT",
      `/api/files/${encodeURIComponent(id)}?${q}`,
      token,
      FILE_CHUNK_TIMEOUT_MS,
      (r) => this.fileStatusBody(r),
      body,
    );
  }

  /** The whole file (its type is never trusted: the caller decides how to give it). */
  downloadFile(token: string, id: string): Promise<Blob> {
    return this.fileRequest(
      "GET",
      `/api/files/${encodeURIComponent(id)}`,
      token,
      FILE_DOWNLOAD_TIMEOUT_MS,
      (r) => r.blob(),
    );
  }

  async sync(token: string, request: SyncRequest): Promise<SyncResponse> {
    const response = await this.request("/api/sync", request, token);
    if (!response.ok) return this.fail(response);
    const body = await this.json<SyncResponse>(response);
    this.checkProtocol(body);
    if (
      typeof body.server_epoch !== "string" ||
      typeof body.cursor !== "number" ||
      !Array.isArray(body.changes) ||
      !Array.isArray(body.rejected)
    ) {
      throw new SyncHttpError("server", "bad sync response");
    }
    return body;
  }
}
