import type { Asset, AssetList, AssetSummary } from '@assetforge/contracts';
import type { AssetRepository } from '@assetforge/core';
import { and, asc, count, eq, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { containsPattern } from './like.js';
import { qualified } from './qualified.js';
import { asset, file, projectAsset } from './schema.js';

const toAsset = (row: typeof asset.$inferSelect): Asset => ({
  id: row.id,
  name: row.name,
  typeId: row.typeId,
  description: row.description,
  status: row.status,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const outerAssetId = qualified(asset, asset.id);

export function createAssetRepository(db: BetterSQLite3Database): AssetRepository {
  return {
    async insert(a) {
      db.insert(asset)
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
      const row = db.update(asset).set(set).where(eq(asset.id, id)).returning().get();
      return row ? toAsset(row) : null;
    },
    async list(q): Promise<AssetList> {
      const conditions: SQL[] = [];
      if (q.typeId !== undefined) conditions.push(eq(asset.typeId, q.typeId));
      if (q.status !== undefined) conditions.push(eq(asset.status, q.status));
      if (q.projectId !== undefined) {
        conditions.push(
          sql`exists (select 1 from ${projectAsset} where ${qualified(projectAsset, projectAsset.assetId)} = ${outerAssetId} and ${qualified(projectAsset, projectAsset.projectId)} = ${q.projectId})`,
        );
      }
      if (q.nameContains !== undefined) {
        conditions.push(sql`${asset.name} like ${containsPattern(q.nameContains)} escape '\\'`);
      }
      const where = conditions.length > 0 ? and(...conditions) : undefined;
      // One read transaction, so the page and the total describe the same snapshot.
      return db.transaction(
        (tx) => {
          const items: AssetSummary[] = tx
            .select({
              id: asset.id,
              name: asset.name,
              typeId: asset.typeId,
              description: asset.description,
              status: asset.status,
              createdAt: asset.createdAt,
              updatedAt: asset.updatedAt,
              projectCount: sql<number>`(select count(*) from ${projectAsset} where ${qualified(projectAsset, projectAsset.assetId)} = ${outerAssetId})`,
              fileCount: sql<number>`(select count(*) from ${file} where ${qualified(file, file.assetId)} = ${outerAssetId})`,
            })
            .from(asset)
            .where(where)
            .orderBy(sql`lower(${asset.name})`, asc(asset.id))
            .limit(q.limit)
            .offset(q.offset)
            .all();
          const total = tx.select({ n: count() }).from(asset).where(where).get()?.n ?? 0;
          return { items, total };
        },
        { behavior: 'deferred' },
      );
    },
  };
}
