import type { AssetType } from '@assetforge/contracts';
import type { AssetTypeRepository } from '@assetforge/core';
import { asc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { assetType } from './schema.js';

const toAssetType = (row: typeof assetType.$inferSelect): AssetType => ({
  id: row.id,
  key: row.key,
  name: row.name,
  sortOrder: row.sortOrder,
  builtIn: row.builtIn,
});

export function createAssetTypeRepository(db: BetterSQLite3Database): AssetTypeRepository {
  return {
    async list() {
      return db
        .select()
        .from(assetType)
        .orderBy(asc(assetType.sortOrder), asc(assetType.name))
        .all()
        .map(toAssetType);
    },
    async get(id) {
      const row = db.select().from(assetType).where(eq(assetType.id, id)).get();
      return row ? toAssetType(row) : null;
    },
    async insertMissing(types) {
      if (types.length === 0) return;
      db.transaction((tx) => {
        for (const t of types) {
          tx.insert(assetType)
            .values({ id: t.id, key: t.key, name: t.name, sortOrder: t.sortOrder, builtIn: t.builtIn })
            .onConflictDoNothing({ target: assetType.key })
            .run();
        }
      });
    },
  };
}
