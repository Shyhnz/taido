import { afterEach, describe, expect, it, vi } from "vitest";
import type { Subject } from "../../bindings";
import {
  fold,
  literalsWithout,
  type ParseResult,
  parseQuickAdd,
  shiftRanges,
} from "./parse";

/** Saturday 3 October 2026, 10:00 (local). */
const NOW = new Date(2026, 9, 3, 10, 0);

function subject(id: string, name: string, sections: string[] = []): Subject {
  return {
    id,
    name,
    color: "violet",
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

const SUBJECTS: Subject[] = [
  subject("site", "Site", ["Design", "Dev back"]),
  subject("siteweb", "Site web", ["SEO"]),
  subject("equipe", "Équipe", ["Réunions"]),
  subject("dupont", "Client Dupont"),
  subject("perso", "Perso", ["Courses"]),
];

/** What a case checks: the title and only the fields that are set. */
interface Expected {
  title: string;
  subject?: string;
  section?: string;
  due?: { date: string; time?: string };
  launch?: "claude" | "codex" | "shell";
  priority?: 2 | 3 | 4;
  unknownProject?: string;
}

function summary(r: ParseResult): Expected {
  const out: Expected = { title: r.title };
  if (r.subject) out.subject = r.subject.name;
  if (r.section) out.section = r.section.name;
  if (r.due) out.due = r.due;
  if (r.launch) out.launch = r.launch;
  if (r.priority !== undefined) out.priority = r.priority;
  if (r.unknownProject !== undefined) out.unknownProject = r.unknownProject;
  return out;
}

type Case = [string, Expected, { context?: string }?];

const CASES: Case[] = [
  // Plain text
  ["Appeler Paul", { title: "Appeler Paul" }],
  ["  Faire   le   point  ", { title: "Faire le point" }],
  // A project-like word without # is just text.
  ["Le site perso à refaire", { title: "Le site perso à refaire" }],

  // Projects
  ["Appeler Paul #Perso", { title: "Appeler Paul", subject: "Perso" }],
  ["#perso Appeler", { title: "Appeler", subject: "Perso" }],
  ["Réviser #equipe", { title: "Réviser", subject: "Équipe" }],
  ["Réviser #ÉQUIPE", { title: "Réviser", subject: "Équipe" }],
  ["Maquette #Site web", { title: "Maquette", subject: "Site web" }],
  ["Maquette #Site", { title: "Maquette", subject: "Site" }],
  [
    "Maquette #Site webinaire",
    { title: "Maquette webinaire", subject: "Site" },
  ],
  [
    "Relancer #Client Dupont demain",
    {
      title: "Relancer",
      subject: "Client Dupont",
      due: { date: "2026-10-04" },
    },
  ],
  ["Payer #Perso, vite", { title: "Payer, vite", subject: "Perso" }],
  // First known project wins; the other stays as text.
  ["#Perso #Site faire", { title: "#Site faire", subject: "Perso" }],

  // Sections
  [
    "Réviser #Équipe/réunions",
    { title: "Réviser", subject: "Équipe", section: "Réunions" },
  ],
  [
    "Maquette #Site/Design",
    { title: "Maquette", subject: "Site", section: "Design" },
  ],
  [
    "API #site/dev back",
    { title: "API", subject: "Site", section: "Dev back" },
  ],
  [
    "Préparer /Design",
    { title: "Préparer", subject: "Site", section: "Design" },
    { context: "site" },
  ],
  ["Préparer /Design", { title: "Préparer /Design" }],
  ["Nettoyer /tmp", { title: "Nettoyer /tmp" }, { context: "site" }],
  [
    "Rédiger /SEO #Site web",
    { title: "Rédiger", subject: "Site web", section: "SEO" },
    { context: "site" },
  ],
  // The section of the view's project does not follow another (unknown) project.
  [
    "Écrire /Design #Inconnu",
    { title: "Écrire /Design #Inconnu", unknownProject: "Inconnu" },
    { context: "site" },
  ],

  // Unknown projects stay in the title until they exist.
  [
    "Relancer #Inconnu",
    { title: "Relancer #Inconnu", unknownProject: "Inconnu" },
  ],
  [
    "Relancer #Inconnu, vite",
    { title: "Relancer #Inconnu, vite", unknownProject: "Inconnu" },
  ],
  ["Bug #42 #Site", { title: "Bug #42", subject: "Site" }],

  // Agents
  ["Tests >claude", { title: "Tests", launch: "claude" }],
  ["Tests >codex", { title: "Tests", launch: "codex" }],
  ["Essai >codexx", { title: "Essai >codexx" }],
  [">Shell build", { title: "build", launch: "shell" }],
  ["Comparer a>claude", { title: "Comparer a>claude" }],
  ["Essai >claudette", { title: "Essai >claudette" }],

  // Relative dates
  ["Payer aujourd'hui", { title: "Payer", due: { date: "2026-10-03" } }],
  ["Payer aujourd’hui", { title: "Payer", due: { date: "2026-10-03" } }],
  ["Payer auj", { title: "Payer", due: { date: "2026-10-03" } }],
  [
    "Sortir ce soir",
    { title: "Sortir", due: { date: "2026-10-03", time: "18:00" } },
  ],
  ["Appeler demain", { title: "Appeler", due: { date: "2026-10-04" } }],
  ["Appeler Demain", { title: "Appeler", due: { date: "2026-10-04" } }],
  ["Appeler après-demain", { title: "Appeler", due: { date: "2026-10-05" } }],
  ["Appeler apres demain", { title: "Appeler", due: { date: "2026-10-05" } }],
  // Ambiguous: « demain matin » is tomorrow at 9:00, not a task called « matin ».
  [
    "Appeler demain matin",
    { title: "Appeler", due: { date: "2026-10-04", time: "09:00" } },
  ],
  [
    "Appeler demain soir",
    { title: "Appeler", due: { date: "2026-10-04", time: "18:00" } },
  ],
  ["Café du matin", { title: "Café du matin" }],
  ["Relire dans 3 jours", { title: "Relire", due: { date: "2026-10-06" } }],
  ["Relire dans 2 semaines", { title: "Relire", due: { date: "2026-10-17" } }],
  ["Relire dans une semaine", { title: "Relire", due: { date: "2026-10-10" } }],

  // Weekdays: next occurrence, never today (NOW is a Saturday).
  ["Réunion lundi", { title: "Réunion", due: { date: "2026-10-05" } }],
  ["Réunion samedi", { title: "Réunion", due: { date: "2026-10-10" } }],
  ["Réunion dimanche", { title: "Réunion", due: { date: "2026-10-04" } }],
  ["Réunion Lundi Prochain", { title: "Réunion", due: { date: "2026-10-05" } }],
  ["Les mardis matin", { title: "Les mardis matin" }],

  // Absolute dates
  ["Payer le 12", { title: "Payer", due: { date: "2026-10-12" } }],
  ["Payer le 2", { title: "Payer", due: { date: "2026-11-02" } }],
  ["Payer le 1er", { title: "Payer", due: { date: "2026-11-01" } }],
  ["Facture 12/10", { title: "Facture", due: { date: "2026-10-12" } }],
  ["Facture 2/10", { title: "Facture", due: { date: "2027-10-02" } }],
  ["Facture 12/10/2027", { title: "Facture", due: { date: "2027-10-12" } }],
  ["Facture 31/02", { title: "Facture 31/02" }],
  ["Facture le 31/02", { title: "Facture le 31/02" }],
  ["x le 30 fev", { title: "x le 30 fev" }],
  ["x le 31 avril", { title: "x le 31 avril" }],
  ["x le 29 février", { title: "x le 29 février" }],
  ["x le 30 fev soir", { title: "x le 30 fev soir" }],
  ["Facture 12 oct", { title: "Facture", due: { date: "2026-10-12" } }],
  ["Facture 12 oct. 2027", { title: "Facture", due: { date: "2027-10-12" } }],
  ["Facture 12 octobre", { title: "Facture", due: { date: "2026-10-12" } }],
  ["Facture 12 Décembre", { title: "Facture", due: { date: "2026-12-12" } }],
  ["Fête 1er mai", { title: "Fête", due: { date: "2027-05-01" } }],
  ["Payer le 3 février", { title: "Payer", due: { date: "2027-02-03" } }],
  ["Acheter 12 oeufs", { title: "Acheter 12 oeufs" }],
  ["Lire le 3e chapitre", { title: "Lire le 3e chapitre" }],

  // Times: alone, it is today, even when already past.
  ["Point 17h", { title: "Point", due: { date: "2026-10-03", time: "17:00" } }],
  [
    "Point 17h30",
    { title: "Point", due: { date: "2026-10-03", time: "17:30" } },
  ],
  [
    "Point à 9h",
    { title: "Point", due: { date: "2026-10-03", time: "09:00" } },
  ],
  [
    "Point 9:00",
    { title: "Point", due: { date: "2026-10-03", time: "09:00" } },
  ],
  ["Point 8h", { title: "Point", due: { date: "2026-10-03", time: "08:00" } }],
  ["Point 25h", { title: "Point 25h" }],
  ["Point 17h3", { title: "Point 17h3" }],
  [
    "Point demain 17h",
    { title: "Point", due: { date: "2026-10-04", time: "17:00" } },
  ],
  [
    "Point demain à 9h30",
    { title: "Point", due: { date: "2026-10-04", time: "09:30" } },
  ],
  [
    "Rdv 12/10 à 9h",
    { title: "Rdv", due: { date: "2026-10-12", time: "09:00" } },
  ],

  // Several dates or times: the first wins, the others stay as text.
  [
    "Appeler demain pour la réunion de lundi",
    {
      title: "Appeler pour la réunion de lundi",
      due: { date: "2026-10-04" },
    },
  ],
  [
    "Point 9h demain 17h",
    { title: "Point 17h", due: { date: "2026-10-04", time: "09:00" } },
  ],
  // An explicit time wins over the one implied by « ce soir ».
  [
    "Point ce soir 17h",
    { title: "Point", due: { date: "2026-10-03", time: "17:00" } },
  ],

  // Everything together
  [
    "Faire la maquette >claude #Site/Design demain 9h",
    {
      title: "Faire la maquette",
      subject: "Site",
      section: "Design",
      due: { date: "2026-10-04", time: "09:00" },
      launch: "claude",
    },
  ],
  ["Demain", { title: "", due: { date: "2026-10-04" } }],

  // Priority: !1, !2, !3 as shown (P1 most urgent), giving the stored 4, 3, 2;
  // the first wins, later ones stay as text.
  ["Payer !1", { title: "Payer", priority: 4 }],
  ["!2 Payer", { title: "Payer", priority: 3 }],
  ["Payer !3 vite", { title: "Payer vite", priority: 2 }],
  ["Payer !3, vite", { title: "Payer, vite", priority: 2 }],
  ["Payer !1 !3", { title: "Payer !3", priority: 4 }],
  ["Payer !4", { title: "Payer !4" }],
  ["Payer !5", { title: "Payer !5" }],
  ["Payer !", { title: "Payer !" }],
  ["Payer !22", { title: "Payer !22" }],
  ["Payer !2x", { title: "Payer !2x" }],
  // A token starts a word.
  ["Urgent!2", { title: "Urgent!2" }],
  [
    "Payer #Perso demain !1 >claude",
    {
      title: "Payer",
      subject: "Perso",
      due: { date: "2026-10-04" },
      launch: "claude",
      priority: 4,
    },
  ],
];

describe("parseQuickAdd", () => {
  it("has at least 40 cases", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40);
  });

  it.each(CASES)("%s", (text, expected, options) => {
    const result = parseQuickAdd(text, NOW, SUBJECTS, {
      contextSubjectId: options?.context ?? null,
    });
    expect(summary(result)).toEqual(expected);
  });

  it("gives every token with its position, value and text", () => {
    const text = "Maquette #Site/Design demain 9h >claude";
    const { tokens } = parseQuickAdd(text, NOW, SUBJECTS);
    expect(tokens).toEqual([
      {
        kind: "project",
        start: 9,
        end: 21,
        text: "#Site/Design",
        value: { subjectId: "site", sectionId: "site-0", name: "Site" },
      },
      {
        kind: "date",
        start: 22,
        end: 28,
        text: "demain",
        value: { date: "2026-10-04", time: null },
      },
      {
        kind: "time",
        start: 29,
        end: 31,
        text: "9h",
        value: { time: "09:00" },
      },
      { kind: "agent", start: 32, end: 39, text: ">claude", value: "claude" },
    ]);
    for (const t of tokens) expect(text.slice(t.start, t.end)).toBe(t.text);
  });

  it("gives the project whose sections /Section reads, like the autocompletion", () => {
    const slash = (text: string, context: string | null = null) =>
      parseQuickAdd(text, NOW, SUBJECTS, { contextSubjectId: context })
        .slashSubject?.id ?? null;
    expect(slash("Bug /De")).toBeNull();
    expect(slash("Bug /De", "site")).toBe("site");
    expect(slash("Bug #Site web /S", "site")).toBe("siteweb");
    // An unknown project hides the view's project.
    expect(slash("Bug #Nouveau /De", "site")).toBeNull();
  });

  it("reports the unknown project token without removing it", () => {
    const { tokens, title } = parseQuickAdd("Relancer #Inconnu", NOW, SUBJECTS);
    expect(tokens).toEqual([
      {
        kind: "project",
        start: 9,
        end: 17,
        text: "#Inconnu",
        value: { subjectId: null, sectionId: null, name: "Inconnu" },
      },
    ]);
    expect(title).toBe("Relancer #Inconnu");
  });

  it("keeps literal ranges as text (a removed chip)", () => {
    const r = parseQuickAdd("Appeler demain #Perso", NOW, SUBJECTS, {
      literals: [{ start: 8, end: 14 }],
    });
    expect(summary(r)).toEqual({ title: "Appeler demain", subject: "Perso" });
    // A later date is still recognised.
    const later = parseQuickAdd("Appeler demain lundi", NOW, SUBJECTS, {
      literals: [{ start: 8, end: 14 }],
    });
    expect(summary(later)).toEqual({
      title: "Appeler demain",
      due: { date: "2026-10-05" },
    });
  });

  it("gives the priority token with its position and stored value", () => {
    const { tokens, priority } = parseQuickAdd("Payer !3 !2", NOW, SUBJECTS);
    expect(priority).toBe(2);
    expect(tokens).toEqual([
      { kind: "priority", start: 6, end: 8, text: "!3", value: 2 },
    ]);
  });

  it("keeps a priority in a literal range as text, the next one then applies", () => {
    const r = parseQuickAdd("Payer !3 !2", NOW, SUBJECTS, {
      literals: [{ start: 6, end: 8 }],
    });
    expect(summary(r)).toEqual({ title: "Payer !3", priority: 3 });
    const literals = literalsWithout("Payer !3 !2", NOW, SUBJECTS, {}, [
      "priority",
    ]);
    expect(
      summary(parseQuickAdd("Payer !3 !2", NOW, SUBJECTS, { literals })),
    ).toEqual({ title: "Payer !3 !2" });
  });

  it("leaves >claude and >shell as text when agents are off (the phone)", () => {
    const r = parseQuickAdd("Tests >claude !2 >shell", NOW, SUBJECTS, {
      agents: false,
    });
    expect(summary(r)).toEqual({
      title: "Tests >claude >shell",
      priority: 3,
    });
    expect(r.tokens.map((t) => t.kind)).toEqual(["priority"]);
  });

  it("finds the next month that has the day for « le 31 »", () => {
    const r = parseQuickAdd("Payer le 31", new Date(2026, 10, 5), SUBJECTS);
    expect(r.due).toEqual({ date: "2026-12-31" });
  });
});

