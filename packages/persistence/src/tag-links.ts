import type { TagOrigin } from '@assetforge/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { assetTag, fileTag, tag } from './schema.js';

/** Inserts the tag unless its name exists and returns the id of the tag with that name. */
export function ensureTag(
  tx: Pick<BetterSQLite3Database, 'insert' | 'select'>,
  r: { name: string; displayName: string; newId: string; now: string },
): string {
  tx.insert(tag)
    .values({ id: r.newId, name: r.name, displayName: r.displayName, createdAt: r.now })
    .onConflictDoNothing({ target: tag.name })
    .run();
  return tx.select({ id: tag.id }).from(tag).where(eq(tag.name, r.name)).get()!.id;
}

type Writer = Pick<BetterSQLite3Database, 'insert' | 'delete' | 'select'>;

/** An owner carries a tag at most once and manual wins: a manual add replaces an ai link, an ai add yields to any link. */
export function linkAssetTag(tx: Writer, assetId: string, tagId: string, origin: TagOrigin, now: string): void {
  if (origin === 'manual') {
    tx.delete(assetTag).where(and(eq(assetTag.assetId, assetId), eq(assetTag.tagId, tagId), eq(assetTag.origin, 'ai'))).run();
  }
  const carried = tx.select({ tagId: assetTag.tagId }).from(assetTag).where(and(eq(assetTag.assetId, assetId), eq(assetTag.tagId, tagId))).get();
  if (!carried) tx.insert(assetTag).values({ assetId, tagId, origin, createdAt: now }).run();
}

/** Same rule as `linkAssetTag`, for each file of the list. */
export function linkFileTags(tx: Writer, fileIds: readonly string[], tagId: string, origin: TagOrigin, now: string): void {
  const ids = [...new Set(fileIds)];
  if (origin === 'manual') {
    tx.delete(fileTag).where(and(inArray(fileTag.fileId, ids), eq(fileTag.tagId, tagId), eq(fileTag.origin, 'ai'))).run();
  }
  const carried = new Set(
    tx
      .select({ fileId: fileTag.fileId })
      .from(fileTag)
      .where(and(inArray(fileTag.fileId, ids), eq(fileTag.tagId, tagId)))
      .all()
      .map((row) => row.fileId),
  );
  const fresh = ids.filter((id) => !carried.has(id));
  if (fresh.length > 0) tx.insert(fileTag).values(fresh.map((fileId) => ({ fileId, tagId, origin, createdAt: now }))).run();
}
