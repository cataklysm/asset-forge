import type { AssetDetail, FileRecord } from '@assetforge/contracts';
import { NotFoundError, ValidationFailedError } from './errors.js';
import { isPreviewable } from './media-types.js';
import type { WorkspaceSession } from './session.js';

type CoverCandidate = Pick<FileRecord, 'id' | 'status' | 'mimeType' | 'importedAt'>;

/** The complete, previewable file with the earliest `importedAt`, ties by `id` ascending; null when there is none. */
export function automaticCover(files: readonly CoverCandidate[]): string | null {
  let best: CoverCandidate | null = null;
  for (const f of files) {
    if (f.status !== 'complete' || !isPreviewable(f.mimeType)) continue;
    // Plain code-unit comparison, like SQLite's BINARY collation.
    if (best === null || f.importedAt < best.importedAt || (f.importedAt === best.importedAt && f.id < best.id)) {
      best = f;
    }
  }
  return best?.id ?? null;
}

export async function getAssetDetail(s: WorkspaceSession, id: string): Promise<AssetDetail> {
  const asset = await s.database.assets.get(id);
  const cover = asset === null ? null : await s.database.assets.getCover(id);
  if (asset === null || cover === null) throw new NotFoundError(`Asset ${id} does not exist`);
  return { ...asset, ...cover };
}

/**
 * Chooses the cover of an asset, or returns to the automatic one with `fileId: null`. Only a
 * complete, previewable file attached to the asset can be chosen. Choosing is a change of the
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
    if (file === null || file.assetId !== assetId) {
      throw new ValidationFailedError(`File ${fileId} is not attached to asset ${assetId}`);
    }
    if (file.status !== 'complete') throw new ValidationFailedError(`File ${fileId} is not completely imported`);
    if (!isPreviewable(file.mimeType)) throw new ValidationFailedError(`File ${fileId} has no preview`);
  }
  await s.database.assets.setCover(assetId, fileId, s.now().toISOString());
  return getAssetDetail(s, assetId);
}
