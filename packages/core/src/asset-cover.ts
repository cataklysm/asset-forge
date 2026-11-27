import type { AssetDetail, FileRecord } from '@assetforge/contracts';
import { NotFoundError, ValidationFailedError } from './errors.js';
import { requireLiveFile } from './file-trash.js';
import { hasThumbnail, isPreviewable } from './media-types.js';
import type { WorkspaceSession } from './session.js';

type CoverCandidate = Pick<FileRecord, 'id' | 'status' | 'mimeType' | 'importedAt'>;

/**
 * The complete, previewable image with the earliest `importedAt`, ties by `id` ascending; only when there is none
 * the complete video chosen by the same order; null when there is neither.
 */
export function automaticCover(files: readonly CoverCandidate[]): string | null {
  let best: CoverCandidate | null = null;
  for (const f of files) {
    if (f.status !== 'complete' || !hasThumbnail(f.mimeType)) continue;
    if (best === null) {
      best = f;
      continue;
    }
    const image = isPreviewable(f.mimeType);
    const bestImage = isPreviewable(best.mimeType);
    if (image !== bestImage) {
      if (image) best = f;
      continue;
    }
    // Plain code-unit comparison, like SQLite's BINARY collation.
    if (f.importedAt < best.importedAt || (f.importedAt === best.importedAt && f.id < best.id)) best = f;
  }
  return best?.id ?? null;
}

export async function getAssetDetail(s: WorkspaceSession, id: string): Promise<AssetDetail> {
  const asset = await s.database.assets.get(id);
  const cover = asset === null ? null : await s.database.assets.getCover(id);
  if (asset === null || cover === null) throw new NotFoundError(`Asset ${id} does not exist`);
  return {
    ...asset,
    ...cover,
    tags: await s.database.tags.listForAsset(id),
    sources: await s.database.assetSources.listByAsset(id),
  };
}

/**
 * Chooses the cover of an asset, or returns to the automatic one with `fileId: null`. Only a
 * complete file with a thumbnail (a previewable image or a video) attached to the asset can be chosen. Choosing is a change of the
 * asset, so `updatedAt` moves.
 */
export async function setAssetCover(
  s: WorkspaceSession,
  request: { assetId: string; fileId: string | null },
): Promise<AssetDetail> {
  const { assetId, fileId } = request;
  if ((await s.database.assets.get(assetId)) === null) throw new NotFoundError(`Asset ${assetId} does not exist`);
  if (fileId !== null) {
    const file = await s.database.files.get(fileId);
    if (file !== null) requireLiveFile(file);
    if (file === null || file.assetId !== assetId) {
      throw new ValidationFailedError(`File ${fileId} is not attached to asset ${assetId}`);
    }
    if (file.status !== 'complete') throw new ValidationFailedError(`File ${fileId} is not completely imported`);
    if (!hasThumbnail(file.mimeType)) throw new ValidationFailedError(`File ${fileId} has no preview`);
  }
  await s.database.assets.setCover(assetId, fileId, s.now().toISOString());
  return getAssetDetail(s, assetId);
}
