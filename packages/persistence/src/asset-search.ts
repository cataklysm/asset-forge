import { searchWords, type AssetQuery } from '@assetforge/core';
import { sql, type SQL } from 'drizzle-orm';
import { assetFilter } from './asset-filters.js';
import { qualified } from './qualified.js';
import { asset, assetSearchMap } from './schema.js';
import type { IndexTransaction } from './search-index.js';

// The asset search over `asset_search`: the MATCH expression, the statements and the page they read.

/** The filters of an asset list without the page. */
type AssetListFilter = Omit<AssetQuery, 'limit' | 'offset'>;

/** A search: the list query with its search words. */
type AssetSearch = AssetQuery & { words: string[] };

/**
 * An FTS5 MATCH expression that requires a token starting with each word: `"w1"* AND "w2"*`.
 *
 * @param words the search words
 * @returns the expression
 */
export function matchExpression(words: readonly string[]): string {
  return words.map((word) => `"${word.replaceAll('"', '""')}"*`).join(' AND ');
}

/**
 * `from ... where ...` of a search over the assets matching every word and the list filters.
 *
 * @param transaction the caller's transaction
 * @param filter the list filters with the search words
 * @returns the clause; null when a requested tag does not exist
 */
function searchFrom(transaction: IndexTransaction, filter: AssetListFilter & { words: readonly string[] }): SQL | null {
  const listFilter = assetFilter(transaction, filter);
  if (listFilter === null) return null;
  const andFilter = listFilter.where === undefined ? sql`` : sql` and ${listFilter.where}`;
  return sql`from asset_search
    cross join ${assetSearchMap} as m on m.rowid = asset_search.rowid
    cross join ${asset} on ${qualified(asset, asset.id)} = m.asset_id
    where asset_search match ${matchExpression(filter.words)}${andFilter}`;
}

/**
 * A `select` of the ids of every asset the asset list would show for these filters, unordered and
 * unpaged, for use as a subquery; null when a requested tag does not exist, so nothing can match.
 *
 * @param transaction the caller's transaction
 * @param filter the list filters
 * @returns the statement; null when a requested tag does not exist
 */
export function matchingAssetIds(transaction: IndexTransaction, filter: AssetListFilter): SQL | null {
  const words = filter.query === undefined ? [] : searchWords(filter.query);
  if (words.length > 0) {
    const from = searchFrom(transaction, { ...filter, words });
    return from === null ? null : sql`select ${qualified(asset, asset.id)} ${from}`;
  }
  const listFilter = assetFilter(transaction, filter);
  if (listFilter === null) return null;
  const where = listFilter.where === undefined ? sql`` : sql` where ${listFilter.where}`;
  return sql`select ${qualified(asset, asset.id)} from ${asset}${where}`;
}

/**
 * The two statements of a search: one page of asset ids (`id`) and the total (`n`) over the same
 * FROM and WHERE. Null when a requested tag does not exist, so nothing can match. Exported for the
 * query plan test; callers use `searchAssets`.
 *
 * @param transaction the caller's transaction
 * @param search the list query with its search words
 * @returns the statements; null when a requested tag does not exist
 */
export function searchStatements(transaction: IndexTransaction, search: AssetSearch): { page: SQL; count: SQL } | null {
  const from = searchFrom(transaction, search);
  if (from === null) return null;
  return {
    page: sql`select ${qualified(asset, asset.id)} as id ${from}
        order by bm25(asset_search, 10.0, 1.0, 4.0, 2.0), lower(${qualified(asset, asset.name)}), ${qualified(asset, asset.id)}
        limit ${search.limit} offset ${search.offset}`,
    count: sql`select count(*) as n ${from}`,
  };
}

/**
 * One page of asset ids matching every word (as a token prefix) and the list filters, best match
 * first (bm25 weighted name 10, description 1, tags 4, file names 2), ties by name and id; plus the
 * total. Run it inside the list's read transaction.
 *
 * @param transaction the list's read transaction
 * @param search the list query with its search words
 * @returns the ids of the page and the total
 */
export function searchAssets(transaction: IndexTransaction, search: AssetSearch): { ids: string[]; total: number } {
  const statements = searchStatements(transaction, search);
  if (statements === null) return { ids: [], total: 0 };
  const ids = transaction.all<{ id: string }>(statements.page).map((row) => row.id);
  const total = transaction.get<{ n: number }>(statements.count)?.n ?? 0;
  return { ids, total };
}
