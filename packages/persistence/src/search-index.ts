import { searchWords, type AssetQuery } from '@assetforge/core';
import { eq, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { assetFilter } from './asset-filters.js';
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

/** An FTS5 MATCH expression that requires a token starting with each word: `"w1"* AND "w2"*`. */
export function matchExpression(words: readonly string[]): string {
  return words.map((w) => `"${w.replaceAll('"', '""')}"*`).join(' AND ');
}

/** `from ... where ...` of a search over the assets matching every word and the list filters; null when a requested tag does not exist. */
function searchFrom(tx: Tx, q: Omit<AssetQuery, 'limit' | 'offset'> & { words: readonly string[] }): SQL | null {
  const filter = assetFilter(tx, q);
  if (filter === null) return null;
  return sql`from asset_search
    cross join ${assetSearchMap} as m on m.rowid = asset_search.rowid
    cross join ${asset} on ${qualified(asset, asset.id)} = m.asset_id
    where asset_search match ${matchExpression(q.words)}${filter.where === undefined ? sql`` : sql` and ${filter.where}`}`;
}

/**
 * A `select` of the ids of every asset the asset list would show for these filters, unordered and
 * unpaged, for use as a subquery; null when a requested tag does not exist, so nothing can match.
 */
export function matchingAssetIds(tx: Tx, q: Omit<AssetQuery, 'limit' | 'offset'>): SQL | null {
  const words = q.query === undefined ? [] : searchWords(q.query);
  if (words.length > 0) {
    const from = searchFrom(tx, { ...q, words });
    return from === null ? null : sql`select ${qualified(asset, asset.id)} ${from}`;
  }
  const filter = assetFilter(tx, q);
  if (filter === null) return null;
  return sql`select ${qualified(asset, asset.id)} from ${asset}${filter.where === undefined ? sql`` : sql` where ${filter.where}`}`;
}

/**
 * The two statements of a search: one page of asset ids (`id`) and the total (`n`) over the same
 * FROM and WHERE. Null when a requested tag does not exist, so nothing can match. Exported for the
 * query plan test; callers use `searchAssets`.
 */
export function searchStatements(tx: Tx, q: AssetQuery & { words: string[] }): { page: SQL; count: SQL } | null {
  const from = searchFrom(tx, q);
  if (from === null) return null;
  return {
    page: sql`select ${qualified(asset, asset.id)} as id ${from}
        order by bm25(asset_search, 10.0, 1.0, 4.0, 2.0), lower(${qualified(asset, asset.name)}), ${qualified(asset, asset.id)}
        limit ${q.limit} offset ${q.offset}`,
    count: sql`select count(*) as n ${from}`,
  };
}

/**
 * One page of asset ids matching every word (as a token prefix) and the list filters, best match
 * first (bm25 weighted name 10, description 1, tags 4, file names 2), ties by name and id; plus the
 * total. Run it inside the list's read transaction.
 */
export function searchAssets(tx: Tx, q: AssetQuery & { words: string[] }): { ids: string[]; total: number } {
  const statements = searchStatements(tx, q);
  if (statements === null) return { ids: [], total: 0 };
  const ids = tx.all<{ id: string }>(statements.page).map((r) => r.id);
  const total = tx.get<{ n: number }>(statements.count)?.n ?? 0;
  return { ids, total };
}
