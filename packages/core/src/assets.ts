import type { Asset, AssetList, AssetStatus, AssetType } from '@assetforge/contracts';
import { NotFoundError } from './errors.js';
import type { AssetQuery } from './ports.js';
import type { WorkspaceSession } from './session.js';
import { startWorkflow } from './workflows.js';

async function requireType(s: WorkspaceSession, typeId: string): Promise<AssetType> {
  const type = await s.database.assetTypes.get(typeId);
  if (type === null) throw new NotFoundError(`Asset type ${typeId} does not exist`);
  return type;
}

export async function createAsset(
  s: WorkspaceSession,
  input: { name: string; typeId: string; description?: string },
): Promise<Asset> {
  const type = await requireType(s, input.typeId);
  const now = s.now().toISOString();
  const asset: Asset = {
    id: s.newId(),
    name: input.name,
    typeId: input.typeId,
    description: input.description ?? '',
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };
  await s.database.assets.insert(asset);
  if (type.defaultWorkflowTemplateId !== null) await startWorkflow(s, asset.id);
  return asset;
}

export async function updateAsset(
  s: WorkspaceSession,
  id: string,
  patch: { name?: string; description?: string; typeId?: string; status?: AssetStatus },
): Promise<Asset> {
  if (patch.typeId !== undefined) await requireType(s, patch.typeId);
  const updated = await s.database.assets.update(id, { ...patch, updatedAt: s.now().toISOString() });
  if (updated === null) throw new NotFoundError(`Asset ${id} does not exist`);
  return updated;
}

export async function getAsset(s: WorkspaceSession, id: string): Promise<Asset> {
  const asset = await s.database.assets.get(id);
  if (asset === null) throw new NotFoundError(`Asset ${id} does not exist`);
  return asset;
}

export function listAssets(s: WorkspaceSession, q: AssetQuery): Promise<AssetList> {
  return s.database.assets.list(q);
}
