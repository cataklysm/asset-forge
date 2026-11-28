import type { FileRecord, TagAssignment } from '@assetforge/contracts';

// The multi-select of a file list: click, ctrl and shift selection, refreshing and dropping records, and what a
// batch can act on.

/** The batch channels take at most this many file ids. */
export const MAX_SELECTION = 1000;

/** Selected files by id, in selection order; `anchor` is the index a shift range starts from. */
export interface FileSelection {
  /** The selected records by id, in selection order. */
  readonly selected: ReadonlyMap<string, FileRecord>;
  /** The index a shift range starts from; null when there is none. */
  readonly anchor: number | null;
}

/** Nothing selected. */
export const NO_SELECTION: FileSelection = { selected: new Map(), anchor: null };

/** The item at a list index; null when it is not loaded. */
export type ItemAt = (index: number) => FileRecord | null;

/**
 * A plain click selects only the item, ctrl toggles it, and shift selects the loaded items
 * from the anchor to `index` in place of the selection. A click on an unloaded item is ignored.
 *
 * @param selection the current selection
 * @param index the clicked index
 * @param itemAt the loaded item at an index
 * @param mods the held modifier keys
 * @returns the new selection; the same one for an unloaded item
 */
export function clickSelect(
  selection: FileSelection,
  index: number,
  itemAt: ItemAt,
  mods: { ctrl: boolean; shift: boolean },
): FileSelection {
  const item = itemAt(index);
  if (item === null) return selection;
  if (mods.shift && selection.anchor !== null) return selectRange(selection.anchor, index, itemAt);
  if (mods.ctrl) return toggleSelect(selection, index, itemAt);
  return { selected: new Map([[item.id, item]]), anchor: index };
}

/**
 * Adds or removes one item and makes it the anchor; nothing is added beyond MAX_SELECTION.
 *
 * @param selection the current selection
 * @param index the toggled index
 * @param itemAt the loaded item at an index
 * @returns the new selection; the same one for an unloaded item
 */
export function toggleSelect(selection: FileSelection, index: number, itemAt: ItemAt): FileSelection {
  const item = itemAt(index);
  if (item === null) return selection;
  const selected = new Map(selection.selected);
  if (selected.has(item.id)) selected.delete(item.id);
  else if (selected.size < MAX_SELECTION) selected.set(item.id, item);
  else return { selected: selection.selected, anchor: index };
  return { selected, anchor: index };
}

/**
 * The loaded items from the anchor to `index`. Collected outward from the anchor, so a capped range keeps the
 * items next to it; ordered by index.
 *
 * @param anchor the index the range starts from
 * @param index the index it ends at
 * @param itemAt the loaded item at an index
 * @returns the range as the selection, with the same anchor
 */
function selectRange(anchor: number, index: number, itemAt: ItemAt): FileSelection {
  const step = index >= anchor ? 1 : -1;
  const picked: [number, FileRecord][] = [];
  for (let i = anchor; picked.length < MAX_SELECTION; i += step) {
    const item = itemAt(i);
    if (item !== null) picked.push([i, item]);
    if (i === index) break;
  }
  picked.sort((first, second) => first[0] - second[0]);
  return { selected: new Map(picked.map(([, item]) => [item.id, item])), anchor };
}

/**
 * The first MAX_SELECTION of `items`.
 *
 * @param items the loaded items
 * @returns them as the selection, without an anchor
 */
export function selectAll(items: readonly FileRecord[]): FileSelection {
  return { selected: new Map(items.slice(0, MAX_SELECTION).map((file) => [file.id, file])), anchor: null };
}

/**
 * Replaces selected records by fresh ones with the same id; others in `records` are ignored.
 *
 * @param selection the current selection
 * @param records fresh records
 * @returns the new selection; the same one when none of them is selected
 */
export function refreshSelected(selection: FileSelection, records: readonly FileRecord[]): FileSelection {
  let selected: Map<string, FileRecord> | null = null;
  for (const record of records) {
    if (!selection.selected.has(record.id)) continue;
    selected ??= new Map(selection.selected);
    selected.set(record.id, record);
  }
  return selected === null ? selection : { ...selection, selected };
}

/**
 * Removes records from the selection.
 *
 * @param selection the current selection
 * @param ids the ids to remove
 * @returns the new selection; the same one when none of them is selected
 */
export function dropSelected(selection: FileSelection, ids: Iterable<string>): FileSelection {
  let selected: Map<string, FileRecord> | null = null;
  for (const id of ids) {
    if (!selection.selected.has(id)) continue;
    selected ??= new Map(selection.selected);
    selected.delete(id);
  }
  return selected === null ? selection : { ...selection, selected };
}

/** Tooltip of a batch action that has no eligible file to act on. */
export const NONE_ELIGIBLE = 'None of the selected files is completely imported';

/**
 * The selected files a batch can act on: completely imported ones, in selection order.
 *
 * @param selection the selection
 * @returns the complete files
 */
export function eligibleFiles(selection: FileSelection): FileRecord[] {
  return [...selection.selected.values()].filter((file) => file.status === 'complete');
}

/**
 * The tags every one of `files` carries, as the first file holds them.
 *
 * @param files the files
 * @returns the shared tags; [] for no files
 */
export function sharedTags(files: readonly FileRecord[]): TagAssignment[] {
  const [first, ...rest] = files;
  if (first === undefined) return [];
  const others = rest.map((file) => new Set(file.tags.map((tag) => tag.name)));
  return first.tags.filter((tag) => others.every((names) => names.has(tag.name)));
}
