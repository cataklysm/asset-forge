import type { FileRecord, TagAssignment } from '@assetforge/contracts';
import type { FileSelection } from './selection';

/** A finished rename or merge: the tag `from` is now `name`, spelled `displayName`. */
export interface TagRename {
  from: string;
  name: string;
  displayName: string;
}

/**
 * `from` becomes the new tag; an entry already named `name` gets the display name; two entries
 * collapse to one at the first position, manual when either was manual. The same array when
 * nothing changes.
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

/** The same record when its tags are unchanged. */
export function renameInRecord(file: FileRecord, change: TagRename): FileRecord {
  const tags = renameInTags(file.tags, change);
  return tags === file.tags ? file : { ...file, tags: [...tags] };
}

/** The same selection when no record changes. */
export function renameInSelection(sel: FileSelection, change: TagRename): FileSelection {
  let selected: Map<string, FileRecord> | null = null;
  for (const [id, record] of sel.selected) {
    const next = renameInRecord(record, change);
    if (next === record) continue;
    selected ??= new Map(sel.selected);
    // Replacing an existing key keeps its position in the map.
    selected.set(id, next);
  }
  return selected === null ? sel : { ...sel, selected };
}

/** Filter names: `from` replaced by `name` in place, no duplicate. The same array when `from` is absent. */
export function renameInNames(names: readonly string[], change: TagRename): readonly string[] {
  if (!names.includes(change.from) || change.from === change.name) return names;
  const replaced = names.map((name) => (name === change.from ? change.name : name));
  return replaced.filter((name, index) => replaced.indexOf(name) === index);
}
