/**
 * Every UI string. French, tutoiement, short sentences.
 * Functions build strings that need values; dates are formatted by src/lib/dates.ts.
 *
 * Vocabulary (decisions D1, D2, D9): the UI says « Projet » for what the code calls a
 * `subject`, and « Sans projet » for the `inbox` (tasks with no subject). « Dossier » only
 * ever means a folder on disk.
 */

import type {
  Agent,
  ChronoStop,
  ColorTheme,
  Editor,
  ErrorKind,
  JournalKind,
  LineKind,
  Ring,
  SubjectColor,
  Theme,
} from "../bindings";

/** The agent in a sentence: « Codex attend », « Claude a fini ». */
export const agentName = (agent: Agent): string =>
  agent === "codex" ? "Codex" : "Claude";

/** The agent's product name, on buttons and settings: « Lancer Claude Code », « Lancer Codex ». */
export const agentProduct = (agent: Agent): string =>
  agent === "codex" ? "Codex" : "Claude Code";

/** How to install an agent (official docs of each tool, checked 2026-10-11). */
export const agentInstallCommand = (agent: Agent): string =>
  agent === "codex"
    ? "npm install -g @openai/codex"
    : "npm install -g @anthropic-ai/claude-code";

/** How to log in an agent, in a terminal. */
export const agentLoginCommand = (agent: Agent): string =>
  agent === "codex" ? "codex login" : "claude";

const plural = (n: number, one: string, many: string) =>
  `${n} ${n > 1 ? many : one}`;

/** « 3 tâches », « 1 tâche », « Aucune tâche ». */
const taskCount = (n: number) =>
  n === 0 ? "Aucune tâche" : plural(n, "tâche", "tâches");

/**
 * What an account keeps on the server (Réglages › Compte on the Mac, Synchro on the phone):
 * one text for both devices. Mirrors the synced entities of docs/SYNC.md (protocol 3) and, since
 * V2.7 bis, the content of attachments (§ 0.13).
 */
const ACCOUNT_PRIVACY =
  "Ton compte garde tes projets, sections, tâches, colonnes du Kanban, temps passé, relations entre tâches et pièces jointes (noms et fichiers). Jamais les dossiers, les terminaux, les sessions de Claude ni le journal.";

/** Readable errors of Claude Code, by `StopFailure.error` type. */
const AGENT_ERRORS: Record<string, string> = {
  rate_limit: "Limite d'usage atteinte",
  overloaded: "Serveurs surchargés, réessaie",
  authentication_failed: "Claude Code n'est plus connecté",
  billing_error: "Problème de facturation",
};

/**
 * « Limite d'usage atteinte » for `rate_limit`, « Erreur : model_not_found » for another
 * type; a text that is not a type (already French) is kept as is.
 */
export function agentErrorLabel(kind: string | null): string {
  if (!kind) return "Erreur";
  const known = AGENT_ERRORS[kind];
  if (known) return known;
  return /^[a-z0-9_]+$/.test(kind) ? `Erreur : ${kind}` : kind;
}

