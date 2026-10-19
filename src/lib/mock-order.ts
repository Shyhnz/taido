/** Position helpers shared by the mock backend and the notebook (core `db/positions.rs`). */

/** Like the core's `ORDER BY position, id`: ties are broken by id on every device. */
export const byPosition = <T extends { position: number; id: string }>(
  a: T,
  b: T,
) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Below this gap the siblings are renumbered before inserting (core `positions::MIN_GAP`). */
export const MIN_GAP = 1e-6;

/** max + 1 over `items` (1 when empty), like the core's `positions::append`. */
export const appendPosition = (
  items: readonly { position: number }[],
): number => items.reduce((max, x) => Math.max(max, x.position), 0) + 1;

/**
 * Puts `item` at `index` among `siblings` (the item itself excluded), like the core's
 * `db/positions.rs`: only the moved item changes — past
 * the end = max + 1, first = first - 1, else the midpoint of its neighbours; the siblings are
 * renumbered 1..n only when that gap falls under `MIN_GAP`. Writing one row per move keeps the
 * sync's whole-row "last writer wins" from overwriting siblings edited on another device.
 */
export function placeAt<T extends { id: string; position: number }>(
  siblings: T[],
  item: T,
  index: number | null,
): void {
  const others = siblings.filter((s) => s.id !== item.id).sort(byPosition);
  if (index === null || index >= others.length) {
    item.position = appendPosition(others);
    return;
  }
  const at = Math.max(0, index);
  if (at === 0) {
    item.position = others[0].position - 1;
    return;
  }
  if (others[at].position - others[at - 1].position < MIN_GAP) {
    others.forEach((s, i) => {
      s.position = i + 1;
    });
  }
  item.position = (others[at - 1].position + others[at].position) / 2;
}
