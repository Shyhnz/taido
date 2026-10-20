/**
 * Demo data for the mock backend, inspired by the wireframes.
 * Dates are relative to the backend clock so Today always has content.
 */

import { addDays, subDays, subHours, subMinutes } from "date-fns";
import type { SubjectColor } from "../bindings";
import { activeLanguage } from "../i18n";
import { toLocalDateString } from "./dates";
import type { MockBackend } from "./mock-backend";
import { defaultColumnId } from "./mock-board";
import { INBOX_EN, SUBJECTS_EN } from "./mock-seed-en";

export interface SeedTask {
  title: string;
  description?: string;
  section?: string;
  /** Days from today (negative = overdue). */
  dueIn?: number;
  dueTime?: string;
  /** Subtasks (child tasks): text, done, optional days to due. */
  subtasks?: [string, boolean, number?][];
  /** 1 (default) to 4. */
  priority?: number;
  completedHoursAgo?: number;
  createdDaysAgo: number;
  notes?: [string, number][];
  /** Kanban column index (0 = first); default: the first column, or Done when completed. */
  column?: number;
}

export interface SeedSubject {
  name: string;
  color: SubjectColor;
  /** `null`: project without folder on disk (D5). */
  rootPath: string | null;
  sections: [string, string | null][];
  tasks: SeedTask[];
  /** Name of its group (listed before it). */
  parent?: string;
  /** A group (no tasks, no sections, no folder). */
  group?: boolean;
}

const SUBJECTS_FR: SeedSubject[] = [
  {
    name: "Acme Studio",
    color: "violet",
    rootPath: "/Users/user/clients/acme",
    sections: [
      ["ETL", "etl"],
      ["Reporting", "reporting"],
    ],
    tasks: [
      {
        title: "Point hebdo avec la DSI",
        description:
          "Faire le point sur les jobs ODS et les priorités de la semaine.",
        dueIn: 0,
        dueTime: "14:00",
        priority: 3,
        subtasks: [
          ["Préparer l'état des jobs ODS", false],
          ["Lister les points bloquants", false],
        ],
        createdDaysAgo: 6,
      },
      {
        title: "Optimiser le job d'import de données",
        description:
          "Rendre le job d'import plus rapide sans changer son résultat.",
        section: "ETL",
        dueIn: 0,
        priority: 4,
        subtasks: [
          ["Identifier le goulot", true],
          ["Mettre le lookup en cache", false],
          ["Script d'index Azure SQL", false, 2],
          ["Valider avec la DSI", false],
        ],
        createdDaysAgo: 3,
        notes: [
          [
            "Le lookup sur DIM_AGENCE est rechargé à chaque ligne. Piste : le mettre en cache.",
            26,
          ],
        ],
      },
      {
        title: "Archivage mensuel du tableau de bord analytique",
        description: "Archiver les classeurs de septembre.",
        section: "Reporting",
        dueIn: 0,
        subtasks: [
          ["Exporter les classeurs", false],
          ["Vérifier les droits", false],
        ],
        createdDaysAgo: 10,
      },
    ],
  },
  {
    // A group gathers projects in the sidebar.
    name: "Clients",
    color: "blue",
    rootPath: null,
    group: true,
    sections: [],
    tasks: [],
  },
  {
    name: "Northwind",
    color: "teal",
    rootPath: "/Users/user/clients/northwind",
    parent: "Clients",
    sections: [["Dashboards", "dashboards"]],
    tasks: [
      {
        title: "Rapport mensuel – filtre période",
        description: "Ajouter un filtre de période au tableau de bord 3-6-9.",
        section: "Dashboards",
        dueIn: -1,
        priority: 2,
        subtasks: [
          ["Champ calculé", true],
          ["Paramètre de période", true],
          ["Publier", false],
        ],
        createdDaysAgo: 4,
      },
      {
        title: "Maquette de la page d'accueil",
        description: "Proposer une maquette du rapport sinistres.",
        section: "Dashboards",
        dueIn: 5,
        subtasks: [
          ["Collecter les besoins", true],
          ["Maquette Figma", false],
        ],
        createdDaysAgo: 2,
      },
    ],
  },
  {
    name: "Globex",
    color: "pink",
    rootPath: "/Users/user/globex",
    sections: [
      ["Summit Events", "summit-events"],
      ["Commercial", null],
    ],
    tasks: [
      {
        title: "Summit Events – export CSV prestataires",
        description:
          "Exporter les prestataires en CSV, filtrable par date de mariage.",
        section: "Summit Events",
        dueIn: 0,
        dueTime: "17:00",
        subtasks: [
          ["Endpoint export CSV", true],
          ["Filtre par date", false],
          ["Bouton dans la liste", false],
        ],
        createdDaysAgo: 1,
      },
      {
        title: "Starter SaaS – module auth",
        description: "Lien magique, ou seulement email et mot de passe ?",
        dueIn: 1,
        priority: 2,
        subtasks: [
          ["Comparer les options", true],
          ["Prototype", false],
          ["Tests", false],
        ],
        createdDaysAgo: 5,
      },
      {
        title: "Relancer les prospects de la semaine",
        description: "Relire les réponses reçues et envoyer les relances.",
        section: "Commercial",
        dueIn: 0,
        completedHoursAgo: 1,
        createdDaysAgo: 7,
      },
      {
        title: "Préparer le devis Bloom Weddings",
        section: "Commercial",
        dueIn: 10,
        createdDaysAgo: 2,
      },
    ],
  },
  {
    name: "Bloom Weddings",
    color: "indigo",
    rootPath: "/Users/user/clients/bloom-weddings",
    parent: "Clients",
    sections: [],
    tasks: [
      {
        title: "Maquette de la page prestataire",
        description: "Reprendre la charte du client.",
        priority: 2,
        createdDaysAgo: 3,
      },
      { title: "Recetter l'import des avis", createdDaysAgo: 1 },
    ],
  },
  {
    name: "Perso",
    color: "gray",
    rootPath: null,
    sections: [],
    tasks: [
      {
        title: "Plug-in vibe coder – landing",
        description: "Page d'accueil et liste d'attente.",
        dueIn: -2,
        subtasks: [
          ["Texte de la page", false],
          ["Formulaire de liste d'attente", false],
        ],
        createdDaysAgo: 9,
      },
      {
        title: "Renouveler le passeport",
        createdDaysAgo: 12,
      },
    ],
  },
];

