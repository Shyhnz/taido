/** Shared setup of the terminal tests (mock backend, fake xterm). */

import { mockBackend } from "../../lib/ipc";

export function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

export const FOLDER = "/Users/user/Projets/globex";

/** A task in a project linked to a folder: terminals open without asking. */
export async function taskWithFolder(title = "Exporter le CSV") {
  const subject = await backend().commands.createSubject({
    name: "Globex",
    color: null,
    rootPath: FOLDER,
    parentId: null,
  });
  return backend().commands.createTask({
    title,
    description: "Filtrable par date.",
    subjectId: subject.id,
    sectionId: null,
    dueDate: null,
    dueTime: null,
  });
}

/** A task of « Sans projet », without folder. */
export async function taskWithoutFolder(title = "Sans dossier") {
  return backend().commands.createTask({
    title,
    description: null,
    subjectId: null,
    sectionId: null,
    dueDate: null,
    dueTime: null,
  });
}

export function openRaw(
  taskId: string,
  kind: "agent" | "shell" | "command",
  command: string | null = null,
) {
  return backend().commands.openTerminal({
    taskId,
    kind,
    agent: null,
    command,
    initialPrompt: null,
    permissionMode: null,
    addTaskContext: null,
    cols: 120,
    rows: 32,
  });
}
