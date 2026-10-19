import { showError } from "../components/Toast";
import { t } from "../i18n";
import { errorKind, errorMessage } from "./ipc";

/**
 * Readable French text of a rejected command, from its `kind`. The raw (English) message of
 * the core is never shown; it goes to the console.
 */
export function readableError(error: unknown, action?: string): string {
  const kind = errorKind(error);
  if (action) return t.errors.withAction(action, kind);
  return kind ? t.errors.kind[kind] : t.errors.unknown;
}

/**
 * Awaits a command and shows its error in a toast. Resolves to `undefined` on failure.
 * `action` is the first half of the toast (`t.errors.action.*`).
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
