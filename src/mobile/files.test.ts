/**
 * Attachment files on the phone and the website (Taido V2.7 bis, src/mobile/files.ts): kept in
 * IndexedDB until sent, sent in chunks after the sync that pushes their row, opened on demand
 * (downloaded, checked, shown when a raster image, saved otherwise), refused or full accounts
 * shown on the tile, the Mac's rules for hashes and deletions.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "../bindings";
import { DEFAULT_MAX_FILE_BYTES } from "../lib/sync-proto";
import { WebFileError } from "../lib/web-files";
import { type FileStore, MemoryFileStore } from "./files";
import { FakeServer, sha256Hex } from "./test/fakeServer";
import {
  attachment,
  link,
  makePhone,
  noteAttachment,
  notePage,
  type Phone,
  subject,
  task,
} from "./test/helpers";

const MAC = "2026-10-01T00:00:00.000Z";
const LATER = "2026-10-05T00:00:00.000Z";
/** SHA-256 of "abc" (FIPS 180-2 test vector). */
const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82,
]);

const text = (s: string) => new TextEncoder().encode(s);

afterEach(() => {
  vi.restoreAllMocks();
});

async function newTask(phone: Phone, title = "Devis") {
  return phone.backend.commands.createTask({
    title,
    description: null,
    subjectId: null,
    sectionId: null,
    dueDate: null,
    dueTime: null,
  });
}

async function tiles(phone: Phone, taskId: string): Promise<Attachment[]> {
  return (await phone.backend.commands.getTask(taskId)).attachments;
}

async function only(phone: Phone, taskId: string): Promise<Attachment> {
  const list = await tiles(phone, taskId);
  expect(list).toHaveLength(1);
  return list[0];
}

/** Pushes the rows, then lets the file job run to its end. */
async function syncAndSend(phone: Phone): Promise<void> {
  await phone.backend.engine.syncNow();
  await phone.backend.files.whenIdle();
}

