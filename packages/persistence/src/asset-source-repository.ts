import type { AssetSourceRepository } from '@assetforge/core';
import { asc, count, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { assetSource } from './schema.js';

export function createAssetSourceRepository(db: BetterSQLite3Database): AssetSourceRepository {
  return {
    async listByAsset(assetId) {
      return db
        .select({ id: assetSource.id, url: assetSource.url, createdAt: assetSource.createdAt })
        .from(assetSource)
        .where(eq(assetSource.assetId, assetId))
        .orderBy(asc(assetSource.createdAt), asc(assetSource.id))
        .all();
    },
    async get(id) {
      return db.select().from(assetSource).where(eq(assetSource.id, id)).get() ?? null;
    },
    async countByAsset(assetId) {
      const row = db.select({ n: count() }).from(assetSource).where(eq(assetSource.assetId, assetId)).get();
      return row?.n ?? 0;
    },
    async insert(row) {
      const result = db
        .insert(assetSource)
        .values(row)
        .onConflictDoNothing({ target: [assetSource.assetId, assetSource.url] })
        .run();
      return result.changes > 0;
    },
    async remove(id) {
      return db.delete(assetSource).where(eq(assetSource.id, id)).run().changes > 0;
    },
  };
}
