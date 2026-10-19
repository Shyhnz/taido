/**
 * The project notebook of the mock backend: groups and
 * pages with the rules of the core (`db/notes.rs`, `views/notes.rs`, `views/search.rs`), for
 * the site, the phone and the tests.
 *
 * A page is Markdown in `body`. It sits in a group or outside any group (`groupId` null);
 * « Épinglées » (`pinnedAt`) and « Résumés de tâches » (a summary outside any group) are views.
 * Outside any group plain pages and summaries are two separately ordered lists. A deleted page
 * is only stamped (`deletedAt`); a deleted group is gone, its pages fall outside any group.
 *
 * The page images are attachments of `MockLinks` whose owner is the page (`notePageId`).
 */

import type {
  ErrorPayload,
  NotebookView,
  NoteGroup,
  NoteGroupBlock,
  NoteHit,
  NoteKind,
  NoteLinkRef,
  NotePage,
  NotePageRow,
  NoteTarget,
  SubjectTag,
} from "../bindings";
import { appendPosition, byPosition, placeAt } from "./mock-order";
import { MAX_NOTE_BODY_BYTES, MAX_NOTE_TITLE_BYTES } from "./sync-proto";

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface NoteGroupRec {
  id: string;
  subjectId: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface NotePageRec {
  id: string;
  subjectId: string;
  groupId: string | null;
  kind: NoteKind;
  title: string;
  body: string;
  sourceTaskId: string | null;
  pinnedAt: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
  /** Soft delete (restorable). */
  deletedAt: string | null;
}

const invalid = (message: string): ErrorPayload => ({
  kind: "invalid",
  message,
});
const notFound = (what: string, id: string): ErrorPayload => ({
  kind: "not_found",
  message: `${what} introuvable : ${id}`,
});

/** Bytes of `text` in UTF-8 (the protocol's limits count bytes). */
export const utf8Length = (text: string): number =>
  new TextEncoder().encode(text).length;

// ---------------------------------------------------------------------------
// Links (core `notes::scan_links`)
// ---------------------------------------------------------------------------

export type LinkKind = "page" | "task" | "file";

/** One link of a body: where it sits (`start..end`, the `!` of an image included). */
export interface LinkSpan {
  start: number;
  end: number;
  kind: LinkKind;
  id: string;
  /** The title (or width) after `|`, empty when absent. */
  label: string;
}

const ID_CHARS = /^[0-9a-f-]*/;
const LINK_KINDS: readonly LinkKind[] = ["page", "task", "file"];

/**
 * Every link of `body`, in order: `[[page:<id>|Title]]`, `[[task:<id>|Title]]`,
 * `[[file:<id>|<l>%]]` (the image form `![[file:…]]` too). `<id>` is 36 characters of
 * `[0-9a-f-]`; the part after `|` is optional.
 */
export function scanLinks(body: string): LinkSpan[] {
  const out: LinkSpan[] = [];
  let from = 0;
  for (;;) {
    const open = body.indexOf("[[", from);
    if (open < 0) break;
    from = open + 2;
    const kind = LINK_KINDS.find((k) => body.startsWith(`${k}:`, from));
    if (kind === undefined) continue;
    const idAt = from + kind.length + 1;
    const run = ID_CHARS.exec(body.slice(idAt, idAt + 37));
    if (run === null || run[0].length !== 36) continue;
    const id = body.slice(idAt, idAt + 36);
    let at = idAt + 36;
    let label = "";
    if (body[at] === "|") {
      const close = body.indexOf("]", at + 1);
      if (close < 0) continue;
      label = body.slice(at + 1, close);
      at = close;
    }
    if (!body.startsWith("]]", at)) continue;
    const end = at + 2;
    const start = open > 0 && body[open - 1] === "!" ? open - 1 : open;
    out.push({ start, end, kind, id, label });
    from = end;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plain text (core `views::notes::excerpt`, `views::search::fold`)
// ---------------------------------------------------------------------------

/** Characters of a page's excerpt. */
export const EXCERPT_CHARS = 120;

const BLOCK_MARKS = ["- [ ] ", "- [x] ", "- [X] ", "- ", "* ", "+ "];
const DROPPED = new Set(["*", "`", "~", "=", "\\"]);

/** `text](url)`: the index after the closing parenthesis, `null` when it is not a link. */
function skipLink(s: string, from: number): number | null {
  const open = s.indexOf("](", from);
  if (open < 0) return null;
  const close = s.indexOf(")", open + 2);
  return close < 0 ? null : close + 1;
}

/** One line as plain text: block marks, links (their title stays), images and tags removed. */
function plainLine(line: string): string {
  let s = line.trimStart();
  // Block marks: quote, heading, task box, bullet, number.
  for (;;) {
    const before = s;
    s = s.replace(/^>+/, "").trimStart();
    s = s.replace(/^#+/, "").trimStart();
    for (const mark of BLOCK_MARKS) {
      if (s.startsWith(mark)) s = s.slice(mark.length).trimStart();
    }
    const digits = /^[0-9]+/.exec(s);
    if (digits !== null && s.startsWith(". ", digits[0].length)) {
      s = s.slice(digits[0].length + 2).trimStart();
    }
    if (s === before) break;
  }
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s.startsWith("![[", i)) {
      // An image: nothing to read.
      const end = s.indexOf("]]", i + 3);
      i = end < 0 ? s.length : end + 2;
    } else if (s.startsWith("[[", i)) {
      // `[[page:<id>|Title]]`: the title; without one, nothing.
      const end = s.indexOf("]]", i + 2);
      const inner = s.slice(i + 2, end < 0 ? s.length : end);
      const bar = inner.indexOf("|");
      if (bar >= 0) out += inner.slice(bar + 1);
      i = end < 0 ? s.length : end + 2;
    } else if (s.startsWith("![", i)) {
      i = skipLink(s, i + 2) ?? i + 2;
    } else if (s[i] === "[") {
      // `[text](url)`: the text.
      const bracket = s.indexOf("](", i + 1);
      const after = bracket < 0 ? null : skipLink(s, bracket);
      if (bracket >= 0 && after !== null) {
        out += s.slice(i + 1, bracket);
        i = after;
      } else {
        out += "[";
        i += 1;
      }
    } else if (s[i] === "<") {
      // An HTML tag (`<u>`), only when it closes.
      const end = s.indexOf(">", i + 1);
      if (end > i + 1 && !/\s/.test(s.slice(i + 1, end))) {
        i = end + 1;
      } else {
        out += "<";
        i += 1;
      }
    } else {
      const c = String.fromCodePoint(s.codePointAt(i) ?? 32);
      if (!DROPPED.has(c)) out += c;
      i += c.length;
    }
  }
  return out.split(/\s+/).filter(Boolean).join(" ");
}

const linesOf = (body: string): string[] =>
  body.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));