/** Plain numbers: jsdom's and Node's `Uint8Array` never compare equal. */
async function bytesOf(blob: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

const numbers = (u: Uint8Array | undefined): number[] => Array.from(u ?? []);

describe("adding files on the phone or the site", () => {
  it("keeps the file here, hashes it and queues its row, without sending anything unlinked", async () => {
    const phone = makePhone();
    const t = await newTask(phone);
    const result = await phone.backend.files.add(t.id, [
      new File(["abc"], "note.txt", { type: "text/plain" }),
    ]);
    expect(result).toEqual({ added: 1 });
    const a = await only(phone, t.id);
    expect(a).toMatchObject({
      fileName: "note.txt",
      mimeType: "text/plain",
      isImage: false,
      size: 3,
      exists: true,
      // No indicator without an account (as on the Mac).
      remote: "none",
    });
    expect(phone.backend.outbox[`attachment:${a.id}`]?.purged).toBe(false);
    expect(
      JSON.parse(phone.backend.snapshot[`attachment:${a.id}`].json),
    ).toEqual({
      task_id: t.id,
      file_name: "note.txt",
      mime_type: "text/plain",
      size: 3,
      sha256: ABC,
      created_at: a.addedAt,
      deleted_at: null,
    });
    const kept = await phone.files.get(a.id);
    expect(kept?.sha256).toBe(ABC);
    expect(await bytesOf(kept?.blob ?? new Blob())).toEqual(
      numbers(text("abc")),
    );
    await phone.backend.files.run();
    expect(phone.server.fileRequests).toEqual([]);
    // Downloaded from this device, even without an account.
    const opened = await phone.backend.files.open(a.id);
    expect(opened.blob.type).toBe("application/octet-stream");
    expect(await bytesOf(opened.blob)).toEqual(numbers(text("abc")));
  });

  it("uploads a file larger than 100 MB when the server allows it", async () => {
    const server = new FakeServer();
    server.maxFileBytes = 200_000_000;
    const phone = makePhone(server);
    await link(phone);
    const t = await newTask(phone);
    // Declared size only: the phone no longer judges the size itself.
    const big = new File(["abc"], "film.mov", { type: "video/quicktime" });
    Object.defineProperty(big, "size", { value: 150_000_000 });
    const result = await phone.backend.files.add(t.id, [
      big,
      new File(["abc"], "a.txt"),
    ]);
    expect(result).toEqual({ added: 2 });
    await syncAndSend(phone);
    const names = (await tiles(phone, t.id)).map((x) => x.fileName).sort();
    expect(names).toEqual(["a.txt", "film.mov"]);
    const film = (await tiles(phone, t.id)).find(
      (x) => x.fileName === "film.mov",
    );
    expect(film?.remote).toBe("none");
    expect(server.files.get(film?.id ?? "")?.complete).toBe(true);
  });

  it("names a second file like the Mac, and a pasted screenshot through the same path", async () => {
    const phone = makePhone();
    const t = await newTask(phone);
    await phone.backend.files.add(t.id, [
      new File(["abc"], "devis.pdf", { type: "application/pdf" }),
      new File(["abd"], "devis.pdf", { type: "application/pdf" }),
    ]);
    await phone.backend.commands.addAttachmentData({
      taskId: t.id,
      name: "capture.png",
      base64: btoa(String.fromCharCode(...PNG)),
    });
    const list = await tiles(phone, t.id);
    expect(list.map((x) => x.fileName)).toEqual([
      "devis.pdf",
      "devis (2).pdf",
      "capture.png",
    ]);
    expect(list[2]).toMatchObject({ isImage: true, size: PNG.length });
    expect((await phone.files.get(list[2].id))?.sha256).toBe(
      await sha256Hex(PNG),
    );
  });

  it("refuses the Mac's commands that need a disk (paths, Finder)", async () => {
    const phone = makePhone();
    const t = await newTask(phone);
    await expect(phone.backend.commands.pickFiles(null)).rejects.toMatchObject({
      kind: "invalid",
    });
    await expect(
      phone.backend.commands.addAttachments({
        taskId: t.id,
        paths: ["/Users/user/devis.pdf"],
      }),
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(await tiles(phone, t.id)).toEqual([]);
  });

  it("a sweep while a file is being kept leaves it alone", async () => {
    const memory = new MemoryFileStore();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Stored, then slow to confirm: the attachment is not added yet.
    const slow: FileStore = {
      get: (id) => memory.get(id),
      put: async (id, file) => {
        await memory.put(id, file);
        await gate;
      },
      delete: (id) => memory.delete(id),
      ids: () => memory.ids(),
    };
    const phone = makePhone(new FakeServer(), { files: slow });
    const t = await newTask(phone);
    const adding = phone.backend.files.add(t.id, [new File(["abc"], "a.txt")]);
    await vi.waitFor(async () => expect(await memory.ids()).toHaveLength(1));
    await phone.backend.files.sweep();
    release();
    await adding;
    const a = await only(phone, t.id);
    expect(await memory.get(a.id)).not.toBeNull();
  });

  it("keeps the files across a reload", async () => {
    const phone = makePhone();
    const t = await newTask(phone);
    await phone.backend.files.add(t.id, [new File(["abc"], "note.txt")]);
    await phone.backend.saveNow();
    const persisted = await phone.store.load();
    const again = makePhone(phone.server, { persisted, files: phone.files });
    const a = await only(again, t.id);
    expect(a.fileName).toBe("note.txt");
    expect(await bytesOf((await again.backend.files.open(a.id)).blob)).toEqual(
      numbers(text("abc")),
    );
    again.backend.diff();
    // Same row, same data: nothing new to send.
    expect(again.backend.outbox).toEqual(phone.backend.outbox);
  });
});

describe("sending (linked)", () => {
  it("sends the file after the sync that pushes its row, then drops the local copy", async () => {
    const phone = makePhone(new FakeServer(), { chunkBytes: 4 });
    await link(phone);
    const t = await newTask(phone);
    await phone.backend.files.add(t.id, [
      new File(["0123456789"], "plan.txt", { type: "text/plain" }),
    ]);
    const a = await only(phone, t.id);
    expect(a.remote).toBe("local_only");
    // While a chunk is in flight, the tile says « Envoi… ».
    const during: string[] = [];
    phone.server.onFile = async (req) => {
      if (req.method === "PUT") during.push((await only(phone, t.id)).remote);
    };
    await syncAndSend(phone);
    expect(during.every((r) => r === "uploading")).toBe(true);
    const held = phone.server.files.get(a.id);
    expect(held?.complete).toBe(true);
    expect(numbers(held?.bytes)).toEqual(numbers(text("0123456789")));
    expect(held?.sha256).toBe(await sha256Hex(text("0123456789")));
    // Empty first chunk (the limits answer before any byte), then the chunks in order.
    expect(
      phone.server.fileRequests.map((r) =>
        r.method === "PUT" ? `PUT ${r.offset}+${r.length}` : r.route,
      ),
    ).toEqual(["status", "PUT 0+0", "PUT 0+4", "PUT 4+4", "PUT 8+2"]);
    expect((await only(phone, t.id)).remote).toBe("none");
    expect(await phone.files.get(a.id)).toBeNull();
    // Still openable in this session (small cache), without a download.
    phone.server.fileRequests = [];
    expect(await bytesOf((await phone.backend.files.open(a.id)).blob)).toEqual(
      numbers(text("0123456789")),
    );
    expect(phone.server.fileRequests).toEqual([]);
    // Sent: never sent again.
    await syncAndSend(phone);
    expect(phone.server.fileRequests).toEqual([]);
  });

  it("waits for the sync that pushes its row before sending a file", async () => {
    const phone = makePhone();
    await link(phone);
    const t = await newTask(phone);
    await phone.backend.files.add(t.id, [new File(["abc"], "a.txt")]);
    await phone.backend.files.run();
    expect(phone.server.fileRequests).toEqual([]);
    await syncAndSend(phone);
    const a = await only(phone, t.id);
    expect(phone.server.files.get(a.id)?.complete).toBe(true);
  });

  it("resumes after a network cut and after a reload, from the bytes the server holds", async () => {
    const server = new FakeServer();
    const phone = makePhone(server, { chunkBytes: 4 });
    await link(phone);
    const t = await newTask(phone);
    await phone.backend.files.add(t.id, [new File(["0123456789"], "plan.txt")]);
    const a = await only(phone, t.id);
    let puts = 0;
    server.onFile = (req) => {
      if (req.method === "PUT" && req.length) {
        puts += 1;
        if (puts === 2) server.offline = true;
      }
    };
    await syncAndSend(phone);
    expect(numbers(server.files.get(a.id)?.bytes)).toEqual(
      numbers(text("0123")),
    );
    expect((await only(phone, t.id)).remote).toBe("local_only");
    expect(await phone.files.get(a.id)).not.toBeNull();

    // The page is reloaded, the network is back: the upload goes on from byte 4.
    server.offline = false;
    server.onFile = null;
    await phone.backend.saveNow();
    const again = makePhone(server, {
      persisted: await phone.store.load(),
      files: phone.files,
      chunkBytes: 4,
    });
    server.fileRequests = [];
    await syncAndSend(again);
    expect(
      server.fileRequests.map((r) =>
        r.method === "PUT" ? `PUT ${r.offset}+${r.length}` : r.route,
      ),
    ).toEqual(["status", "PUT 4+4", "PUT 8+2"]);
    expect(server.files.get(a.id)?.complete).toBe(true);
    expect(numbers(server.files.get(a.id)?.bytes)).toEqual(
      numbers(text("0123456789")),
    );
    expect((await only(again, t.id)).remote).toBe("none");
  });

  it("re-reads the status after a chunk refused for its offset, and goes on from there", async () => {
    const server = new FakeServer();
    const phone = makePhone(server, { chunkBytes: 4 });
    await link(phone);
    const t = await newTask(phone);
    await phone.backend.files.add(t.id, [new File(["0123456789"], "plan.txt")]);
    const a = await only(phone, t.id);
    server.onFile = (req) => {
      // Before the first chunk lands, the server already holds 4 bytes (an earlier attempt
      // whose answer was lost).
      if (req.method === "PUT" && req.length === 4 && req.offset === 0) {
        const f = server.files.get(a.id);
        if (f) f.bytes = text("0123");
      }
    };
    await syncAndSend(phone);
    expect(
      server.fileRequests.map((r) =>
        r.method === "PUT" ? `PUT ${r.offset}+${r.length}` : r.route,
      ),
    ).toEqual(["status", "PUT 0+0", "PUT 0+4", "status", "PUT 4+4", "PUT 8+2"]);
    expect(server.files.get(a.id)?.complete).toBe(true);
  });

  it("too large or account full: the tile says so, tasks still sync, a raised limit sends it", async () => {
    const server = new FakeServer();
    server.maxFileBytes = 5;
    const phone = makePhone(server);
    await link(phone);
    const t = await newTask(phone);
    await phone.backend.files.add(t.id, [new File(["0123456789"], "big.txt")]);
    await syncAndSend(phone);
    const big = await only(phone, t.id);
    expect(big.remote).toBe("too_large");
    // Nothing of it was sent: refused by the empty first chunk.
    expect(
      server.fileRequests.filter((r) => r.method === "PUT" && r.length),
    ).toEqual([]);

    server.maxFileBytes = DEFAULT_MAX_FILE_BYTES;
    server.quotaBytes = 4;
    const other = await newTask(phone, "Autre tâche");
    await syncAndSend(phone);
    expect((await only(phone, t.id)).remote).toBe("quota_full");
    // The tasks keep syncing.
    expect(server.get(`task:${other.id}`)).toBeDefined();
    expect(await phone.backend.commands.syncStatus()).toMatchObject({
      state: "idle",
      pending: 0,
    });

    // Retried at each sync: room again, it goes.
    server.quotaBytes = 1000;
    await syncAndSend(phone);
    expect((await only(phone, t.id)).remote).toBe("none");
    expect(server.files.get(big.id)?.complete).toBe(true);
  });

  it("an unlink during an upload records nothing", async () => {
    const server = new FakeServer();
    const phone = makePhone(server, { chunkBytes: 4 });
    await link(phone);
    const t = await newTask(phone);
    await phone.backend.files.add(t.id, [new File(["0123456789"], "plan.txt")]);
    await phone.backend.engine.syncNow();
    // Unlinked while the last chunk travels: the server completes the file, the phone
    // records nothing (another account may be linked next).
    server.onFile = async (req) => {
      if (req.method === "PUT" && req.offset === 8) {
        await phone.backend.commands.syncUnlink();
      }
    };
    await phone.backend.files.whenIdle();
    const a = await only(phone, t.id);
    const rec = phone.backend.links.attachments.find((x) => x.id === a.id);
    expect(rec?.file).toBe("local");
    expect(await phone.files.get(a.id)).not.toBeNull();
  });
});

describe("opening", () => {
  /** The Mac has pushed a row and sent its file. */
  async function macFile(
    server: FakeServer,
    id: string,
    bytes: Uint8Array,
    patch: Parameters<typeof attachment>[3] = {},
  ) {
    server.put(task("t", MAC));
    const sha256 = await sha256Hex(bytes);
    server.put(
      attachment(id, "t", MAC, { size: bytes.length, sha256, ...patch }),
    );
    server.files.set(id, { size: bytes.length, sha256, bytes, complete: true });
  }

  it("downloads a file of the Mac on demand, checks it, and says « Téléchargement… » meanwhile", async () => {
    const server = new FakeServer();
    await macFile(server, "att-pdf", text("%PDF-1.7 devis"), {
      file_name: "devis.pdf",
    });
    const phone = makePhone(server);
    await link(phone);
    const a = await only(phone, "t");
    // On the server, not here: the normal state of the web app, nothing to say.
    expect(a).toMatchObject({ fileName: "devis.pdf", remote: "none" });
    await phone.backend.files.whenIdle();
    expect(server.fileRequests).toEqual([]);

    const during: string[] = [];
    server.onFile = async () => {
      during.push((await only(phone, "t")).remote);
    };
    const opened = await phone.backend.files.open("att-pdf");
    expect(during).toEqual(["downloading"]);
    expect(opened).toMatchObject({ fileName: "devis.pdf" });
    expect(opened.blob.type).toBe("application/octet-stream");
    expect(await bytesOf(opened.blob)).toEqual(numbers(text("%PDF-1.7 devis")));
    expect((await only(phone, "t")).remote).toBe("none");
  });

  it("hands every file over to be saved, a raster image as an SVG or an HTML page", async () => {
    const server = new FakeServer();
    await macFile(server, "att-png", PNG, {
      file_name: "capture.png",
      mime_type: "image/png",
    });
    const svg = text('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"/>');
    server.put(
      attachment("att-svg", "t", MAC, {
        file_name: "logo.svg",
        mime_type: "image/svg+xml",
        size: svg.length,
        sha256: await sha256Hex(svg),
      }),
    );
    server.files.set("att-svg", {
      size: svg.length,
      sha256: await sha256Hex(svg),
      bytes: svg,
      complete: true,
    });
    const html = text("<script>fetch('/api/sync')</script>");
    server.put(
      attachment("att-html", "t", MAC, {
        file_name: "photo.png",
        mime_type: "image/png",
        size: html.length,
        sha256: await sha256Hex(html),
      }),
    );
    server.files.set("att-html", {
      size: html.length,
      sha256: await sha256Hex(html),
      bytes: html,
      complete: true,
    });
    const phone = makePhone(server);
    await link(phone);

    for (const id of ["att-png", "att-svg", "att-html"]) {
      const saved = await phone.backend.files.open(id);
      expect(saved.blob.type).toBe("application/octet-stream");
    }
    const png = await phone.backend.files.open("att-png");
    expect(png.fileName).toBe("capture.png");
    expect(await bytesOf(png.blob)).toEqual(numbers(PNG));
  });

  it("refuses bytes that are not the attachment's, and says when the server lacks the file", async () => {
    const server = new FakeServer();
    await macFile(server, "att-1", text("abc"));
    const f = server.files.get("att-1");
    if (f) f.bytes = text("abd");
    server.put(attachment("att-2", "t", MAC, { sha256: ABC }));
    const phone = makePhone(server);
    await link(phone);
    await expect(phone.backend.files.open("att-1")).rejects.toMatchObject({
      kind: "corrupt",
    });
    await expect(phone.backend.files.open("att-2")).rejects.toMatchObject({
      kind: "not_on_server",
    });
    server.offline = true;
    await expect(phone.backend.files.open("att-2")).rejects.toMatchObject({
      kind: "offline",
    });
    await phone.backend.commands.syncUnlink();
    const error = await phone.backend.files.open("att-2").catch((e) => e);
    expect(error).toBeInstanceOf(WebFileError);
    expect(error.kind).toBe("unlinked");
    expect((await tiles(phone, "t")).every((x) => x.remote === "none")).toBe(
      true,
    );
  });
});

describe("rows pulled from another device", () => {
  it("a different hash means the local copy is not that file: dropped, fetched on demand", async () => {
    const phone = makePhone();
    const t = await newTask(phone);
    await phone.backend.files.add(t.id, [new File(["abc"], "devis.pdf")]);
    const a = await only(phone, t.id);
    phone.backend.applyPulled([
      attachment(a.id, t.id, LATER, {
        file_name: "devis.pdf",
        sha256: "0".repeat(64),
      }),
    ]);
    await phone.backend.files.sweep();
    expect(await phone.files.get(a.id)).toBeNull();
    const rec = phone.backend.links.attachments.find((x) => x.id === a.id);
    expect(rec).toMatchObject({ file: "missing", sha256: "0".repeat(64) });
    // A version without hash keeps the known one (an older app sent it).
    phone.backend.applyPulled([
      attachment(a.id, t.id, "2026-10-06T00:00:00.000Z", {
        file_name: "devis.pdf",
      }),
    ]);
    expect(rec?.sha256).toBe("0".repeat(64));
  });

  it("a pulled deletion or the task's tombstone drops the local copy", async () => {
    const phone = makePhone();
    const t = await newTask(phone);
    await phone.backend.files.add(t.id, [
      new File(["abc"], "a.txt"),
      new File(["abd"], "b.txt"),
    ]);
    const [a, b] = await tiles(phone, t.id);
    phone.backend.applyPulled([
      attachment(a.id, t.id, LATER, {
        file_name: "a.txt",
        sha256: ABC,
        deleted_at: LATER,
      }),
    ]);
    await phone.backend.files.sweep();
    expect(await phone.files.get(a.id)).toBeNull();
    expect(await phone.files.get(b.id)).not.toBeNull();
    expect((await tiles(phone, t.id)).map((x) => x.fileName)).toEqual([
      "b.txt",
    ]);
  });

  it("removing an attachment here drops its copy and sends the deletion", async () => {
    const phone = makePhone();
    const t = await newTask(phone);
    await phone.backend.files.add(t.id, [new File(["abc"], "a.txt")]);
    const a = await only(phone, t.id);
    await phone.backend.commands.deleteAttachment(a.id);
    await phone.backend.files.whenIdle();
    expect(await phone.files.get(a.id)).toBeNull();
    expect(
      JSON.parse(phone.backend.snapshot[`attachment:${a.id}`].json).deleted_at,
    ).not.toBeNull();
    await expect(phone.backend.files.open(a.id)).rejects.toMatchObject({
      kind: "not_found",
    });
  });
});

describe("images of a notebook page", () => {
  async function newPage(phone: Phone) {
    const { id: subjectId } = await phone.backend.commands.createSubject({
      name: "Globex",
      color: null,
      rootPath: null,
      parentId: null,
    });
    return phone.backend.commands.createNotePage({
      subjectId,
      groupId: null,
      title: "Maquettes",
      body: "",
      kind: "page",
      sourceTaskId: null,
    });
  }

  it("are sent after the sync that pushes their row, as `note_attachment` rows", async () => {
    const phone = makePhone(new FakeServer(), { chunkBytes: 4 });
    await link(phone);
    const page = await newPage(phone);
    const { ids } = await phone.backend.files.addToPage(page.id, [
      new File(["0123456789"], "plan.png", { type: "image/png" }),
    ]);
    const [id] = ids;
    // The file is not sent before the server has the row.
    await phone.backend.files.run();
    expect(phone.server.fileRequests).toEqual([]);
    expect(
      (await phone.backend.commands.listNoteAttachments(page.id))[0].remote,
    ).toBe("local_only");
    await syncAndSend(phone);
    expect(phone.server.get(`note_attachment:${id}`)).toBeDefined();
    expect(phone.server.get(`attachment:${id}`)).toBeUndefined();
    const held = phone.server.files.get(id);
    expect(held?.complete).toBe(true);
    expect(numbers(held?.bytes)).toEqual(numbers(text("0123456789")));
    expect(await phone.files.get(id)).toBeNull();
    expect(
      (await phone.backend.commands.listNoteAttachments(page.id))[0].remote,
    ).toBe("none");
  });

  it("come from another device as rows: opened on demand, checked, shown as a thumbnail", async () => {
    const server = new FakeServer();
    const phone = makePhone(server);
    await link(phone);
    const hash = await sha256Hex(PNG);
    phone.backend.applyPulled([
      subject("p", MAC),
      notePage("pg", "p", MAC),
      noteAttachment("img", "pg", MAC, {
        file_name: "maquette.png",
        size: PNG.length,
        sha256: hash,
      }),
    ]);
    server.put(
      noteAttachment("img", "pg", MAC, { size: PNG.length, sha256: hash }),
    );
    server.files.set("img", {
      size: PNG.length,
      sha256: hash,
      bytes: PNG,
      complete: true,
    });
    const [image] = await phone.backend.commands.listNoteAttachments("pg");
    expect(image).toMatchObject({ fileName: "maquette.png", isImage: true });
    const blob = await phone.backend.files.preview("img");
    expect(blob?.type).toBe("image/png");
    expect(await bytesOf(blob ?? new Blob())).toEqual(numbers(PNG));
  });

  it("a deletion pulled, or the page's tombstone, drops the local copy", async () => {
    const phone = makePhone();
    const page = await newPage(phone);
    const { ids } = await phone.backend.files.addToPage(page.id, [
      new File(["abc"], "a.png", { type: "image/png" }),
      new File(["abd"], "b.png", { type: "image/png" }),
    ]);
    phone.backend.applyPulled([
      noteAttachment(ids[0], page.id, LATER, {
        file_name: "a.png",
        sha256: ABC,
        deleted_at: LATER,
      }),
    ]);
    await phone.backend.files.sweep();
    expect(await phone.files.get(ids[0])).toBeNull();
    expect(await phone.files.get(ids[1])).not.toBeNull();
  });
});

describe("fix round 1", () => {
  it("a failed read of a kept file leaves it to send later, never dropped", async () => {
    const memory = new MemoryFileStore();
    let failGets = 1;
    const flaky: FileStore = {
      get: async (id) => {
        if (failGets > 0) {
          failGets -= 1;
          throw new Error("UnknownError: connection lost (simulated)");
        }
        return memory.get(id);
      },
      put: (id, file) => memory.put(id, file),
      delete: (id) => memory.delete(id),
      ids: () => memory.ids(),
    };
    const phone = makePhone(new FakeServer(), { files: flaky });
    await link(phone);
    const t = await newTask(phone);
    await phone.backend.files.add(t.id, [new File(["abc"], "a.txt")]);
    await syncAndSend(phone);
    const a = await only(phone, t.id);
    expect(phone.backend.links.attachments[0].file).toBe("local");
    expect(a.remote).toBe("local_only");
    await phone.backend.files.sweep();
    expect(await memory.get(a.id)).not.toBeNull();
    // The next sync reads it and sends it.
    await syncAndSend(phone);
    expect(phone.server.files.get(a.id)?.complete).toBe(true);
    expect((await only(phone, t.id)).remote).toBe("none");
  });

  it("a full device: nothing added, the storage error said", async () => {
    const files = new MemoryFileStore();
    const phone = makePhone(new FakeServer(), { files });
    const t = await newTask(phone);
    files.failNextPut = true;
    const error = await phone.backend.files
      .add(t.id, [new File(["abc"], "a.txt")])
      .catch((e) => e);
    expect(error).toBeInstanceOf(WebFileError);
    expect(error.kind).toBe("storage");
    expect(await tiles(phone, t.id)).toEqual([]);
    expect(await files.ids()).toEqual([]);
  });

  it("pasted data is not judged by the phone: the server decides", async () => {
    const phone = makePhone();
    const t = await newTask(phone);
    const pasted = new Blob(["abc"], { type: "image/png" });
    Object.defineProperty(pasted, "size", { value: 150_000_000 });
    await phone.backend.files.addData(t.id, "capture.png", pasted);
    expect((await tiles(phone, t.id)).map((x) => x.fileName)).toEqual([
      "capture.png",
    ]);
  });

  it("keeps the very bytes it hashed, not the picked file", async () => {
    const phone = makePhone();
    const t = await newTask(phone);
    const picked = new File(["abc"], "a.txt", { type: "text/plain" });
    await phone.backend.files.add(t.id, [picked]);
    const [a] = await tiles(phone, t.id);
    const kept = await phone.files.get(a.id);
    expect(kept?.blob).not.toBe(picked);
    expect(kept?.blob.type).toBe("text/plain");
    expect(
      await sha256Hex(
        new Uint8Array(await (kept?.blob ?? new Blob()).arrayBuffer()),
      ),
    ).toBe(ABC);
  });

  it("a kept copy that no longer matches its hash is never sent again, and stays on this device", async () => {
    const files = new MemoryFileStore();
    const phone = makePhone(new FakeServer(), { files });
    await link(phone);
    const t = await newTask(phone);
    await phone.backend.files.add(t.id, [new File(["abc"], "a.txt")]);
    const [a] = await tiles(phone, t.id);
    // The device's storage damaged it: same size, same recorded hash, other bytes.
    const kept = files.files.get(a.id);
    if (kept) files.files.set(a.id, { ...kept, blob: new Blob(["abd"]) });
    await syncAndSend(phone);
    const puts = () =>
      phone.server.fileRequests.filter((r) => r.method === "PUT").length;
    const sent = puts();
    expect(sent).toBeGreaterThan(0);
    expect(phone.server.files.get(a.id)).toBeUndefined();
    expect(phone.backend.links.attachments[0].file).toBe("unsendable");
    expect((await only(phone, t.id)).remote).toBe("local_only");
    // Never again, and the copy stays (opened from this device).
    await syncAndSend(phone);
    await phone.backend.files.sweep();
    expect(puts()).toBe(sent);
    expect(await files.get(a.id)).not.toBeNull();
    expect(await bytesOf((await phone.backend.files.open(a.id)).blob)).toEqual(
      numbers(text("abd")),
    );
  });

  it("a hash refused while the copy is right waits for the next session, then goes", async () => {
    const server = new FakeServer();
    const phone = makePhone(server);
    await link(phone);
    const t = await newTask(phone);
    await phone.backend.files.add(t.id, [new File(["abc"], "a.txt")]);
    const [a] = await tiles(phone, t.id);
    server.refuseHashOnce = true;
    await syncAndSend(phone);
    expect(server.files.get(a.id)).toBeUndefined();
    expect((await only(phone, t.id)).remote).toBe("local_only");
    // Not sent again in this session (a full re-send at every sync would never end).
    const before = server.fileRequests.length;
    await syncAndSend(phone);
    expect(server.fileRequests.length).toBe(before);
    // After a reload, tried again.
    await phone.backend.saveNow();
    const again = makePhone(server, {
      persisted: await phone.store.load(),
      files: phone.files,
    });
    await syncAndSend(again);
    expect(server.files.get(a.id)?.complete).toBe(true);
    expect((await only(again, t.id)).remote).toBe("none");
  });

  it("« Les remettre »: a held attachment keeps its copy and comes back to send", async () => {
    const phone = makePhone();
    const S = "2026-10-01T00:00:00.000Z";
    const rows = [];
    for (let i = 0; i < 30; i += 1) rows.push(task(`t${i}`, S));
    phone.backend.applyPulled(rows);
    await phone.backend.files.add("t0", [new File(["abc"], "a.txt")]);
    const [a] = await tiles(phone, "t0");
    phone.backend.state.tasks = [];
    phone.backend.links.attachments = [];
    phone.backend.emitDataChanged(["tasks"]);
    expect(phone.backend.heldDeletions.has(`attachment:${a.id}`)).toBe(true);
    await phone.backend.files.sweep();
    expect(await phone.files.get(a.id)).not.toBeNull();

    phone.backend.restoreHeldDeletions();
    await phone.backend.files.whenIdle();
    expect(
      phone.backend.links.attachments.find((x) => x.id === a.id)?.file,
    ).toBe("local");
    expect(await phone.files.get(a.id)).not.toBeNull();

    // « Supprimer partout »: then the copy goes.
    phone.backend.state.tasks = [];
    phone.backend.links.attachments = [];
    phone.backend.emitDataChanged(["tasks"]);
    phone.backend.confirmHeldDeletions();
    await phone.backend.files.whenIdle();
    expect(await phone.files.get(a.id)).toBeNull();
  });
});