describe("literalsWithout", () => {
  it("turns every date and time back into text, hidden ones included", () => {
    const text = "Appeler demain 9h pour lundi #Perso";
    const literals = literalsWithout(text, NOW, SUBJECTS, {}, ["date", "time"]);
    const r = parseQuickAdd(text, NOW, SUBJECTS, { literals });
    expect(summary(r)).toEqual({
      title: "Appeler demain 9h pour lundi",
      subject: "Perso",
    });
  });

  it("removes projects and sections but leaves an unknown project", () => {
    const text = "Faire #Site/Design #Inconnu";
    const literals = literalsWithout(text, NOW, SUBJECTS, {}, [
      "project",
      "section",
    ]);
    const r = parseQuickAdd(text, NOW, SUBJECTS, { literals });
    expect(summary(r)).toEqual({
      title: "Faire #Site/Design #Inconnu",
      unknownProject: "Inconnu",
    });
  });
});

describe("fold", () => {
  it("lowers and strips accents without changing the length", () => {
    const text = "Après-demain ÉQUIPE aujourd’hui 🙂";
    const folded = fold(text);
    expect(folded).toBe("apres-demain equipe aujourd'hui 🙂");
    expect(folded.length).toBe(text.length);
  });
});

describe("shiftRanges", () => {
  const range = { start: 8, end: 14 }; // « demain » in « Appeler demain »

  it("keeps a range before the edit", () => {
    expect(shiftRanges("Appeler demain", "Appeler demain!", [range])).toEqual([
      range,
    ]);
  });

  it("shifts a range after the edit", () => {
    expect(
      shiftRanges("Appeler demain", "Vite Appeler demain", [range]),
    ).toEqual([{ start: 13, end: 19 }]);
  });

  it("drops a range the edit touches", () => {
    expect(shiftRanges("Appeler demain", "Appeler demai", [range])).toEqual([]);
  });
});