const charCount = (s: string): number => {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
};

/**
 * The start of a page as plain text: Markdown marks, links (their title stays), images and
 * HTML tags removed, lines joined by one space, cut at `EXCERPT_CHARS` characters.
 */
export function excerpt(body: string): string {
  let out = "";
  for (const line of linesOf(body)) {
    const text = plainLine(line);
    if (text === "") continue;
    if (out !== "") out += " ";
    out += text;
    if (charCount(out) >= EXCERPT_CHARS) break;
  }
  return Array.from(out).slice(0, EXCERPT_CHARS).join("").trimEnd();
}

/** The whole body as plain text (what the search reads): the excerpt's rules, no cut. */
export function plainText(body: string): string {
  const parts: string[] = [];
  for (const line of linesOf(body)) {
    const text = plainLine(line);
    if (text !== "") parts.push(text);
  }
  return parts.join(" ");
}

const FOLDED: Record<string, string> = {
  œ: "oe",
  æ: "ae",
  ß: "ss",
  ø: "o",
  đ: "d",
  ħ: "h",
  ı: "i",
  ŀ: "l",
  ł: "l",
  ŧ: "t",
  "’": "'",
  "‘": "'",
  ʼ: "'",
};

/** Lower case without accents: « Écrire l’Œuvre » → « ecrire l'oeuvre » (core `fold`). */
export function fold(text: string): string {
  let mapped = "";
  for (const c of text.toLowerCase()) mapped += FOLDED[c] ?? c;
  return mapped.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** `word` is in `title` where a word starts (after a character that is not a letter or digit). */
function startsAWord(title: string, word: string): boolean {
  for (let i = title.indexOf(word); i >= 0; i = title.indexOf(word, i + 1)) {
    if (
      i === 0 ||
      !/[\p{L}\p{N}]/u.test(String.fromCodePoint(prevCode(title, i)))
    ) {
      return true;
    }
  }
  return false;
}

const prevCode = (s: string, i: number): number => {
  const low = s.charCodeAt(i - 1);
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    return s.codePointAt(i - 2) ?? low;
  }
  return low;
};

