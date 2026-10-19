/**
 * In-memory sync server for the phone's tests (docs/SYNC.md § 2.4), built on the shared
 * conflict rule `incomingWins`. Exposes a `fetch` the client uses; no network. One account
 * (`email`, `password`, `plan`): login, logout, `GET /api/account` and sync.
 *
 * V2.7 bis: the attachment files (`/api/files/{id}` and `/status`), following the real server's
 * contract (sync-server/src/files.rs): a file only for a live attachment row, chunks appended at
 * `offset`, an upload refused when its hash is not the row's, limits checked when an upload
 * opens, SHA-256 checked on the last byte, the file forgotten when its attachment is deleted or
 * when the row names another hash.
 */

import {
  type AttachmentData,
  type Change,
  type ChangeKey,
  changeKey,
  DEFAULT_ACCOUNT_QUOTA_BYTES,
  DEFAULT_MAX_FILE_BYTES,
  type FileStatus,
  incomingWins,
  knownEntitySet,
  type LoginRequest,
  MAX_CHUNK_BYTES,
  MAX_PULL_CHANGES,
  PROTOCOL_VERSION,
  type SyncRequest,
  type SyncResponse,
  stampOf,
  validateChange,
} from "../../lib/sync-proto";
import type { FetchFn } from "../sync/client";

interface Stored {
  change: Change;
  rev: number;
}

/** One attachment's file as the server holds it. */
export interface FakeFile {
  size: number;
  sha256: string;
  bytes: Uint8Array;
  complete: boolean;
}

/** One request to the file routes, in order. */
export interface FileRequest {
  method: string;
  id: string;
  route: "status" | "file";
  /** PUT only. */
  offset?: number;
  /** PUT only: bytes in the body. */
  length?: number;
}

export interface Canned {
  status: number;
  body: string;
  contentType?: string;
}

export class FakeServer {
  records = new Map<string, Stored>();
  maxRev = 0;
  epoch = "epoch-1";
  /** The account's address (lowercase), as the server stores it. */
  email = "user@exemple.fr";
  password = "secret-password";
  /** An older server still sends `plan`: set it to test that the phone ignores it. */
  legacyPlan: string | null = null;
  /** Number of `GET /api/account` requests answered. */
  accountReads = 0;
  /** `GET /api/account` answers 500 (the account read is best effort). */
  accountBroken = false;
  tokens = new Map<string, string>();
  pageSize = MAX_PULL_CHANGES;
  /** Every `/api/sync` request, in order. */
  requests: SyncRequest[] = [];
  /** Network down: fetch rejects with a TypeError. */
  offline = false;
  /** Answers the next requests with these instead (consumed in order). */
  canned: Canned[] = [];
  /** Refuse with 413 any sync request with more than this many changes. */
  maxChanges = Number.POSITIVE_INFINITY;
  /** Ids the server rejects (as if invalid). */
  rejectIds = new Set<string>();
  /** Called while a sync request is in flight (before the answer is computed). */
  onSync: ((req: SyncRequest) => void | Promise<void>) | null = null;
  /** Attachment files, by attachment id. */
  files = new Map<string, FakeFile>();
  maxFileBytes = DEFAULT_MAX_FILE_BYTES;
  quotaBytes = DEFAULT_ACCOUNT_QUOTA_BYTES;
  /** Every request to the file routes, in order. */
  fileRequests: FileRequest[] = [];
  /** The next finished upload is refused as if its bytes were damaged on the way. */
  refuseHashOnce = false;
  /** Called before a file request is answered (a test can cut the network there). */
  onFile: ((req: FileRequest) => void | Promise<void>) | null = null;
  /**
   * Rows answered with every pull, past the `known_entities` filter: what a newer server (or
   * a buggy one) may send of an entity this client does not know.
   */
  unfiltered: Change[] = [];
  private devices = 0;

  /** Stores a row as if another device had pushed it. */
  put(change: Change): void {
    this.maxRev += 1;
    this.records.set(changeKey(change), { change, rev: this.maxRev });
  }

  get(key: string): Change | undefined {
    return this.records.get(key)?.change;
  }

  /** Simulates a restore: another database, other content. */
  reset(epoch: string, keep: (c: Change) => boolean = () => false): void {
    this.epoch = epoch;
    const kept = [...this.records.values()]
      .filter((s) => keep(s.change))
      .sort((a, b) => a.rev - b.rev);
    this.records.clear();
    this.maxRev = 0;
    for (const s of kept) this.put(s.change);
  }