describe("sub-projects in the quick add", () => {
  const sub = (
    id: string,
    name: string,
    parentId: string,
    sections: string[] = [],
  ) => ({
    ...subject(id, name, sections),
    parentId,
  });
  const TREE: Subject[] = [
    subject("globex", "Globex", ["Ventes"]),
    sub("globex-admin", "Admin", "globex", ["Factures"]),
    sub("globex-client", "Client", "globex"),
    subject("perso", "Perso"),
    sub("perso-admin", "Admin", "perso"),
    subject("admin", "Admin"),
  ];
  const parse = (text: string) => {
    const r = parseQuickAdd(text, NOW, TREE);
    return { title: r.title, subject: r.subject?.id, section: r.section?.name };
  };

  it("reaches a sub-project by #Parent/Sous-projet, and its sections", () => {
    expect(parse("Payer #Perso/Admin")).toEqual({
      title: "Payer",
      subject: "perso-admin",
      section: undefined,
    });
    expect(parse("Payer #globex/admin/factures demain").subject).toBe(
      "globex-admin",
    );
    expect(parse("Payer #globex/admin/factures").section).toBe("Factures");
    // A section of the parent is still read as before.
    expect(parse("Vendre #Globex/Ventes")).toMatchObject({
      subject: "globex",
      section: "Ventes",
    });
  });

  it("reaches a sub-project by its name alone, a shared name going to the top level", () => {
    expect(parse("Appeler #Client").subject).toBe("globex-client");
    expect(parse("Ranger #Admin").subject).toBe("admin");
  });
});

