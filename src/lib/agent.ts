/**
 * The agent ⌘T and the main button launch (Réglages › Agents): every
 * text that names a tool without a session at hand follows it, and changes as soon as the
 * setting does.
 */

import type { Agent } from "../bindings";
import { useSettings } from "./queries";

export function useDefaultAgent(): Agent {
  return useSettings().data?.defaultAgent ?? "claude";
}
