import type { FileRecord, TagAssignment, TagOrigin, TagSuggestion } from '@assetforge/contracts';

/**
 * Tags are keyed by normalised name; `displayName` is kept from the first creation. An owner carries
 * a tag at most once: a manual add replaces an AI assignment of that tag on that owner, an AI add does
 * nothing when the owner already carries the tag, and a removal deletes the assignment whatever its origin.
 */
export interface TagRepository {
  /**
   * Tags with at least one assignment whose name starts with `prefix` (already normalised); most used first, then by
   * name. Assignments of files in the trash do not count.
   *
   * @param request the normalised prefix and the most tags to answer
   * @returns the suggestions
   */
  suggest(request: { prefix: string; limit: number }): Promise<TagSuggestion[]>;
  /**
   * One transaction: inserts the tag if its name is missing, then the assignment, applying the rule above.
   *
   * @param assignment the asset, the normalised name, the display name, the origin, the id for a new tag row and the
   *   time
   */
  addToAsset(assignment: {
    assetId: string;
    name: string;
    displayName: string;
    origin: TagOrigin;
    newId: string;
    now: string;
  }): Promise<void>;
  /**
   * Deletes the assignment whatever its origin; a missing tag or assignment is a no-op.
   *
   * @param assignment the asset and the normalised name
   */
  removeFromAsset(assignment: { assetId: string; name: string }): Promise<void>;
  /**
   * Like `addToAsset`, for a file.
   *
   * @param assignment the file, the normalised name, the display name, the origin, the id for a new tag row and the
   *   time
   */
  addToFile(assignment: {
    fileId: string;
    name: string;
    displayName: string;
    origin: TagOrigin;
    newId: string;
    now: string;
  }): Promise<void>;
  /**
   * Like `removeFromAsset`, for a file.
   *
   * @param assignment the file and the normalised name
   */
  removeFromFile(assignment: { fileId: string; name: string }): Promise<void>;
  /**
   * One transaction over a batch: throws `NotFoundError` for any unknown file, then
   * `ValidationFailedError` for any file that is not complete, then `InvalidOperationError` for any file in the
   * trash, before it writes anything; then
   * adds the assignment to every file by the rule above, reindexes each distinct
   * asset once and returns the records in request order.
   *
   * @param assignment the files, the normalised name, the display name, the origin, the id for a new tag row and the
   *   time
   * @returns the updated records in request order
   */
  addToFiles(assignment: {
    fileIds: readonly string[];
    name: string;
    displayName: string;
    origin: TagOrigin;
    newId: string;
    now: string;
  }): Promise<FileRecord[]>;
  /**
   * Like `addToFiles`, deleting the assignment whatever its origin; a file without it is left alone.
   *
   * @param assignment the files and the normalised name
   * @returns the updated records in request order
   */
  removeFromFiles(assignment: { fileIds: readonly string[]; name: string }): Promise<FileRecord[]>;
  /**
   * The tags an asset carries itself.
   *
   * @param assetId the asset
   * @returns the assignments by name, then origin
   */
  listForAsset(assetId: string): Promise<TagAssignment[]>;
  /**
   * The tag with this normalised name: its display name, the assets that carry it themselves, the files not in the
   * trash and the prompts that carry it.
   *
   * @param name the normalised name
   * @returns the display name and the three counts; null without a tag row
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
   *
   * @param rename the source name, the target name and display name, and whether an existing target may be merged into
   * @returns whether the rename was a merge
   */
  rename(rename: { from: string; name: string; displayName: string; merge: boolean }): Promise<{ merged: boolean }>;
}