describe("« @ » before a date (Taido V2.4)", () => {
  // Friday 9 October 2026, 15:00.
  const now = new Date(2026, 9, 9, 15, 0);
  const due = (text: string) => {
    const r = parseQuickAdd(text, now, []);
    return { title: r.title, due: r.due };
  };
  it("reads @vendredi, @13/10, @demain 10h like without the @", () => {
    expect(due("Appel @vendredi")).toEqual({
      title: "Appel",
      due: { date: "2026-10-16" },
    });
    expect(due("Appel @13/10")).toEqual({
      title: "Appel",
      due: { date: "2026-10-13" },
    });
    expect(due("Appel @demain 10h")).toEqual({
      title: "Appel",
      due: { date: "2026-10-10", time: "10:00" },
    });
    expect(due("Appel @demain @10h")).toEqual({
      title: "Appel",
      due: { date: "2026-10-10", time: "10:00" },
    });
  });
  it("leaves an @ that is not a date in the title", () => {
    expect(due("Écrire à @paul")).toEqual({
      title: "Écrire à @paul",
      due: undefined,
    });
  });
});

describe("quick add in English", () => {
  // Saturday 3 October 2026, 10:00: tomorrow is Sunday the 4th, next Monday the 5th.
  const en = (text: string) =>
    summary(parseQuickAdd(text, NOW, SUBJECTS, { language: "en" }));

  it.each<[string, Expected]>([
    ["Call Bob tomorrow", { title: "Call Bob", due: { date: "2026-10-04" } }],
    [
      "Review monday !1",
      { title: "Review", due: { date: "2026-10-05" }, priority: 4 },
    ],
    ["Plan next week", { title: "Plan", due: { date: "2026-10-05" } }],
    ["Pay rent today", { title: "Pay rent", due: { date: "2026-10-03" } }],
    [
      "Call mum tonight",
      { title: "Call mum", due: { date: "2026-10-03", time: "18:00" } },
    ],
    [
      "Call mum @tomorrow 5pm",
      { title: "Call mum", due: { date: "2026-10-04", time: "17:00" } },
    ],
    [
      "Standup tomorrow at 9:30am",
      { title: "Standup", due: { date: "2026-10-04", time: "09:30" } },
    ],
    [
      "Standup tomorrow 14:15",
      { title: "Standup", due: { date: "2026-10-04", time: "14:15" } },
    ],
    [
      "Gym tomorrow morning",
      { title: "Gym", due: { date: "2026-10-04", time: "09:00" } },
    ],
    [
      "Demo friday afternoon",
      { title: "Demo", due: { date: "2026-10-09", time: "14:00" } },
    ],
    ["Demo fri", { title: "Demo", due: { date: "2026-10-09" } }],
    ["Demo on Tuesday", { title: "Demo", due: { date: "2026-10-06" } }],
    ["Demo next saturday", { title: "Demo", due: { date: "2026-10-10" } }],
    [
      "Renew passport in 3 days",
      { title: "Renew passport", due: { date: "2026-10-06" } },
    ],
    [
      "Renew passport in a week",
      { title: "Renew passport", due: { date: "2026-10-10" } },
    ],
    [
      "Party day after tomorrow",
      { title: "Party", due: { date: "2026-10-05" } },
    ],
    ["Taxes 15 nov", { title: "Taxes", due: { date: "2026-11-15" } }],
    ["Taxes Nov 15th", { title: "Taxes", due: { date: "2026-11-15" } }],
    [
      "Taxes on 2 january 2027",
      { title: "Taxes", due: { date: "2027-01-02" } },
    ],
    ["Taxes 13/10", { title: "Taxes", due: { date: "2026-10-13" } }],
    ["Rent on the 12th", { title: "Rent", due: { date: "2026-10-12" } }],
    [
      "Lunch at noon",
      { title: "Lunch", due: { date: "2026-10-03", time: "12:00" } },
    ],
    [
      "Ship it 12am",
      { title: "Ship it", due: { date: "2026-10-03", time: "00:00" } },
    ],
    [
      "Fix login #Site/Design tomorrow >claude",
      {
        title: "Fix login",
        subject: "Site",
        section: "Design",
        due: { date: "2026-10-04" },
        launch: "claude",
      },
    ],
    // French words are plain text in English.
    ["Appeler Bob demain", { title: "Appeler Bob demain" }],
    // Only whole words: no date inside another word.
    [
      "Sunday school notes mondays",
      { title: "school notes mondays", due: { date: "2026-10-04" } },
    ],
    [
      "Call Bob tomorrow about monday",
      { title: "Call Bob about monday", due: { date: "2026-10-04" } },
    ],
  ])("%s", (text, expected) => {
    expect(en(text)).toEqual(expected);
  });
});

describe("quick add in French stays French", () => {
  it("reads demain and leaves English words alone", () => {
    expect(summary(parseQuickAdd("Appeler Bob demain", NOW, SUBJECTS))).toEqual(
      {
        title: "Appeler Bob",
        due: { date: "2026-10-04" },
      },
    );
    expect(summary(parseQuickAdd("Call Bob tomorrow", NOW, SUBJECTS))).toEqual({
      title: "Call Bob tomorrow",
    });
  });
});

describe("the quick add follows the interface's language", () => {
  afterEach(() => {
    window.localStorage.setItem("taido.language", "fr");
    vi.resetModules();
  });

  it("reads English words in an English window", async () => {
    window.localStorage.setItem("taido.language", "en");
    vi.resetModules();
    const { parseQuickAdd: parseEn } = await import("./parse");
    expect(parseEn("Call Bob tomorrow", NOW, []).due).toEqual({
      date: "2026-10-04",
    });
    expect(parseEn("Appeler Bob demain", NOW, []).due).toBeUndefined();
  });
});
