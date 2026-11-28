import { searchWords, type AssetQuery } from '@assetforge/core';
import { sql, type SQL } from 'drizzle-orm';
import { assetFilter } from './asset-filters.js';
import { qualified } from './qualified.js';
import { asset, assetSearchMap } from './schema.js';
import type { Tx } from './search-index.js';

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
