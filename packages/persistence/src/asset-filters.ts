import type { AssetQuery } from '@assetforge/core';
import { and, inArray, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { qualified } from './qualified.js';
import { asset, assetTag, file, fileTag, projectAsset, tag } from './schema.js';

/** `"asset"."id"`, the asset the list statement iterates over. */
export const outerAssetId = qualified(asset, asset.id);

/**
 * The outer asset has a complete file that satisfies `predicate` (written against the `file` table).
 *
 * @param predicate the condition on the file
 * @returns the condition over the outer asset row
 */
const hasCompleteFile = (predicate: SQL): SQL =>
  sql`exists (select 1 from ${file} where ${qualified(file, file.assetId)} = ${outerAssetId} and ${qualified(file, file.status)} = 'complete' and ${predicate})`;

/**
 * The asset `assetId` (an expression such as `outerAssetId`) carries the tag itself.
 *
 * @param assetId the asset expression
 * @param tagId the tag
 * @returns the condition
 */
export const hasAssetTag = (assetId: SQL, tagId: string): SQL =>
  sql`exists (select 1 from ${assetTag} where ${qualified(assetTag, assetTag.assetId)} = ${assetId} and ${qualified(assetTag, assetTag.tagId)} = ${tagId})`;

/**
 * One of the complete files of the asset `assetId` carries the tag. `cross join` keeps `file`
 * (keyed on the asset) as the outer loop; otherwise SQLite drives from `file_tag` by tag id and
 * reads every file carrying the tag for each candidate asset.
 *
 * @param assetId the asset expression
 * @param tagId the tag
 * @returns the condition
 */
export const hasFileTag = (assetId: SQL, tagId: string): SQL =>
  sql`exists (select 1 from ${file} cross join ${fileTag} on ${qualified(fileTag, fileTag.fileId)} = ${qualified(file, file.id)}
      where ${qualified(file, file.assetId)} = ${assetId} and ${qualified(file, file.status)} = 'complete' and ${qualified(fileTag, fileTag.tagId)} = ${tagId})`;

/**
 * The asset `assetId` carries the tag itself or through one of its complete files.
 *
 * @param assetId the asset expression
 * @param tagId the tag
 * @returns the condition
 */
export const carriesTag = (assetId: SQL, tagId: string): SQL =>
  sql`(${hasAssetTag(assetId, tagId)} or ${hasFileTag(assetId, tagId)})`;

/**
 * The filters of the asset list except the words, against the outer `asset` row, with every column
 * qualified so the condition also holds in a statement that joins other tables. Null when a
 * requested tag does not exist, so nothing can match. Run it in the list's read transaction.
 *
 * @param transaction the list's read transaction
 * @param query the filters
 * @returns the condition; null when a requested tag does not exist
 */
export function assetFilter(
  transaction: Pick<BetterSQLite3Database, 'select'>,
  query: Omit<AssetQuery, 'limit' | 'offset' | 'query'>,
): { where: SQL | undefined } | null {
  const conditions: SQL[] = [];
  if (query.typeId !== undefined) conditions.push(sql`${qualified(asset, asset.typeId)} = ${query.typeId}`);
  if (query.status !== undefined) conditions.push(sql`${qualified(asset, asset.status)} = ${query.status}`);
  if (query.projectId !== undefined) {
    conditions.push(
      sql`exists (select 1 from ${projectAsset} where ${qualified(projectAsset, projectAsset.assetId)} = ${outerAssetId} and ${qualified(projectAsset, projectAsset.projectId)} = ${query.projectId})`,
    );
  }
  if (query.fileRole !== undefined)
    conditions.push(hasCompleteFile(sql`${qualified(file, file.role)} = ${query.fileRole}`));
  if (query.fileKind !== undefined)
    conditions.push(hasCompleteFile(sql`${qualified(file, file.kind)} = ${query.fileKind}`));
  const names = [...new Set(query.tagNames ?? [])];
  if (names.length > 0) {
    const tagIds = transaction.select({ id: tag.id }).from(tag).where(inArray(tag.name, names)).all();
    if (tagIds.length < names.length) return null;
    conditions.push(...tagIds.map(({ id }) => carriesTag(outerAssetId, id)));
  }
  return { where: and(...conditions) };
}
