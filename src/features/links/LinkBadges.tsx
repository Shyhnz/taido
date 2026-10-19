/**
 * What a task row or a kanban card shows of its attachments and relations (Taido V2.3,
 * minimal icons 2026-10-13): a lock « bloquée par » (brick orange, like an overdue date: it
 * waits on something), a stop sign « bloque » (red, like Linear), a link « liée à » (yellow),
 * each with its count, then « 📎 3 ». The words stay in the tooltip and for screen readers.
 * In a task row (`inRow`) the relation icons come first (`order-first`) and, marked
 * `data-relation`, are the last ones hidden on a narrow row (useFitBadges).
 */

import {
  Link2,
  Lock,
  type LucideIcon,
  OctagonMinus,
  Paperclip,
} from "lucide-react";
import type { TaskRow } from "../../bindings";
import { t } from "../../i18n";

export function LinkBadges({
  row,
  inRow = false,
}: {
  row: TaskRow;
  inRow?: boolean;
}) {
  const first = inRow ? "order-first" : "";
  return (
    <>
      {row.blockedBy !== null && (
        <Badge
          Icon={Lock}
          count={row.blockedByCount}
          label={t.relations.rowBlockedBy(row.blockedBy, row.blockedByCount)}
          className={`text-due-overdue ${first}`}
          data-blocked
          data-relation
        />
      )}
      {row.blocksCount > 0 && (
        <Badge
          Icon={OctagonMinus}
          count={row.blocksCount}
          label={t.relations.rowBlocks(row.blocksCount)}
          className={`text-relation-blocks ${first}`}
          data-relation
        />
      )}
      {row.relatedCount > 0 && (
        <Badge
          Icon={Link2}
          count={row.relatedCount}
          label={t.relations.rowRelated(row.relatedCount)}
          className={`text-relation-related ${first}`}
          data-relation
        />
      )}
      {row.attachmentCount > 0 && (
        <Badge
          Icon={Paperclip}
          count={row.attachmentCount}
          label={t.attachments.rowCount(row.attachmentCount)}
          className=""
        />
      )}
    </>
  );
}

function Badge({
  Icon,
  count,
  label,
  className,
  ...data
}: {
  Icon: LucideIcon;
  count: number;
  label: string;
  className: string;
  "data-blocked"?: boolean;
  "data-relation"?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 tabular-nums ${className}`}
      title={label}
      {...data}
    >
      <Icon size={12} aria-hidden />
      <span aria-hidden>{count}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
