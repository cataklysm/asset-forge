import { eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { qualified } from './qualified.js';
import { asset, assetSearchMap, assetTag, file, fileTag, tag } from './schema.js';

/** What the index functions need of a database or transaction handle. */
export type Tx = Pick<BetterSQLite3Database, 'select' | 'insert' | 'run' | 'all' | 'get'>;

/**
 * Rewrites the full-text row of the asset from its current state: name, description, the tag names
 * of the asset and of its complete files, and the original names of its complete files. Call it
 * inside the transaction that changed any of these. No-op for an unknown asset.
 */
export function reindexAsset(tx: Tx, assetId: string): void {
  const row = tx
    .select({ name: asset.name, description: asset.description })
    .from(asset)
    .where(eq(asset.id, assetId))
    .get();
  if (!row) return;
  const tags = tx.all<{ name: string }>(sql`
    select ${qualified(tag, tag.name)} as name from ${tag}
    where ${qualified(tag, tag.id)} in (select ${qualified(assetTag, assetTag.tagId)} from ${assetTag} where ${qualified(assetTag, assetTag.assetId)} = ${assetId})
       or ${qualified(tag, tag.id)} in (
         select ${qualified(fileTag, fileTag.tagId)} from ${fileTag}
         join ${file} on ${qualified(file, file.id)} = ${qualified(fileTag, fileTag.fileId)}
         where ${qualified(file, file.assetId)} = ${assetId} and ${qualified(file, file.status)} = 'complete')
    order by ${qualified(tag, tag.name)}`);
  const fileNames = tx.all<{ name: string }>(sql`
    select ${qualified(file, file.originalName)} as name from ${file}
    where ${qualified(file, file.assetId)} = ${assetId} and ${qualified(file, file.status)} = 'complete'
    order by ${qualified(file, file.importedAt)}, ${qualified(file, file.id)}`);

  const mapped = tx.select({ rowid: assetSearchMap.rowid }).from(assetSearchMap).where(eq(assetSearchMap.assetId, assetId)).get();
  let rowid: number;
  if (mapped) {
    rowid = mapped.rowid;
    tx.run(sql`delete from asset_search where rowid = ${rowid}`);
  } else {
    rowid = tx.insert(assetSearchMap).values({ assetId }).returning({ rowid: assetSearchMap.rowid }).get().rowid;
  }
  // Index text is NFC like the query words; the stored rows keep their spelling.
  const nfc = (text: string) => text.normalize('NFC');
  tx.run(sql`insert into asset_search (rowid, name, description, tags, file_names) values (
    ${rowid}, ${nfc(row.name)}, ${nfc(row.description)},
    ${nfc(tags.map((t) => t.name).join(' '))}, ${nfc(fileNames.map((f) => f.name).join(' '))})`);
}

/** Reindexes each distinct, non-null asset id once (the asset a file left and the one it joined). */
export function reindexAssets(tx: Tx, assetIds: readonly (string | null)[]): void {
  for (const id of new Set(assetIds)) if (id !== null) reindexAsset(tx, id);
}

/** The asset of a file, or null for an inbox or unknown file. */
export function assetOfFile(tx: Tx, fileId: string): string | null {
  return tx.select({ assetId: file.assetId }).from(file).where(eq(file.id, fileId)).get()?.assetId ?? null;
}
