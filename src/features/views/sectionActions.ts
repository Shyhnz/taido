/** Section menu (⋯ on hover of its header, right click): Renommer, Supprimer (+ Sous-dossier…). */

import { confirmDialog, promptDialog } from "../../components/Dialog";
import type { MenuItem } from "../../components/Menu";
import { fr } from "../../i18n/fr";
import { features } from "../../lib/features";
import { commands } from "../../lib/ipc";
import { run } from "../../lib/run";

interface SectionRef {
  id: string;
  name: string;
  subpath: string | null;
}

export async function renameSection(section: SectionRef) {
  await promptDialog({
    title: fr.section.renameTitle,
    fields: [
      {
        name: "name",
        label: fr.section.nameLabel,
        initial: section.name,
        required: true,
      },
    ],
    // Errors stay in the dialog with the typed name (audit B3).
    submit: {
      run: (values) =>
        commands.updateSection({
          id: section.id,
          name: values.name,
          subpath: null,
        }),
      action: fr.errors.action.updateSection,
    },
  });
}

async function editSubpath(section: SectionRef) {
  await promptDialog({
    title: fr.section.subpathTitle,
    fields: [
      {
        name: "subpath",
        label: fr.section.subpathLabel,
        initial: section.subpath ?? "",
        placeholder: fr.section.subpathPlaceholder,
        mono: true,
        help: fr.section.subpathHelp,
      },
    ],
    // An empty subfolder clears it (`Some("")`).
    submit: {
      run: (values) =>
        commands.updateSection({
          id: section.id,
          name: null,
          subpath: values.subpath.trim(),
        }),
      action: fr.errors.action.updateSection,
    },
  });
}

export async function deleteSection(section: SectionRef) {
  const ok = await confirmDialog({
    title: fr.section.deleteTitle(section.name),
    message: fr.section.deleteMessage,
    confirmLabel: fr.section.deleteConfirm,
  });
  if (ok) {
    await run(
      commands.deleteSection(section.id),
      fr.errors.action.deleteSection,
    );
  }
}

export function sectionMenuItems(section: SectionRef): MenuItem[] {
  return [
    {
      label: fr.section.menuRename,
      onSelect: () => {
        void renameSection(section);
      },
    },
    // The sub-folder only matters once terminals exist.
    ...(features.terminals
      ? [
          {
            label: fr.section.menuSubpath,
            onSelect: () => {
              void editSubpath(section);
            },
          },
        ]
      : []),
    { separator: true },
    {
      label: fr.section.menuDelete,
      onSelect: () => {
        void deleteSection(section);
      },
    },
  ];
}
