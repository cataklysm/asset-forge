import type { AssetRelationView } from '@assetforge/contracts';
import type { AssetRelationRepository } from '@assetforge/core';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { asset, assetRelation } from './schema.js';

/** What reading relations needs of a transaction handle. */
type RelationReader = Pick<BetterSQLite3Database, 'select'>;

/**
 * The asset relation repository over the workspace database.
 *
 * @param database the workspace database
 * @returns the repository
 */
export function createAssetRelationRepository(database: BetterSQLite3Database): AssetRelationRepository {
  return {
    insert: (relation) => insertRelation(database, relation),
    remove: (key) => removeRelation(database, key),
    listForAsset: (assetId) => listForAsset(database, assetId),
  };
}

/**
 * Inserts the relation unless it exists.
 *
 * @param database the workspace database
 * @param relation the relation
 * @returns false when it existed
 */
async function insertRelation(
  database: BetterSQLite3Database,
  relation: Parameters<AssetRelationRepository['insert']>[0],
): Promise<boolean> {
  const result = database
    .insert(assetRelation)
    .values({
      fromAssetId: relation.fromAssetId,
      toAssetId: relation.toAssetId,
      kind: relation.kind,
      createdAt: relation.createdAt,
    })
    .onConflictDoNothing()
    .run();
  return result.changes > 0;
}

/**
 * Deletes the relation.
 *
 * @param database the workspace database
 * @param key the two assets and the kind
 * @returns whether a relation was deleted
 */
async function removeRelation(
  database: BetterSQLite3Database,
  key: Parameters<AssetRelationRepository['remove']>[0],
): Promise<boolean> {
  const result = database
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
}

/**
 * The relations of an asset, outgoing first, then incoming.
 *
 * @param database the workspace database
 * @param assetId the asset
 * @returns the relations with the other asset
 */
async function listForAsset(database: BetterSQLite3Database, assetId: string): Promise<AssetRelationView[]> {
  // One read transaction, so both directions describe the same snapshot.
  return database.transaction(
    (transaction) => [
      ...relationsInDirection(transaction, assetId, 'outgoing'),
      ...relationsInDirection(transaction, assetId, 'incoming'),
    ],
    { behavior: 'deferred' },
  );
}

/**
 * The relations of an asset in one direction, by kind, then the other asset's name and id.
 *
 * @param transaction the caller's read transaction
 * @param assetId the asset
 * @param direction `outgoing` (the asset is `from`) or `incoming` (the asset is `to`)
 * @returns the relations with the other asset
 */
function relationsInDirection(
  transaction: RelationReader,
  assetId: string,
  direction: 'outgoing' | 'incoming',
): AssetRelationView[] {
  const own = direction === 'outgoing' ? assetRelation.fromAssetId : assetRelation.toAssetId;
  const otherId = direction === 'outgoing' ? assetRelation.toAssetId : assetRelation.fromAssetId;
  return transaction
    .select({ relation: assetRelation, other: asset })
    .from(assetRelation)
    .innerJoin(asset, eq(asset.id, otherId))
    .where(eq(own, assetId))
    .orderBy(asc(assetRelation.kind), sql`lower(${asset.name})`, asc(asset.id))
    .all()
    .map((row) => ({
      fromAssetId: row.relation.fromAssetId,
      toAssetId: row.relation.toAssetId,
      kind: row.relation.kind,
      createdAt: row.relation.createdAt,
      direction,
      other: {
        id: row.other.id,
        name: row.other.name,
        typeId: row.other.typeId,
        description: row.other.description,
        status: row.other.status,
        createdAt: row.other.createdAt,
        updatedAt: row.other.updatedAt,
      },
    }));
}
