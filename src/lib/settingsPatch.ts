/**
 * `update_settings` takes a full `SettingsPatch` where `null` means « unchanged »; this builds
 * one from the fields that change (Réglages, first-launch guide).
 */

import type { SettingsPatch } from "../bindings";

const NO_CHANGE: SettingsPatch = {
  theme: null,
  colorTheme: null,
  syncTheme: null,
  panelWidth: null,
  showCompleted: null,
  editor: null,
  claudePath: null,
  summarizeSessions: null,
  notifications: null,
  tutorial: null,
  chronoCountsWaiting: null,
  defaultAgent: null,
  codexPath: null,
  agentChosen: null,
  voiceSpaceHold: null,
};

/** A full `SettingsPatch` that changes only the given fields. */
export function settingsPatch(change: Partial<SettingsPatch>): SettingsPatch {
  return { ...NO_CHANGE, ...change };
}