  fetch: FetchFn = async (input, init) => {
    if (this.offline) throw new TypeError("Failed to fetch");
    const canned = this.canned.shift();
    if (canned) {
      return new Response(canned.body, {
        status: canned.status,
        headers: { "content-type": canned.contentType ?? "application/json" },
      });
    }
    const path = new URL(input).pathname;
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    if (path === "/api/login" && method === "POST") {
      return this.login(body as LoginRequest);
    }
    const auth = new Headers(init.headers).get("authorization") ?? "";
    const device = this.tokens.get(auth.replace(/^Bearer /, ""));
    if (!device) return json(401, { error: "unauthorized", message: "no" });
    if (path === "/api/logout" && method === "POST") {
      this.tokens.delete(auth.replace(/^Bearer /, ""));
      return new Response(null, { status: 204 });
    }
    if (path === "/api/account" && method === "GET") {
      if (this.accountBroken) {
        return json(500, { error: "internal", message: "broken" });
      }
      this.accountReads += 1;
      return json(200, {
        protocol: PROTOCOL_VERSION,
        email: this.email,
        ...(this.legacyPlan === null ? {} : { plan: this.legacyPlan }),
        created_at: "2026-10-01T00:00:00.000Z",
      });
    }
    const file = /^\/api\/files\/([^/]+)(\/status)?$/.exec(path);
    if (file) {
      return this.fileRoute(
        method,
        decodeURIComponent(file[1]),
        file[2] ? "status" : "file",
        new URL(input).searchParams,
        init.body,
      );
    }
    if (path !== "/api/sync" || method !== "POST") {
      return json(404, { error: "bad_request", message: "no route" });
    }
    const req = body as SyncRequest;
    if (req.protocol !== PROTOCOL_VERSION) {
      return json(400, { error: "unsupported_protocol", message: "proto" });
    }
    if (req.changes.length > this.maxChanges) {
      return json(413, { error: "payload_too_large", message: "big" });
    }
    this.requests.push(structuredClone(req));
    if (this.onSync) await this.onSync(req);
    return json(200, this.sync(req, device));
  };

  /** The attachment (or page image) row the server holds, when live. */
  private liveAttachment(id: string): AttachmentData | null {
    const c = this.get(`attachment:${id}`) ?? this.get(`note_attachment:${id}`);
    if (
      (c?.entity !== "attachment" && c?.entity !== "note_attachment") ||
      c.data === null
    ) {
      return null;
    }
    return c.data.deleted_at === null ? (c.data as AttachmentData) : null;
  }

  private fileStatus(id: string, row: AttachmentData): FileStatus {
    let f = this.files.get(id);
    if (f && row.sha256 && f.sha256 !== row.sha256) {
      // Not this attachment's file any more (the real server drops it the same way).
      this.files.delete(id);
      f = undefined;
    }
    return {
      protocol: PROTOCOL_VERSION,
      received: f ? f.bytes.length : 0,
      size: f ? f.size : row.size,
      complete: f?.complete ?? false,
    };
  }

  private async fileRoute(
    method: string,
    id: string,
    route: "status" | "file",
    query: URLSearchParams,
    body: unknown,
  ): Promise<Response> {
    const bytes =
      method === "PUT" && body instanceof Blob
        ? new Uint8Array(await body.arrayBuffer())
        : new Uint8Array();
    const req: FileRequest = { method, id, route };
    if (method === "PUT") {
      req.offset = Number(query.get("offset"));
      req.length = bytes.length;
    }
    this.fileRequests.push(req);
    if (this.onFile) await this.onFile(req);
    if (this.offline) throw new TypeError("Failed to fetch");
    if (bytes.length > MAX_CHUNK_BYTES) {
      return json(413, { error: "payload_too_large", message: "chunk" });
    }
    const row = this.liveAttachment(id);
    if (!row) return json(404, { error: "not_found", message: "no file" });
    if (route === "status") {
      return method === "GET"
        ? json(200, this.fileStatus(id, row))
        : json(405, { error: "bad_request", message: "method" });
    }
    if (method === "GET") {
      const f = this.files.get(id);
      if (!f?.complete) return json(404, { error: "not_found", message: "no" });
      return download(f.bytes);
    }
    if (method !== "PUT") {
      return json(405, { error: "bad_request", message: "method" });
    }
    const offset = Number(query.get("offset"));
    const size = Number(query.get("size"));
    const sha256 = query.get("sha256") ?? "";
    if (row.sha256 && sha256 !== row.sha256) {
      return json(400, { error: "bad_request", message: "not its sha256" });
    }
    if (size > this.maxFileBytes) {
      return json(413, { error: "file_too_large", message: "too large" });
    }
    let f = this.files.get(id);
    if (!f || f.size !== size || f.sha256 !== sha256) {
      let others = 0;
      for (const [other, g] of this.files) if (other !== id) others += g.size;
      if (others + size > this.quotaBytes) {
        return json(507, { error: "quota_exceeded", message: "full" });
      }
      f = { size, sha256, bytes: new Uint8Array(), complete: false };
      this.files.set(id, f);
    }
    if (offset !== f.bytes.length) {
      return json(409, { error: "chunk_offset", message: "offset" });
    }
    if (f.complete) {
      return bytes.length === 0
        ? json(200, this.fileStatus(id, row))
        : json(400, { error: "bad_request", message: "complete" });
    }
    if (offset + bytes.length > size) {
      return json(400, { error: "bad_request", message: "past the end" });
    }
    const next = new Uint8Array(f.bytes.length + bytes.length);
    next.set(f.bytes);
    next.set(bytes, f.bytes.length);
    f.bytes = next;
    if (f.bytes.length === size) {
      const damaged = this.refuseHashOnce;
      this.refuseHashOnce = false;
      if (damaged || (await sha256Hex(f.bytes)) !== sha256) {
        this.files.delete(id);
        return json(400, { error: "hash_mismatch", message: "hash" });
      }
      f.complete = true;
    }
    return json(200, this.fileStatus(id, row));
  }