/** Hits returned at most (core `views::search::MAX_HITS`). */
/** Suffix of a duplicated page's title (core `COPY_SUFFIX`). */
const COPY_SUFFIX = " (copie)";

/** « <title> (copie) », the title cut on a character so the whole fits the byte limit. */
export function copyTitle(title: string): string {
  const room = MAX_NOTE_TITLE_BYTES - utf8Length(COPY_SUFFIX);
  let cut = title;
  while (utf8Length(cut) > room) cut = Array.from(cut).slice(0, -1).join("");
  return `${cut.trimEnd()}${COPY_SUFFIX}`;
}

export const MAX_NOTE_HITS = 20;

// ---------------------------------------------------------------------------
// The notebook
// ---------------------------------------------------------------------------

export interface NotesHost {
  newId(prefix: string): string;
  now(): string;
  /** A live project that can hold notes: `not_found` or `invalid` (a group) otherwise. */
  ensureProject(id: string): void;
  /** A live task. */
  taskLive(id: string): boolean;
  /**
   * Whether a project's pages can be reached: the project is not in the trash, nor its parent
   * (core `notes::LIVE_PROJECT`).
   */
  projectLive(id: string): boolean;
}

const toGroup = (g: NoteGroupRec): NoteGroup => ({
  id: g.id,
  subjectId: g.subjectId,
  name: g.name,
  position: g.position,
});

