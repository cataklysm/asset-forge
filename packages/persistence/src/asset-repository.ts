import type { Asset, AssetList } from '@assetforge/contracts';
import { searchWords, type AssetRepository } from '@assetforge/core';
import { count, eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { assetFilter } from './asset-filters.js';
import { searchAssets } from './asset-search.js';
import { automaticCovers, summaries, withTags } from './asset-summaries.js';
import { asset } from './schema.js';
import { reindexAsset, type IndexTransaction } from './search-index.js';

/** The query of an asset list. */
type AssetListQuery = Parameters<AssetRepository['list']>[0];

/**
 * The asset of a row.
 *
 * @param row the asset row
 * @returns the asset
 */
const toAsset = (row: typeof asset.$inferSelect): Asset => ({
  id: row.id,
  name: row.name,
  typeId: row.typeId,
  description: row.description,
  status: row.status,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * The asset repository over the workspace database.
 *
 * @param database the workspace database
 * @returns the repository
 */
export function createAssetRepository(database: BetterSQLite3Database): AssetRepository {
  return {
    insert: (newAsset) => insertAsset(database, newAsset),
    get: (id) => getAsset(database, id),
    update: (id, patch) => updateAsset(database, id, patch),
    list: (query) => listAssets(database, query),
    getCover: (assetId) => getCover(database, assetId),
    setCover: (assetId, fileId, updatedAt) => setCover(database, assetId, fileId, updatedAt),
  };
}

/**
 * Inserts the asset and indexes it.
 *
 * @param database the workspace database
 * @param newAsset the asset
 * @returns nothing
 */
async function insertAsset(database: BetterSQLite3Database, newAsset: Asset): Promise<void> {
  database.transaction((transaction) => {
    transaction
      .insert(asset)
      .values({
        id: newAsset.id,
        name: newAsset.name,
        typeId: newAsset.typeId,
        description: newAsset.description,
        status: newAsset.status,
        createdAt: newAsset.createdAt,
        updatedAt: newAsset.updatedAt,
      })
      .run();
    reindexAsset(transaction, newAsset.id);
  });
}

/**
 * One asset.
 *
 * @param database the workspace database
 * @param id the asset
 * @returns the asset; null when unknown
 */
async function getAsset(database: BetterSQLite3Database, id: string): Promise<Asset | null> {
  const row = database.select().from(asset).where(eq(asset.id, id)).get();
  return row ? toAsset(row) : null;
}

/**
 * Changes the given fields and the update time and reindexes the asset.
 *
 * @param database the workspace database
 * @param id the asset
 * @param patch the fields to change with the update time
 * @returns the changed asset; null when unknown
 */
async function updateAsset(
  database: BetterSQLite3Database,
  id: string,
  patch: Parameters<AssetRepository['update']>[1],
): Promise<Asset | null> {
  const set: Partial<typeof asset.$inferInsert> = { updatedAt: patch.updatedAt };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.typeId !== undefined) set.typeId = patch.typeId;
  if (patch.status !== undefined) set.status = patch.status;
  return database.transaction((transaction) => {
    const row = transaction.update(asset).set(set).where(eq(asset.id, id)).returning().get();
    if (!row) return null;
    reindexAsset(transaction, id);
    return toAsset(row);
  });
}

/**
 * One page of the asset list: by search relevance when the query has words, else by name.
 *
 * @param database the workspace database
 * @param query the filters and the page
 * @returns the page and the total
 */
async function listAssets(database: BetterSQLite3Database, query: AssetListQuery): Promise<AssetList> {
  const words = query.query === undefined ? [] : searchWords(query.query);
  // One read transaction, so the tag ids, the page and the total describe the same snapshot.
  return database.transaction(
    (transaction) => {
      if (words.length > 0) return searchedPage(transaction, query, words);
      return filteredPage(transaction, query);
    },
    { behavior: 'deferred' },
  );
}

/**
 * A page of the assets matching the search words, best match first.
 *
 * @param transaction the list's read transaction
 * @param query the filters and the page
 * @param words the search words
 * @returns the page and the total
 */
function searchedPage(transaction: IndexTransaction, query: AssetListQuery, words: string[]): AssetList {
  const tagNames = query.tagNames ?? [];
  const { ids, total } = searchAssets(transaction, { ...query, words });
  if (ids.length === 0) return { items: [], total };
  const byId = new Map(summaries(transaction, inArray(asset.id, ids)).map((summary) => [summary.id, summary]));
  return { items: withTags(transaction, ids.flatMap((id) => byId.get(id) ?? []), tagNames), total };
}

/**
 * A page of the assets matching the filters, by name.
 *
 * @param transaction the list's read transaction
 * @param query the filters and the page
 * @returns the page and the total
 */
function filteredPage(transaction: IndexTransaction, query: AssetListQuery): AssetList {
  const tagNames = query.tagNames ?? [];
  const filter = assetFilter(transaction, query);
  if (filter === null) return { items: [], total: 0 };
  const page = summaries(transaction, filter.where, { limit: query.limit, offset: query.offset });
  const items = withTags(transaction, page, tagNames);
  const total = transaction.select({ n: count() }).from(asset).where(filter.where).get()?.n ?? 0;
  return { items, total };
}

/**
 * The effective cover of the asset: the chosen one, else the automatic one.
 *
 * @param database the workspace database
 * @param assetId the asset
 * @returns the cover and whether it was chosen; null for an unknown asset
 */
async function getCover(database: BetterSQLite3Database, assetId: string): ReturnType<AssetRepository['getCover']> {
  // One read transaction, so the chosen and the automatic cover describe the same snapshot.
  return database.transaction(
    (transaction) => {
      const row = transaction.select({ chosen: asset.coverFileId }).from(asset).where(eq(asset.id, assetId)).get();
      if (!row) return null;
      if (row.chosen !== null) return { coverFileId: row.chosen, coverIsChosen: true };
      return { coverFileId: automaticCovers(transaction, [assetId]).get(assetId) ?? null, coverIsChosen: false };
    },
    { behavior: 'deferred' },
  );
}

/**
 * Sets or clears the chosen cover.
 *
 * @param database the workspace database
 * @param assetId the asset
 * @param fileId the cover file; null for the automatic cover
 * @param updatedAt the update time
 * @returns nothing
 */
async function setCover(
  database: BetterSQLite3Database,
  assetId: string,
  fileId: string | null,
  updatedAt: string,
): Promise<void> {
  database.update(asset).set({ coverFileId: fileId, updatedAt }).where(eq(asset.id, assetId)).run();
}