  private login(req: LoginRequest): Response {
    if (req.protocol !== PROTOCOL_VERSION) {
      return json(400, { error: "unsupported_protocol", message: "proto" });
    }
    if (
      req.email.trim().toLowerCase() !== this.email ||
      req.password !== this.password
    ) {
      return json(401, { error: "unauthorized", message: "bad credentials" });
    }
    this.devices += 1;
    const token = `token-${this.devices}`;
    const device = `device-${this.devices}`;
    this.tokens.set(token, device);
    return json(200, {
      protocol: PROTOCOL_VERSION,
      token,
      device_id: device,
      server_epoch: this.epoch,
    });
  }

  private sync(req: SyncRequest, device: string): SyncResponse {
    const accepted = new Set<string>();
    const refused = new Set<string>();
    const rejected: ChangeKey[] = [];
    for (const raw of req.changes) {
      const c = { ...raw, device_id: device } as Change;
      const key = changeKey(c);
      if (validateChange(c) !== null || this.rejectIds.has(c.id)) {
        rejected.push({ entity: c.entity, id: c.id });
        continue;
      }
      const stored = this.records.get(key);
      if (!stored || incomingWins(stampOf(c), stampOf(stored.change))) {
        this.put(c);
        accepted.add(key);
        refused.delete(key);
        // A deleted attachment frees its file (real server: same transaction).
        if (
          (c.entity === "attachment" || c.entity === "note_attachment") &&
          c.data?.deleted_at !== null
        ) {
          this.files.delete(c.id);
        }
      } else {
        refused.add(key);
      }
    }
    const cursor = req.cursor > this.maxRev ? 0 : req.cursor;
    // The real server sends the notebook's rows only to a client that declares them.
    const known = new Set<string>(knownEntitySet(req.known_entities));
    const rows = [...this.records.entries()]
      .filter(
        ([k, s]) =>
          s.rev > cursor && !accepted.has(k) && known.has(s.change.entity),
      )
      .map(([, s]) => s)
      .sort((a, b) => a.rev - b.rev);
    const page = rows.slice(0, this.pageSize);
    const hasMore = rows.length > this.pageSize;
    const extra = [...refused]
      .map((k) => this.records.get(k))
      .filter(
        (s): s is Stored =>
          s !== undefined && s.rev <= cursor && known.has(s.change.entity),
      );
    const changes = [
      ...[...page, ...extra]
        .sort((a, b) => a.rev - b.rev)
        .map((s) => structuredClone(s.change)),
      ...this.unfiltered.map((c) => structuredClone(c)),
    ];
    return {
      protocol: PROTOCOL_VERSION,
      server_epoch: this.epoch,
      cursor: hasMore ? page[page.length - 1].rev : this.maxRev,
      changes,
      has_more: hasMore,
      rejected,
      accepted: accepted.size,
      server_time: new Date().toISOString(),
    };
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Lowercase hex SHA-256 (Web Crypto). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * A download as the real server sends it. `blob()` gives this realm's `Blob` (in jsdom, the
 * `Response` of Node would hand a Node `Blob` the page's code cannot mix with its own).
 */
function download(bytes: Uint8Array): Response {
  const response = new Response(bytes as BodyInit, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": "attachment",
    },
  });
  Object.defineProperty(response, "blob", {
    value: async () => new Blob([bytes as BlobPart]),
  });
  return response;
}
