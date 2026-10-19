/**
 * Feature flags. UI that is not ready is hidden behind these
 * flags, never shown disabled nor labelled "Bientôt". Flip a flag when its feature ships.
 *
 * The installable web app (PWA, `IS_MOBILE`) is the same UI with every
 * Mac-only feature off (docs/SYNC.md § Mobile app).
 */

import { IS_MOBILE } from "./target";

export interface Features {
  /** Terminals, Claude Code launch, working folder, git branch, "Ouvrir dans…". */
  readonly terminals: boolean;
  /** ⌘K search (magnifier in the sidebar header). */
  readonly search: boolean;
  /** Focus mode of the task panel (⌘⇧F). */
  readonly focusMode: boolean;
  /** Claude's state on the rows (second line) and in the panel. */
  readonly states: boolean;
  /** Folders on disk (« Dossier de l'appli », « Relier à un dossier… », « Ouvrir le dossier »). */
  readonly folders: boolean;
  /** The task's journal and Claude session history in the panel. */
  readonly journal: boolean;
  /** Drag and drop of tasks, subtasks and projects with a mouse/trackpad (and ⌥↑/⌥↓). */
  readonly dragAndDrop: boolean;
  /**
   * Web app (phone or computer): fingers drag too, with a long press on the row, project or
   * group header; the pointer drag then ignores touch pointers (src/features/dnd/sensors.ts).
   */
  readonly touchDrag: boolean;
  /** Keyboard shortcuts and their hints (⌘K, ⌘N, ⌘,…). */
  readonly shortcuts: boolean;
  /** First-launch guide: Mac only, Claude does not run on the phone. */
  readonly tutorial: boolean;
  /** « Demander au projet » (Pro): the agent runs on the Mac. */
  readonly ask: boolean;
}

const desktop: Features = {
  terminals: true,
  search: true,
  focusMode: true,
  states: true,
  folders: true,
  journal: true,
  dragAndDrop: true,
  touchDrag: false,
  shortcuts: true,
  tutorial: true,
  ask: true,
};

const mobile: Features = {
  terminals: false,
  search: true,
  focusMode: false,
  states: false,
  folders: false,
  journal: false,
  dragAndDrop: true,
  touchDrag: true,
  shortcuts: false,
  tutorial: false,
  ask: false,
};

export const features: Features = IS_MOBILE ? mobile : desktop;