const toPage = (p: NotePageRec): NotePage => ({
  id: p.id,
  subjectId: p.subjectId,
  groupId: p.groupId,
  kind: p.kind,
  title: p.title,
  body: p.body,
  sourceTaskId: p.sourceTaskId,
  pinnedAt: p.pinnedAt,
  position: p.position,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

const toRow = (p: NotePageRec): NotePageRow => ({
  id: p.id,
  title: p.title,
  kind: p.kind,
  excerpt: excerpt(p.body),
  updatedAt: p.updatedAt,
  pinned: p.pinnedAt !== null,
});

const nonEmpty = (value: string, what: string): string => {
  const trimmed = value.trim();
  if (trimmed === "") throw invalid(`${what} ne peut pas être vide`);
  return trimmed;
};

/** How well a page matches, best first. */
const Rank = {
  TitleStart: 0,
  WordStart: 1,
  InTitle: 2,
  Elsewhere: 3,
} as const;
type Rank = (typeof Rank)[keyof typeof Rank];

export class MockNotes {
  groups: NoteGroupRec[] = [];
  pages: NotePageRec[] = [];

  constructor(private readonly host: NotesHost) {}

  reset(): void {
    this.groups = [];
    this.pages = [];
  }

  // --- groups ----------------------------------------------------------------------------

  private groupsOf(subjectId: string): NoteGroupRec[] {
    return this.groups.filter((g) => g.subjectId === subjectId);
  }

  group(id: string): NoteGroupRec {
    const g = this.groups.find((x) => x.id === id);
    if (!g) throw notFound("Groupe de notes", id);
    return g;
  }

  createGroup(subjectId: string, name: string): NoteGroup {
    this.host.ensureProject(subjectId);
    const clean = nonEmpty(name, "Le nom du groupe");
    const now = this.host.now();
    const rec: NoteGroupRec = {
      id: this.host.newId("notegroup"),
      subjectId,
      name: clean,
      position: appendPosition(this.groupsOf(subjectId)),
      createdAt: now,
      updatedAt: now,
    };
    this.groups.push(rec);
    return toGroup(rec);
  }

  updateGroup(id: string, name: string): NoteGroup {
    const g = this.group(id);
    const clean = nonEmpty(name, "Le nom du groupe");
    if (clean !== g.name) {
      g.name = clean;
      g.updatedAt = this.host.now();
    }
    return toGroup(g);
  }

  /**
   * Deletes the group for good; its pages go outside any group, after the pages already there
   * and in their order (plain pages after the plain pages, summaries after the summaries).
   * Returns the ids of the pages that moved.
   */
  deleteGroup(id: string): string[] {
    const g = this.group(id);
    const moved: NotePageRec[] = [];
    for (const [kind, summaries] of [
      ["page", false],
      ["summary", true],
    ] as const) {
      const base = appendPosition(this.scope(g.subjectId, null, summaries));
      const own = this.pages.filter((p) => p.groupId === id && p.kind === kind);
      if (own.length === 0) continue;
      const min = Math.min(...own.map((p) => p.position));
      for (const p of own) p.position = base + p.position - min;
    }
    for (const p of this.pages) {
      if (p.groupId === id) {
        p.groupId = null;
        moved.push(p);
      }
    }
    this.groups = this.groups.filter((x) => x.id !== id);
    return moved.map((p) => p.id);
  }

  reorderGroup(id: string, index: number): void {
    const g = this.group(id);
    placeAt(this.groupsOf(g.subjectId), g, index);
    g.updatedAt = this.host.now();
  }

  /** The group `id` when it belongs to `subjectId`. */
  private groupOf(id: string, subjectId: string): NoteGroupRec {
    const g = this.group(id);
    if (g.subjectId !== subjectId) {
      throw invalid(`Le groupe ${id} appartient à un autre projet`);
    }
    return g;
  }

  // --- pages -----------------------------------------------------------------------------

  /** A live page of a live project. */
  page(id: string): NotePageRec {
    const p = this.pages.find((x) => x.id === id && x.deletedAt === null);
    if (!p || !this.host.projectLive(p.subjectId)) throw notFound("Page", id);
    return p;
  }

  /** A page, deleted or not (its images, the purge). */
  anyPage(id: string): NotePageRec | undefined {
    return this.pages.find((x) => x.id === id);
  }

  /** Live, unpinned pages of a list (core `positions::Scope::NotePages`). */
  private scope(
    subjectId: string,
    groupId: string | null,
    summaries: boolean,
  ): NotePageRec[] {
    return this.pages.filter(
      (p) =>
        p.subjectId === subjectId &&
        p.groupId === groupId &&
        p.pinnedAt === null &&
        p.deletedAt === null &&
        (groupId !== null || (p.kind === "summary") === summaries),
    );
  }

  private checkTitle(title: string): string {
    const clean = nonEmpty(title, "Le titre de la page");
    if (utf8Length(clean) > MAX_NOTE_TITLE_BYTES) {
      throw invalid(
        `Le titre de la page dépasse ${MAX_NOTE_TITLE_BYTES} octets`,
      );
    }
    return clean;
  }

  private checkBody(body: string): void {
    if (utf8Length(body) > MAX_NOTE_BODY_BYTES) {
      throw invalid(`La page dépasse ${MAX_NOTE_BODY_BYTES} octets`);
    }
  }

  createPage(input: {
    subjectId: string;
    groupId: string | null;
    title: string;
    body: string;
    kind: NoteKind;
    sourceTaskId: string | null;
  }): NotePage {
    this.host.ensureProject(input.subjectId);
    const title = this.checkTitle(input.title);
    this.checkBody(input.body);
    if (
      input.sourceTaskId !== null &&
      !this.host.taskLive(input.sourceTaskId)
    ) {
      throw notFound("Tâche", input.sourceTaskId);
    }
    const groupId =
      input.groupId === null
        ? null
        : this.groupOf(input.groupId, input.subjectId).id;
    const now = this.host.now();
    const rec: NotePageRec = {
      id: this.host.newId("page"),
      subjectId: input.subjectId,
      groupId,
      kind: input.kind,
      title,
      body: input.body,
      sourceTaskId: input.sourceTaskId,
      pinnedAt: null,
      position: appendPosition(
        this.scope(input.subjectId, groupId, input.kind === "summary"),
      ),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.pages.push(rec);
    return toPage(rec);
  }

  getPage(id: string): NotePage {
    return toPage(this.page(id));
  }

  /**
   * Changes the title and/or the body. Writes nothing (not even `updatedAt`) when the values
   * are the current ones; `changed` tells whether it did.
   */
  updatePage(
    id: string,
    title: string | null,
    body: string | null,
  ): { page: NotePage; changed: boolean } {
    const p = this.page(id);
    const newTitle = title === null ? p.title : this.checkTitle(title);
    if (body !== null) this.checkBody(body);
    const newBody = body ?? p.body;
    if (newTitle === p.title && newBody === p.body) {
      return { page: toPage(p), changed: false };
    }
    p.title = newTitle;
    p.body = newBody;
    p.updatedAt = this.host.now();
    return { page: toPage(p), changed: true };
  }

  /**
   * Moves a page: pins it (`pinnedAt`; its group is kept), or puts it in a group / outside any
   * group at `index` (`null` = at the end), unpinned.
   */
  movePage(
    id: string,
    asked: NoteTarget,
    index: number | null,
  ): { page: NotePage; changed: boolean } {
    const p = this.page(id);
    const now = this.host.now();
    if (asked === "pinned") {
      // Already pinned: nothing is written.
      if (p.pinnedAt !== null) return { page: toPage(p), changed: false };
      p.pinnedAt = now;
      p.updatedAt = now;
      return { page: toPage(p), changed: true };
    }
    // A summary sent outside any group goes to « Résumés de tâches ».
    const target: NoteTarget =
      asked === "ungrouped" && p.kind === "summary" ? "summaries" : asked;
    if (target === "summaries" && p.kind !== "summary") {
      throw invalid("Seul un résumé va dans « Résumés de tâches »");
    }
    const groupId =
      typeof target === "object"
        ? this.groupOf(target.group.id, p.subjectId).id
        : null;
    const siblings = this.scope(p.subjectId, groupId, target === "summaries");
    if (index === null) p.position = appendPosition(siblings);
    else placeAt(siblings, p, index);
    p.groupId = groupId;
    p.pinnedAt = null;
    p.updatedAt = now;
    return { page: toPage(p), changed: true };
  }

  /**
   * Pins or unpins a page (core `set_pinned`). Unpinning keeps its group and position; a
   * page whose group died meanwhile is outside any group already. `changed`: false when the
   * page already was in that state (nothing written).
   */
  setPinned(id: string, pinned: boolean): { page: NotePage; changed: boolean } {
    const p = this.page(id);
    if ((p.pinnedAt !== null) === pinned)
      return { page: toPage(p), changed: false };
    const now = this.host.now();
    p.pinnedAt = pinned ? now : null;
    p.updatedAt = now;
    return { page: toPage(p), changed: true };
  }

  /** « Dupliquer » (core `duplicate_page`): « … (copie) » right after the original. */
  duplicatePage(id: string): NotePage {
    const p = this.page(id);
    const now = this.host.now();
    const rec: NotePageRec = {
      ...p,
      id: this.host.newId("page"),
      title: copyTitle(p.title),
      pinnedAt: null,
      position: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const siblings = this.scope(p.subjectId, p.groupId, p.kind === "summary");
    // Right after the original: as many siblings before it as at or before the original.
    const index = siblings.filter(
      (x) => x.id !== p.id && byPosition(x, p) <= 0,
    ).length;
    placeAt(siblings, rec, index + (siblings.includes(p) ? 1 : 0));
    this.pages.push(rec);
    return toPage(rec);
  }

  /** Soft delete (the page can be restored). */
  deletePage(id: string): void {
    const p = this.page(id);
    p.deletedAt = this.host.now();
    p.updatedAt = p.deletedAt;
  }

  /** Brings a soft-deleted page back where it was. */
  restorePage(id: string): NotePage {
    const p = this.pages.find((x) => x.id === id && x.deletedAt !== null);
    if (!p) throw notFound("Page supprimée", id);
    // Refused before anything is written (core `restore_page`).
    if (!this.host.projectLive(p.subjectId)) {
      throw invalid("Le projet de cette page est dans la corbeille.");
    }
    p.deletedAt = null;
    p.updatedAt = this.host.now();
    return toPage(p);
  }

  /**
   * Before the purge of `doomed` pages (core `trash::hand_over_shared_images`): the page that
   * keeps an image of theirs because it still shows it (`[[file:<id>`; a duplicated page shares
   * the original's image ids): a live page first, else a deleted one not purged yet, most
   * recently changed first. `null` when no other page shows it (the image goes).
   */
  imageHolder(imageId: string, doomed: ReadonlySet<string>): string | null {
    const needle = `[[file:${imageId}`;
    const holders = this.pages
      .filter(
        (p) =>
          !doomed.has(p.id) &&
          p.body.includes(needle) &&
          this.linksTo(p.body, "file", imageId),
      )
      .sort(
        (a, b) =>
          Number(a.deletedAt !== null) - Number(b.deletedAt !== null) ||
          b.updatedAt.localeCompare(a.updatedAt) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    return holders[0]?.id ?? null;
  }

  // --- views -----------------------------------------------------------------------------

  /**
   * A project's notebook. A pinned page is only in `pinned` (oldest pin first); the other lists
   * keep the order of their positions. Plain pages and summaries outside any group are two
   * lists; inside a group both kinds share the group's order.
   */
  notebook(subjectId: string): NotebookView {
    this.host.ensureProject(subjectId);
    const groups = this.groupsOf(subjectId).sort(byPosition);
    const known = new Set(groups.map((g) => g.id));
    // A page whose group is unknown here (rule N11) shows outside any group.
    const pages = this.pages
      .filter((p) => p.subjectId === subjectId && p.deletedAt === null)
      .map((p) =>
        p.groupId !== null && !known.has(p.groupId)
          ? { ...p, groupId: null }
          : p,
      )
      .sort(byPosition);
    const pinned = pages
      .filter((p) => p.pinnedAt !== null)
      .sort(
        (a, b) =>
          (a.pinnedAt ?? "").localeCompare(b.pinnedAt ?? "") ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    const unpinned = pages.filter((p) => p.pinnedAt === null);
    const blocks: NoteGroupBlock[] = groups.map((g) => ({
      group: toGroup(g),
      pages: unpinned.filter((p) => p.groupId === g.id).map(toRow),
    }));
    return {
      subjectId,
      pinned: pinned.map(toRow),
      ungrouped: unpinned
        .filter((p) => p.groupId === null && p.kind === "page")
        .map(toRow),
      groups: blocks,
      summaries: unpinned
        .filter((p) => p.groupId === null && p.kind === "summary")
        .map(toRow),
    };
  }

  // --- links -----------------------------------------------------------------------------

  private linksTo(body: string, kind: LinkKind, id: string): boolean {
    return scanLinks(body).some((l) => l.kind === kind && l.id === id);
  }

  /** Live pages (other than `except`) whose body links to `kind:id`, most recent first. */
  private pagesLinkingTo(
    kind: LinkKind,
    id: string,
    except: string | null,
  ): NoteLinkRef[] {
    return this.pages
      .filter(
        (p) =>
          p.deletedAt === null &&
          this.host.projectLive(p.subjectId) &&
          p.id !== except &&
          p.body.includes(`[[${kind}:${id}`) &&
          this.linksTo(p.body, kind, id),
      )
      .sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .map((p) => ({ kind: "page", id: p.id, title: p.title, alive: true }));
  }

  /**
   * « Mentionné dans » of a page: the live pages, then the live tasks (their note) that link
   * to it. `tasks` are the live tasks, most recently changed first.
   */
  backlinks(
    pageId: string,
    tasks: readonly { id: string; title: string; description: string }[],
  ): NoteLinkRef[] {
    const out = this.pagesLinkingTo("page", pageId, pageId);
    const needle = `[[page:${pageId}`;
    for (const t of tasks) {
      if (
        t.description.includes(needle) &&
        this.linksTo(t.description, "page", pageId)
      ) {
        out.push({ kind: "task", id: t.id, title: t.title, alive: true });
      }
    }
    return out;
  }

  /** The live pages that link to a task. */
  taskMentions(taskId: string): NoteLinkRef[] {
    return this.pagesLinkingTo("task", taskId, null);
  }

  // --- search ----------------------------------------------------------------------------

  /**
   * Live pages matching `query` (every word in the title, the text without its Markdown or the
   * project's name; case and accents ignored): title matches first (start of the title, word
   * start, inside), then the others, most recently updated first; `MAX_NOTE_HITS` at most.
   * `tagOf` gives a project's tag, `null` when its pages are not offered (trashed project, or
   * a sub-project whose parent is trashed). With `subjectId` (the notebook's own search): that
   * project's pages only, all of them, and its name is no match.
   */
  search(
    query: string,
    tagOf: (subjectId: string) => SubjectTag | null,
    subjectId: string | null = null,
  ): NoteHit[] {
    const folded = fold(query);
    const words = folded.split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const phrase = words.join(" ");
    const scored: { rank: Rank; page: NotePageRec; subject: SubjectTag }[] = [];
    for (const page of this.pages) {
      if (page.deletedAt !== null) continue;
      if (subjectId !== null && page.subjectId !== subjectId) continue;
      const subject = tagOf(page.subjectId);
      if (subject === null) continue;
      const fTitle = fold(page.title);
      const fBody = fold(plainText(page.body));
      const fSubject = subjectId === null ? fold(subject.name) : "";
      if (
        !words.every(
          (w) =>
            fTitle.includes(w) || fBody.includes(w) || fSubject.includes(w),
        )
      ) {
        continue;
      }
      const rank = fTitle
        .split(/\s+/)
        .filter(Boolean)
        .join(" ")
        .startsWith(phrase)
        ? Rank.TitleStart
        : words.some((w) => startsAWord(fTitle, w))
          ? Rank.WordStart
          : words.some((w) => fTitle.includes(w))
            ? Rank.InTitle
            : Rank.Elsewhere;
      scored.push({ rank, page, subject });
    }
    scored.sort(
      (a, b) =>
        a.rank - b.rank ||
        b.page.updatedAt.localeCompare(a.page.updatedAt) ||
        (a.page.title < b.page.title
          ? -1
          : a.page.title > b.page.title
            ? 1
            : 0) ||
        (a.page.id < b.page.id ? -1 : a.page.id > b.page.id ? 1 : 0),
    );
    const kept = subjectId === null ? scored.slice(0, MAX_NOTE_HITS) : scored;
    return kept.map(({ page, subject }) => ({
      id: page.id,
      title: page.title,
      subject,
      kind: page.kind,
    }));
  }
}
