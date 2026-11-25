import { isOpenable, isPreviewable } from './media-types.js';
import { NotFoundError, StorageUnreachableError, ValidationFailedError } from './errors.js';
import type { WorkspaceSession } from './session.js';

export interface PreviewSource {
  sha256: string;
  absolutePath: string;
}

/** null unless the file exists, is complete, previewable and has a checksum. Storage errors propagate. */
export async function resolvePreviewSource(
  s: WorkspaceSession,
  fileId: string,
): Promise<PreviewSource | null> {
  const file = await s.database.files.get(fileId);
  if (file === null || file.status !== 'complete' || file.sha256 === null) return null;
  if (!isPreviewable(file.mimeType)) return null;
  return { sha256: file.sha256, absolutePath: await s.storage.absolutePath(file.relativePath) };
}

/** Absolute path for the shell. 'open' additionally requires isOpenable. */
export async function resolveFilePath(
  s: WorkspaceSession,
  fileId: string,
  purpose: 'open' | 'reveal',
): Promise<string> {
  const file = await s.database.files.get(fileId);
  if (file === null || file.status !== 'complete') throw new NotFoundError('File not found');
  if (!(await s.storage.isReachable())) {
    throw new StorageUnreachableError('The storage of this workspace is not reachable');
  }
  if (purpose === 'open' && !isOpenable(file.relativePath)) {
    throw new ValidationFailedError('This file type is never opened by AssetForge');
  }
  if (!(await s.storage.exists(file.relativePath))) {
    throw new NotFoundError('The file is missing on disk');
  }
  return s.storage.absolutePath(file.relativePath);
}
