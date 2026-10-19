/**
 * Header of a notebook block (« Épinglées », a group, « Résumés de tâches »): small capitals
 * like the sections, a fold chevron (remembered), and for a real group a « … » menu and, on
 * a large screen, a double click to rename it in place (like a project in the sidebar).
 */

import { ChevronDown, ChevronRight, Ellipsis } from "lucide-react";
import type { NoteGroup } from "../../bindings";
import { openContextMenu, openMenuAt } from "../../components/Menu";
import { t } from "../../i18n";
import { useUi } from "../../stores/ui";
import { InlineNameInput } from "../sidebar/Sidebar";
import { groupMenuItems, renameNoteGroup, useGroupRename } from "./noteActions";

export function NoteGroupHeader({
  name,
  foldKey,
  group,
  wide,
  count = 0,
}: {
  name: string;
  /** Pages of the block (shown after the name while it is folded). */
  count?: number;
  foldKey: string;
  /** A real group (renamed, deleted); `null` for the two fixed blocks. */
  group: NoteGroup | null;
  /** Mac and large screens: rename in place, « … » on hover. */
  wide: boolean;
}) {
  const open = useUi((s) => s.foldedNoteGroups[foldKey] !== true);
  const toggle = useUi((s) => s.toggleNoteGroup);
  const renaming = useGroupRename(
    (s) => group !== null && s.renamingId === group.id,
  );
  const stopRename = () => useGroupRename.setState({ renamingId: null });
  const Chevron = open ? ChevronDown : ChevronRight;
  const menuLabel = t.notes.groupMenu(name);

  if (group && renaming) {
    return (
      <div className="py-1">
        <InlineNameInput
          label={t.notes.groupName}
          initial={group.name}
          onCancel={stopRename}
          onCommit={async (value) => {
            const ok =
              value.trim() === group.name ||
              (await renameNoteGroup(group.id, value));
            if (ok) stopRename();
            return ok;
          }}
        />
      </div>
    );
  }

  const toggleLabel = t.notes.toggleGroup(name, open);
  // Folded: how many pages it hides, after its name.
  const hidden =
    !open && count > 0 ? (
      <span className="shrink-0 pl-1.5 text-[11.5px] font-normal tracking-normal text-text-3 normal-case tabular-nums">
        {t.notes.pageCount(count)}
      </span>
    ) : null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: right click mirrors the « … » button
    <div
      onContextMenu={
        group
          ? (e) => openContextMenu(e, groupMenuItems(group, wide), menuLabel)
          : undefined
      }
      className={`group/header flex items-center gap-0.5 ${wide ? "h-8" : "h-11"}`}
    >
      {wide ? (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-label={toggleLabel}
            onClick={() => toggle(foldKey)}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text"
          >
            <Chevron size={14} aria-hidden />
          </button>
          <h3
            onDoubleClick={
              group
                ? () => useGroupRename.setState({ renamingId: group.id })
                : undefined
            }
            className="flex min-w-0 flex-1 items-baseline text-[11.5px] font-semibold tracking-[0.06em] text-text-2 uppercase select-none"
          >
            <span className="min-w-0 truncate">{name}</span>
            {hidden}
          </h3>
        </>
      ) : (
        // Phone: the chevron and the name are one target (like « Terminées »).
        <h3 className="flex min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={open}
            aria-label={toggleLabel}
            onClick={() => toggle(foldKey)}
            className="flex h-11 min-w-0 flex-1 items-center gap-1 rounded-md pr-2 text-left text-text-2"
          >
            <span className="inline-flex w-9 shrink-0 justify-center text-text-3">
              <Chevron size={14} aria-hidden />
            </span>
            <span className="min-w-0 truncate text-[11.5px] font-semibold tracking-[0.06em] uppercase">
              {name}
            </span>
            {hidden}
          </button>
        </h3>
      )}
      {group && (
        <button
          type="button"
          aria-label={menuLabel}
          title={t.common.more}
          onClick={(e) =>
            openMenuAt(
              e.currentTarget,
              groupMenuItems(group, wide),
              menuLabel,
              true,
            )
          }
          // Hidden until hovered only where there is a hover (a touch screen always shows it).
          className={`inline-flex shrink-0 items-center justify-center rounded-md text-text-2 hover:bg-hover hover:text-text ${
            wide
              ? "h-6 w-6 [@media(hover:hover)]:opacity-0 group-hover/header:opacity-100 focus-visible:opacity-100"
              : "h-11 w-11"
          }`}
        >
          <Ellipsis size={16} aria-hidden />
        </button>
      )}
    </div>
  );
}