export const fr = {
  appName: "Taido",

  common: {
    cancel: "Annuler",
    save: "Enregistrer",
    delete: "Supprimer",
    close: "Fermer",
    add: "Ajouter",
    create: "Créer",
    rename: "Renommer",
    retry: "Réessayer",
    none: "Aucune",
    noneMasc: "Aucun",
    more: "Plus d'actions",
    loading: "Chargement…",
    tasks: taskCount,
  },

  /**
   * Readable errors. The core sends `{ kind, message }`: the UI shows the text for the kind
   * (optionally after the action that failed) and logs the raw message to the console.
   */
  errors: {
    kind: {
      not_found: "Cet élément n'existe plus.",
      invalid: "Cette valeur n'est pas valide.",
      no_folder: "Choisis d'abord un dossier pour cette tâche.",
      folder_missing: "Dossier introuvable.",
      claude_missing:
        "Claude Code est introuvable. Installe-le ou indique son chemin dans Réglages.",
      codex_missing:
        "Codex est introuvable. Installe-le ou indique son chemin dans Réglages.",
      internal: "Un problème est survenu. Réessaie.",
      // Account commands (V2.7); the account forms show `fr.sync.accountError` instead.
      sync_auth: "E-mail ou mot de passe incorrect.",
      sync_rate_limited: "Trop d'essais. Attends quelques minutes.",
      sync_email_taken: "Un compte existe déjà avec cette adresse.",
      sync_weak_password: "Mot de passe trop court (10 caractères au moins).",
      sync_bad_email: "Adresse e-mail invalide.",
      sync_invalid_code: "Code faux ou expiré.",
      sync_mail_unavailable: "Le serveur ne peut pas envoyer d'e-mails.",
      sync_signups_closed: "Les inscriptions sont fermées sur ce serveur.",
      sync_offline: "Serveur injoignable.",
      sync_server: "Le serveur a renvoyé une erreur.",
      // « Télécharger » (2026-10-10).
      file_not_here: "Ce fichier n'est pas sur cet appareil.",
      file_not_on_server:
        "Ce fichier n'est pas encore arrivé sur ton compte. Réessaie plus tard.",
      downloads_denied:
        "Taido n'a pas accès à Téléchargements. Autorise-le dans Réglages Système › Confidentialité et sécurité › Fichiers et dossiers › Taido › Téléchargements.",
      disk_full: "Plus de place sur cet appareil pour ce fichier.",
      file_write_failed: "Impossible d'écrire le fichier sur cet appareil.",
      // Dictation.
      mic_denied:
        "Taido n'a pas accès au micro. Autorise-le dans Réglages Système › Confidentialité et sécurité › Micro.",
      voice_unavailable: "La dictée n'est pas disponible pour le moment.",
    } satisfies Record<ErrorKind, string>,
    /** Fallback when the error has no known kind. */
    unknown: "Un problème est survenu. Réessaie.",
    /** First half of an error toast, e.g. « Impossible d'ajouter la tâche. Réessaie. » */
    action: {
      createTask: "Impossible d'ajouter la tâche.",
      updateTask: "Impossible d'enregistrer la tâche.",
      completeTask: "Impossible de cocher la tâche.",
      deleteTask: "Impossible de supprimer la tâche.",
      moveTask: "Impossible de déplacer la tâche.",
      duplicateTask: "Impossible de dupliquer la tâche.",
      closeTerminal: "Impossible de fermer le terminal.",
      createSubject: "Impossible de créer le projet.",
      updateSubject: "Impossible de modifier le projet.",
      deleteSubject: "Impossible de supprimer le projet.",
      reorder: "Impossible de déplacer l'élément.",
      createSection: "Impossible de créer la section.",
      updateSection: "Impossible de modifier la section.",
      deleteSection: "Impossible de supprimer la section.",
      subtask: "Impossible d'enregistrer la sous-tâche.",
      note: "Impossible d'ajouter la note.",
      settings: "Impossible d'enregistrer le réglage.",
      loadView: "Impossible d'afficher cette liste.",
      loadSubjects: "Projets indisponibles.",
      createColumn: "Impossible d'ajouter la colonne.",
    },
    /** « Impossible d'ajouter la tâche. Réessaie. » */
    withAction: (action: string, kind: ErrorKind | null) =>
      kind === "not_found"
        ? `${action} Cet élément n'existe plus.`
        : kind === "invalid"
          ? `${action} Vérifie la saisie.`
          : kind === "no_folder" ||
              kind === "folder_missing" ||
              kind === "claude_missing" ||
              kind === "codex_missing"
            ? `${action} ${fr.errors.kind[kind]}`
            : `${action} Réessaie.`,
  },

  sidebar: {
    search: "Rechercher",
    /** The sidebar row (magnifier + « Recherche »), opens ⌘K. */
    searchRow: "Recherche",
    upcoming: "Prochainement",
    newTask: "Nouvelle tâche",
    navLabel: "Navigation",
    today: "Aujourd'hui",
    noProject: "Sans projet",
    projects: "Projets",
    newProject: "Nouveau projet",
    firstProject: "Crée ton premier projet",
    projectsUnavailable: "Projets indisponibles",
    settings: "Réglages",
    /** Fold / show the sidebar (button, « M »). */
    collapse: "Replier la barre latérale",
    expand: "Afficher la barre latérale",
    projectMenu: (name: string) => `Actions du projet ${name}`,
    /** Red counter of « Aujourd'hui » (tasks where the agent waits). */
    waitingCount: (n: number, agent: Agent) =>
      n > 1
        ? `${n} tâches où ${agentName(agent)} attend`
        : `1 tâche où ${agentName(agent)} attend`,
    announce: {
      movedUp: (name: string) => `Projet « ${name} » monté d'un cran`,
      movedDown: (name: string) => `Projet « ${name} » descendu d'un cran`,
      /** « Sans projet » is no project: its own wording. */
      inboxMovedUp: "« Sans projet » monté d'un cran",
      inboxMovedDown: "« Sans projet » descendu d'un cran",
    },
  },

  theme: {
    light: "Clair",
    dark: "Sombre",
    system: "Système",
  } satisfies Record<Theme, string>,

  /** Colour themes (Réglages › Thème). */
  colorTheme: {
    taido: "Taido",
    slate: "Ardoise",
    graphite: "Graphite",
    blueberry: "Myrtille",
    lavender: "Lavande",
    plum: "Prune",
    raspberry: "Framboise",
    cocoa: "Cacao",
    sage: "Sauge",
    lagoon: "Lagon",
  } satisfies Record<ColorTheme, string>,

  /** A project (`subject` in the code). */
  subject: {
    /** Finder title when linking the on-disk folder (behind `features.terminals`, D5). */
    pickFolderTitle: "Choisis le dossier du projet",
    menuRename: "Renommer",
    menuColor: "Couleur",
    menuAddSection: "Ajouter une section",
    menuLinkFolder: "Relier à un dossier…",
    menuOpenFolder: "Ouvrir le dossier",
    menuDelete: "Supprimer",
    deleteTitle: (name: string) => `Supprimer « ${name} » ?`,
    deleteMessage: (n: number) =>
      n === 0
        ? "Le projet n'a aucune tâche en cours. Ses tâches terminées seront supprimées aussi."
        : `Ses ${plural(n, "tâche en cours", "tâches en cours")} et ses tâches terminées seront supprimées.`,
    deleteConfirm: "Supprimer le projet",
    colors: {
      violet: "Violet",
      teal: "Sarcelle",
      pink: "Rose",
      gray: "Gris",
      blue: "Bleu",
      indigo: "Indigo",
      brown: "Brun",
      slate: "Ardoise",
    } satisfies Record<SubjectColor, string>,
  },

  section: {
    add: "Ajouter une section",
    nameLabel: "Nom de la section",
    namePlaceholder: "Nom de la section",
    /** (`features.terminals`): sub-folder of the project folder. */
    subpathLabel: "Sous-dossier (facultatif)",
    subpathPlaceholder: "Ex. etl",
    menu: (name: string) => `Actions de la section ${name}`,
    menuRename: "Renommer",
    menuSubpath: "Sous-dossier…",
    menuDelete: "Supprimer",
    renameTitle: "Renommer la section",
    subpathTitle: "Sous-dossier de la section",
    subpathHelp: "Relatif au dossier du projet. Laisse vide pour aucun.",
    deleteTitle: (name: string) => `Supprimer la section « ${name} » ?`,
    deleteMessage: "Ses tâches restent dans le projet, hors section.",
    deleteConfirm: "Supprimer la section",
  },

  views: {
    completed: "Terminées",
    /** « Jeudi 1 octobre · 7 tâches », or just the date when nothing is due. */
    todaySubtitle: (date: string, n: number) =>
      n === 0 ? date : `${date} · ${taskCount(n)}`,
    /** « 3 tâches » under a project or « Sans projet »; hidden (empty) at 0. */
    countSubtitle: (n: number) => (n === 0 ? "" : taskCount(n)),
    groups: {
      /** Today: tasks where the agent waits for you. */
      claudeWaiting: (agent: Agent) => `${agentName(agent)} attend`,
      overdue: "En retard",
      /** Today: the rest of the day, headed only after another group. */
      today: "Aujourd'hui",
      postponeToToday: "Reporter à aujourd'hui",
    },
    empty: {
      noProjectTitle: "Tout est rangé",
      noProjectText: "Les tâches qui n'ont pas de projet apparaissent ici.",
      todayTitle: "Rien de prévu aujourd'hui",
      todayText: "Profite, ou ajoute une tâche pour la journée.",
      subjectTitle: "Ce projet est vide",
      subjectText: "Ajoute une première tâche.",
    },
    firstLaunch: {
      title: "Commence par un projet",
      text: "Un projet par client ou par chantier, par exemple « Client Dupont » ou « Perso ». Tes tâches vivent dedans.",
      action: "Créer un projet",
    },
    loadError: "Impossible d'afficher cette liste.",
    unknownSubject: "Ce projet n'existe plus",
  },

  addTask: {
    /** Ghost add row at the bottom of a group. */
    row: "Ajouter…",
    titlePlaceholder: "Nom de la tâche",
    descriptionPlaceholder: "Note",
    submit: "Ajouter",
    dialogTitle: "Nouvelle tâche",
    destination: "Destination",
    dueToday: "Aujourd'hui",
    hint: "↵ ajouter · Échap fermer",
  },

  /** Quick add (⌘N, `q`, « Nouvelle tâche »). */
  quickAdd: {
    titleLabel: "Nom de la tâche",
    titlePlaceholder: "Appeler Paul demain 17h #projet",
    descriptionLabel: "Description",
    help: "#projet · /section · @date · demain 17h · !2 · >claude · >codex",
    /** The PWA has no Claude (`features.terminals` off). */
    helpMobile: "#projet · /section · @date · !2",
    /** (E): chip of a `!1`…`!3` token (the shown number). */
    priority: (n: number) => `Priorité ${n}`,
    submit: "Ajouter",
    submitAndLaunch: "Ajouter et lancer",
    /** Tooltip of « Annuler ». */
    cancelHint: "Échap",
    /** Tooltip of the primary button. */
    submitHint: "Entrée · ⌥Entrée pour ajouter et continuer",
    chips: "Ce que l'ajout va faire",
    agentOnAdd: (agent: Agent) => `${agentProduct(agent)}, ouvert à l'ajout`,
    agentShell: "Shell",
    remove: (label: string) => `Retirer : ${label}`,
    unknownProject: "Projet introuvable",
    createProject: (name: string) => `Créer « ${name} » ?`,
    projectCreated: (name: string) => `Projet « ${name} » créé`,
    suggestions: "Projets et sections",
  },

  ring: {
    /** `null` for a plain task: « Terminer ». With an agent state: « Terminer · Claude attend ta réponse ». */
    markDone: (state: string | null) =>
      state ? `Terminer · ${state}` : "Terminer",
    reopen: "Rouvrir",
    state: (ring: Ring, agent: Agent): string =>
      (
        ({
          human: "À faire",
          completed: "Terminée",
          starting: `Démarrage de ${agentProduct(agent)}`,
          working: `${agentName(agent)} travaille`,
          waiting: `${agentName(agent)} attend ta réponse`,
          done: `${agentName(agent)} a fini`,
          idle: "Session ouverte, prête",
          paused: "Session en pause",
          error: "Erreur",
          crashed: "Session arrêtée",
        }) satisfies Record<Ring, string>
      )[ring],
  },

  /** Second-line templates, one per LineKind. */
  line: {
    description: (text: string | null) => text ?? "",
    completed: (when: string | null) =>
      when ? `Terminée ${when}` : "Terminée",
    // By design: only the state, never what the agent said or does; the
    // conversation itself is in the agent's terminal.
    waiting_permission: (_: string | null, agent: Agent) =>
      `${agentName(agent)} attend ta réponse`,
    waiting_question: (_: string | null, agent: Agent) =>
      `${agentName(agent)} attend ta réponse`,
    waiting_input: (_: string | null, agent: Agent) =>
      `${agentName(agent)} attend ta réponse`,
    /** `text` is the `StopFailure.error` type (`rate_limit`…), or a text already in French. */
    error: (text: string | null) => agentErrorLabel(text),
    crashed: () => "Session arrêtée",
    done: (_: string | null, agent: Agent) => `${agentName(agent)} a fini`,
    working: (_: string | null, agent: Agent) =>
      `${agentName(agent)} travaille`,
    starting: (_: string | null, agent: Agent) =>
      `Démarrage de ${agentProduct(agent)}…`,
    idle: () => "Session ouverte, prête",
    paused: (when: string | null) => (when ? `En pause · ${when}` : "En pause"),
  } satisfies Record<LineKind, (value: string | null, agent: Agent) => string>,

  row: {
    /** (`features.terminals`). */
    sessions: (n: number) => plural(n, "session", "sessions"),
    subtasks: (done: number, total: number) => `${done}/${total}`,
    subtasksLabel: (done: number, total: number) =>
      `${done} sous-tâche${done > 1 ? "s" : ""} faite${done > 1 ? "s" : ""} sur ${total}`,
    hasNote: "A une note",
    dueLabel: (label: string) => `Échéance : ${label}`,
    overdue: "En retard",
    dragHandle: "Glisser pour déplacer",
    menuOpen: "Ouvrir",
    /** (`features.terminals`). */
    menuLaunchAgent: (agent: Agent) => `Lancer ${agentProduct(agent)}`,
    menuOpenShell: "Ouvrir un shell",
    menuMove: "Déplacer vers…",
    menuFile: "Ranger dans…",
    menuDue: "Échéance…",
    menuDelete: "Supprimer",
    deleteTitle: (title: string) => `Supprimer « ${title} » ?`,
    deleteMessage:
      "La tâche, ses sous-tâches et son historique seront supprimés.",
    deleteConfirm: "Supprimer la tâche",
  },

  toast: {
    completed: "Tâche terminée",
    undo: "Annuler",
    see: "Voir",
    deleted: "Tâche supprimée",
    subjectDeleted: (name: string) => `Projet « ${name} » supprimé`,
    duplicated: "Tâche dupliquée",
    /** « Déplacée dans Globex », « Déplacée dans Sans projet ». */
    moved: (where: string) => `Déplacée dans ${where}`,
    /** « Ajoutée dans Globex ». */
    added: (where: string) => `Ajoutée dans ${where}`,
  },

  move: {
    title: "Déplacer vers…",
    fileTitle: "Ranger dans…",
    noProject: "Sans projet",
  },

  due: {
    title: "Échéance",
    date: "Date",
    time: "Heure (facultatif)",
    today: "Aujourd'hui",
    tomorrow: "Demain",
    yesterday: "Hier",
    pick: "Choisir une date…",
    clear: "Aucune",
    none: "Aucune",
  },

  panel: {
    label: "Panneau de la tâche",
    /** (`features.focusMode`). */
    focusMode: "Mode focus",
    /** (`features.terminals`). */
    openIn: "Ouvrir dans…",
    more: "Plus d'actions sur la tâche",
    duplicate: "Dupliquer",
    delete: "Supprimer",
    close: "Fermer le panneau",
    resize: "Redimensionner le panneau",
    titleLabel: "Titre de la tâche",
    descriptionPlaceholder: "Ajoute une note",
    /** (`features.terminals`). */
    terminals: "Terminaux",
    noTerminal:
      "Aucun terminal pour l'instant. N'importe quelle tâche peut en recevoir un.",
    launchAgentHere: (agent: Agent) => `Lancer ${agentProduct(agent)} ici`,
    openShell: "Ouvrir un shell",
    subtasks: "Sous-tâches",
    addSubtask: "Ajouter une sous-tâche",
    subtaskPlaceholder: "Nouvelle sous-tâche",
    subtaskLabel: "Texte de la sous-tâche",
    deleteSubtask: "Supprimer la sous-tâche",
    dragSubtask: "Glisser pour réordonner",
    journal: "Historique",
    emptyJournal: "Rien pour l'instant.",
    loading: "Chargement…",
    notFound: "Cette tâche n'existe plus.",
    noProject: "Sans projet",
    // --- m1bis task panel (one column) ---
    move: "Déplacer vers…",
    /** Chip « Projet › Section »: accessible name and menu title. */
    location: (where: string) => `Projet : ${where}. Changer`,
    locationMenu: "Ranger dans…",
    /** Chip « Échéance ». */
    dueEmpty: "Échéance",
    dueChip: (label: string) => `Échéance : ${label}. Changer`,
    dueOverdue: "en retard",
    noteTitle: "Note",
    showHistory: "Afficher l'historique",
    hideHistory: "Masquer l'historique",
    /** (`features.terminals`): folder, git branch, state. */
    technicalDetails: "Détails techniques",
    // --- end m1bis task panel ---
  },

  /** (`features.terminals`): « Détails techniques » of the task panel. */
  attrs: {
    /** (`features.terminals`): on-disk working folder. */
    folder: "Dossier",
    folderInherited: {
      section: "comme la section",
      subject: "comme le projet",
      task: "propre à la tâche",
    },
    folderMissing: "Dossier introuvable",
    folderNone: "Aucun",
    folderPick: "Choisir le dossier de la tâche",
    folderReset: "Revenir au dossier du projet",
    gitBranch: "Branche git",
    terminals: "Terminaux",
    state: "État",
  },
  /** Terminals of a task. */
  /** Dictation in Claude and Codex terminals. */
  voice: {
    dictate: "Dicter",
    dictateHint: (spaceHold: boolean) =>
      spaceHold ? "Dicter (ou garde Espace enfoncée)" : "Dicter",
    stop: "Arrêter et écrire le texte",
    listening: "J'écoute…",
    cancelHint: "Échap pour annuler",
    transcribing: "Transcription…",
    heardNothing: "Je n'ai rien entendu.",
    setupTitle: "Dicter à l'IA",
    setupBody: (size: string) =>
      `Parle au lieu de taper : ta voix est transcrite sur cet appareil, rien n'est envoyé sur internet. Il faut d'abord télécharger le modèle de transcription (${size}, une seule fois).`,
    setupLanguages:
      "Français, anglais, espagnol, allemand, italien et 20 autres langues européennes.",
    download: "Télécharger",
    downloading: (percent: number) => `Téléchargement… ${percent} %`,
    retry: "Réessayer",
    failed: "Le téléchargement a échoué. Vérifie ta connexion et réessaie.",
    ready:
      "C'est prêt. Clique sur le micro ou garde Espace enfoncée pour parler.",
    readyNoSpace: "C'est prêt. Clique sur le micro pour parler.",
    micDenied: "Taido n'a pas accès au micro.",
    openMicSettings: "Ouvrir les réglages du micro",
  },
  terminals: {
    session: "Session",
    tabs: "Terminaux de la tâche",
    agent: (agent: Agent) => agentProduct(agent),
    shell: "Shell",
    exited: "Terminé",
    add: "Nouveau terminal",
    addAgent: (agent: Agent) => `${agentProduct(agent)}…`,
    quickActions: "Lancer un terminal ou ouvrir le dossier",
    addShell: "Shell",
    addCommand: "Commande…",
    close: (label: string) => `Fermer ${label}`,
    /** The tab's gauge: how full the conversation's memory (context window) is. */
    context: {
      label: (agent: Agent, percent: number) =>
        `Mémoire de ${agentName(agent)} : ${percent} % utilisée`,
      of: (limit: string) => `sur ${limit}`,
      left: "Reste",
      plan: "Forfait",
      planUsed: (percent: number) => `${percent} % utilisé`,
      nearlyFull: (agent: Agent) =>
        `${agentName(agent)} va bientôt résumer la conversation pour libérer de la place.`,
    },
    view: (label: string) => `Terminal ${label}`,
    resize: "Redimensionner le terminal",
    paneSelect: (n: number) => `Terminal du volet ${n}`,
    // Launch
    launchAgent: (agent: Agent) => `Lancer ${agentProduct(agent)}`,
    openShell: "Ouvrir un shell",
    runCommand: "Lancer une commande…",
    launch: "Lancer",
    commandTitle: "Lancer une commande",
    commandLabel: "Commande",
    commandPlaceholder: "npm run dev",
    openError: "Impossible d'ouvrir le terminal.",
    // Folder
    pickFolderTitle: "Choisis le dossier où travailler pour cette tâche",
    folderMissingTitle: "Dossier introuvable",
    folderMissingMessage: (path: string | null) =>
      path
        ? `Le dossier ${path} n'existe plus. Choisis-en un autre pour lancer le terminal.`
        : "Le dossier de la tâche n'existe plus. Choisis-en un autre pour lancer le terminal.",
    chooseFolder: "Choisir un dossier",
    // Closing
    closeClaudeTitle: (agent: Agent) =>
      `Fermer la session ${agentName(agent)} ?`,
    closeClaudeMessage: (agent: Agent) =>
      `${agentProduct(agent)} sera arrêté dans ce terminal. La conversation pourra être reprise plus tard.`,
    closeClaudeConfirm: "Fermer la session",
    stopSessionsTitle: (n: number) =>
      n > 1
        ? `${n} sessions tournent sur cette tâche`
        : "Une session tourne sur cette tâche",
    completeMessage: "Terminer la tâche ferme ses terminaux.",
    completeConfirm: "Terminer la tâche",
    deleteMessage: "Supprimer la tâche ferme ses terminaux.",
    deleteConfirm: "Supprimer la tâche",
    // Quit
    quitTitle: "Quitter ?",
    quitSessions: (n: number) =>
      n > 1
        ? `${n} sessions tournent encore. Quitter les met en pause.`
        : "1 session tourne encore. Quitter la met en pause.",
    quitTerminals: (n: number) =>
      n > 1
        ? `${n} terminaux tournent encore. Quitter les arrête.`
        : "1 terminal tourne encore. Quitter l'arrête.",
    quitConfirm: "Quitter",
    // Focus mode
    fullWidth: "Mode focus",
    leaveFullWidth: "Quitter le mode focus",
    swapPanes: "Échanger les volets",
    resizePanes: "Largeur des volets",
    resetPanes:
      "Glisser pour régler la largeur · double-clic : largeur par défaut",
    resizePaneRows: "Hauteur des volets",
    resetPaneRows:
      "Glisser pour régler la hauteur · double-clic : hauteur par défaut",
    /** Where a pane sits (up to four panes, 2026-10-05), for its menu. */
    panePlace: {
      left: "de gauche",
      right: "de droite",
      topLeft: "en haut à gauche",
      topRight: "en haut à droite",
      bottomLeft: "en bas à gauche",
      bottomRight: "en bas à droite",
    },
    paneMenu: (place: string) => `Terminal du volet ${place}`,
    inOtherPane: "autre volet",
    hiddenTerminals: (n: number) =>
      n > 1 ? `${n} autres terminaux` : "1 autre terminal",
    toFocusedPane: "dans le volet actif",
    noTerminal: "Aucun terminal pour cette tâche",
    editTitle: "Modifier le titre",
    // Claude's state on the terminal itself (one carrier per scope)
    waitingShort: (agent: Agent) => `${agentName(agent)} attend`,
    waitingBar: (agent: Agent) => `${agentName(agent)} attend ta réponse`,
    sessionEnded: "Session terminée",
    processEnded: (code: number | null) =>
      code === null ? "Terminé" : `Terminé · code ${code}`,
    relaunch: "Relancer",
    closeTab: "Fermer",
    claudeNumbered: (n: number, agent: Agent) => `${agentProduct(agent)} ${n}`,
    claudeNamed: (recap: string, agent: Agent) =>
      `${agentName(agent)} · ${recap}`,
    resetHeight: "Double-clic : hauteur par défaut",
    noteAndSubtasks: "Note et sous-tâches",
    leavesFocus: "quitte le focus",
    due: "Échéance…",
    // « Ouvrir dans… »
    openInFinder: "Ouvrir dans le Finder",
    /** ⋯ › « Ouvrir dans › »: the installed editors, then these two (2026-10-11). */
    openIn: "Ouvrir dans",
    finder: "Finder",
    terminal: "Terminal",
    openInError: "Impossible d'ouvrir le dossier.",
  },

  /** Hook events of the « Diagnostic » tab of Réglages. */
  diagnostic: {
    title: "Événements des sessions",
    subtitle: "Du plus récent au plus ancien, 200 au plus.",
    refresh: "Actualiser",
    loading: "Chargement des événements…",
    empty:
      "Aucun événement pour l'instant. Lance une session sur une tâche : ses événements apparaîtront ici.",
    error: "Impossible de lire les événements.",
    noTerminal: "sans terminal",
    terminal: (id: string) => `Terminal ${id}`,
    payload: "Charge utile",
    count: (n: number) => (n > 1 ? `${n} événements` : `${n} événement`),
  },
  /** Editors of « Ouvrir dans » (Réglages). */
  editors: {
    vscode: "VS Code",
    cursor: "Cursor",
    zed: "Zed",
    windsurf: "Windsurf",
    sublime: "Sublime Text",
  } satisfies Record<Editor, string>,

  /** ⌘K « Aller à une tâche ». */
  search: {
    title: "Rechercher",
    open: "Rechercher (⌘K)",
    label: "Rechercher une tâche ou une note",
    placeholder: "Aller à une tâche, un projet ou une note…",
    results: "Résultats",
    hint: "Tape le nom d'une tâche, d'un projet ou d'une note.",
    loading: "Recherche…",
    none: (query: string) =>
      `Aucune tâche ni note ne correspond à « ${query} ».`,
    error: "La recherche a échoué.",
    noProject: "Sans projet",
    /** « Globex › Export ». */
    where: (project: string, section: string | null) =>
      section ? `${project} › ${section}` : project,
    completed: "terminée",
    /** « Note · Globex »: a notebook page found by ⌘K. */
    noteWhere: (project: string) => `Note · ${project}`,
    footer: "↑↓ choisir · ↵ ouvrir · Échap fermer",
  },

  /** « Réglages », gear of the sidebar and ⌘,. */
  settings: {
    workspace: "Dossier de l'appli",
    workspaceHelp:
      "Chaque projet y a son dossier, créé automatiquement (les sous-projets dans celui de leur projet) ; les tâches sans projet travaillent dans « Sans projet ».",
    title: "Réglages",
    open: "Réglages (⌘,)",
    tabs: {
      general: "Général",
      /** Colour themes and clair / sombre (2026-10-11, like Todoist's Réglages › Thème). */
      theme: "Thème",
      /** (docs/SYNC.md § 5); same text as `fr.sync.tab`. */
      sync: "Synchro",
      /** The Mac's name of the « sync » tab (Taido V2.7); the phone keeps « Synchro ». */
      account: "Compte",
      agents: "Agents",
      diagnostic: "Diagnostic",
    },
    tabsLabel: "Sections des réglages",
    theme: "Apparence",
    themeHelp: "« Système » suit le réglage clair ou sombre de macOS.",
    /** The phone's Réglages › Général. */
    themeHelpMobile:
      "« Système » suit le réglage clair ou sombre du téléphone.",
    color: "Couleur",
    colorHelp: "Chaque couleur a sa version claire et sa version sombre.",
    syncTheme: "Même thème sur tous mes appareils",
    syncThemeHelp:
      "Avec ton compte, tous tes appareils prennent le thème choisi sur l'un d'eux. Désactivé, cet appareil garde le sien.",
    syncThemeHelpMobile:
      "Avec ton compte, tous tes appareils prennent le thème choisi sur l'un d'eux. Désactivé, ce téléphone garde le sien.",
    /** Réglages › Agents. */
    defaultAgent: "IA par défaut",
    defaultAgentHelp:
      "⌘T et le bouton « Lancer » ouvrent cette IA. L'autre reste dans le menu + d'une tâche.",
    agentReady: (version: string | null) =>
      version ? `Prête · ${version}` : "Prête",
    agentLoggedOutShort: "Pas connectée",
    agentMissingShort: "Pas installée",
    agentCheckingShort: "Vérification…",
    agentPath: (agent: Agent) =>
      `Chemin du programme ${agent === "codex" ? "codex" : "claude"}`,
    claudePathPlaceholder: "Automatique",
    claudePathHelp:
      "Laisse vide pour le trouver automatiquement (PATH du shell, emplacements habituels).",
    agentPathInvalid: (agent: Agent) =>
      `Indique un chemin absolu, par exemple /opt/homebrew/bin/${agent === "codex" ? "codex" : "claude"}.`,
    claudePathSaved: "Chemin enregistré.",
    claudePathCleared: "Détection automatique rétablie.",
    claudeCheck: "Vérifier",
    agentCheckLabel: (agent: Agent) => `Vérifier ${agentProduct(agent)}`,
    claudeChecking: "Vérification…",
    agentCheckError: (agent: Agent) =>
      `Impossible de vérifier ${agentProduct(agent)}.`,
    claudeProgram: "Programme",
    claudeNotFound: "Introuvable",
    agentInstall: (agent: Agent) =>
      `Pour l'installer : ${agentInstallCommand(agent)}`,
    claudeVersion: "Version",
    claudeLogin: "Connexion",
    claudeLoggedIn: "Connecté",
    agentLoggedOut: (agent: Agent) =>
      `Pas connecté. Lance ${agentLoginCommand(agent)} dans un terminal et connecte-toi.`,
    claudeLoginUnknown: "Inconnue",
    voiceSpaceHold: "Garder Espace enfoncée pour dicter",
    voiceSpaceHoldHelp:
      "Dans un terminal Claude ou Codex, un appui long sur Espace écoute ta voix et écrit le texte. Un appui court tape un espace. Le bouton micro marche toujours.",
    summarize: "Résumer automatiquement les sessions terminées",
    summarizeHelp:
      "Une phrase par session terminée, quelques centaines de tokens de ton abonnement.",
    notify: (agent: Agent) =>
      `Me prévenir quand ${agentName(agent)} a fini ou m'attend`,
    notifyHelp:
      "Une notification discrète, sans son, sauf si la tâche est déjà sous tes yeux. Un clic t'emmène sur la session.",
    unknown: "Inconnue",
    appVersion: "Version de l'appli",
    hooksPort: "Port des hooks",
    envPath: "PATH résolu",
    envFallback: "PATH de secours : le shell de connexion n'a pas pu être lu.",
    logDir: "Dossier des logs",
    dataDir: "Dossier des données",
    openFolder: "Ouvrir",
    openFolderLabel: (what: string) =>
      `Ouvrir le ${what.toLowerCase()} dans le Finder`,
    statusLoading: "Chargement…",
    statusError: "Impossible de lire l'état de l'appli.",
  },
  /** Agent check before the first launch. */
  claudeCheck: {
    missingTitle: (agent: Agent) => `${agentProduct(agent)} introuvable`,
    missingText: (agent: Agent) =>
      `L'appli ne trouve pas le programme ${agent === "codex" ? "codex" : "claude"}. Installe ${agentProduct(agent)} (par exemple avec ${agentInstallCommand(agent)}), puis réessaie.`,
    missingSettings:
      "S'il est déjà installé ailleurs, indique son chemin dans Réglages › Agents.",
    loggedOutTitle: (agent: Agent) =>
      `${agentProduct(agent)} n'est pas connecté`,
    loggedOutText: (agent: Agent) =>
      `Lance ${agentLoginCommand(agent)} dans un terminal et connecte-toi, puis réessaie.`,
    found: (version: string | null, path: string | null) =>
      [version && `Version ${version}`, path].filter(Boolean).join(" · "),
    retry: "Réessayer",
    checking: "Vérification…",
    stillMissing: "Toujours introuvable.",
    stillLoggedOut: "Toujours pas connecté.",
    openSettings: "Ouvrir les réglages",
  },

  /** First-launch guide. */
  tutorial: {
    label: "Guide de démarrage",
    /** First card: which AI the user works with. */
    agent: {
      title: "Avec quelle IA tu travailles ?",
      text: "Taido la lance dans chaque tâche et te dit où elle en est. Tu pourras changer dans Réglages › Agents.",
      choices: "IA",
      copy: "Copier",
      copied: "Copié",
      checkAgain: "Revérifier",
      checkFailed: "Vérification impossible",
      next: "Continuer",
      later: "Je choisirai plus tard",
    },
    stepOf: (n: number, total: number) => `Étape ${n} sur ${total}`,
    skip: "Passer cette étape",
    quit: "Quitter le guide",
    left: "Tu peux revoir le guide dans Réglages › Général.",
    welcome: {
      title: (app: string) => `Bienvenue dans ${app}`,
      text: "Ici, chaque tâche a son espace de travail, où Claude Code peut tourner. Un point de couleur te dit où il en est, sans ouvrir la tâche.",
      examples: [
        "Corriger le bug de connexion",
        "Préparer la démo client",
        "Mettre à jour la doc",
      ],
      ask: "On fait le tour en 3 minutes ?",
      start: "C'est parti",
      decline: "Non merci",
    },
    project: {
      title: "Ton premier projet",
      text: "Un projet par client ou par chantier. Tape un nom, par exemple « Perso », puis Entrée.",
    },
    task: {
      title: "Une tâche",
      text: "Écris « Essayer Claude » comme nom de tâche, puis Entrée. Si le champ est fermé, clique d'abord sur « Ajouter… ».",
    },
    open: {
      title: "Ouvre-la",
      text: "Clique sur ta tâche : c'est son espace de travail. Claude va tourner dedans.",
    },
    claude: {
      title: "Lance Claude et parle-lui",
      checking: "Je vérifie que Claude Code est prêt…",
      ready: "Claude Code est prêt. Clique sur « Lancer Claude Code » (ou ⌘T).",
      missing:
        "Claude Code n'est pas installé sur cet appareil. Installe-le (par exemple avec npm install -g @anthropic-ai/claude-code), puis réessaie.",
      notLoggedIn:
        "Claude Code n'est pas connecté. Lance claude dans un terminal et connecte-toi, puis réessaie.",
      retry: "Réessayer",
      skipPart: "Passer cette partie",
    },
    talk: {
      title: "Lance Claude et parle-lui",
      ask: "Écris-lui ceci dans le terminal, puis Entrée :",
      prompt: "Crée un fichier bonjour.txt qui dit bonjour",
      copy: "Copier",
      copied: "Copié",
      watch: "Puis regarde le point à côté du titre de la tâche.",
      working:
        "Orange : Claude travaille. Tu peux aller ailleurs, il continue tout seul.",
      waiting:
        "Rouge : Claude attend ta réponse. Réponds-lui dans le terminal. La première fois, il demande s'il peut travailler dans ce dossier : choisis « Yes » puis Entrée.",
      done: "Vert : Claude a fini. Tu le vois d'un coup d'œil dans la liste, sans ouvrir la tâche.",
      noRed: "S'il te pose une question, le point devient rouge.",
      error:
        "Claude a rencontré un problème : regarde le terminal. Tu peux continuer le guide.",
      next: "Continuer",
    },
    kanban: {
      title: "Passe en Kanban",
      text: (title: string | null, target: string) =>
        title
          ? `En haut du projet, clique sur « Kanban », puis glisse « ${title} » dans la colonne « ${target} ».`
          : `En haut du projet, clique sur « Kanban », puis glisse ta tâche dans la colonne « ${target} ».`,
      /** Launching Claude already moved the card (core rule). */
      already: (column: string) =>
        `Ta tâche est déjà dans « ${column} » : Claude l'y a mise en démarrant.`,
      /** Before the board loads. */
      fallbackTarget: "En cours",
      hint: "Les colonnes se renomment et s'ajoutent : c'est ton tableau.",
    },
    file: {
      title: "Une pièce jointe",
      text: "Ouvre ta tâche et glisse un fichier du Finder dans « Pièces jointes » (une image, un PDF…). Claude pourra le lire.",
    },
    quickAdd: {
      title: "Ajout rapide ⌘N",
      text: (project: string | null) =>
        project
          ? `Appuie sur ⌘N et tape : Appeler le client demain #${project}, puis Entrée.`
          : "Appuie sur ⌘N et tape : Appeler le client demain, puis Entrée.",
      hint: "« #projet » range la tâche, « demain » lui donne une date.",
    },
    complete: {
      title: "Coche",
      text: (title: string | null) =>
        title
          ? `Clique sur le rond de « ${title} » pour la cocher, puis confirme : son terminal se ferme, mais la session Claude reste dans l'historique et tu pourras la reprendre.`
          : "Clique sur le rond d'une tâche pour la cocher.",
    },
    account: {
      title: "Crée ton compte",
      text: "Avec un compte, tu retrouves tes projets, ton temps et tes fichiers sur ton téléphone et sur le site.",
      linked:
        "Ton compte est relié : tes projets te suivent sur ton téléphone et sur le site.",
      open: "Créer mon compte",
      later: "Pas maintenant",
      next: "Continuer",
    },
    done: {
      title: "Tu as fait le tour",
      text: "Les raccourcis à garder sous la main :",
      shortcuts: [
        ["⌘N", "Ajout rapide"],
        ["⌘K", "Recherche"],
        ["⌘T", "Lancer Claude dans la tâche ouverte"],
        ["⌘1 · ⌘2 · ⌘3", "À faire · Aujourd'hui · Prochainement"],
        ["M", "Replier la barre latérale"],
        ["⌘,", "Réglages"],
      ],
      more: {
        title: "À découvrir aussi",
        items: [
          "Dashboard : les chiffres d'un projet, à côté de Liste et Kanban.",
          "Portefeuille : tous tes projets, une ligne chacun, dans la barre latérale.",
          "@ dans l'ajout rapide : « @vendredi » donne une date à la tâche.",
        ],
      },
      finish: "Terminer",
    },
    replayLegend: "Guide de démarrage",
    replayHelp: "Refais le tour de l'appli, pas à pas.",
    replay: "Revoir le guide",
  },

  journal: {
    created: "Tâche créée",
    completed: "Tâche terminée",
    reopened: "Tâche rouverte",
    note: "Note",
    session_started: "Session démarrée",
    prompt: "Demande",
    turn_ended: "Tour terminé",
    waiting: "En attente",
    error: "Erreur",
    session_ended: "Session terminée",
    crashed: "Session arrêtée",
    resumed: "Session reprise",
    cleared: "Conversation effacée",
    compacted: "Conversation compactée",
  } satisfies Record<JournalKind, string>,

  /** « Sessions Claude » of the task panel: work history, like `claude --resume`. */
  sessions: {
    title: "Conversations passées",
    titleCount: (n: number) => `Conversations passées (${n})`,
    running: "en cours",
    crashed: "arrêtée brutalement",
    noMessage: "Conversation sans message",
    resume: "Reprendre",
    resumeLabel: (start: string) => `Reprendre la session du ${start}`,
    goToTab: "Aller à l'onglet",
    goToTabLabel: (start: string) =>
      `Aller à l'onglet de la session du ${start}`,
    notResumable: "Rien à reprendre : aucun message",
    showDetail: (start: string) =>
      `Voir les échanges de la session du ${start}`,
    exchanges: (n: number) => (n <= 1 ? `${n} échange` : `${n} échanges`),
    loading: "Chargement des échanges…",
    empty: "Aucun échange enregistré.",
    loadError: "Impossible de charger les échanges.",
    retry: "Réessayer",
    you: "Toi",
    agent: (agent: Agent) => agentName(agent),
    resumed: "Conversation reprise",
    cleared: "Conversation effacée (/clear)",
    compacted: "Contexte compacté",
    showMore: "Voir plus",
    showLess: "Voir moins",
    resumeError: "Impossible de reprendre la session.",
    durationUnderMinute: "moins d'1 min",
    durationMinutes: (n: number) => `${n} min`,
    durationHours: (h: number, m: number) =>
      `${h} h ${String(m).padStart(2, "0")}`,
    // Recap by the session's agent and rename (option 4).
    aiSummary: (agent: Agent) => `Résumé par ${agentName(agent)}`,
    rename: "Renommer la session",
    renameLabel: (start: string) => `Nom de la session du ${start}`,
    renameHint:
      "Entrée pour enregistrer, Échap pour annuler, vide pour le résumé automatique",
    renameError: "Impossible de renommer la session.",
  },

  dates: {
    justNow: "à l'instant",
    minutesAgo: (n: number) => `il y a ${n} min`,
    hoursAgo: (n: number) => `il y a ${n} h`,
    yesterdayAt: (time: string) => `hier ${time}`,
    todayAt: (time: string) => `aujourd'hui ${time}`,
    today: "Aujourd'hui",
    tomorrow: "Demain",
    yesterday: "Hier",
  },

  shortcuts: {
    dialogClose: "Fermer la fenêtre",
  },

  // --- Sidebar projects: inline creation, rename, loading ---
  projectNav: {
    newPlaceholder: "Nom du projet",
    newLabel: "Nom du nouveau projet",
    newHint: "↵ créer · Échap annuler",
    renameLabel: (name: string) => `Nouveau nom du projet ${name}`,
    loading: "Chargement des projets",
    restoreError: "Impossible de restaurer le projet.",
  },
  // --- end sidebar projects ---

  // ---- Lists, rows and in-place editor ----
  list: {
    /** Accessible name of the task list of a view. */
    label: (view: string) => `Tâches · ${view}`,
    more: (title: string) => `Actions de la tâche ${title}`,
    file: "Ranger dans…",
    fileLabel: (title: string) => `Ranger « ${title} » dans un projet`,
    hasNote: "A une note",
    sectionCount: (n: number) => taskCount(n),
    retry: "Réessayer",
    loading: "Chargement de la liste",
    /** « 2 tâches reportées à aujourd'hui ». */
    rescheduled: (n: number) =>
      n > 1
        ? `${n} tâches reportées à aujourd'hui`
        : "Tâche reportée à aujourd'hui",
    /**
     * Polite announcements (aria-live) after list actions that show no toast; a toast is a
     * status region and is announced by itself.
     */
    announce: {
      reopened: (title: string) => `« ${title} » rouverte`,
      movedUp: (title: string) => `« ${title} » montée d'un cran`,
      movedDown: (title: string) => `« ${title} » descendue d'un cran`,
      added: (title: string) => `« ${title} » ajoutée`,
    },
  },

  editor: {
    destination: (where: string) => `Destination : ${where}. Changer`,
    due: (label: string) => `Échéance : ${label}. Changer`,
    noDue: "Échéance",
    projectMenu: "Choisir la destination",
  },
  // ---- end of the views area block ----

  // --- m1bis date picker (src/components/DatePicker.tsx) ---
  /** French date picker of the due date (panel chip and « Échéance… » dialog). */
  datePicker: {
    label: "Choisir l'échéance",
    today: "Aujourd'hui",
    tomorrow: "Demain",
    nextMonday: "Lundi prochain",
    previousMonth: "Mois précédent",
    nextMonth: "Mois suivant",
    /** Suffix of the accessible name of today's cell. */
    isToday: "aujourd'hui",
    time: "Heure",
    timePlaceholder: "Ajouter une heure",
    timeHelp: "Par exemple 17h ou 9:30. Entrée pour valider.",
    timeInvalid: "Heure non reconnue. Essaie 17h ou 9:30.",
    clearTime: "Retirer l'heure",
    clear: "Retirer l'échéance",
  },
  // --- end m1bis date picker ---

  // ── Keyboard, toasts and global regions (m1bis-keyboard) ──────────────────────────────
  app: {
    /** Label of the toast area (aria region). */
    notifications: "Notifications",
    /** ⌘Entrée on a completed task. */
    reopened: "Tâche rouverte",
    /** « Ouvrir le dossier » failed (bug #11). */
    openFolderError: "Impossible d'ouvrir le dossier.",
  },
  // ── end m1bis-keyboard ─────────────────────────────────────────────────────────────────

  // ── lists, priority, Claude dot, Upcoming (m5bis-list) ──────────────────
  /**
   * Round checkbox coloured by priority. `n` is the number shown (`displayPriority`): P1 red,
   * P2 orange, P3 yellow, P4 plain.
   */
  priorityRing: {
    name: (n: number) => `Priorité ${n}`,
    /** « Terminer », or « Terminer · Priorité 1 » above the plain P4. */
    markDone: (n: number) => (n < 4 ? `Terminer · Priorité ${n}` : "Terminer"),
    reopen: "Rouvrir",
    /** Row ⋯ menu entries. */
    menu: (n: number) => `Priorité ${n}`,
  },
  /** Subtasks shown under their task in the lists (Todoist). */
  nesting: {
    expand: (title: string) => `Afficher les sous-tâches de « ${title} »`,
    collapse: (title: string) => `Masquer les sous-tâches de « ${title} »`,
    childrenLabel: (title: string) => `Sous-tâches de « ${title} »`,
  },
  /** « Prochainement » (Upcoming), like Todoist. */
  upcoming: {
    title: "Prochainement",
    /** « Octobre 2026 », the month picker button. */
    monthPicker: (month: string) => `${month}, choisir une date`,
    previousWeek: "Semaine précédente",
    nextWeek: "Semaine suivante",
    today: "Aujourd'hui",
    weekLabel: "Jours de la semaine",
    /** Accessible name of a day of the strip. */
    dayButton: (label: string, count: number) =>
      count === 0 ? label : `${label}, ${taskCount(count)}`,
    /** « 3 oct · Aujourd'hui · Samedi », « 5 oct · Lundi ». */
    dayTitle: (date: string, relative: string | null, weekday: string) =>
      relative ? `${date} · ${relative} · ${weekday}` : `${date} · ${weekday}`,
    /** A day without task, on one line (2026-10-12). */
    nothingPlanned: "Rien de prévu",
    addOnDay: (day: string) => `Ajouter une tâche : ${day}`,
    /** « Liste | Calendrier » switch (2026-10-12). */
    modeLabel: "Affichage",
    list: "Liste",
    calendar: "Calendrier",
    previousMonth: "Mois précédent",
    nextMonth: "Mois suivant",
    /** Weekday headers of the calendar, Monday first. */
    weekdays: ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"],
    /** « + 2 autres » under a full calendar day. */
    more: (n: number) => `+ ${n} ${n > 1 ? "autres" : "autre"}`,
    /** Accessible name of a calendar day (it opens the list on that day). */
    openDay: (label: string, count: number) =>
      count === 0
        ? `${label}, voir la liste`
        : `${label}, ${taskCount(count)}, voir la liste`,
    lateOn: (title: string) => `${title}, en retard`,
    /** Phone calendar: a tap selects the day, its tasks show under the grid. */
    selectDay: (label: string, count: number) =>
      count === 0 ? label : `${label}, ${taskCount(count)}`,
    seeInList: "Voir dans la liste",
    dragHint: "Appui long sur une tâche pour la glisser sur un autre jour.",
    /** Toast after a task is dropped on a calendar day: « Déplacée au mercredi 14 octobre ». */
    movedTo: (day: string) => `Déplacée au ${day}`,
  },
  // ── end m5bis-list ──────────────────────────────────────────────────────────────────────
  // ── task panel (child tasks, priority, session recap) ─────────────────
  panelBis: {
    /** Breadcrumb of a subtask's panel. */
    backToParent: (title: string) => `Revenir à « ${title} »`,
    /** Location chip of a subtask (not clickable: it moves with its parent). */
    locationFromParent: "Comme la tâche parente",
    /** Shown priority (`displayPriority`, by design): P1 red, P2 orange, P3 yellow, P4 grey by default. */
    priority: "Priorité",
    priorityShort: (p: number) => `P${p}`,
    priorityName: (p: number) => `Priorité ${p}`,
    priorityChip: (p: number) => `Priorité : P${p}. Changer`,
    priorityMenuItem: "Priorité…",
    openSubtask: (text: string) => `Ouvrir la sous-tâche « ${text} »`,
    renameSubtask: "Renommer la sous-tâche",
    subtaskDue: (label: string) => `Échéance : ${label}`,
    /** « Sessions Claude » folded or not. */
    showSessions: "Afficher les sessions",
    hideSessions: "Masquer les sessions",
    /** One-line recap of a session: first message → first sentence of the last reply. */
    recap: (prompt: string, reply: string | null) =>
      reply ? `${prompt} → ${reply}` : prompt,
  },
  // ── task panel ─────────────────────────────────────────────────────
  // ── sub-projects and « À faire » ──────────────────────────────────────
  subProjects: {
    /** « Globex › Client »: a sub-project with its parent. */
    path: (parent: string, name: string) => `${parent} › ${name}`,
    /** Chevron of a parent project in the sidebar. */
    hide: (name: string) => `Masquer les sous-projets de « ${name} »`,
    show: (name: string) => `Afficher les sous-projets de « ${name} »`,
    menuAdd: "Ajouter un sous-projet",
    menuMove: "Déplacer vers…",
    moveMenuLabel: (name: string) => `Déplacer « ${name} » vers…`,
    topLevel: "Aucun (projet principal)",
    moveError: "Impossible de déplacer le projet.",
    /** « Client » est maintenant dans « Globex ». */
    moved: (name: string, parent: string | null) =>
      parent
        ? `« ${name} » est maintenant dans « ${parent} »`
        : `« ${name} » est maintenant un projet principal`,
    newLabel: (parent: string) => `Nom du nouveau sous-projet de ${parent}`,
    newPlaceholder: "Nom du sous-projet",
    /** A sub-project's folder: its own, else its parent's. */
    folderHint: "Créé dans le dossier du projet parent dès qu'il en a un",
    pickFolderTitle:
      "Choisis le dossier du sous-projet (dossier du projet parent si vide)",
    /** Deleting a parent deletes its sub-projects too. */
    deleteChildren: (n: number) =>
      n > 1
        ? `Ses ${n} sous-projets et leurs tâches seront supprimés aussi.`
        : "Son sous-projet et ses tâches seront supprimés aussi.",
    /** Links under a parent project's title. */
    listLabel: "Sous-projets",
    link: (name: string, n: number) =>
      n === 0 ? `Ouvrir ${name}` : `Ouvrir ${name}, ${taskCount(n)}`,
  },
  /** Taido V2.2 bis, product decision: groups gather projects in the sidebar, like Brave's tab groups. */
  groups: {
    menuLabel: (name: string) => `Options du groupe « ${name} »`,
    toggle: (name: string, open: boolean) =>
      open ? `Replier le groupe « ${name} »` : `Déplier le groupe « ${name} »`,
    rename: "Renommer le groupe",
    color: "Couleur",
    dissolve: "Dégrouper",
    dissolved: (name: string) =>
      `Groupe « ${name} » retiré, ses projets restent`,
    addTo: "Ajouter à un groupe",
    addToLabel: (n: number) =>
      n > 1
        ? `Ajouter les ${n} projets à un groupe`
        : "Ajouter le projet à un groupe",
    newGroup: "Nouveau groupe",
    into: (name: string) => `${name}`,
    remove: "Retirer du groupe",
    selection: (n: number) => `${n} projets sélectionnés`,
    renameLabel: (name: string) => `Nom du groupe « ${name} »`,
    error: "Impossible de changer le groupe.",
  },
  /** « À faire » (`ViewKind::All`): every open task, grouped by project. */
  all: {
    title: "À faire",
    openProject: (name: string) => `Ouvrir le projet ${name}`,
    emptyTitle: "Rien à faire",
    emptyText: "Toutes les tâches ouvertes de tes projets apparaissent ici.",
  },

  /** Screen reader announcements of drag and drop (dnd-kit's live region). */
  dnd: {
    instructions:
      "Pour déplacer cet élément, appuie sur Espace ou Entrée, déplace-le avec les flèches, puis appuie de nouveau sur Espace ou Entrée pour le déposer, ou sur Échap pour annuler.",
    pickedUp: (name: string) => `Saisi : « ${name} »`,
    over: (name: string) => `Au-dessus de « ${name} »`,
    droppedOn: (name: string) => `Déposé sur « ${name} »`,
    dropped: "Déposé",
    cancelled: "Déplacement annulé",
  },
  // ── ────────────────────────────────────────────────────────────────

  // ── sync and mobile app (contract: docs/SYNC.md § UI strings) ──────────────
  /** Sync with the server: Réglages › Synchro, sidebar button, mobile settings. */
  sync: {
    tab: "Synchro",
    /** Réglages › Synchro while `sync_status` loads, or when it failed. */
    loading: "Chargement…",
    loadError: "Impossible de lire l'état de la synchro.",
    intro:
      "Synchronise tes projets et tes tâches avec ton téléphone, par ton serveur.",
    /** `intro` read on the phone itself (Taido V2.7: the phone logs in to the account). */
    introMobile:
      "Connecte-toi à ton compte pour retrouver les projets et les tâches de ton ordinateur.",
    privacy: ACCOUNT_PRIVACY,
    serverUrl: "Adresse du serveur",
    serverUrlPlaceholder: "https://sync.example.com",
    email: "Adresse e-mail",
    emailPlaceholder: "toi@exemple.fr",
    password: "Mot de passe",
    /** Phone, under the login form: no signup nor password reset on the phone in V2.7. */
    signupOnMac: "Crée ton compte depuis l'ordinateur.",
    forgotOnMac:
      "Pour changer ton mot de passe, utilise « Mot de passe oublié » sur l'ordinateur.",
    link: "Se connecter",
    linking: "Connexion…",
    linkedTo: (url: string) => `Connecté à ${url}`,
    linkedToast: "Connecté. Première synchro en cours…",
    /** Linked but the server refused the token (`unauthorized`): e-mail and password fields. */
    reconnectHelp:
      "Le serveur ne reconnaît plus cet appareil. Connecte-toi à nouveau pour reprendre la synchro.",
    reconnect: "Se reconnecter",
    reconnectedToast: "Reconnecté. Synchro en cours…",
    interval: "Synchroniser toutes les",
    intervalOption: (minutes: number) =>
      minutes === 60 ? "1 heure" : `${minutes} min`,
    intervalHelp:
      "Et aussi au démarrage, peu après chaque modification, et quand tu cliques sur « Synchroniser ».",
    /** Sidebar button and mobile menu entry. */
    syncNow: "Synchroniser",
    state: {
      unlinked: "Synchro désactivée",
      idle: "À jour",
      syncing: "Synchronisation…",
      offline: "Hors connexion",
      error: "Erreur de synchro",
    },
    /** `relative` comes from `formatRelative` (src/lib/dates.ts): « il y a 8 min ». */
    lastSync: (relative: string) => `Dernière synchro : ${relative}`,
    never: "Jamais synchronisé",
    pending: (n: number) =>
      n > 1 ? `${n} modifications à envoyer` : "1 modification à envoyer",
    /** Tooltip / accessible name of the sidebar button: « Synchroniser · À jour · Dernière synchro : il y a 8 min ». */
    buttonLabel: (state: string, detail: string | null) =>
      detail
        ? `Synchroniser · ${state} · ${detail}`
        : `Synchroniser · ${state}`,
    /** `SyncStatus.errorKind` while `state` is "error". */
    error: {
      unauthorized: "Connexion refusée : reconnecte-toi dans les Réglages.",
      server:
        "Le serveur a renvoyé une erreur. Nouvel essai à la prochaine synchro.",
      unsupported_protocol:
        "Le serveur utilise une autre version : mets à jour l'appli.",
      internal: "Un problème est survenu pendant la synchro.",
      /** Phone only: many rows vanished at once (docs/SYNC.md § 6.2). */
      deletions_held:
        "Beaucoup d'éléments ont disparu de ce téléphone : la synchro attend ta confirmation.",
    },
    /**
     * Errors of the account commands (`sync_signup`, `sync_login`, `sync_forgot_password`,
     * `sync_reset_password`), by `ErrorKind`; others use `fr.errors`.
     */
    accountError: {
      sync_auth: "E-mail ou mot de passe incorrect.",
      sync_rate_limited:
        "Trop d'essais. Attends quelques minutes avant de réessayer.",
      sync_email_taken:
        "Un compte existe déjà avec cette adresse. Connecte-toi plutôt.",
      sync_weak_password: "Le mot de passe doit faire au moins 10 caractères.",
      sync_bad_email: "Cette adresse e-mail n'est pas valide.",
      sync_invalid_code: "Code faux ou expiré. Demande un nouveau code.",
      sync_mail_unavailable:
        "Le serveur ne peut pas envoyer d'e-mails pour le moment. Réessaie plus tard.",
      sync_signups_closed:
        "Les inscriptions sont fermées sur ce serveur. Demande un compte à la personne qui l'héberge.",
      sync_offline: "Serveur injoignable. Vérifie ta connexion.",
      sync_server: "Le serveur a renvoyé une erreur. Réessaie plus tard.",
      invalid: "Indique une adresse de serveur qui commence par https://.",
      /** `invalid` refusal of a signup or login while already linked to an account. */
      alreadyLinked: "Déconnecte-toi d'abord pour changer de compte.",
      /** `invalid` refusal of signup, forgotten password or reset on the phone (V2.7). */
      notOnPhone:
        "Crée ton compte ou change ton mot de passe depuis l'ordinateur.",
    },
  },
  /** The installable web app (PWA) for Android. */
  mobile: {
    menu: "Menu",
    closeMenu: "Fermer le menu",
    back: "Retour",
    settings: "Réglages",
    linkFirst:
      "Connecte-toi à ton compte pour retrouver tes projets et tes tâches.",
    offlineBanner:
      "Hors connexion : tes modifications partiront au retour du réseau.",
    updateReady: "Une nouvelle version est prête.",
    reload: "Recharger",
    storageError:
      "Impossible d'enregistrer sur ce téléphone. Libère de l'espace puis réessaie.",
    /** Banner when the sync holds many deletions (docs/SYNC.md § 6.2). */
    deletionsHeld: (n: number) =>
      `${n} éléments ont disparu de ce téléphone. Les supprimer aussi sur tes autres appareils ?`,
    deletionsHeldConfirm: "Supprimer partout",
    deletionsHeldRestore: "Les remettre",
    /** Another page of the app holds the data (docs/SYNC.md § 6.2, one page at a time). */
    otherPage:
      "L'appli est déjà ouverte ailleurs (l'appli installée ou un onglet de Chrome).",
    otherPageHelp:
      "Une seule page à la fois peut l'utiliser, pour ne pas écraser tes modifications.",
    useHere: "Utiliser ici",
    pageTakenOver:
      "L'appli a été ouverte ailleurs. Cette page est en pause pour ne pas écraser tes modifications.",
    installHelp:
      "Pour l'installer : menu ⋮ de Chrome › « Ajouter à l'écran d'accueil ».",
  },
  // ── Taido V2.7: accounts on the Mac (welcome screen, Réglages › Compte) ──────────────────
  account: {
    /** Réglages › Compte while not logged in: the two ways in. */
    start: {
      signup: "Créer un compte",
      login: "J'ai déjà un compte",
    },
    intro:
      "Un compte te permet de retrouver tes projets et tes tâches sur tous tes appareils.",
    privacy: ACCOUNT_PRIVACY,
    title: {
      signup: "Créer un compte",
      login: "Se connecter",
      forgot: "Mot de passe oublié",
      reset: "Choisis un nouveau mot de passe",
    },
    email: "Adresse e-mail",
    emailPlaceholder: "toi@exemple.fr",
    password: "Mot de passe",
    newPassword: "Nouveau mot de passe",
    passwordRule: "10 caractères au moins.",
    showPassword: "Afficher le mot de passe",
    hidePassword: "Masquer le mot de passe",
    code: "Code reçu par e-mail",
    forgotHelp:
      "Indique ton adresse : on t'envoie un code pour choisir un nouveau mot de passe.",
    codeSent: (email: string) =>
      `On t'a envoyé un code à ${email}. Il est valable 30 minutes.`,
    newCode: "Demander un nouveau code",
    forgotLink: "Mot de passe oublié ?",
    /** Under the e-mail while the address is not confirmed (signup mail, 24 h link). */
    unconfirmed: "Adresse à confirmer",
    unconfirmedHelp: "Ouvre le lien du mail « Confirme ton adresse ».",
    resend: "Renvoyer le mail",
    resentToast: (email: string) => `Mail envoyé à ${email}.`,
    toLogin: "J'ai déjà un compte",
    toSignup: "Créer un compte",
    back: "Retour",
    serverUrl: "Adresse du serveur",
    serverUrlPlaceholder: "https://sync.example.com",
    serverHelp: "L'adresse du serveur de synchro que tu utilises.",
    serverRequired: "Indique l'adresse de ton serveur de synchro.",
    submit: {
      signup: "Créer mon compte",
      login: "Se connecter",
      forgot: "Envoyer le code",
      reset: "Changer le mot de passe",
    },
    busy: {
      signup: "Création…",
      login: "Connexion…",
      forgot: "Envoi…",
      reset: "Changement…",
    },
    signedUpToast: "Compte créé. Première synchro en cours…",
    loggedInToast: "Connecté. Synchro en cours…",
    resetToast: "Mot de passe changé. Tu es connecté.",
    /** The reset worked but the login after it did not (or the merge was declined). */
    resetThenLogin: "Mot de passe changé. Connecte-toi.",
    /** Login to an existing account while this Mac already holds projects or tasks. */
    mergeTitle: "Fusionner avec ce compte ?",
    mergeText: (email: string) =>
      `Cet appareil contient déjà des projets. Ils seront ajoutés à ceux du compte ${email}.`,
    merge: "Fusionner",
    server: (url: string) => `Serveur : ${url}`,
    syncNow: "Synchroniser maintenant",
    logout: "Se déconnecter",
    loggingOut: "Synchro avant de partir…",
    logoutTitle: "Se déconnecter du compte ?",
    logoutText:
      "Tes projets et tes tâches restent sur cet appareil. La synchro s'arrête jusqu'à ta prochaine connexion.",
    logoutPendingTitle: "Modifications pas encore envoyées",
    logoutPending: (n: number) =>
      n > 1
        ? `${n} modifications n'ont pas encore été envoyées au compte. Elles restent sur cet appareil et partiront à ta prochaine connexion.`
        : "1 modification n'a pas encore été envoyée au compte. Elle reste sur cet appareil et partira à ta prochaine connexion.",
    /** The sync before logging out failed and nothing says what is left. */
    logoutFailed:
      "La synchro n'a pas pu se faire : des modifications n'ont peut-être pas été envoyées au compte. Elles restent sur cet appareil et partiront à ta prochaine connexion.",
    logoutAnyway: "Se déconnecter quand même",
    loggedOutToast: "Déconnecté. Tes projets restent sur cet appareil.",
    /** The texts above that name the device, as the phone says them (same flows, V2.7). */
    phone: {
      mergeText: (email: string) =>
        `Ce téléphone contient déjà des projets. Ils seront ajoutés à ceux du compte ${email}.`,
      logoutText:
        "Tes projets et tes tâches restent sur ce téléphone. La synchro s'arrête jusqu'à ta prochaine connexion.",
      logoutPending: (n: number) =>
        n > 1
          ? `${n} modifications n'ont pas encore été envoyées au compte. Elles restent sur ce téléphone et partiront à ta prochaine connexion.`
          : "1 modification n'a pas encore été envoyée au compte. Elle reste sur ce téléphone et partira à ta prochaine connexion.",
      logoutFailed:
        "La synchro n'a pas pu se faire : des modifications n'ont peut-être pas été envoyées au compte. Elles restent sur ce téléphone et partiront à ta prochaine connexion.",
      loggedOutToast: "Déconnecté. Tes projets restent sur ce téléphone.",
    },
  },

  // ── ────────────────────────────────────────────────────────────────────

  // ── Taido V2.2: kanban ─────────────────────────────────────────────
  board: {
    tabs: "Affichage du projet",
    list: "Liste",
    board: "Kanban",
    hint: (first: string, second: string, agent: Agent) =>
      `Lancer ${agentName(agent)} sur une tâche « ${first} » la passe « ${second} ».`,
    columnLabel: (name: string, n: number) =>
      `${name}, ${n} tâche${n > 1 ? "s" : ""}`,
    more: (n: number) => `+ ${n} autre${n > 1 ? "s" : ""}`,
    addTask: "+ Tâche",
    addColumn: "+ Colonne",
    newColumnPlaceholder: "Nom de la colonne",
    columnMenu: (name: string) => `Options de la colonne « ${name} »`,
    rename: "Renommer",
    moveLeft: "Déplacer à gauche",
    moveRight: "Déplacer à droite",
    delete: "Supprimer la colonne",
    deleteTitle: (name: string) => `Supprimer la colonne « ${name} » ?`,
    deleteMessage: (first: string) =>
      `Ses tâches reviennent dans « ${first} ». Aucune tâche n'est supprimée.`,
    empty: "Aucune tâche",
    loading: "Chargement du kanban…",
    error: "Le kanban n'a pas pu être chargé.",
    retry: "Réessayer",
    dragLabel: (title: string) => `Déplacer « ${title} »`,
    /** Web app (Taido V2.8): a linked device before its first full sync has no columns yet. */
    notReady:
      "Les colonnes arrivent avec la première synchronisation. Reviens dans un instant.",
    notReadyError:
      "Impossible d'ajouter la colonne : le kanban attend la première synchronisation.",
    /** Phone: the row of column names above the board (a tap scrolls to the column). */
    columnsNav: "Colonnes du kanban",
    columnTab: (name: string, n: number) =>
      `${name}, ${n} tâche${n > 1 ? "s" : ""}`,
    /** Phone: « Déplacer vers… », the main way to move a card. */
    moveTo: "Déplacer vers…",
    moveToLabel: (title: string) => `Déplacer « ${title} » vers…`,
  },

  // ── Taido V2.6: portfolio ─────────────────────────────────────────
  portfolio: {
    title: "Portefeuille",
    subtitle: "Tous tes projets, une ligne chacun.",
    export: "Exporter les temps (CSV)",
    exported: (path: string) => `Temps exportés : ${path}`,
    /** Web app (Taido V2.8): the CSV is a download. */
    downloaded: (fileName: string) => `Temps exportés : ${fileName} téléchargé`,
    fileName: (date: string, days: number) =>
      `taido-temps-${days}j-${date}.csv`,
    open: "Tâches ouvertes",
    done: (days: number) => `Terminées (${days} j)`,
    overdue: "En retard",
    time: (days: number) => `Temps (${days} j)`,
    table: "Projets",
    cols: {
      project: "Projet",
      open: "Ouvertes",
      done: (days: number) => `Terminées ${days} j`,
      overdue: "En retard",
      blocked: "Bloquées",
      next: "Prochaine tâche définie",
      sessions: "Sessions",
      time: (days: number) => `Temps ${days} j`,
      last: "Dernière activité",
    },
    sortBy: (col: string) => `Trier par ${col}`,
    noDated: "aucune tâche datée",
    running: (n: number) => `${n} session${n > 1 ? "s" : ""} en cours`,
    waiting: (n: number) =>
      `${n} session${n > 1 ? "s" : ""} en attente de ta réponse`,
    noSession: "aucune",
    inactive: (n: number) => `inactif ${n} j`,
    never: "jamais",
    openDashboard: (name: string) => `Ouvrir le dashboard de ${name}`,
    empty: "Aucun projet pour l'instant.",
    footnote:
      "Tri par défaut : prochaine tâche définie la plus proche. Clic sur un projet : son dashboard.",
    loading: "Chargement du portefeuille…",
    error: "Le portefeuille n'a pas pu être chargé.",
  },

  // ── Taido V2.5: dashboard ──────────────────────────────────────────
  dashboard: {
    tab: "Dashboard",
    period: "Période",
    days: (n: number) => `${n} jours`,
    open: "Ouvertes",
    /** By design: subtasks count in the open tile, said in small. */
    withSubtasks: (n: number) =>
      n === 0 ? "aucune sous-tâche" : `dont ${n} sous-tâche${n > 1 ? "s" : ""}`,
    openDelta: (n: number, days: number) =>
      n === 0
        ? `stable sur ${days} j`
        : `${n > 0 ? "+" : "−"}${Math.abs(n)} sur ${days} j`,
    done: "Terminées",
    doneBefore: (n: number) => `${n} la période d'avant`,
    overdue: "En retard",
    overdueHint: "échéance dépassée",
    blocked: "Bloquées",
    blockedHint: (relation: number, waiting: number) =>
      `${relation} par une tâche · ${waiting} attend${waiting > 1 ? "ent" : ""} ta réponse`,
    /** Web app (Taido V2.8): no Claude, so nothing « attend ta réponse ». */
    blockedHintWeb: (relation: number) => `${relation} par une tâche`,
    time: "Temps passé",
    perDone: (time: string) => `moy. ${time} par tâche finie`,
    noneDone: "aucune tâche finie",
    oldest: "Plus vieille ouverte",
    oldestValue: (days: number) => `${days} j`,
    noOpen: "aucune",
    timeByDay: "Temps par jour",
    auto: (agent: Agent) => `sessions ${agentName(agent)} (auto)`,
    manual: "ajouté à la main",
    dayTip: (date: string, auto: string, manual: string, agent: Agent) =>
      `${date} · ${agentName(agent)} ${auto} · à la main ${manual}`,
    upcoming: "Prochaines tâches au calendrier",
    undated: (n: number) =>
      n === 0
        ? "toutes les tâches ouvertes ont une date"
        : `${n} tâche${n > 1 ? "s" : ""} ouverte${n > 1 ? "s" : ""} sans date`,
    noUpcoming: "Aucune échéance à venir",
    lateOrBlocked: "En retard et bloquées",
    late: (days: number) => `retard ${days} j`,
    blockedBy: (title: string) => `par : ${title}`,
    waiting: "attend ta réponse",
    nothingLate: "Rien en retard ni bloqué",
    lingering: "Tâches qui traînent",
    age: (days: number) =>
      days === 0 ? "ouverte aujourd'hui" : `ouverte depuis ${days} j`,
    timeByTask: (days: number) => `Temps par tâche (${days} j)`,
    noTime: "Pas de temps sur la période",
    loading: "Chargement du dashboard…",
    error: "Le dashboard n'a pas pu être chargé.",
    retry: "Réessayer",
    /** The compact strip above the list (wireframe V2·1). */
    strip: "Chiffres du projet",
    stripOpen: (n: number) => `${n} ouverte${n > 1 ? "s" : ""}`,
    stripDone: (n: number) => `${n} terminée${n > 1 ? "s" : ""} (7 j)`,
    stripLate: (n: number) => `${n} en retard`,
    stripBlocked: (n: number) => `${n} bloquée${n > 1 ? "s" : ""}`,
    stripTime: (time: string) => `${time} cette semaine`,
    stripOpenDashboard: "Ouvrir le dashboard",
  },

  // ── Taido V2.3: attachments and relations ───────────────────
  attachments: {
    title: "Pièces jointes",
    hint: (agent: Agent) =>
      `copiées dans le dossier de la tâche, lisibles par ${agentName(agent)}`,
    drop: "Glisse des fichiers ici, colle une capture (⌘V), ou",
    browse: "parcourir",
    pickTitle: "Joindre des fichiers",
    /** 2026-10-10: the tile's first action, on every surface (« Ouvrir » before). */
    download: "Télécharger",
    /** Mac: the toast once the copy is in the Downloads folder (action: `reveal`). */
    downloaded: "Enregistré dans Téléchargements",
    /**
     * Mac: a file not here yet that could not be fetched, by `ErrorKind` (others use
     * `fr.errors.kind`; `sync_auth` uses `fr.sync.error.unauthorized`).
     */
    downloadError: {
      sync_offline:
        "Ce fichier n'est pas encore sur cet appareil et le serveur est injoignable.",
      sync_server:
        "Le serveur a renvoyé une erreur pendant le téléchargement. Réessaie plus tard.",
    },
    reveal: "Afficher dans le Finder",
    delete: "Retirer",
    deleteTitle: (name: string) => `Retirer « ${name} » ?`,
    removeOne: (name: string) => `Retirer « ${name} »`,
    deleteMessage:
      "Elle est retirée de tous tes appareils, et sa copie dans le dossier de la tâche est supprimée. Le fichier d'origine ne bouge pas.",
    missing: "fichier introuvable",
    /** V2.7 bis: where the file stands with the account (core `AttachmentRemote`). */
    remote: {
      local_only: "Sur cet appareil seulement",
      uploading: "Envoi…",
      to_download: "À télécharger",
      downloading: "Téléchargement…",
      too_large: "Trop gros pour le serveur",
      quota_full: "Espace du compte plein",
    },
    /** V2.7 bis: the web app (site and phone), where files come from the browser. */
    web: {
      drop: "Glisse des fichiers ici, colle une image, ou",
      adding: "Ajout…",
      localOnly: "Sur cet appareil seulement",
      /** No task folder on the web: the attachment simply leaves every device. */
      deleteMessage: "Elle est retirée de tous tes appareils.",
      tooLarge: (names: string) => `Trop gros (100 Mo max) : ${names}`,
      error: {
        unlinked: "Connecte-toi à ton compte pour télécharger ce fichier.",
        not_on_server:
          "Ce fichier n'est pas encore arrivé sur ton compte. Réessaie plus tard.",
        offline: "Pas de connexion : le fichier n'a pas pu être téléchargé.",
        corrupt: "Le fichier reçu est abîmé. Réessaie.",
        storage: "Plus de place sur cet appareil pour garder ce fichier.",
        too_large: "Trop gros (100 Mo max).",
        not_found: "Ce fichier n'existe plus.",
      },
    },
    added: (n: number, title: string) =>
      n > 1
        ? `${n} fichiers joints à « ${title} »`
        : `Fichier joint à « ${title} »`,
    rowCount: (n: number) =>
      `${n} pièce${n > 1 ? "s" : ""} jointe${n > 1 ? "s" : ""}`,
    pasted: (date: string) => `capture-${date}.png`,
    menu: (name: string) => `Options de « ${name} »`,
    size: (bytes: number) =>
      bytes < 1024
        ? `${bytes} o`
        : bytes < 1024 * 1024
          ? `${Math.round(bytes / 1024)} Ko`
          : `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} Mo`,
  },
  relations: {
    title: "Relations",
    blocks: "Bloque",
    blockedBy: "Bloquée par",
    related: "Liée à",
    none: "aucune",
    /** « + Lier une tâche » (2026-10-11, option A): one menu instead of three searches. */
    add: "+ Lier une tâche",
    menu: "Lier une tâche",
    kind: "Type de lien",
    search: "Chercher, ou parcourir ci-dessous…",
    searchLabel: "Chercher une tâche (tous les projets)",
    noResult: "Aucune tâche trouvée",
    loading: "Chargement…",
    filters: "Filtres",
    filter: {
      all: "Toutes",
      recent: "Récentes",
      project: "Ce projet",
      waiting: "Attend ta réponse",
      done: "Terminées",
    },
    recentGroup: "Modifiées récemment",
    alreadyLinked: "déjà liée",
    showSubtasks: (n: number, title: string) =>
      `Afficher les ${n} sous-tâche${n > 1 ? "s" : ""} de « ${title} »`,
    hideSubtasks: (title: string) => `Masquer les sous-tâches de « ${title} »`,
    groupLabel: (project: string, n: number) =>
      `${project}, ${n} tâche${n > 1 ? "s" : ""}`,
    hints: {
      move: "choisir",
      subtasks: "sous-tâches",
      pick: "lier",
      kind: "type de lien",
      close: "fermer",
    },
    remove: (title: string) => `Retirer le lien avec « ${title} »`,
    done: "terminée",
    open: "à faire",
    noProject: "Sans projet",
    rowBlocks: (n: number) => `bloque ${n} tâche${n > 1 ? "s" : ""}`,
    rowBlockedBy: (title: string, n = 1) =>
      n > 1
        ? `bloquée par : ${title} et ${n - 1} autre${n > 2 ? "s" : ""}`
        : `bloquée par : ${title}`,
    rowRelated: (n: number) => `liée à ${n} tâche${n > 1 ? "s" : ""}`,
    warnTitle: "Cette tâche est bloquée",
    warnMessage: (titles: string, agent: Agent) =>
      `Elle attend encore : ${titles}. Tu peux quand même lancer ${agentName(agent)}.`,
    warnConfirm: "Lancer quand même",
  },

  // ── Task panel, layout C (2026-10-11): folded sections with a summary ──────────
  folds: {
    /** Empty sections, offered on one line at the bottom of the panel. */
    addLabel: "Ajouter :",
    add: {
      subtasks: "Sous-tâche",
      attachments: "Fichier",
      relations: "Lien",
      chrono: "Temps",
    },
    files: (n: number) => `${n} fichier${n > 1 ? "s" : ""}`,
    blocks: (n: number) => `bloque ${n}`,
    blockedBy: (n: number) => `bloquée par ${n}`,
    related: (n: number) => `liée à ${n}`,
    /** In the meta line under the title: the blocking tasks not done yet. */
    blockedByChip: (n: number) => `Bloquée par ${n}`,
    blockedByChipLabel: (n: number) =>
      `Bloquée par ${n} tâche${n > 1 ? "s" : ""} pas encore terminée${n > 1 ? "s" : ""}. Voir les relations`,
    chronoRunning: "en cours",
    chronoPaused: "en pause",
    technical: "Dossier et branche",
    journalCount: (n: number) => `${n} événement${n > 1 ? "s" : ""}`,
    showNote: "Afficher toute la note",
    hideNote: "Réduire la note",
    showAllSegments: (n: number) => `Voir tout le journal (${n})`,
    showFewerSegments: "Voir moins",
  },

  // ── Taido V2.1: chrono ────────────────────────────────────────────
  /** The project notebook: « Notes » tab and its pages. */
  ask: {
    button: "Demander au projet",
    title: "Demander au projet",
    close: "Fermer",
    resize: "Redimensionner le panneau des questions",
    newConversation: "Nouvelle conversation",
    opening: "Ouverture de Claude Code…",
    ended: "La conversation avec Claude Code est terminée.",
    restart: "Nouvelle conversation",
    failedToOpen: "Claude Code n'a pas pu s'ouvrir.",
    retry: "Réessayer",
    openError: "Impossible d'ouvrir Claude Code.",
  },
  notes: {
    tab: "Notes",
    listLabel: "Pages du carnet",
    search: "Chercher dans les notes",
    clearSearch: "Effacer la recherche",
    noMatch: (query: string) => `Aucune page ne contient « ${query} ».`,
    searchFailed: "Recherche impossible pour l'instant.",
    searchRetry: "Réessayer",
    pinned: "Épinglées",
    /** Under an empty « Épinglées »: a drop place on a large screen, a plain line on the phone. */
    pinnedEmptyWide: "Glisse une page ici pour l'épingler",
    pinnedEmptyPhone: "Aucune page épinglée",
    summaries: "Résumés de tâches",
    ungrouped: "Sans groupe",
    newPage: "Nouvelle page",
    newGroup: "Nouveau groupe",
    groupName: "Nom du groupe",
    groupMenu: (name: string) => `Actions du groupe ${name}`,
    /** Group « … »: a new page in this group. */
    newPageHere: "Nouvelle page ici",
    /** After a folded group's name: how many pages it hides. */
    pageCount: (n: number) => (n === 1 ? "1 page" : `${n} pages`),
    toggleGroup: (name: string, open: boolean) =>
      open ? `Replier ${name}` : `Déplier ${name}`,
    rename: "Renommer",
    renameGroup: "Renommer le groupe",
    deleteGroupTitle: (name: string) => `Supprimer le groupe « ${name} » ?`,
    deleteGroupText: "Les pages restent dans le carnet, sans groupe.",
    pageMenu: (title: string) => `Actions de la page ${title}`,
    pin: "Épingler",
    unpin: "Désépingler",
    moveTo: "Déplacer vers…",
    moveToLabel: (title: string) => `Déplacer « ${title} » vers`,
    duplicate: "Dupliquer",
    deleted: "Page supprimée",
    deletedElsewhere: "Cette page a été supprimée sur un autre appareil",
    untitled: "Sans titre",
    titleLabel: "Titre de la page",
    pageLabel: "Page du carnet",
    summaryBadge: "Résumé",
    /** Second line of a summary on the phone: « Résumé · 12 oct. ». */
    summaryLine: (date: string) => `Résumé · ${date}`,
    modified: (date: string) => `Modifiée le ${date}`,
    back: "Notes",
    backLabel: "Retour aux notes",
    emptyTitle: "Aucune note dans ce projet",
    emptyText:
      "Écris ici ce que tu veux retrouver plus tard : accès, décisions, liens…",
    emptyClaude:
      "Claude peut aussi y écrire : demande-lui “range ça dans les notes du projet”.",
    loadError: "Impossible d'afficher les notes.",
    pageError: "Impossible d'ouvrir cette page.",
    /** Large screen, a notebook with groups but no page: the right side. */
    noPageOpen: "Choisis une page ou crée-en une.",
    /** Under a page: the pages and tasks that link it. */
    mentionedIn: "Mentionné dans",
    /** Task panel: the pages that link the task. */
    mentionedInNotes: "Mentionné dans les notes",
    mentionPage: "Page",
    mentionTask: "Tâche",
    editor: {
      bodyLabel: "Texte de la page",
      placeholder: "Écris ici… « [[ » pour lier une page ou une tâche",
      toolbar: "Mise en forme",
      bold: "Gras",
      italic: "Italique",
      underline: "Souligné",
      strike: "Barré",
      highlight: "Surligné",
      heading1: "Titre 1",
      heading2: "Titre 2",
      /** Phone: one button that goes Titre 1 → Titre 2 → texte. */
      heading: "Titre",
      /** The phone's « Titre » button, with the level of the line now. */
      headingNow: (level: 0 | 1 | 2) =>
        `Titre (${level === 0 ? "texte normal" : `Titre ${level}`}). Changer le niveau`,
      bulletList: "Liste à puces",
      orderedList: "Liste numérotée",
      taskList: "Case à cocher",
      quote: "Citation",
      code: "Code",
      link: "Lien web",
      linkUrl: "Adresse du lien",
      linkUrlHint: "Vide pour retirer le lien",
      wikiLink: "Lier une page ou une tâche",
      undo: "Annuler",
      more: "Autres styles",
      hideKeyboard: "Masquer le clavier",
      linkSuggest: "Pages et tâches du projet",
      linkNone: "Aucune page ni tâche ne correspond",
      linkPages: "Pages",
      linkTasks: "Tâches",
      /** A link to a page or task that no longer exists. */
      linkDead: (label: string) => `${label} (introuvable)`,
      tooLong:
        "Page trop longue : elle n'est plus enregistrée. Raccourcis-la ou coupe-la en plusieurs pages.",
      draftConflict:
        "Cette page a été modifiée ailleurs. Ton texte trop long est resté sur cet appareil : lequel garder ?",
      draftResume: "Reprendre mon brouillon",
      draftKeepCurrent: "Garder la version actuelle",
      draftDropped: "Brouillon trop long abandonné",
      draftKept:
        "Page trop longue : ton texte est gardé sur cet appareil. Raccourcis-le pour l'enregistrer.",
    },
    /** Images in a page (plan task 8). */
    image: {
      add: "Ajouter une image",
      pickTitle: "Choisir des images",
      adding: "Ajout de l'image…",
      /** The image's button: what it shows and its width. */
      label: (name: string | null, width: number) =>
        `Image${name ? ` ${name}` : ""}, ${width} %. Changer la taille`,
      resize: "Redimensionner l'image",
      sizes: "Taille de l'image",
      size: (width: number) => `${width} %`,
      remove: "Retirer",
      /** Toast after « Retirer » (its « Annuler » puts the image back). */
      removed: "Image retirée",
      downloading: "Image en cours de téléchargement",
      /** No image has this id on this device, and the sync has nothing more to bring. */
      missing: "Image introuvable",
      unsupportedFormat: "Format d'image non pris en charge",
      open: "Ouvrir",
      onlyImages: "Seules les images vont dans une page",
      addError: "Impossible d'ajouter l'image.",
    },
    errors: {
      createPage: "Impossible de créer la page.",
      updatePage: "Impossible d'enregistrer la page.",
      movePage: "Impossible de déplacer la page.",
      deletePage: "Impossible de supprimer la page.",
      createGroup: "Impossible de créer le groupe.",
      updateGroup: "Impossible de renommer le groupe.",
      deleteGroup: "Impossible de supprimer le groupe.",
    },
  },

  chrono: {
    title: "Chrono",
    runningLabel: (time: string) => `Chrono : ${time}, en cours`,
    pausedLabel: (time: string) => `Chrono : ${time}, en pause`,
    running: (agent: Agent) =>
      `${agentName(agent)} travaille, le chrono tourne`,
    never: (agent: Agent) =>
      `Le chrono démarre tout seul quand ${agentName(agent)} travaille sur cette tâche.`,
    /** Why the chrono is paused (the last segment's stop reason). */
    paused: (reason: ChronoStop, agent: Agent): string =>
      ({
        waiting: `En pause : ${agentName(agent)} attend ta réponse, il repart quand tu réponds`,
        turn_ended: `En pause : ${agentName(agent)} a fini, il repart à ton prochain message`,
        session_closed: "En pause : session fermée",
        task_done: "Arrêté : tâche terminée",
        app_closed: "En pause : Taido a été fermé",
      })[reason],
    /** The last automatic segment was stopped with « Arrêter » (no stop reason). */
    pausedByHand: (agent: Agent) =>
      `Arrêté à la main : il repart au prochain tour de ${agentName(agent)}`,
    /** Journal lines. */
    eventTurnEnded: (agent: Agent) => `pause : ${agentName(agent)} a fini`,
    event: {
      started: "démarrage",
      waiting: "pause : attend ta réponse",
      turn_ended: "pause : fin du tour",
      session_closed: "pause : session fermée",
      task_done: "arrêt : tâche terminée",
      app_closed: "pause : Taido fermé",
      manual: "ajout à la main",
      running: "en cours",
      /** An automatic segment stopped with « Arrêter » (no stop reason). */
      stoppedByHand: "arrêté à la main",
    },
    journal: "Journal",
    addManual: "+ Ajouter du temps à la main",
    manualMinutes: "Durée (minutes)",
    manualNote: "Note (facultatif)",
    manualNotePlaceholder: "Réunion, appel, facture…",
    manualAdd: "Ajouter",
    manualCancel: "Annuler",
    manualInvalid: "Indique une durée de 1 à 1440 minutes.",
    deleteSegment: "Retirer ce temps",
    /** Stops a running segment by hand, from any device (docs/SYNC.md § 0.8). */
    stop: "Arrêter",
    stopped: "Chrono arrêté.",
    settingWaiting: "Compter l'attente de ta réponse dans le chrono",
    settingWaitingHint: (agent: Agent) =>
      `Par défaut, le chrono se met en pause quand ${agentName(agent)} attend ta réponse.`,
  },
} as const;