const INBOX_FR: SeedTask[] = [
  { title: "Tester Raycast pour les snippets", createdDaysAgo: 1 },
  {
    title: "Lire l'article sur les worktrees git",
    description: "Garder les liens utiles dans les notes.",
    createdDaysAgo: 0,
  },
];

export function seedMockData(backend: MockBackend): void {
  const now = backend.now();
  const french = activeLanguage === "fr";
  const SUBJECTS = french ? SUBJECTS_FR : SUBJECTS_EN;
  const INBOX = french ? INBOX_FR : INBOX_EN;

  const addTask = (
    task: SeedTask,
    subjectId: string | null,
    sectionId: string | null,
  ) => {
    const createdAt = subMinutes(
      subDays(now, task.createdDaysAgo),
      30,
    ).toISOString();
    const completedAt =
      task.completedHoursAgo !== undefined
        ? subHours(now, task.completedHoursAgo).toISOString()
        : null;
    const rec = backend.insertTask({
      id: backend.newId("task"),
      subjectId,
      sectionId,
      title: task.title,
      description: task.description ?? "",
      dueDate:
        task.dueIn !== undefined
          ? toLocalDateString(addDays(now, task.dueIn))
          : null,
      dueTime: task.dueTime ?? null,
      workdirOverride: null,
      completedAt,
      createdAt,
      updatedAt: completedAt ?? createdAt,
      priority: task.priority ?? 1,
      boardColumnId:
        task.column !== undefined && subjectId !== null
          ? defaultColumnId(subjectId, task.column)
          : null,
    });
    for (const [text, done, dueIn] of task.subtasks ?? []) {
      const child = backend.insertSubtask(rec.id, text, done, createdAt);
      if (dueIn !== undefined) {
        child.dueDate = toLocalDateString(addDays(now, dueIn));
      }
    }
    backend.insertJournal(rec.id, "created", "", createdAt);
    for (const [text, minutesAgo] of task.notes ?? []) {
      backend.insertJournal(
        rec.id,
        "note",
        text,
        subMinutes(now, minutesAgo).toISOString(),
      );
    }
    if (completedAt)
      backend.insertJournal(rec.id, "completed", "", completedAt);
  };

  const subjectIds = new Map<string, string>();
  for (const s of SUBJECTS) {
    const at = subDays(now, 30).toISOString();
    const subject = backend.insertSubject({
      id: backend.newId("subject"),
      name: s.name,
      color: s.color,
      rootPath: s.rootPath,
      parentId: s.parent ? (subjectIds.get(s.parent) ?? null) : null,
      isGroup: s.group ?? false,
      createdAt: at,
      updatedAt: at,
    });
    subjectIds.set(s.name, subject.id);
    const sectionIds = new Map<string, string>();
    for (const [name, subpath] of s.sections) {
      const section = backend.insertSection({
        id: backend.newId("section"),
        subjectId: subject.id,
        name,
        subpath,
        createdAt: at,
        updatedAt: at,
      });
      sectionIds.set(name, section.id);
    }
    for (const task of s.tasks) {
      const sectionId = task.section
        ? (sectionIds.get(task.section) ?? null)
        : null;
      addTask(task, subject.id, sectionId);
    }
  }
  for (const task of INBOX) addTask(task, null, null);
}
