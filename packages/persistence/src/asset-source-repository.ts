import type { AssetSourceRepository } from '@assetforge/core';
import { asc, count, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { asset, assetSource } from './schema.js';

/**
 * The asset source repository over the workspace database.
 *
 * @param database the workspace database
 * @returns the repository
 */
export function createAssetSourceRepository(database: BetterSQLite3Database): AssetSourceRepository {
  return {
    listByAsset: async (assetId) => sourcesOfAsset(database, assetId),
    get: (id) => getSource(database, id),
    countByAsset: (assetId) => countByAsset(database, assetId),
    insert: (row) => insertSource(database, row),
    remove: (id, updatedAt) => removeSource(database, id, updatedAt),
  };
}

/**
 * The sources of an asset, oldest first; synchronous, so it can run inside another read transaction.
 *
 * @param reader the workspace database or an open transaction
 * @param assetId the asset
 * @returns the sources
 */
export function sourcesOfAsset(
  reader: Pick<BetterSQLite3Database, 'select'>,
  assetId: string,
): Awaited<ReturnType<AssetSourceRepository['listByAsset']>> {
  return reader
    .select({ id: assetSource.id, url: assetSource.url, createdAt: assetSource.createdAt })
    .from(assetSource)
    .where(eq(assetSource.assetId, assetId))
    .orderBy(asc(assetSource.createdAt), asc(assetSource.id))
    .all();
}

/**
 * One source row.
 *
 * @param database the workspace database
 * @param id the source
 * @returns the row; null when unknown
 */
async function getSource(database: BetterSQLite3Database, id: string): ReturnType<AssetSourceRepository['get']> {
  return database.select().from(assetSource).where(eq(assetSource.id, id)).get() ?? null;
}

/**
 * The number of sources of an asset.
 *
 * @param database the workspace database
 * @param assetId the asset
 * @returns the count
 */
async function countByAsset(database: BetterSQLite3Database, assetId: string): Promise<number> {
  const row = database.select({ n: count() }).from(assetSource).where(eq(assetSource.assetId, assetId)).get();
  return row?.n ?? 0;
}

/**
 * Inserts the source unless the asset already has its URL, and moves the asset's `updated_at` to the source's
 * `created_at` in the same transaction.
 *
 * @param database the workspace database
 * @param row the source row
 * @returns false, writing nothing, when the URL already exists on the asset
 */
async function insertSource(
  database: BetterSQLite3Database,
  row: Parameters<AssetSourceRepository['insert']>[0],
): Promise<boolean> {
  return database.transaction((transaction) => {
    const result = transaction
      .insert(assetSource)
      .values(row)
      .onConflictDoNothing({ target: [assetSource.assetId, assetSource.url] })
      .run();
    if (result.changes === 0) return false;
    transaction.update(asset).set({ updatedAt: row.createdAt }).where(eq(asset.id, row.assetId)).run();
    return true;
  });
}

/**
 * Deletes the source and moves its asset's `updated_at` in the same transaction.
 *
 * @param database the workspace database
 * @param id the source
 * @param updatedAt the asset's new `updated_at`
 * @returns whether a source was deleted
 */
async function removeSource(database: BetterSQLite3Database, id: string, updatedAt: string): Promise<boolean> {
  return database.transaction((transaction) => {
    const removed = transaction
      .delete(assetSource)
      .where(eq(assetSource.id, id))
      .returning({ assetId: assetSource.assetId })
      .get();
    if (!removed) return false;
    transaction.update(asset).set({ updatedAt }).where(eq(asset.id, removed.assetId)).run();
    return true;
  });
}