/** Replaces the agent's name in a text written for Claude. */
const toCodex = (text: string): string =>
  text.replaceAll("Claude Code", "Codex").replaceAll("Claude", "Codex");

/** The same texts with every string, and every string a function returns, rewritten. */
function mapTexts<T>(value: T, f: (text: string) => string): T {
  if (typeof value === "string") return f(value) as T;
  if (typeof value === "function") {
    return ((...args: unknown[]) =>
      mapTexts((value as (...a: unknown[]) => unknown)(...args), f)) as T;
  }
  if (Array.isArray(value)) return value.map((v) => mapTexts(v, f)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, mapTexts(v, f)]),
    ) as T;
  }
  return value;
}

/** Codex's own steps where Claude's would be wrong. */
const CODEX_TUTORIAL = (() => {
  const t = mapTexts(fr.tutorial, toCodex);
  return {
    ...t,
    claude: {
      ...t.claude,
      missing: `Codex n'est pas installé sur cet appareil. Installe-le (par exemple avec ${agentInstallCommand("codex")}), puis réessaie.`,
      notLoggedIn: `Codex n'est pas connecté. Lance ${agentLoginCommand("codex")} dans un terminal, puis réessaie.`,
    },
    talk: {
      ...t.talk,
      waiting:
        "Rouge : Codex attend ta réponse. Réponds-lui dans le terminal. La première fois, il demande s'il peut faire confiance au dossier, puis aux signaux de Taido : choisis « Trust and continue », puis « Trust all and continue » (flèche bas, puis Entrée).",
    },
  };
})();

/** The guide's texts for the agent chosen at the first launch. */
export const tutorialTexts = (agent: Agent): typeof fr.tutorial =>
  // Same shape, other strings: the literal types of `as const` do not hold for Codex's.
  agent === "codex"
    ? (CODEX_TUTORIAL as unknown as typeof fr.tutorial)
    : fr.tutorial;

export type Fr = typeof fr;
