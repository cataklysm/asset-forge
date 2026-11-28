import type { FileRecord, TagAssignment } from '@assetforge/contracts';
import type { FileSelection } from './selection';

/** A finished rename or merge: the tag `from` is now `name`, spelled `displayName`. */
export interface TagRename {
  /** The normalised name before the rename. */
  from: string;
  /** The normalised name after it. */
  name: string;
  /** The display name the kept tag carries. */
  displayName: string;
}

/**
 * `from` becomes the new tag; an entry already named `name` gets the display name; two entries
 * collapse to one at the first position, manual when either was manual. The same array when
 * nothing changes.
 *
 * @param tags the tags of one owner
 * @param change the finished rename
 * @returns the renamed tags, or `tags` itself when nothing changes
 */
export function renameInTags(tags: readonly TagAssignment[], change: TagRename): readonly TagAssignment[] {
  const touched = (tag: TagAssignment) => tag.name === change.from || tag.name === change.name;
  const hits = tags.filter(touched);
  if (hits.length === 0) return tags;
  const origin = hits.some((tag) => tag.origin === 'manual') ? 'manual' : hits[0]!.origin;
  const merged: TagAssignment = { name: change.name, displayName: change.displayName, origin };
  if (hits.length === 1) {
    const [hit] = hits as [TagAssignment];
    if (hit.name === merged.name && hit.displayName === merged.displayName) return tags;
    return tags.map((tag) => (tag === hit ? merged : tag));
  }
  const first = tags.findIndex(touched);
  return tags.flatMap((tag, index) => (index === first ? [merged] : touched(tag) ? [] : [tag]));
}

/**
 * Applies a rename to the tags of one file record.
 *
 * @param file the record
 * @param change the finished rename
 * @returns a copy with renamed tags, or the same record when its tags are unchanged
 */
export function renameInRecord(file: FileRecord, change: TagRename): FileRecord {
  const tags = renameInTags(file.tags, change);
  return tags === file.tags ? file : { ...file, tags: [...tags] };
}

/**
 * Applies a rename to the records of a file selection.
 *
 * @param selection the selection
 * @param change the finished rename
 * @returns a copy with renamed records, or the same selection when no record changes
 */
export function renameInSelection(selection: FileSelection, change: TagRename): FileSelection {
  let selected: Map<string, FileRecord> | null = null;
  for (const [id, record] of selection.selected) {
    const next = renameInRecord(record, change);
    if (next === record) continue;
    selected ??= new Map(selection.selected);
    // Replacing an existing key keeps its position in the map.
    selected.set(id, next);
  }
  return selected === null ? selection : { ...selection, selected };
}

/** The display names of a filter's tags, by normalised name. */
export type TagLabels = Readonly<Record<string, string>>;

/**
 * Filter labels after a rename: the source's entry dropped, the kept tag spelled as renamed when the filter holds
 * it. The same object when nothing changes.
 *
 * @param labels the display names of a filter
 * @param names the filter's tag names after the rename
 * @param change the finished rename
 * @returns the renamed labels, or `labels` itself when nothing changes
 */
export function renameInLabels(labels: TagLabels, names: readonly string[], change: TagRename): TagLabels {
  const holds = names.includes(change.name);
  const stale = change.from !== change.name && change.from in labels;
  if (!stale && (!holds || labels[change.name] === change.displayName)) return labels;
  const next: Record<string, string> = { ...labels };
  delete next[change.from];
  if (holds) next[change.name] = change.displayName;
  return next;
}

/**
 * Filter names: `from` replaced by `name` in place, no duplicate. The same array when `from` is absent.
 *
 * @param names the tag names of a filter
 * @param change the finished rename
 * @returns the renamed names, or `names` itself when nothing changes
 */
export function renameInNames(names: readonly string[], change: TagRename): readonly string[] {
  if (!names.includes(change.from) || change.from === change.name) return names;
  const replaced = names.map((name) => (name === change.from ? change.name : name));
  return replaced.filter((name, index) => replaced.indexOf(name) === index);
}
