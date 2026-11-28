import type { Asset, AssetDetail, AssetList } from '@assetforge/contracts';
import {
  PREVIEWABLE_MIME_TYPES,
  searchWords,
  VIDEO_MIME_TYPES,
  type AssetCover,
  type AssetRepository,
  type NewAssetWorkflow,
} from '@assetforge/core';
import { and, count, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { assetFilter, outerAssetId } from './asset-filters.js';
import { toAsset } from './asset-rows.js';
import { searchAssets } from './asset-search.js';
import { sourcesOfAsset } from './asset-source-repository.js';
import { writeWorkflow } from './asset-workflow-repository.js';
import { automaticCovers, summaries, withTags } from './asset-summaries.js';
import { qualified } from './qualified.js';
import { asset, file } from './schema.js';
import { reindexAsset, type IndexTransaction } from './search-index.js';
import { tagsOfAsset } from './tag-repository.js';

/** The query of an asset list. */
type AssetListQuery = Parameters<AssetRepository['list']>[0];

/**
 * The asset repository over the workspace database.
 *
 * @param database the workspace database
 * @returns the repository
 */
export function createAssetRepository(database: BetterSQLite3Database): AssetRepository {
  return {
    insert: (newAsset) => insertAsset(database, newAsset),
    insertWithWorkflow: (newAsset, workflow) => insertAssetWithWorkflow(database, newAsset, workflow),
    get: (id) => getAsset(database, id),
    update: (id, patch) => updateAsset(database, id, patch),
    list: (query) => listAssets(database, query),
    getCover: (assetId) => getCover(database, assetId),
    getDetail: (assetId) => getDetail(database, assetId),
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
  database.transaction((transaction) => writeAsset(transaction, newAsset));
}

/**
 * Inserts the asset, its search entry and its first workflow with the step rows in one transaction; a failure
 * anywhere rolls all of it back.
 *
 * @param database the workspace database
 * @param newAsset the asset
 * @param workflow the workflow of the asset and its steps
 * @returns nothing
 */
async function insertAssetWithWorkflow(
  database: BetterSQLite3Database,
  newAsset: Asset,
  workflow: NewAssetWorkflow,
): Promise<void> {
  database.transaction((transaction) => {
    writeAsset(transaction, newAsset);
    writeWorkflow(transaction, workflow.workflow, workflow.steps);
  });
}

/**
 * Writes the asset row and its search entry inside the caller's transaction.
 *
 * @param transaction the open transaction
 * @param newAsset the asset
 */
function writeAsset(transaction: IndexTransaction, newAsset: Asset): void {
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
  return {
    items: withTags(
      transaction,
      ids.flatMap((id) => byId.get(id) ?? []),
      tagNames,
    ),
    total,
  };
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
  return database.transaction((transaction) => coverOf(transaction, assetId), { behavior: 'deferred' });
}

/**
 * The effective cover of the asset inside an open read.
 *
 * @param reader the open transaction
 * @param assetId the asset
 * @returns the cover and whether it was chosen; null for an unknown asset
 */
function coverOf(reader: Pick<BetterSQLite3Database, 'select'>, assetId: string): AssetCover | null {
  const row = reader.select({ chosen: asset.coverFileId }).from(asset).where(eq(asset.id, assetId)).get();
  if (!row) return null;
  if (row.chosen !== null) return { coverFileId: row.chosen, coverIsChosen: true };
  return { coverFileId: automaticCovers(reader, [assetId]).get(assetId) ?? null, coverIsChosen: false };
}

/**
 * The asset with its cover, its own tags and its sources, read in one read transaction.
 *
 * @param database the workspace database
 * @param assetId the asset
 * @returns the detail; null for an unknown asset
 */
async function getDetail(database: BetterSQLite3Database, assetId: string): Promise<AssetDetail | null> {
  return database.transaction(
    (transaction) => {
      const row = transaction.select().from(asset).where(eq(asset.id, assetId)).get();
      const cover = row ? coverOf(transaction, assetId) : null;
      if (!row || cover === null) return null;
      return {
        ...toAsset(row),
        ...cover,
        tags: tagsOfAsset(transaction, assetId),
        sources: sourcesOfAsset(transaction, assetId),
      };
    },
    { behavior: 'deferred' },
  );
}

/**
 * Sets or clears the chosen cover in one guarded statement: a chosen file must be attached to the asset, complete,
 * outside the trash and have a thumbnail (a previewable image or a video).
 *
 * @param database the workspace database
 * @param assetId the asset
 * @param fileId the cover file; null for the automatic cover
 * @param updatedAt the update time
 * @returns whether the asset was written; false for an unknown asset or a file that cannot be the cover
 */
async function setCover(
  database: BetterSQLite3Database,
  assetId: string,
  fileId: string | null,
  updatedAt: string,
): Promise<boolean> {
  const guard = fileId === null ? eq(asset.id, assetId) : and(eq(asset.id, assetId), coverCandidate(fileId));
  return database.update(asset).set({ coverFileId: fileId, updatedAt }).where(guard).run().changes > 0;
}

/**
 * The condition that a file can be the cover of the outer asset row.
 *
 * @param fileId the chosen file
 * @returns the SQL condition
 */
function coverCandidate(fileId: string): SQL {
  const thumbnailTypes = inArray(file.mimeType, [...PREVIEWABLE_MIME_TYPES, ...VIDEO_MIME_TYPES]);
  return sql`exists (select 1 from ${file} where ${qualified(file, file.id)} = ${fileId} and ${qualified(file, file.assetId)} = ${outerAssetId} and ${qualified(file, file.status)} = 'complete' and ${qualified(file, file.deletedAt)} is null and ${thumbnailTypes})`;
}
