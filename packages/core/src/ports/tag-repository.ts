import type { FileRecord, TagAssignment, TagOrigin, TagSuggestion } from '@assetforge/contracts';

/**
 * Tags are keyed by normalised name; `displayName` is kept from the first creation. An owner carries
 * a tag at most once: a manual add replaces an AI assignment of that tag on that owner, an AI add does
 * nothing when the owner already carries the tag, and a removal deletes the assignment whatever its origin.
 */
export interface TagRepository {
  /** Tags with at least one assignment whose name starts with `prefix` (already normalised); most used first, then by name. */
  suggest(q: { prefix: string; limit: number }): Promise<TagSuggestion[]>;
  /** One transaction: inserts the tag if its name is missing, then the assignment, applying the rule above. */
  addToAsset(r: { assetId: string; name: string; displayName: string; origin: TagOrigin; newId: string; now: string }): Promise<void>;
  /** Deletes the assignment whatever its origin; a missing tag or assignment is a no-op. */
  removeFromAsset(r: { assetId: string; name: string }): Promise<void>;
  addToFile(r: { fileId: string; name: string; displayName: string; origin: TagOrigin; newId: string; now: string }): Promise<void>;
  removeFromFile(r: { fileId: string; name: string }): Promise<void>;
  /**
   * One transaction over a batch: throws `NotFoundError` for any unknown file and
   * `ValidationFailedError` for any file that is not complete before it writes anything; then
   * adds the assignment to every file by the rule above, reindexes each distinct
   * asset once and returns the records in request order.
   */
  addToFiles(r: { fileIds: readonly string[]; name: string; displayName: string; origin: TagOrigin; newId: string; now: string }): Promise<FileRecord[]>;
  /** Like `addToFiles`, deleting the assignment whatever its origin; a file without it is left alone. */
  removeFromFiles(r: { fileIds: readonly string[]; name: string }): Promise<FileRecord[]>;
  listForAsset(assetId: string): Promise<TagAssignment[]>; // by name, then origin
  /**
   * The tag with this normalised name: its display name, the assets that carry it themselves, the files not in the
   * trash and the prompts that carry it. Null without a tag row.
   */
  usage(name: string): Promise<{ displayName: string; assets: number; files: number; prompts: number } | null>;
  /**
   * One transaction. `from` and `name` are normalised. Throws NotFoundError('Tag does not exist') without a tag `from`.
   * from === name: sets the display name. Otherwise, no tag `name`: renames the row (name and display name).
   * Otherwise a merge: throws InvalidOperationError('A tag with this name already exists') unless `merge`; moves every
   * link of `from` to `name` (an owner carrying both keeps one link, manual when either was manual, with the earlier
   * createdAt), sets the target's display name and deletes the source row. Prompt links move the same way (prompt tags
   * have no origin) and leave the prompt's updated_at alone.
   * Except for from === name: rewrites waiting proposals that hold `from` and reindexes the assets affected.
   */
  rename(r: { from: string; name: string; displayName: string; merge: boolean }): Promise<{ merged: boolean }>;
}
