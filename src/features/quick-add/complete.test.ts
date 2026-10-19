import { describe, expect, it } from "vitest";
import type { Subject } from "../../bindings";
import { applyCompletion, findCompletion, fuzzyRank } from "./complete";

function subject(id: string, name: string, sections: string[] = []): Subject {
  return {
    id,
    name,
    color: "teal",
    rootPath: null,
    position: null,
    sections: sections.map((s, i) => ({
      id: `${id}-${i}`,
      subjectId: id,
      name: s,
      subpath: null,
      position: i,
      openCount: 0,
    })),
    openCount: 0,
    dot: null,
    parentId: null,
    isGroup: false,
  };
}

const SUBJECTS = [
  subject("site", "Site", ["Design", "Dev back"]),
  subject("equipe", "Équipe", ["Réunions"]),
  subject("dupont", "Client Dupont"),
];

const labels = (text: string, slash: Subject | null = null) =>
  findCompletion(text, text.length, SUBJECTS, slash)?.options.map(
    (o) => o.label,
  ) ?? null;

describe("findCompletion", () => {
  it("lists the projects right after #", () => {
    expect(labels("Faire #")).toEqual(["Site", "Équipe", "Client Dupont"]);
  });

  it("matches without case or accents, prefix first, then sections", () => {
    expect(labels("Faire #equ")).toEqual(["Équipe"]);
    expect(labels("Faire #de")).toEqual(["Site › Design", "Site › Dev back"]);
    expect(labels("Faire #dup")).toEqual(["Client Dupont"]);
  });

  it("is fuzzy: letters in order", () => {
    expect(labels("Faire #cdp")).toEqual(["Client Dupont"]);
    expect(fuzzyRank("client dupont", "zz")).toBeNull();
  });

  it("completes sections after #Projet/", () => {
    expect(labels("Faire #Site/")).toEqual([
      "Site › Design",
      "Site › Dev back",
    ]);
    expect(labels("Faire #site/dev")).toEqual(["Site › Dev back"]);
  });

  it("completes /Section in the given project only", () => {
    expect(labels("Faire /")).toBeNull();
    expect(labels("Faire /r", SUBJECTS[1])).toEqual(["Réunions"]);
  });

  it("follows a multi-word name while it is a prefix", () => {
    expect(labels("Faire #Client Du")).toEqual(["Client Dupont"]);
    expect(labels("#Site et puis")).toBeNull();
  });

  it("closes once the name is complete", () => {
    expect(labels("Faire #Équipe")).toBeNull();
  });

  it("closes once a complete name is followed by a space", () => {
    const withWeb = [...SUBJECTS, subject("web", "Site web")];
    const at = (text: string) =>
      findCompletion(text, text.length, withWeb, null)?.options.map(
        (o) => o.label,
      ) ?? null;
    expect(at("Corriger #Site ")).toBeNull();
    expect(at("Corriger #Site/Design ")).toBeNull();
    // A longer name is still offered once its next word is typed.
    expect(at("Corriger #Site w")).toEqual(["Site web"]);
    expect(labels("Faire /Design ", SUBJECTS[0])).toBeNull();
  });

  it("marks only prefix and word-start matches as strong (Enter may take them)", () => {
    const strong = (text: string, slash: Subject | null = null) =>
      findCompletion(text, text.length, SUBJECTS, slash)?.options.map((o) => [
        o.label,
        o.strong,
      ]) ?? null;
    expect(strong("Faire #sit")).toEqual([["Site", true]]);
    expect(strong("Faire #dup")).toEqual([["Client Dupont", true]]);
    expect(strong("Faire #cdp")).toEqual([["Client Dupont", false]]);
    const templates = subject("ops", "Ops", ["Templates"]);
    expect(strong("Nettoyer /tmp", templates)).toEqual([["Templates", false]]);
  });

  it("ignores # or / inside a word", () => {
    expect(labels("C#")).toBeNull();
    expect(labels("et/ou")).toBeNull();
  });
});

