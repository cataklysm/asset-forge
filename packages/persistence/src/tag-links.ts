import type { TagOrigin } from '@assetforge/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { assetTag, fileTag, tag } from './schema.js';

// The tag rows and the links of assets and files to them.

/** A handle that can read, insert and delete: the database or a transaction on it. */
type LinkWriter = Pick<BetterSQLite3Database, 'insert' | 'delete' | 'select'>;

/**
 * Inserts the tag unless its name exists.
 *
 * @param transaction the caller's transaction
 * @param newTag the normalised name, the display name, the id for a new row and the time
 * @returns the id of the tag with that name
 */
export function ensureTag(
  transaction: Pick<BetterSQLite3Database, 'insert' | 'select'>,
  newTag: { name: string; displayName: string; newId: string; now: string },
): string {
  transaction
    .insert(tag)
    .values({ id: newTag.newId, name: newTag.name, displayName: newTag.displayName, createdAt: newTag.now })
    .onConflictDoNothing({ target: tag.name })
    .run();
  return transaction.select({ id: tag.id }).from(tag).where(eq(tag.name, newTag.name)).get()!.id;
}

/**
 * Links the tag to the asset. An owner carries a tag at most once and manual wins: a manual add replaces an ai link,
 * an ai add yields to any link.
 *
 * @param transaction the caller's transaction
 * @param assetId the asset
 * @param tagId the tag
 * @param origin manual or ai
 * @param now the time of a new link
 * @returns nothing
 */
export function linkAssetTag(transaction: LinkWriter, assetId: string, tagId: string, origin: TagOrigin, now: string): void {
  if (origin === 'manual') {
    transaction
      .delete(assetTag)
      .where(and(eq(assetTag.assetId, assetId), eq(assetTag.tagId, tagId), eq(assetTag.origin, 'ai')))
      .run();
  }
  const carried = transaction
    .select({ tagId: assetTag.tagId })
    .from(assetTag)
    .where(and(eq(assetTag.assetId, assetId), eq(assetTag.tagId, tagId)))
    .get();
  if (!carried) transaction.insert(assetTag).values({ assetId, tagId, origin, createdAt: now }).run();
}

/**
 * Same rule as `linkAssetTag`, for each file of the list.
 *
 * @param transaction the caller's transaction
 * @param fileIds the files; a repeated id counts once
 * @param tagId the tag
 * @param origin manual or ai
 * @param now the time of a new link
 * @returns nothing
 */
export function linkFileTags(
  transaction: LinkWriter,
  fileIds: readonly string[],
  tagId: string,
  origin: TagOrigin,
  now: string,
): void {
  const ids = [...new Set(fileIds)];
  if (origin === 'manual') {
    transaction
      .delete(fileTag)
      .where(and(inArray(fileTag.fileId, ids), eq(fileTag.tagId, tagId), eq(fileTag.origin, 'ai')))
      .run();
  }
  const carried = new Set(
    transaction
      .select({ fileId: fileTag.fileId })
      .from(fileTag)
      .where(and(inArray(fileTag.fileId, ids), eq(fileTag.tagId, tagId)))
      .all()
      .map((row) => row.fileId),
  );
  const fresh = ids.filter((id) => !carried.has(id));
  if (fresh.length > 0) {
    transaction
      .insert(fileTag)
      .values(fresh.map((fileId) => ({ fileId, tagId, origin, createdAt: now })))
      .run();
  }
}
