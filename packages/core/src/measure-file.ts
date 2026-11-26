import type { FileRecord } from '@assetforge/contracts';
import { NotFoundError, StorageUnreachableError } from './errors.js';
import { isPreviewable } from './media-types.js';
import type { WorkspaceSession } from './session.js';

/**
 * Stores the pixel size of a complete, previewable file that has none yet. Idempotent: a file that
 * already has dimensions is returned as is. A file whose size cannot be determined stays unchanged.
 * The probe runs outside any database transaction.
 */
export async function measureFile(s: WorkspaceSession, fileId: string): Promise<FileRecord> {
  const file = await s.database.files.get(fileId);
  if (file === null) throw new NotFoundError('File not found');
  if (file.status !== 'complete' || !isPreviewable(file.mimeType)) return file;
  if (file.width !== null && file.height !== null) return file;
  if (!(await s.storage.isReachable())) {
    throw new StorageUnreachableError('The storage of this workspace is not reachable');
  }
  if (!(await s.storage.exists(file.relativePath))) return file;
  let size: { width: number; height: number } | null;
  try {
    size = await s.imageProbe.measure(await s.storage.absolutePath(file.relativePath));
  } catch {
    return file;
  }
  return size === null ? file : s.database.files.setDimensions(file.id, size);
}
