import type { AssetRelation, AssetRelationView } from '@assetforge/contracts';
import { InvalidOperationError, NotFoundError } from './errors.js';
import type { RelationKey } from './ports.js';
import type { WorkspaceSession } from './session.js';

async function requireAsset(s: WorkspaceSession, id: string): Promise<void> {
  if ((await s.database.assets.get(id)) === null) throw new NotFoundError(`Asset ${id} does not exist`);
}

export async function addRelation(s: WorkspaceSession, key: RelationKey): Promise<AssetRelation> {
  if (key.fromAssetId === key.toAssetId) {
    throw new InvalidOperationError('An asset cannot be related to itself');
  }
  await requireAsset(s, key.fromAssetId);
  await requireAsset(s, key.toAssetId);
  const relation: AssetRelation = { ...key, createdAt: s.now().toISOString() };
  if (await s.database.relations.insert(relation)) return relation;
  // Already existed: return the stored row, not the one that was just built.
  const existing = (await s.database.relations.listForAsset(key.fromAssetId)).find(
    (r) => r.direction === 'outgoing' && r.toAssetId === key.toAssetId && r.kind === key.kind,
  );
  return existing
    ? { fromAssetId: existing.fromAssetId, toAssetId: existing.toAssetId, kind: existing.kind, createdAt: existing.createdAt }
    : relation;
}

export async function removeRelation(s: WorkspaceSession, key: RelationKey): Promise<void> {
  await s.database.relations.remove(key);
}

export async function listRelations(s: WorkspaceSession, assetId: string): Promise<AssetRelationView[]> {
  await requireAsset(s, assetId);
  return s.database.relations.listForAsset(assetId);
}
