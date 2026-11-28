import type { Asset, AssetList } from '@assetforge/contracts';
import { searchWords, type AssetRepository } from '@assetforge/core';
import { count, eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { assetFilter } from './asset-filters.js';
import { automaticCovers, summaries, withTags } from './asset-summaries.js';
import { asset } from './schema.js';
import { searchAssets } from './asset-search.js';
import { reindexAsset } from './search-index.js';

const toAsset = (row: typeof asset.$inferSelect): Asset => ({
  id: row.id,
  name: row.name,
  typeId: row.typeId,
  description: row.description,
  status: row.status,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export function createAssetRepository(db: BetterSQLite3Database): AssetRepository {
  return {
    async insert(a) {
      db.transaction((tx) => {
        tx.insert(asset)
          .values({
            id: a.id,
            name: a.name,
            typeId: a.typeId,
            description: a.description,
            status: a.status,
            createdAt: a.createdAt,
            updatedAt: a.updatedAt,
          })
          .run();
        reindexAsset(tx, a.id);
      });
    },
    async get(id) {
      const row = db.select().from(asset).where(eq(asset.id, id)).get();
      return row ? toAsset(row) : null;
    },
    async update(id, patch) {
      const set: Partial<typeof asset.$inferInsert> = { updatedAt: patch.updatedAt };
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.description !== undefined) set.description = patch.description;
      if (patch.typeId !== undefined) set.typeId = patch.typeId;
      if (patch.status !== undefined) set.status = patch.status;
      return db.transaction((tx) => {
        const row = tx.update(asset).set(set).where(eq(asset.id, id)).returning().get();
        if (!row) return null;
        reindexAsset(tx, id);
        return toAsset(row);
      });
    },
    async list(q): Promise<AssetList> {
      const words = q.query === undefined ? [] : searchWords(q.query);
      // One read transaction, so the tag ids, the page and the total describe the same snapshot.
      return db.transaction(
        (tx) => {
          const tagNames = q.tagNames ?? [];
          if (words.length > 0) {
            const { ids, total } = searchAssets(tx, { ...q, words });
            if (ids.length === 0) return { items: [], total };
            const byId = new Map(summaries(tx, inArray(asset.id, ids)).map((s) => [s.id, s]));
            return { items: withTags(tx, ids.flatMap((id) => byId.get(id) ?? []), tagNames), total };
          }
          const filter = assetFilter(tx, q);
          if (filter === null) return { items: [], total: 0 };
          const items = withTags(tx, summaries(tx, filter.where, { limit: q.limit, offset: q.offset }), tagNames);
          const total = tx.select({ n: count() }).from(asset).where(filter.where).get()?.n ?? 0;
          return { items, total };
        },
        { behavior: 'deferred' },
      );
    },
    async getCover(assetId) {
      // One read transaction, so the chosen and the automatic cover describe the same snapshot.
      return db.transaction(
        (tx) => {
          const row = tx.select({ chosen: asset.coverFileId }).from(asset).where(eq(asset.id, assetId)).get();
          if (!row) return null;
          if (row.chosen !== null) return { coverFileId: row.chosen, coverIsChosen: true };
          return { coverFileId: automaticCovers(tx, [assetId]).get(assetId) ?? null, coverIsChosen: false };
        },
        { behavior: 'deferred' },
      );
    },
    async setCover(assetId, fileId, updatedAt) {
      db.update(asset).set({ coverFileId: fileId, updatedAt }).where(eq(asset.id, assetId)).run();
    },
  };
}