describe("findCompletion with sub-projects", () => {
  const sub = (
    id: string,
    name: string,
    parentId: string,
    sections: string[] = [],
  ) => ({
    ...subject(id, name, sections),
    parentId,
  });
  // Sidebar order: each parent followed by its sub-projects; two « Admin ».
  const TREE: Subject[] = [
    subject("globex", "Globex", ["Ventes"]),
    sub("globex-admin", "Admin", "globex", ["Factures"]),
    sub("globex-client", "Client", "globex"),
    subject("perso", "Perso"),
    sub("perso-admin", "Admin", "perso"),
  ];
  const options = (text: string) =>
    findCompletion(text, text.length, TREE, null)?.options.map((o) => [
      o.label,
      o.insert,
    ]) ?? null;

  it("names a sub-project with its parent, and inserts the path when the name is shared", () => {
    expect(options("Faire #adm")).toEqual([
      ["Globex › Admin", "#Globex/Admin"],
      ["Perso › Admin", "#Perso/Admin"],
    ]);
    // A name nobody shares stays short.
    expect(options("Faire #cli")).toEqual([["Globex › Client", "#Client"]]);
    expect(options("Faire #fac")).toEqual([
      ["Globex › Admin › Factures", "#Globex/Admin/Factures"],
    ]);
  });

  it("offers a parent's sections and sub-projects after #Parent/, then a sub-project's sections", () => {
    expect(options("Faire #globex/")).toEqual([
      ["Globex › Ventes", "#Globex/Ventes"],
      ["Globex › Admin", "#Globex/Admin"],
      ["Globex › Client", "#Globex/Client"],
    ]);
    expect(options("Faire #perso/ad")).toEqual([
      ["Perso › Admin", "#Perso/Admin"],
    ]);
    expect(options("Faire #Globex/Admin/")).toEqual([
      ["Globex › Admin › Factures", "#Globex/Admin/Factures"],
    ]);
  });

  it("stops once a full path is followed by a space", () => {
    expect(options("Faire #Perso/Admin ")).toBeNull();
  });
});

describe("applyCompletion", () => {
  it("replaces the fragment and adds a space", () => {
    const text = "Faire #equ demain";
    const completion = findCompletion(text, 10, SUBJECTS, null);
    if (!completion) throw new Error("expected options");
    expect(applyCompletion(text, completion, completion.options[0])).toEqual({
      text: "Faire #Équipe demain",
      caret: 14,
    });
  });

  it("replaces the rest of the word under the caret", () => {
    const text = "Faire #Sixx";
    const completion = findCompletion(text, 8, SUBJECTS, null);
    if (!completion) throw new Error("expected options");
    expect(applyCompletion(text, completion, completion.options[0]).text).toBe(
      "Faire #Site ",
    );
  });
});

describe("« @ » offers dates (Taido V2.4)", () => {
  // Friday 9 October 2026, 15:00.
  const now = new Date(2026, 9, 9, 15, 0);
  it("lists the date words with their date, and writes the plain word", () => {
    const all = findCompletion("Appel @", 7, [], null, now);
    expect(all?.options.map((o) => o.label).slice(0, 4)).toEqual([
      "Aujourd'hui",
      "Demain",
      "Après-demain",
      "Ce soir",
    ]);
    const ven = findCompletion("Appel @ven", 10, [], null, now);
    expect(ven?.options[0]).toMatchObject({
      label: "Vendredi",
      insert: "vendredi",
      date: true,
      hint: "16 oct.",
    });
    if (!ven) throw new Error("no completion");
    expect(applyCompletion("Appel @ven", ven, ven.options[0])).toEqual({
      text: "Appel vendredi ",
      caret: 15,
    });
    expect(findCompletion("Appel @demain 10", 16, [], null, now)).toBeNull();
  });
});
