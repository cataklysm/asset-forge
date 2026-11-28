import type { Asset } from '@assetforge/contracts';
import { NotFoundError } from './errors.js';
import type { WorkspaceSession } from './session.js';

/**
 * An asset that must exist; the one check every use case on an asset starts with.
 *
 * @param session the open workspace
 * @param assetId the asset
 * @returns the asset
 * @throws `NotFoundError` (`not_found`) for an unknown asset
 */
export async function requireAsset(session: WorkspaceSession, assetId: string): Promise<Asset> {
  const asset = await session.database.assets.get(assetId);
  if (asset === null) throw new NotFoundError(`Asset ${assetId} does not exist`);
  return asset;
}
