import type { Asset, AssetList, AssetStatus, AssetType } from '@assetforge/contracts';
import { NotFoundError } from './errors.js';
import type { AssetQuery } from './ports/asset-repositories.js';
import type { WorkspaceSession } from './session.js';
import { searchWords } from './search.js';
import { tagName } from './tags.js';
import { startWorkflow } from './workflows.js';

/**
 * An asset type that must exist.
 *
 * @param session the open workspace
 * @param typeId the asset type
 * @returns it
 * @throws `NotFoundError` when it does not exist
 */
async function requireType(session: WorkspaceSession, typeId: string): Promise<AssetType> {
  const type = await session.database.assetTypes.get(typeId);
  if (type === null) throw new NotFoundError(`Asset type ${typeId} does not exist`);
  return type;
}

/**
 * Creates a draft asset and starts the default workflow of its type, when the type has one.
 *
 * @param session the open workspace
 * @param input the name, the asset type and the optional description
 * @returns the new asset
 * @throws `NotFoundError` for an unknown asset type
 */
export async function createAsset(
  session: WorkspaceSession,
  input: { name: string; typeId: string; description?: string },
): Promise<Asset> {
  const type = await requireType(session, input.typeId);
  const now = session.now().toISOString();
  const asset: Asset = {
    id: session.newId(),
    name: input.name,
    typeId: input.typeId,
    description: input.description ?? '',
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };
  await session.database.assets.insert(asset);
  if (type.defaultWorkflowTemplateId !== null) await startWorkflow(session, asset.id);
  return asset;
}

/**
 * Changes the given fields of an asset; `updatedAt` moves.
 *
 * @param session the open workspace
 * @param id the asset
 * @param patch the fields to change
 * @returns the changed asset
 * @throws `NotFoundError` for an unknown asset or asset type
 */
export async function updateAsset(
  session: WorkspaceSession,
  id: string,
  patch: { name?: string; description?: string; typeId?: string; status?: AssetStatus },
): Promise<Asset> {
  if (patch.typeId !== undefined) await requireType(session, patch.typeId);
  const updated = await session.database.assets.update(id, { ...patch, updatedAt: session.now().toISOString() });
  if (updated === null) throw new NotFoundError(`Asset ${id} does not exist`);
  return updated;
}

/**
 * An asset that must exist.
 *
 * @param session the open workspace
 * @param id the asset
 * @returns it
 * @throws `NotFoundError` when it does not exist
 */
export async function getAsset(session: WorkspaceSession, id: string): Promise<Asset> {
  const asset = await session.database.assets.get(id);
  if (asset === null) throw new NotFoundError(`Asset ${id} does not exist`);
  return asset;
}

/**
 * One page of assets. A query without search words and an empty tag list filter nothing; tag names are
 * normalised and made distinct.
 *
 * @param session the open workspace
 * @param assetQuery the filter and the page
 * @returns the page
 */
export async function listAssets(session: WorkspaceSession, assetQuery: AssetQuery): Promise<AssetList> {
  const { query, tagNames, ...rest } = assetQuery;
  const names = tagNames === undefined ? [] : [...new Set(tagNames.map((tag) => tagName(tag).name))];
  return session.database.assets.list({
    ...rest,
    ...(query !== undefined && searchWords(query).length > 0 && { query }),
    ...(names.length > 0 && { tagNames: names }),
  });
}
