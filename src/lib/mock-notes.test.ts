/**
 * The project notebook in the mock backend: the same
 * cases as the core's `db/notes.rs`, `views/notes.rs` and `views/search.rs` tests, so that the
 * site and the phone behave like the Mac.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type {
  NoteGroup,
  NoteKind,
  NotePage,
  NotePageRow,
  NoteTarget,
} from "../bindings";
import { MockBackend } from "./mock-backend";
import {
  EXCERPT_CHARS,
  excerpt,
  fold,
  plainText,
  scanLinks,
} from "./mock-notes";
import { MAX_NOTE_BODY_BYTES } from "./sync-proto";

const ID_A = "0192f0a1-7c2b-7d3e-9f00-112233445566";
const ID_B = "0192f0a1-7c2b-7d3e-9f00-aabbccddeeff";
const ID_C = "0192f0a1-7c2b-7d3e-9f00-000000000001";

let b: MockBackend;
let c: MockBackend["commands"];
let clock: number;

const tick = (ms = 5) => {
  clock += ms;
};

beforeEach(() => {
  clock = Date.parse("2026-10-14T10:00:00.000Z");
  b = new MockBackend({ seed: false, now: () => new Date(clock) });
  c = b.commands;
});

const project = async (name = "S") =>
  (await c.createSubject({ name, color: null, rootPath: null, parentId: null }))
    .id;

const group = (subjectId: string, name: string): Promise<NoteGroup> =>
  c.createNoteGroup({ subjectId, name });

const page = (
  subjectId: string,
  groupId: string | null,
  title: string,
  body = "",
  kind: NoteKind = "page",
): Promise<NotePage> =>
  c.createNotePage({
    subjectId,
    groupId,
    title,
    body,
    kind,
    sourceTaskId: null,
  });

const move = (id: string, target: NoteTarget, index: number | null = null) =>
  c.moveNotePage({ id, target, index });

const titles = (rows: NotePageRow[]) => rows.map((r) => r.title);

const rejects = async (p: Promise<unknown>, kind: string) => {
  await expect(p).rejects.toMatchObject({ kind });
};

describe("notebook pages (mock core, db/notes.rs)", () => {
  it("unpin keeps the group and the position (core set_pinned)", async () => {
    const s = await project();
    const g = await group(s, "G");
    await page(s, g.id, "A");
    const p = await page(s, g.id, "P");
    await page(s, g.id, "B");
    const pinned = await c.pinNotePage({ id: p.id, pinned: true });
    expect(pinned.pinnedAt).not.toBeNull();
    expect(titles((await c.notebook(s)).groups[0].pages)).toEqual(["A", "B"]);
    tick();
    const unpinned = await c.pinNotePage({ id: p.id, pinned: false });
    expect(unpinned.pinnedAt).toBeNull();
    expect(unpinned.groupId).toBe(g.id);
    expect(unpinned.position).toBe(p.position);
    expect(titles((await c.notebook(s)).groups[0].pages)).toEqual([
      "A",
      "P",
      "B",
    ]);
    // Unpinning an unpinned page writes nothing.
    let events = 0;
    await b.events.dataChanged.listen(() => {
      events += 1;
    });
    tick();
    const same = await c.pinNotePage({ id: p.id, pinned: false });
    expect(same.updatedAt).toBe(unpinned.updatedAt);
    expect(events).toBe(0);
  });

  it("unpin after its group died lands outside any group, by kind", async () => {
    const s = await project();
    const g = await group(s, "G");
    const p = await page(s, g.id, "P");
    const sum = await page(s, null, "Résumé", "", "summary");
    await move(sum.id, { group: { id: g.id } });
    await c.pinNotePage({ id: p.id, pinned: true });
    await c.pinNotePage({ id: sum.id, pinned: true });
    await c.deleteNoteGroup(g.id);
    await c.pinNotePage({ id: p.id, pinned: false });
    await c.pinNotePage({ id: sum.id, pinned: false });
    const view = await c.notebook(s);
    expect(titles(view.ungrouped)).toEqual(["P"]);
    expect(titles(view.summaries)).toEqual(["Résumé"]);
  });

  it("duplicate copies right after the original (core duplicate_page)", async () => {
    const s = await project();
    const g = await group(s, "G");
    const a = await page(s, g.id, "A", "Texte **gras**");
    await page(s, g.id, "B");
    const copy = await c.duplicateNotePage(a.id);
    expect(copy.id).not.toBe(a.id);
    expect(copy).toMatchObject({
      title: "A (copie)",
      body: "Texte **gras**",
      kind: "page",
      groupId: g.id,
      pinnedAt: null,
    });
    expect(titles((await c.notebook(s)).groups[0].pages)).toEqual([
      "A",
      "A (copie)",
      "B",
    ]);
    const sum = await page(s, null, "Résumé", "", "summary");
    const sumCopy = await c.duplicateNotePage(sum.id);
    expect([sumCopy.kind, sumCopy.groupId]).toEqual(["summary", null]);
  });

  it("duplicate of a long title stays within 500 bytes", async () => {
    const s = await project();
    const long = `${"é".repeat(249)}x`;
    const p = await page(s, null, long);
    const copy = await c.duplicateNotePage(p.id);
    expect(new TextEncoder().encode(copy.title).length).toBeLessThanOrEqual(
      500,
    );
    expect(copy.title.endsWith(" (copie)")).toBe(true);
    expect(copy.title.startsWith("éé")).toBe(true);
    await rejects(c.duplicateNotePage("missing"), "not_found");
  });

  it("create_page appends in its group and validates", async () => {
    const s = await project();
    const g = await group(s, "Décisions");
    const a = await page(s, g.id, " A ");
    const x = await page(s, g.id, "B");
    const loose = await page(s, null, "Loose");
    expect(a.title).toBe("A");
    expect([a.position, x.position, loose.position]).toEqual([1, 2, 1]);
    expect(a.groupId).toBe(g.id);
    expect(a.kind).toBe("page");
    const view = await c.notebook(s);
    expect(view.groups.map((blk) => blk.group)).toEqual([g]);
    expect(titles(view.groups[0].pages)).toEqual(["A", "B"]);
    // A group of another project is refused, so is a blank title.
    const other = await project("Other");
    await rejects(page(other, g.id, "X"), "invalid");
    await rejects(page(s, null, "  "), "invalid");
    // A group of nowhere, a project that is not one.
    await rejects(page(s, "nope", "X"), "not_found");
    await rejects(page("nope", null, "X"), "not_found");
  });

  it("a page or task id is a UUID shape, so that links to it parse", async () => {
    const s = await project();
    const p = await page(s, null, "P");
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("update_page with the same text writes nothing", async () => {
    const s = await project();
    const p = await page(s, null, "Title");
    let events = 0;
    await b.events.dataChanged.listen(() => {
      events += 1;
    });
    tick();
    const same = await c.updateNotePage({
      id: p.id,
      title: "Title",
      body: "",
    });
    expect(same.updatedAt).toBe(p.updatedAt);
    expect(events).toBe(0);
    const changed = await c.updateNotePage({
      id: p.id,
      title: null,
      body: "Hello",
    });
    expect(changed.body).toBe("Hello");
    expect(changed.title).toBe("Title");
    expect(changed.updatedAt).not.toBe(p.updatedAt);
    expect(events).toBe(1);
    expect((await c.getNotePage(p.id)).body).toBe("Hello");
  });

  it("pinning sets pinned_at and keeps the group; pinning twice keeps the first stamp", async () => {
    const s = await project();
    const g = await group(s, "G");
    const p = await page(s, g.id, "P");
    const moved = await move(p.id, "pinned");
    expect(moved.pinnedAt).not.toBeNull();
    expect(moved.groupId).toBe(g.id);
    tick();
    const again = await move(p.id, "pinned");
    expect(again.pinnedAt).toBe(moved.pinnedAt);
  });

  it("moving out of Épinglées into a group unpins it", async () => {
    const s = await project();
    const g = await group(s, "G");
    const h = await group(s, "H");
    const a = await page(s, h.id, "A");
    const p = await page(s, g.id, "P");
    await move(p.id, "pinned");
    const moved = await move(p.id, { group: { id: h.id } }, 0);
    expect(moved.pinnedAt).toBeNull();
    expect(moved.groupId).toBe(h.id);
    const view = await c.notebook(s);
    expect(titles(view.groups[1].pages)).toEqual(["P", "A"]);
    // Out of a group, appended outside any group.
    const out = await move(a.id, "ungrouped");
    expect(out.groupId).toBeNull();
    // A group of another project is refused.
    const other = await project("Other");
    const foreign = await group(other, "Foreign");
    await rejects(move(a.id, { group: { id: foreign.id } }), "invalid");
  });

  it("a plain page is refused in « Résumés de tâches »; a summary stays one in a group", async () => {
    const s = await project();
    const g = await group(s, "G");
    const plain = await page(s, g.id, "Plain");
    await rejects(move(plain.id, "summaries"), "invalid");
    expect((await c.getNotePage(plain.id)).groupId).toBe(g.id);
    const sum = await page(s, null, "Summary", "Done.", "summary");
    const inGroup = await move(sum.id, { group: { id: g.id } }, 0);
    expect(inGroup.kind).toBe("summary");
    const back = await move(sum.id, "summaries");
    expect(back.groupId).toBeNull();
  });

  it("deleting a group leaves its pages ungrouped, after the ones already there", async () => {
    const s = await project();
    const g = await group(s, "G");
    await page(s, null, "Loose");
    await page(s, g.id, "A");
    await page(s, g.id, "B");
    expect(await c.deleteNoteGroup(g.id)).toBeNull();
    const view = await c.notebook(s);
    expect(view.groups).toEqual([]);
    expect(titles(view.ungrouped)).toEqual(["Loose", "A", "B"]);
    await rejects(c.deleteNoteGroup(g.id), "not_found");
  });

  it("the body limit counts UTF-8 bytes; the title limit is 500 bytes", async () => {
    const s = await project();
    const big = "x".repeat(MAX_NOTE_BODY_BYTES + 1);
    await rejects(page(s, null, "Big", big), "invalid");
    const p = await page(s, null, "Small");
    await rejects(
      c.updateNotePage({ id: p.id, title: null, body: big }),
      "invalid",
    );
    // 131 073 two-byte characters are 262 146 bytes: too long though far fewer characters.
    const accents = "é".repeat(MAX_NOTE_BODY_BYTES / 2 + 1);
    await rejects(
      c.updateNotePage({ id: p.id, title: null, body: accents }),
      "invalid",
    );
    // Exactly the limit passes; so does a title of 500 bytes, not 501.
    await c.updateNotePage({
      id: p.id,
      title: "t".repeat(500),
      body: "é".repeat(MAX_NOTE_BODY_BYTES / 2),
    });
    await rejects(
      c.updateNotePage({ id: p.id, title: "t".repeat(501), body: null }),
      "invalid",
    );
    await rejects(
      c.updateNotePage({ id: p.id, title: "é".repeat(251), body: null }),
      "invalid",
    );
  });

  it("delete and restore a page", async () => {
    const s = await project();
    const p = await page(s, null, "P");
    expect(await c.deleteNotePage(p.id)).toBeNull();
    expect((await c.notebook(s)).ungrouped).toEqual([]);
    await rejects(c.getNotePage(p.id), "not_found");
    const back = await c.restoreNotePage(p.id);
    expect(back.title).toBe("P");
    expect((await c.notebook(s)).ungrouped).toHaveLength(1);
    await rejects(c.restoreNotePage(p.id), "not_found");
  });

  it("restoring a page of a trashed project is refused before anything changes", async () => {
    const s = await project();
    const p = await page(s, null, "P");
    await c.deleteNotePage(p.id);
    await c.deleteSubject(s);
    await expect(c.restoreNotePage(p.id)).rejects.toMatchObject({
      kind: "invalid",
      message: "Le projet de cette page est dans la corbeille.",
    });
    await c.restoreSubject(s);
    expect((await c.restoreNotePage(p.id)).title).toBe("P");
  });

  it("a source task is checked, a summary keeps it", async () => {
    const s = await project();
    const t = await c.createTask({
      title: "T",
      description: null,
      subjectId: s,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    const sum = await c.createNotePage({
      subjectId: s,
      groupId: null,
      title: "Sum",
      body: "",
      kind: "summary",
      sourceTaskId: t.id,
    });
    expect(sum.sourceTaskId).toBe(t.id);
    await rejects(
      c.createNotePage({
        subjectId: s,
        groupId: null,
        title: "Sum",
        body: "",
        kind: "summary",
        sourceTaskId: "nope",
      }),
      "not_found",
    );
  });

  it("groups rename and reorder", async () => {
    const s = await project();
    const a = await group(s, "A");
    await group(s, "B");
    const renamed = await c.updateNoteGroup({ id: a.id, name: " Décisions " });
    expect(renamed.name).toBe("Décisions");
    await rejects(c.updateNoteGroup({ id: a.id, name: " " }), "invalid");
    await rejects(group(s, "  "), "invalid");
    await c.reorderNoteGroup({ id: a.id, index: 1 });
    const names = (await c.notebook(s)).groups.map((blk) => blk.group.name);
    expect(names).toEqual(["B", "Décisions"]);
  });

  it("ungrouped pages and summaries are ordered apart", async () => {
    const s = await project();
    await page(s, null, "P1");
    const s1 = await page(s, null, "S1", "", "summary");
    await page(s, null, "P2");
    const s2 = await page(s, null, "S2", "", "summary");
    const x = await page(s, null, "X");
    const order = async (summaries: boolean) => {
      const v = await c.notebook(s);
      return titles(summaries ? v.summaries : v.ungrouped);
    };
    // Drop X at index 1 of the plain list [P1, P2]: between them.
    await move(x.id, "ungrouped", 1);
    expect(await order(false)).toEqual(["P1", "X", "P2"]);
    await move(x.id, "ungrouped", 2);
    expect(await order(false)).toEqual(["P1", "P2", "X"]);
    // Reordering inside the summaries.
    await move(s2.id, "summaries", 0);
    expect(await order(true)).toEqual(["S2", "S1"]);
    await move(s2.id, "summaries", 1);
    expect(await order(true)).toEqual(["S1", "S2"]);
    // A deleted group's pages: plain after the plain ones, summaries after the summaries.
    const g = await group(s, "G");
    await move(x.id, { group: { id: g.id } }, 0);
    await move(s1.id, { group: { id: g.id } }, 0);
    await c.deleteNoteGroup(g.id);
    expect(await order(false)).toEqual(["P1", "P2", "X"]);
    expect(await order(true)).toEqual(["S2", "S1"]);
  });

  it("the notebook of a trashed project is closed", async () => {
    const s = await project();
    const g = await group(s, "G");
    await c.deleteSubject(s);
    await rejects(c.notebook(s), "not_found");
    await rejects(group(s, "Autre"), "not_found");
    await rejects(page(s, g.id, "P"), "not_found");
    await c.restoreSubject(s);
    expect((await c.notebook(s)).groups).toHaveLength(1);
  });

  it("pinning a pinned page again writes nothing (m1)", async () => {
    const s = await project();
    const p = await page(s, null, "P");
    const pinned = await move(p.id, "pinned");
    let events = 0;
    await b.events.dataChanged.listen(() => {
      events += 1;
    });
    tick();
    const again = await move(p.id, "pinned");
    expect(again.updatedAt).toBe(pinned.updatedAt);
    expect(events).toBe(0);
  });

  it("a summary sent outside any group goes to « Résumés de tâches » (m2)", async () => {
    const s = await project();
    const g = await group(s, "G");
    const first = await page(s, null, "R1", "x", "summary");
    const r = await page(s, null, "R2", "x", "summary");
    await move(r.id, { group: { id: g.id } }, 0);
    const back = await move(r.id, "ungrouped", 0);
    expect(back.groupId).toBeNull();
    const view = await c.notebook(s);
    expect(view.ungrouped).toEqual([]);
    expect(view.summaries.map((x) => x.id)).toEqual([r.id, first.id]);
  });

  it("the pages of a trashed project are out of reach until it is restored (I3)", async () => {
    const gone = await project("Gone");
    const live = await project("Live");
    const t = await c.createTask({
      title: "T",
      description: null,
      subjectId: live,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    const target = await page(live, null, "Cible");
    const hidden = await page(
      gone,
      null,
      "Cachée",
      `[[page:${target.id}|Cible]] [[task:${t.id}|T]]`,
    );
    await c.deleteSubject(gone);
    await rejects(c.getNotePage(hidden.id), "not_found");
    await rejects(
      c.updateNotePage({ id: hidden.id, title: "X", body: null }),
      "not_found",
    );
    expect(await c.notePageBacklinks(target.id)).toEqual([]);
    expect(await c.taskNoteMentions(t.id)).toEqual([]);
    await c.restoreSubject(gone);
    expect((await c.getNotePage(hidden.id)).title).toBe("Cachée");
    expect(await c.notePageBacklinks(target.id)).toHaveLength(1);
    expect(await c.taskNoteMentions(t.id)).toHaveLength(1);
  });

  it("a page whose group is unknown shows outside any group (T4b, rule N11)", async () => {
    const s = await project();
    const p = await page(s, null, "Orpheline");
    const rec = b.notes.pages.find((x) => x.id === p.id);
    if (rec) rec.groupId = "0192f0a1-7c2b-7d3e-9f00-0000000000ff";
    const view = await c.notebook(s);
    expect(view.ungrouped.map((x) => x.id)).toEqual([p.id]);
  });

  it("a group is not a project: it holds no notebook", async () => {
    const s = await project();
    const grouped = await c.groupProjects({
      projectIds: [s],
      groupId: null,
      name: "Globex",
    });
    await rejects(c.notebook(grouped), "invalid");
  });
});

describe("notebook view (views/notes.rs)", () => {
  it("a pinned page is only in Épinglées, oldest pin first", async () => {
    const s = await project();
    const g = await group(s, "Décisions");
    const a = await page(s, g.id, "Dans le groupe");
    const loose = await page(s, null, "Libre");
    const other = await page(s, g.id, "Autre");
    await move(loose.id, "pinned");
    tick();
    await move(a.id, "pinned");
    const view = await c.notebook(s);
    expect(titles(view.pinned)).toEqual(["Libre", "Dans le groupe"]);
    expect(view.pinned.every((r) => r.pinned)).toBe(true);
    expect(view.ungrouped).toEqual([]);
    expect(view.groups).toHaveLength(1);
    expect(titles(view.groups[0].pages)).toEqual(["Autre"]);
    expect(view.groups[0].pages[0].id).toBe(other.id);
    expect(view.summaries).toEqual([]);
    expect(view.subjectId).toBe(s);
  });

  it("a summary without a group is in the summaries; in a group it keeps its kind", async () => {
    const s = await project();
    const g = await group(s, "G");
    await page(s, null, "P1");
    await page(s, null, "R1", "Fait.", "summary");
    const moved = await page(s, null, "R2", "Fait aussi.", "summary");
    await page(s, null, "P2");
    await move(moved.id, { group: { id: g.id } });
    const view = await c.notebook(s);
    expect(titles(view.ungrouped)).toEqual(["P1", "P2"]);
    expect(titles(view.summaries)).toEqual(["R1"]);
    expect(view.summaries[0].kind).toBe("summary");
    expect(titles(view.groups[0].pages)).toEqual(["R2"]);
    expect(view.groups[0].pages[0].kind).toBe("summary");
    const other = await project("Autre");
    expect((await c.notebook(other)).ungrouped).toEqual([]);
    await rejects(c.notebook("nope"), "not_found");
  });

  it("excerpt strips Markdown", () => {
    const body =
      "# Titre\n\n**Gras**, *italique*, ==surligné==, ~~barré~~ et <u>souligné</u>.\n" +
      "- [ ] une case\n- [x] faite\n> citation avec `code`\n1. premier\n" +
      `Voir [[page:${ID_A}|Style des mails]] et ` +
      `[le site](https://exemple.fr/a_b) ![[file:${ID_A}|50%]] fin`;
    const want =
      "Titre Gras, italique, surligné, barré et souligné. une case faite citation avec code premier Voir Style des mails et le site fin";
    expect(excerpt(body)).toBe(
      Array.from(want).slice(0, EXCERPT_CHARS).join("").trimEnd(),
    );
    expect(excerpt("")).toBe("");
    expect(excerpt("a < b et c > d")).toBe("a < b et c > d");
    expect(Array.from(excerpt("é".repeat(300)))).toHaveLength(EXCERPT_CHARS);
    expect(excerpt(`![[file:${ID_A}|25%]]`)).toBe("");
  });

  it("the rows carry the excerpt, the kind and the update date", async () => {
    const s = await project();
    await page(s, null, "P", "# Titre\n\n**gras**");
    const row = (await c.notebook(s)).ungrouped[0];
    expect(row.excerpt).toBe("Titre gras");
    expect(row.pinned).toBe(false);
    expect(row.updatedAt).toBe("2026-10-14T10:00:00.000Z");
  });
});

describe("links and « Mentionné dans » (db/notes.rs)", () => {
  it("links_in finds pages, tasks and files", () => {
    const body =
      `Voir [[page:${ID_A}|Style des mails]] et [[task:${ID_B}|Envoyer]].\n` +
      `![[file:${ID_C}|50%]] ![[file:${ID_C}]] [[page:${ID_B}]]\n` +
      `pas un lien : [[page:nope|X]] [[note:${ID_A}]] [[page:${ID_A}|ouvert`;
    expect(scanLinks(body).map((l) => [l.kind, l.id])).toEqual([
      ["page", ID_A],
      ["task", ID_B],
      ["file", ID_C],
      ["file", ID_C],
      ["page", ID_B],
    ]);
    expect(scanLinks("")).toEqual([]);
    expect(scanLinks("[[page:ÉÉÉ|é]] [[")).toEqual([]);
    // Spans include the `!` of an image; labels are kept.
    const [first] = scanLinks(`x ![[file:${ID_C}|50%]]`);
    expect([first.start, first.label]).toEqual([2, "50%"]);
    // An id that runs on past 36 characters is not an id.
    expect(scanLinks(`[[page:${ID_A}0|X]]`)).toEqual([]);
  });

  it("backlinks list the live pages and tasks that mention a page", async () => {
    const s = await project();
    const target = await page(s, null, "Cible");
    const mention = async (title: string, body: string) => {
      const p = await page(s, null, title);
      tick();
      await c.updateNotePage({ id: p.id, title: null, body });
      return p;
    };
    const one = await mention("Une", `voir [[page:${target.id}|Cible]]`);
    tick();
    const two = await mention(
      "Deux",
      `[[page:${target.id}|Ancien titre]] et encore`,
    );
    await mention("Autre", "aucun lien");
    const gone = await mention("Supprimée", `[[page:${target.id}|Cible]]`);
    await c.deleteNotePage(gone.id);
    // A page does not mention itself.
    await c.updateNotePage({
      id: target.id,
      title: null,
      body: `[[page:${target.id}|Cible]]`,
    });
    const t = await c.createTask({
      title: "Mails transactionnels",
      description: `cf. [[page:${target.id}|Cible]]`,
      subjectId: s,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    const refs = await c.notePageBacklinks(target.id);
    expect(refs.map((r) => [r.kind, r.id, r.title, r.alive])).toEqual([
      ["page", two.id, "Deux", true],
      ["page", one.id, "Une", true],
      ["task", t.id, "Mails transactionnels", true],
    ]);
    // The pages that mention a task.
    const citing = await mention("Cite la tâche", `fait : [[task:${t.id}|x]]`);
    const mentions = await c.taskNoteMentions(t.id);
    expect(mentions).toEqual([
      { kind: "page", id: citing.id, title: "Cite la tâche", alive: true },
    ]);
    // A deleted task is not listed as a backlink.
    await c.deleteTask(t.id);
    expect((await c.notePageBacklinks(target.id)).map((r) => r.kind)).toEqual([
      "page",
      "page",
    ]);
  });
});

describe("page images (db/attachments.rs)", () => {
  it("list, preview and delete a page image; a task's attachment is not a page's", async () => {
    const s = await project();
    const t = await c.createTask({
      title: "T",
      description: null,
      subjectId: s,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    const p = await page(s, null, "Maquettes");
    await c.addAttachmentData({
      taskId: t.id,
      name: "tache.png",
      base64: "iVBORw0KGgo=",
    });
    const image = await c.addNoteAttachmentData({
      notePageId: p.id,
      name: "capture.png",
      base64: "iVBORw0KGgo=",
    });
    const images = await c.listNoteAttachments(p.id);
    expect(images).toHaveLength(1);
    expect([images[0].id, images[0].notePageId]).toEqual([image.id, p.id]);
    expect(images[0].isImage && images[0].exists).toBe(true);
    expect((await c.getTask(t.id)).attachments).toHaveLength(1);
    expect(await c.attachmentPreview(image.id)).toMatch(
      /^data:image\/png;base64,/,
    );
    // The same name twice gets a free one.
    const twice = await c.addNoteAttachmentData({
      notePageId: p.id,
      name: "capture.png",
      base64: "iVBORw0KGgo=",
    });
    expect(twice.fileName).toBe("capture (2).png");
    // By path: the new images come back in order.
    const added = await c.addNoteAttachments({
      notePageId: p.id,
      paths: ["/tmp/a.png", "/tmp/b.HEIC"],
    });
    expect(added.map((a) => a.fileName)).toEqual(["a.png", "b.HEIC"]);
    expect(added.map((a) => a.mimeType)).toEqual(["image/png", "image/heic"]);
    // A page holds only images (task 8), refused before anything is added.
    const before = (await c.listNoteAttachments(p.id)).length;
    await rejects(
      c.addNoteAttachments({
        notePageId: p.id,
        paths: ["/tmp/c.png", "/tmp/devis.pdf"],
      }),
      "invalid",
    );
    await rejects(
      c.addNoteAttachmentData({
        notePageId: p.id,
        name: "devis.pdf",
        base64: "JVBERi0=",
      }),
      "invalid",
    );
    expect(await c.listNoteAttachments(p.id)).toHaveLength(before);
    await rejects(
      c.addNoteAttachments({ notePageId: p.id, paths: ["relative.png"] }),
      "invalid",
    );
    await rejects(
      c.addNoteAttachmentData({
        notePageId: p.id,
        name: "x.png",
        base64: "@@@",
      }),
      "invalid",
    );
    await rejects(
      c.addNoteAttachmentData({
        notePageId: "nope",
        name: "x.png",
        base64: "AAAA",
      }),
      "not_found",
    );
    // Deleting a page image; a task's attachment is not deletable as one.
    const taskAttachment = (await c.getTask(t.id)).attachments[0];
    await rejects(c.deleteNoteAttachment(taskAttachment.id), "not_found");
    expect(await c.deleteNoteAttachment(image.id)).toBeNull();
    expect((await c.listNoteAttachments(p.id)).map((a) => a.id)).not.toContain(
      image.id,
    );
    await rejects(c.attachmentPreview(image.id), "not_found");
  });
});

describe("searchNotes (views/search.rs)", () => {
  it("finds a page by a word of its text, accents and case ignored, titles first", async () => {
    const s = await project("Écriture");
    const other = await project("Globex");
    const byBody = await page(
      s,
      null,
      "Accès",
      "Le mot de passe est dans le **coffre-fort** été",
    );
    const byTitle = await page(other, null, "Été 2026", "rien");
    const byTitleStart = await page(s, null, "Etes-vous prêt");
    const gone = await page(s, null, "Supprimée été", "été");
    await c.deleteNotePage(gone.id);
    await page(s, null, "Sans rapport", "autre chose");

    const hits = await c.searchNotes("ETE", null);
    const ids = hits.map((h) => h.id);
    expect(ids[0]).toBe(byTitleStart.id);
    expect(ids).toContain(byTitle.id);
    expect(ids).toContain(byBody.id);
    expect(ids).not.toContain(gone.id);
    expect(ids.indexOf(byTitle.id)).toBeLessThan(ids.indexOf(byBody.id));
    const bodyHit = hits.find((h) => h.id === byBody.id);
    expect(bodyHit?.subject.name).toBe("Écriture");
    expect(bodyHit?.kind).toBe("page");
    // The project's name finds its pages too; every word must be found.
    expect(await c.searchNotes("globex rien", null)).toHaveLength(1);
    expect(await c.searchNotes("coffre inexistant", null)).toEqual([]);
    expect(await c.searchNotes("coffre-fort", null)).toHaveLength(1);
    expect(await c.searchNotes("  ", null)).toEqual([]);
    // A trashed project's pages are not offered.
    await c.deleteSubject(other);
    const after = await c.searchNotes("ete", null);
    expect(after.every((h) => h.subject.id !== other)).toBe(true);
  });

  it("searches the text without its Markdown, not the link syntax", async () => {
    const s = await project();
    const linked = await page(
      s,
      null,
      "Index",
      `Voir [[page:${ID_A}|Style des mails]] et ![[file:${ID_C}|50%]] puis **fort**`,
    );
    expect((await c.searchNotes("style", null)).map((h) => h.id)).toEqual([
      linked.id,
    ]);
    // Neither the link's kind, nor the ids, nor the image syntax are text.
    expect(await c.searchNotes("page", null)).toEqual([]);
    expect(await c.searchNotes("0192f0a1", null)).toEqual([]);
    expect(await c.searchNotes("file", null)).toEqual([]);
    expect(await c.searchNotes("50%", null)).toEqual([]);
  });

  it("skips the pages of a sub-project whose parent is trashed", async () => {
    const parent = await project("Parent");
    const group = await c.groupProjects({
      projectIds: [parent],
      groupId: null,
      name: "Clients",
    });
    const child = await c.createSubject({
      name: "Site",
      color: null,
      rootPath: null,
      parentId: group,
    });
    const p = await page(child.id, null, "Zébu");
    expect((await c.searchNotes("zebu", null)).map((h) => h.id)).toEqual([
      p.id,
    ]);
    // The sync can leave a live sub-project under a trashed parent (until it is normalised).
    const rec = b.state.subjects.find((x) => x.id === group);
    if (rec) rec.deletedAt = "2026-10-14T10:00:00.000Z";
    expect(await c.searchNotes("zebu", null)).toEqual([]);
  });

  it("the notebook's own search reads whole pages of one project, uncapped (I4)", async () => {
    const s = await project("Atelier");
    const other = await project("Autre");
    const far = await page(s, null, "Longue", `${"mot ".repeat(60)} licorne`);
    await page(other, null, "Ailleurs", "licorne");
    expect((await c.searchNotes("licorne", s)).map((h) => h.id)).toEqual([
      far.id,
    ]);
    expect(await c.searchNotes("atelier", s)).toEqual([]);
    for (let n = 0; n < 25; n += 1) await page(s, null, `Lot ${n}`);
    expect(await c.searchNotes("lot", s)).toHaveLength(25);
  });

  it("caps the hits at 20, most recent first", async () => {
    const s = await project();
    for (let n = 0; n < 25; n += 1) {
      tick(1000);
      await page(s, null, `Lot ${String(n).padStart(2, "0")}`);
    }
    const hits = await c.searchNotes("lot", null);
    expect(hits).toHaveLength(20);
    expect(hits[0].title).toBe("Lot 24");
  });
});

describe("fold and plainText", () => {
  it("fold lowers case and drops accents like the core", () => {
    expect(fold("Écrire l’Œuvre ÇA ß")).toBe("ecrire l'oeuvre ca ss");
    expect(fold("Łódź Øre")).toBe("lodz ore");
  });

  it("plainText keeps every line, unlike the excerpt", () => {
    expect(plainText("# A\n\n**b**\n- c")).toBe("A b c");
  });
});

describe("task changes the notebook sees", () => {
  it("renaming, deleting, restoring a task and relinking its note emit `notes`", async () => {
    const s = await project();
    const t = await c.createTask({
      title: "T",
      description: null,
      subjectId: s,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    const p = await page(s, null, "P");
    const scopes: string[][] = [];
    await b.events.dataChanged.listen((e) => {
      scopes.push(e.payload.scopes);
    });
    const last = () => scopes[scopes.length - 1] ?? [];

    await c.updateTask({ id: t.id, title: "T2", description: null });
    expect(last()).toContain("notes");
    await c.updateTask({
      id: t.id,
      title: null,
      description: `voir [[page:${p.id}|P]]`,
    });
    expect(last()).toContain("notes");
    await c.updateTask({ id: t.id, title: null, description: "plus rien" });
    expect(last()).toContain("notes");
    // Plain typing in a note leaves the notebooks alone.
    await c.updateTask({ id: t.id, title: null, description: "plus rien !" });
    expect(last()).not.toContain("notes");
    await c.deleteTask(t.id);
    expect(last()).toContain("notes");
    await c.restoreTask(t.id);
    expect(last()).toContain("notes");
  });
});

describe("images moved between pages (db/attachments.rs copy_to_page, prune_page_images)", () => {
  const PNG = "iVBORw0KGgo=";
  const img = (pageId: string, name = "plan.png") =>
    c.addNoteAttachmentData({ notePageId: pageId, name, base64: PNG });
  const setBody = (id: string, body: string) =>
    c.updateNotePage({ id, title: null, body });

  it("an image pasted in another page becomes its own copy", async () => {
    const s = await project();
    const a = await page(s, null, "A");
    const bp = await page(s, null, "B");
    const x = await img(a.id);
    const copy = await c.copyNoteAttachment({ id: x.id, toPageId: bp.id });
    expect(copy.id).not.toBe(x.id);
    // The core frees the name in the project folder (« plan (2).png »), the mock per page.
    expect(copy).toMatchObject({ notePageId: bp.id, size: x.size });
    expect(copy.fileName).toMatch(/^plan( \(2\))?\.png$/);
    expect(await c.attachmentPreview(copy.id)).toBe(
      await c.attachmentPreview(x.id),
    );
    const t = await c.createTask({
      title: "T",
      description: null,
      subjectId: s,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    await c.addAttachmentData({
      taskId: t.id,
      name: "devis.pdf",
      base64: "JVBERi0=",
    });
    const pdf = (await c.getTask(t.id)).attachments[0];
    await rejects(
      c.copyNoteAttachment({ id: pdf.id, toPageId: bp.id }),
      "invalid",
    );
    await rejects(
      c.copyNoteAttachment({ id: ID_C, toPageId: bp.id }),
      "not_found",
    );
  });

  it("prune deletes only the page's images no live page shows", async () => {
    const s = await project();
    const a = await page(s, null, "A");
    const bp = await page(s, null, "B");
    const x = await img(a.id, "x.png");
    const y = await img(bp.id, "y.png");
    // Cut from A, pasted in B: A's close keeps the file B shows.
    await setBody(bp.id, `![[file:${x.id}|50%]]`);
    expect(
      await c.pruneNoteImages({ pageId: a.id, candidateIds: [x.id] }),
    ).toEqual([]);
    await setBody(bp.id, "");
    await setBody(a.id, `Voir ![[file:${x.id}]]`);
    expect(
      await c.pruneNoteImages({ pageId: a.id, candidateIds: [x.id] }),
    ).toEqual([]);
    await setBody(a.id, "Rien.");
    expect(
      await c.pruneNoteImages({
        pageId: a.id,
        candidateIds: [x.id, y.id, "nope"],
      }),
    ).toEqual([x.id]);
    expect((await c.listNoteAttachments(a.id)).map((i) => i.id)).toEqual([]);
    expect((await c.listNoteAttachments(bp.id)).map((i) => i.id)).toEqual([
      y.id,
    ]);
    // A deleted page can still be restored: it keeps its images until it is purged.
    const z = await img(a.id, "z.png");
    await setBody(bp.id, `![[file:${z.id}]]`);
    await c.deleteNotePage(bp.id);
    expect(
      await c.pruneNoteImages({ pageId: a.id, candidateIds: [z.id] }),
    ).toEqual([]);
  });

  it("a page takes the same image formats as the core; others are refused", async () => {
    const s = await project();
    const a = await page(s, null, "A");
    for (const name of ["scan.TIFF", "photo.avif", "vieux.bmp", "photo.heif"]) {
      await img(a.id, name);
    }
    await rejects(img(a.id, "icone.ico"), "invalid");
    expect(await c.listNoteAttachments(a.id)).toHaveLength(4);
  });
});

describe("attachment_info (db/attachments.rs info)", () => {
  it("reads an attachment by id whoever owns it; null when there is none", async () => {
    const s = await project();
    const a = await page(s, null, "A");
    const x = await c.addNoteAttachmentData({
      notePageId: a.id,
      name: "plan.png",
      base64: "iVBORw0KGgo=",
    });
    expect(await c.attachmentInfo(x.id)).toMatchObject({
      id: x.id,
      fileName: "plan.png",
      mimeType: "image/png",
      exists: true,
    });
    expect(await c.attachmentInfo(ID_C)).toBeNull();
    await c.deleteNoteAttachment(x.id);
    expect(await c.attachmentInfo(x.id)).toBeNull();
  });
});

describe("what a page takes (the core's mime_of, by the name first)", () => {
  it("decides by the file name's extension; the browser's type only without one", async () => {
    const { pageImageRefusal, imageFileName } = await import("./mock-links");
    expect(pageImageRefusal("photo.jpg", "image/png")).toBeNull();
    expect(pageImageRefusal("scan.TIFF")).toBeNull();
    // The core goes by the name: a known image type does not save an unknown extension.
    expect(pageImageRefusal("photo.jpg.download", "image/jpeg")).toBe("format");
    expect(pageImageRefusal("favicon.ico", "image/x-icon")).toBe("format");
    expect(pageImageRefusal("favicon.ico")).toBe("format");
    expect(pageImageRefusal("devis.pdf", "application/pdf")).toBe("other");
    expect(pageImageRefusal("notes.txt", "image/png")).toBe("other");
    // No extension: the browser's type decides, and the name gets the extension the core
    // needs.
    expect(pageImageRefusal("photo", "image/jpeg")).toBeNull();
    expect(pageImageRefusal("photo", "image/x-icon")).toBe("format");
    expect(pageImageRefusal("photo", "")).toBe("other");
    expect(imageFileName("photo", "image/jpeg")).toBe("photo.jpg");
    expect(imageFileName("photo.png", "image/jpeg")).toBe("photo.png");
  });
});
