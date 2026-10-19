/** Section menu (⋯ on hover of its header, right click): Renommer, Supprimer (+ Sous-dossier…). */

import { confirmDialog, promptDialog } from "../../components/Dialog";
import type { MenuItem } from "../../components/Menu";
import { t } from "../../i18n";
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
    title: t.section.renameTitle,
    fields: [
      {
        name: "name",
        label: t.section.nameLabel,
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
      action: t.errors.action.updateSection,
    },
  });
}

async function editSubpath(section: SectionRef) {
  await promptDialog({
    title: t.section.subpathTitle,
    fields: [
      {
        name: "subpath",
        label: t.section.subpathLabel,
        initial: section.subpath ?? "",
        placeholder: t.section.subpathPlaceholder,
        mono: true,
        help: t.section.subpathHelp,
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
      action: t.errors.action.updateSection,
    },
  });
}

export async function deleteSection(section: SectionRef) {
  const ok = await confirmDialog({
    title: t.section.deleteTitle(section.name),
    message: t.section.deleteMessage,
    confirmLabel: t.section.deleteConfirm,
  });
  if (ok) {
    await run(
      commands.deleteSection(section.id),
      t.errors.action.deleteSection,
    );
  }
}

export function sectionMenuItems(section: SectionRef): MenuItem[] {
  return [
    {
      label: t.section.menuRename,
      onSelect: () => {
        void renameSection(section);
      },
    },
    // The sub-folder only matters once terminals exist.
    ...(features.terminals
      ? [
          {
            label: t.section.menuSubpath,
            onSelect: () => {
              void editSubpath(section);
            },
          },
        ]
      : []),
    { separator: true },
    {
      label: t.section.menuDelete,
      onSelect: () => {
        void deleteSection(section);
      },
    },
  ];
}
