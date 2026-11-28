import type { AssetDetail, FileRecord } from '@assetforge/contracts';
import { NotFoundError, ValidationFailedError } from './errors.js';
import { requireLiveFile } from './file-trash.js';
import { hasThumbnail, isPreviewable } from './media-types.js';
import type { WorkspaceSession } from './session.js';

/** The fields of a file the automatic cover is chosen by. */
type CoverCandidate = Pick<FileRecord, 'id' | 'status' | 'mimeType' | 'importedAt'>;

/**
 * The complete, previewable image with the earliest `importedAt`, ties by `id` ascending; only when there is none
 * the complete video chosen by the same order.
 *
 * @param files the files of the asset
 * @returns the id of the cover; null when there is neither
 */
export function automaticCover(files: readonly CoverCandidate[]): string | null {
  let best: CoverCandidate | null = null;
  for (const file of files) {
    if (file.status !== 'complete' || !hasThumbnail(file.mimeType)) continue;
    if (best === null || isBetterCover(file, best)) best = file;
  }
  return best?.id ?? null;
}

/**
 * Whether a candidate beats the cover chosen so far: an image beats a video, then the earlier import wins.
 *
 * @param file a complete file with a thumbnail
 * @param best the cover chosen so far
 * @returns true when `file` is the better cover
 */
function isBetterCover(file: CoverCandidate, best: CoverCandidate): boolean {
  const image = isPreviewable(file.mimeType);
  const bestImage = isPreviewable(best.mimeType);
  if (image !== bestImage) return image;
  // Plain code-unit comparison, like SQLite's BINARY collation.
  return file.importedAt < best.importedAt || (file.importedAt === best.importedAt && file.id < best.id);
}

/**
 * An asset with its cover, its tags and its sources.
 *
 * @param session the open workspace
 * @param id the asset
 * @returns the detail
 * @throws `NotFoundError` when the asset does not exist
 */
export async function getAssetDetail(session: WorkspaceSession, id: string): Promise<AssetDetail> {
  const detail = await session.database.assets.getDetail(id);
  if (detail === null) throw new NotFoundError(`Asset ${id} does not exist`);
  return detail;
}

/**
 * Chooses the cover of an asset, or returns to the automatic one with `fileId: null`. Only a
 * complete file with a thumbnail (a previewable image or a video) attached to the asset can be chosen. Choosing is a change of the
 * asset, so `updatedAt` moves.
 *
 * @param session the open workspace
 * @param request the asset and the chosen file, or null for the automatic cover
 * @returns the asset's detail
 * @throws `NotFoundError` for an unknown asset; `ValidationFailedError` for a file that cannot be the cover
 */
export async function setAssetCover(
  session: WorkspaceSession,
  request: { assetId: string; fileId: string | null },
): Promise<AssetDetail> {
  const { assetId, fileId } = request;
  if (!(await session.database.assets.setCover(assetId, fileId, session.now().toISOString()))) {
    await refuseCover(session, assetId, fileId);
  }
  return getAssetDetail(session, assetId);
}

/**
 * Explains why the guarded cover write wrote nothing; it always throws.
 *
 * @param session the open workspace
 * @param assetId the asset
 * @param fileId the chosen file; null for the automatic cover
 * @returns never resolves
 * @throws `NotFoundError` for an unknown asset; the trash refusal for a trashed file; `ValidationFailedError` for a
 *   file of another asset, an incomplete file or one without a preview
 */
async function refuseCover(session: WorkspaceSession, assetId: string, fileId: string | null): Promise<never> {
  if ((await session.database.assets.get(assetId)) === null) throw new NotFoundError(`Asset ${assetId} does not exist`);
  if (fileId !== null) await requireCoverFile(session, assetId, fileId);
  // The file changed between the write and this read.
  throw new ValidationFailedError(`File ${fileId} cannot be the cover of asset ${assetId}`);
}

/**
 * Refuses a file that cannot be chosen as the asset's cover.
 *
 * @param session the open workspace
 * @param assetId the asset
 * @param fileId the chosen file
 * @returns resolves when the file can be the cover
 * @throws the trash refusal for a trashed file; `ValidationFailedError` for a file of another asset, an incomplete
 *   file or one without a preview
 */
async function requireCoverFile(session: WorkspaceSession, assetId: string, fileId: string): Promise<void> {
  const file = await session.database.files.get(fileId);
  if (file !== null) requireLiveFile(file);
  if (file === null || file.assetId !== assetId) {
    throw new ValidationFailedError(`File ${fileId} is not attached to asset ${assetId}`);
  }
  if (file.status !== 'complete') throw new ValidationFailedError(`File ${fileId} is not completely imported`);
  if (!hasThumbnail(file.mimeType)) throw new ValidationFailedError(`File ${fileId} has no preview`);
}
