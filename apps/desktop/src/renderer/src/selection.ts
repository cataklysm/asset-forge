import type { FileRecord, TagAssignment } from '@assetforge/contracts';

/** The batch channels take at most this many file ids. */
export const MAX_SELECTION = 1000;

/** Selected files by id, in selection order; `anchor` is the index a shift range starts from. */
export interface FileSelection {
  readonly selected: ReadonlyMap<string, FileRecord>;
  readonly anchor: number | null;
}

export const NO_SELECTION: FileSelection = { selected: new Map(), anchor: null };

/** The item at a list index; null when it is not loaded. */
export type ItemAt = (index: number) => FileRecord | null;

/**
 * A plain click selects only the item, ctrl toggles it, and shift selects the loaded items
 * from the anchor to `index` in place of the selection. A click on an unloaded item is ignored.
 */
export function clickSelect(
  sel: FileSelection,
  index: number,
  itemAt: ItemAt,
  mods: { ctrl: boolean; shift: boolean },
): FileSelection {
  const item = itemAt(index);
  if (item === null) return sel;
  if (mods.shift && sel.anchor !== null) return selectRange(sel.anchor, index, itemAt);
  if (mods.ctrl) return toggleSelect(sel, index, itemAt);
  return { selected: new Map([[item.id, item]]), anchor: index };
}

/** Adds or removes one item and makes it the anchor; nothing is added beyond MAX_SELECTION. */
export function toggleSelect(sel: FileSelection, index: number, itemAt: ItemAt): FileSelection {
  const item = itemAt(index);
  if (item === null) return sel;
  const selected = new Map(sel.selected);
  if (selected.has(item.id)) selected.delete(item.id);
  else if (selected.size < MAX_SELECTION) selected.set(item.id, item);
  else return { selected: sel.selected, anchor: index };
  return { selected, anchor: index };
}

// Collected outward from the anchor, so a capped range keeps the items next to it; ordered by index.
function selectRange(anchor: number, index: number, itemAt: ItemAt): FileSelection {
  const step = index >= anchor ? 1 : -1;
  const picked: [number, FileRecord][] = [];
  for (let i = anchor; picked.length < MAX_SELECTION; i += step) {
    const item = itemAt(i);
    if (item !== null) picked.push([i, item]);
    if (i === index) break;
  }
  picked.sort((a, b) => a[0] - b[0]);
  return { selected: new Map(picked.map(([, item]) => [item.id, item])), anchor };
}

/** The first MAX_SELECTION of `items`. */
export function selectAll(items: readonly FileRecord[]): FileSelection {
  return { selected: new Map(items.slice(0, MAX_SELECTION).map((f) => [f.id, f])), anchor: null };
}

/** Replaces selected records by fresh ones with the same id; others in `records` are ignored. */
export function refreshSelected(sel: FileSelection, records: readonly FileRecord[]): FileSelection {
  let selected: Map<string, FileRecord> | null = null;
  for (const record of records) {
    if (!sel.selected.has(record.id)) continue;
    selected ??= new Map(sel.selected);
    selected.set(record.id, record);
  }
  return selected === null ? sel : { ...sel, selected };
}

export function dropSelected(sel: FileSelection, ids: Iterable<string>): FileSelection {
  let selected: Map<string, FileRecord> | null = null;
  for (const id of ids) {
    if (!sel.selected.has(id)) continue;
    selected ??= new Map(sel.selected);
    selected.delete(id);
  }
  return selected === null ? sel : { ...sel, selected };
}

/** The selected files a batch can act on: completely imported ones, in selection order. */
export function eligibleFiles(sel: FileSelection): FileRecord[] {
  return [...sel.selected.values()].filter((f) => f.status === 'complete');
}

/** The tags every one of `files` carries, as the first file holds them; [] for no files. */
export function sharedTags(files: readonly FileRecord[]): TagAssignment[] {
  const [first, ...rest] = files;
  if (first === undefined) return [];
  const others = rest.map((f) => new Set(f.tags.map((t) => t.name)));
  return first.tags.filter((t) => others.every((names) => names.has(t.name)));
}
