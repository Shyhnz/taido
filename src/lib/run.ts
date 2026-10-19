import { showError } from "../components/Toast";
import { fr } from "../i18n/fr";
import { errorKind, errorMessage } from "./ipc";

/**
 * Readable French text of a rejected command, from its `kind`. The raw (English) message of
 * the core is never shown; it goes to the console.
 */
export function readableError(error: unknown, action?: string): string {
  const kind = errorKind(error);
  if (action) return fr.errors.withAction(action, kind);
  return kind ? fr.errors.kind[kind] : fr.errors.unknown;
}

/**
 * Awaits a command and shows its error in a toast. Resolves to `undefined` on failure.
 * `action` is the first half of the toast (`fr.errors.action.*`).
 */
export async function run<T>(
  promise: Promise<T>,
  action?: string,
): Promise<T | undefined> {
  try {
    return await promise;
  } catch (error) {
    console.error(errorMessage(error), error);
    showError(readableError(error, action));
    return undefined;
  }
}
