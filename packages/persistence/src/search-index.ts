import { eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { qualified } from './qualified.js';
import { asset, assetSearchMap, assetTag, file, fileTag, tag } from './schema.js';

// The full-text row of an asset in `asset_search`, kept in step inside every transaction that changes searchable data.

/** What the index functions need of a database or transaction handle. */
export type IndexTransaction = Pick<BetterSQLite3Database, 'select' | 'insert' | 'run' | 'all' | 'get'>;

/**
 * Rewrites the full-text row of the asset from its current state: name, description, the tag names
 * of the asset and of its complete files, and the original names of its complete files. Call it
 * inside the transaction that changed any of these. No-op for an unknown asset.
 *
 * @param transaction the caller's transaction
 * @param assetId the asset
 * @returns nothing
 */
export function reindexAsset(transaction: IndexTransaction, assetId: string): void {
  const row = transaction
    .select({ name: asset.name, description: asset.description })
    .from(asset)
    .where(eq(asset.id, assetId))
    .get();
  if (!row) return;
  const tags = indexedTagNames(transaction, assetId);
  const fileNames = indexedFileNames(transaction, assetId);
  const rowid = clearedSearchRow(transaction, assetId);
  // Index text is NFC like the query words; the stored rows keep their spelling.
  const nfc = (text: string) => text.normalize('NFC');
  transaction.run(sql`insert into asset_search (rowid, name, description, tags, file_names) values (
    ${rowid}, ${nfc(row.name)}, ${nfc(row.description)},
    ${nfc(tags.join(' '))}, ${nfc(fileNames.join(' '))})`);
}

/**
 * The tag names of the asset and of its complete files.
 *
 * @param transaction the caller's transaction
 * @param assetId the asset
 * @returns the names in name order, each once
 */
function indexedTagNames(transaction: IndexTransaction, assetId: string): string[] {
  return transaction
    .all<{ name: string }>(
      sql`
    select ${qualified(tag, tag.name)} as name from ${tag}
    where ${qualified(tag, tag.id)} in (select ${qualified(assetTag, assetTag.tagId)} from ${assetTag} where ${qualified(assetTag, assetTag.assetId)} = ${assetId})
       or ${qualified(tag, tag.id)} in (
         select ${qualified(fileTag, fileTag.tagId)} from ${fileTag}
         join ${file} on ${qualified(file, file.id)} = ${qualified(fileTag, fileTag.fileId)}
         where ${qualified(file, file.assetId)} = ${assetId} and ${qualified(file, file.status)} = 'complete')
    order by ${qualified(tag, tag.name)}`,
    )
    .map((tagRow) => tagRow.name);
}

/**
 * The original names of the asset's complete files.
 *
 * @param transaction the caller's transaction
 * @param assetId the asset
 * @returns the names in import order
 */
function indexedFileNames(transaction: IndexTransaction, assetId: string): string[] {
  return transaction
    .all<{ name: string }>(
      sql`
    select ${qualified(file, file.originalName)} as name from ${file}
    where ${qualified(file, file.assetId)} = ${assetId} and ${qualified(file, file.status)} = 'complete'
    order by ${qualified(file, file.importedAt)}, ${qualified(file, file.id)}`,
    )
    .map((fileRow) => fileRow.name);
}

/**
 * The rowid of the asset's full-text row with that row deleted; an asset not yet indexed is given a new rowid.
 *
 * @param transaction the caller's transaction
 * @param assetId the asset
 * @returns the rowid to insert the new row under
 */
function clearedSearchRow(transaction: IndexTransaction, assetId: string): number {
  const mapped = transaction
    .select({ rowid: assetSearchMap.rowid })
    .from(assetSearchMap)
    .where(eq(assetSearchMap.assetId, assetId))
    .get();
  if (!mapped) {
    return transaction.insert(assetSearchMap).values({ assetId }).returning({ rowid: assetSearchMap.rowid }).get().rowid;
  }
  transaction.run(sql`delete from asset_search where rowid = ${mapped.rowid}`);
  return mapped.rowid;
}

/**
 * Reindexes each distinct, non-null asset id once (the asset a file left and the one it joined).
 *
 * @param transaction the caller's transaction
 * @param assetIds the assets; null entries are skipped
 * @returns nothing
 */
export function reindexAssets(transaction: IndexTransaction, assetIds: readonly (string | null)[]): void {
  for (const id of new Set(assetIds)) if (id !== null) reindexAsset(transaction, id);
}

/**
 * The asset of a file.
 *
 * @param transaction the database or the caller's transaction
 * @param fileId the file
 * @returns the asset id; null for an inbox or unknown file
 */
export function assetOfFile(transaction: IndexTransaction, fileId: string): string | null {
  return transaction.select({ assetId: file.assetId }).from(file).where(eq(file.id, fileId)).get()?.assetId ?? null;
}
