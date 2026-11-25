import type { AssetQuery } from '@assetforge/core';
import { and, inArray, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { qualified } from './qualified.js';
import { asset, assetTag, file, fileTag, projectAsset, tag } from './schema.js';

/** `"asset"."id"`, the asset the list statement iterates over. */
export const outerAssetId = qualified(asset, asset.id);

/** The outer asset has a complete file that satisfies `predicate` (written against the `file` table). */
const hasCompleteFile = (predicate: SQL): SQL =>
  sql`exists (select 1 from ${file} where ${qualified(file, file.assetId)} = ${outerAssetId} and ${qualified(file, file.status)} = 'complete' and ${predicate})`;

/**
 * The outer asset carries the tag itself or through one of its complete files. `cross join` keeps
 * `file` (keyed on the asset) as the outer loop; otherwise SQLite drives from `file_tag` by tag id
 * and reads every file carrying the tag for each candidate asset.
 */
const carriesTag = (tagId: string): SQL =>
  sql`(exists (select 1 from ${assetTag} where ${qualified(assetTag, assetTag.assetId)} = ${outerAssetId} and ${qualified(assetTag, assetTag.tagId)} = ${tagId})
    or exists (select 1 from ${file} cross join ${fileTag} on ${qualified(fileTag, fileTag.fileId)} = ${qualified(file, file.id)}
      where ${qualified(file, file.assetId)} = ${outerAssetId} and ${qualified(file, file.status)} = 'complete' and ${qualified(fileTag, fileTag.tagId)} = ${tagId}))`;

/**
 * The filters of the asset list except the words, against the outer `asset` row, with every column
 * qualified so the condition also holds in a statement that joins other tables. Null when a
 * requested tag does not exist, so nothing can match. Run it in the list's read transaction.
 */
export function assetFilter(
  tx: Pick<BetterSQLite3Database, 'select'>,
  q: Omit<AssetQuery, 'limit' | 'offset' | 'query'>,
): { where: SQL | undefined } | null {
  const conditions: SQL[] = [];
  if (q.typeId !== undefined) conditions.push(sql`${qualified(asset, asset.typeId)} = ${q.typeId}`);
  if (q.status !== undefined) conditions.push(sql`${qualified(asset, asset.status)} = ${q.status}`);
  if (q.projectId !== undefined) {
    conditions.push(
      sql`exists (select 1 from ${projectAsset} where ${qualified(projectAsset, projectAsset.assetId)} = ${outerAssetId} and ${qualified(projectAsset, projectAsset.projectId)} = ${q.projectId})`,
    );
  }
  if (q.fileRole !== undefined) conditions.push(hasCompleteFile(sql`${qualified(file, file.role)} = ${q.fileRole}`));
  if (q.fileKind !== undefined) conditions.push(hasCompleteFile(sql`${qualified(file, file.kind)} = ${q.fileKind}`));
  const names = [...new Set(q.tagNames ?? [])];
  if (names.length > 0) {
    const tagIds = tx.select({ id: tag.id }).from(tag).where(inArray(tag.name, names)).all();
    if (tagIds.length < names.length) return null;
    conditions.push(...tagIds.map(({ id }) => carriesTag(id)));
  }
  return { where: and(...conditions) };
}
