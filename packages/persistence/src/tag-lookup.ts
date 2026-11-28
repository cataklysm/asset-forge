import { inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { tag } from './schema.js';

// The lookup of tags by their normalised names, shared by the tag filters of the lists.

/** A handle that can read: the database or a transaction on it. */
type TagReader = Pick<BetterSQLite3Database, 'select'>;

/** A tag found by its name. */
export interface NamedTag {
  /** The tag's id. */
  id: string;
  /** The normalised name. */
  name: string;
  /** The name as it is shown. */
  displayName: string;
}

/**
 * The named tags that exist, in request order, each once, read in one statement; unknown names are left out.
 *
 * @param reader the caller's transaction
 * @param names the normalised names
 * @returns the tags
 */
export function existingTags(reader: TagReader, names: readonly string[]): NamedTag[] {
  const unique = [...new Set(names)];
  if (unique.length === 0) return [];
  const rows = reader
    .select({ id: tag.id, name: tag.name, displayName: tag.displayName })
    .from(tag)
    .where(inArray(tag.name, unique))
    .all();
  const byName = new Map(rows.map((row) => [row.name, row]));
  return unique.flatMap((name) => byName.get(name) ?? []);
}

/**
 * The tags of a tag filter in request order, each once; null when one does not exist, so nothing can match.
 *
 * @param reader the caller's transaction
 * @param names the normalised names
 * @returns the tags; null when one does not exist
 */
export function filterTags(reader: TagReader, names: readonly string[]): NamedTag[] | null {
  const tags = existingTags(reader, names);
  return tags.length < new Set(names).size ? null : tags;
}
