import type { AssetRelation, AssetRelationView } from '@assetforge/contracts';
import { InvalidOperationError, NotFoundError } from './errors.js';
import type { RelationKey } from './ports/asset-repositories.js';
import type { WorkspaceSession } from './session.js';

/**
 * Refuses an unknown asset.
 *
 * @param session the open workspace
 * @param id the asset
 * @returns resolves when it exists
 * @throws `NotFoundError` otherwise
 */
async function requireAsset(session: WorkspaceSession, id: string): Promise<void> {
  if ((await session.database.assets.get(id)) === null) throw new NotFoundError(`Asset ${id} does not exist`);
}

/**
 * Relates two different assets; a relation that already exists is returned as stored.
 *
 * @param session the open workspace
 * @param key the two assets and the kind
 * @returns the relation
 * @throws `InvalidOperationError` for an asset related to itself, `NotFoundError` for an unknown asset
 */
export async function addRelation(session: WorkspaceSession, key: RelationKey): Promise<AssetRelation> {
  if (key.fromAssetId === key.toAssetId) {
    throw new InvalidOperationError('An asset cannot be related to itself');
  }
  await requireAsset(session, key.fromAssetId);
  await requireAsset(session, key.toAssetId);
  const relation: AssetRelation = { ...key, createdAt: session.now().toISOString() };
  if (await session.database.relations.insert(relation)) return relation;
  // Already existed: return the stored row, not the one that was just built.
  return (await storedRelation(session, key)) ?? relation;
}

/**
 * The stored outgoing relation of `key`.
 *
 * @param session the open workspace
 * @param key the two assets and the kind
 * @returns it; undefined when there is none
 */
async function storedRelation(session: WorkspaceSession, key: RelationKey): Promise<AssetRelation | undefined> {
  const existing = (await session.database.relations.listForAsset(key.fromAssetId)).find(
    (view) => view.direction === 'outgoing' && view.toAssetId === key.toAssetId && view.kind === key.kind,
  );
  if (!existing) return undefined;
  return {
    fromAssetId: existing.fromAssetId,
    toAssetId: existing.toAssetId,
    kind: existing.kind,
    createdAt: existing.createdAt,
  };
}

/**
 * Removes a relation; a missing one is no error.
 *
 * @param session the open workspace
 * @param key the two assets and the kind
 * @returns resolves once it is gone
 */
export async function removeRelation(session: WorkspaceSession, key: RelationKey): Promise<void> {
  await session.database.relations.remove(key);
}

/**
 * The relations of an asset in both directions.
 *
 * @param session the open workspace
 * @param assetId the asset
 * @returns them
 * @throws `NotFoundError` for an unknown asset
 */
export async function listRelations(session: WorkspaceSession, assetId: string): Promise<AssetRelationView[]> {
  await requireAsset(session, assetId);
  return session.database.relations.listForAsset(assetId);
}
