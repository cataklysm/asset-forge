import type { AssetRelationView } from '@assetforge/contracts';
import type { AssetRelationRepository } from '@assetforge/core';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { asset, assetRelation } from './schema.js';

export function createAssetRelationRepository(db: BetterSQLite3Database): AssetRelationRepository {
  return {
    async insert(r) {
      const result = db
        .insert(assetRelation)
        .values({ fromAssetId: r.fromAssetId, toAssetId: r.toAssetId, kind: r.kind, createdAt: r.createdAt })
        .onConflictDoNothing()
        .run();
      return result.changes > 0;
    },
    async remove(key) {
      const result = db
        .delete(assetRelation)
        .where(
          and(
            eq(assetRelation.fromAssetId, key.fromAssetId),
            eq(assetRelation.toAssetId, key.toAssetId),
            eq(assetRelation.kind, key.kind),
          ),
        )
        .run();
      return result.changes > 0;
    },
    async listForAsset(assetId): Promise<AssetRelationView[]> {
      // One read transaction, so both directions describe the same snapshot.
      return db.transaction(
        (tx) => {
          const read = (direction: 'outgoing' | 'incoming'): AssetRelationView[] => {
            const own = direction === 'outgoing' ? assetRelation.fromAssetId : assetRelation.toAssetId;
            const otherId = direction === 'outgoing' ? assetRelation.toAssetId : assetRelation.fromAssetId;
            return tx
              .select({ relation: assetRelation, other: asset })
              .from(assetRelation)
              .innerJoin(asset, eq(asset.id, otherId))
              .where(eq(own, assetId))
              .orderBy(asc(assetRelation.kind), sql`lower(${asset.name})`, asc(asset.id))
              .all()
              .map((r) => ({
                fromAssetId: r.relation.fromAssetId,
                toAssetId: r.relation.toAssetId,
                kind: r.relation.kind,
                createdAt: r.relation.createdAt,
                direction,
                other: {
                  id: r.other.id,
                  name: r.other.name,
                  typeId: r.other.typeId,
                  description: r.other.description,
                  status: r.other.status,
                  createdAt: r.other.createdAt,
                  updatedAt: r.other.updatedAt,
                },
              }));
          };
          return [...read('outgoing'), ...read('incoming')];
        },
        { behavior: 'deferred' },
      );
    },
  };
}
