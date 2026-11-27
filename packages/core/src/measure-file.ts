import type { FileRecord } from '@assetforge/contracts';
import { NotFoundError, StorageUnreachableError } from './errors.js';
import { isPreviewable, videoFormat } from './media-types.js';
import type { VideoInfo } from './ports.js';
import type { WorkspaceSession } from './session.js';

const isPositiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0;

/** A width or height that is not a positive integer makes the answer unknown; such a duration makes only the duration unknown. */
function validVideoInfo(info: VideoInfo | null): VideoInfo | null {
  if (info === null || !isPositiveInteger(info.width) || !isPositiveInteger(info.height)) return null;
  const durationMs = info.durationMs !== null && isPositiveInteger(info.durationMs) ? info.durationMs : null;
  return { width: info.width, height: info.height, durationMs };
}

/**
 * Stores the pixel size of a complete, previewable file that has none yet, and for a complete video its
 * displayed size and duration through the video probe. Idempotent: a file that already has dimensions is
 * returned as is. A file whose size cannot be determined stays unchanged. The probe runs outside any
 * database transaction.
 */
export async function measureFile(s: WorkspaceSession, fileId: string): Promise<FileRecord> {
  const file = await s.database.files.get(fileId);
  if (file === null) throw new NotFoundError('File not found');
  const video = videoFormat(file.mimeType);
  if (file.status !== 'complete' || (video === null && !isPreviewable(file.mimeType))) return file;
  if (file.width !== null && file.height !== null) return file;
  if (!(await s.storage.isReachable())) {
    throw new StorageUnreachableError('The storage of this workspace is not reachable');
  }
  if (!(await s.storage.exists(file.relativePath))) return file;
  const absolutePath = await s.storage.absolutePath(file.relativePath);
  let size: { width: number; height: number; durationMs?: number | null } | null;
  try {
    size = video === null ? await s.imageProbe.measure(absolutePath) : validVideoInfo(await s.videoProbe.measure(absolutePath, video));
  } catch {
    return file;
  }
  return size === null ? file : s.database.files.setDimensions(file.id, size);
}
