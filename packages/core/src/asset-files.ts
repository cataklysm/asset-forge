import type { FileRecord, FileRole, FileTarget } from '@assetforge/contracts';
import { AssetForgeError, InvalidOperationError, NotFoundError } from './errors.js';
import { requireLiveFile } from './file-trash.js';
import { assetFilePath, inboxPath } from './paths.js';
import type { WorkspaceSession } from './session.js';

/**
 * Attaches a complete file to an asset with a role (`target`), or detaches it back to the
 * inbox (`null`). A change of path is journaled: the move row is written before the file
 * moves and is committed together with the file row, so a crash in between is resolved by
 * `recoverFileMoves` on the next open. The target is never overwritten.
 */
export async function relocateFile(
  s: WorkspaceSession,
  fileId: string,
  target: FileTarget | null,
): Promise<FileRecord> {
  const file = await s.database.files.get(fileId);
  if (file === null) throw new NotFoundError(`File ${fileId} does not exist`);
  requireLiveFile(file);
  if (file.status !== 'complete') {
    throw new InvalidOperationError(`File ${fileId} is not completely imported`);
  }
  if (target !== null && (await s.database.assets.get(target.assetId)) === null) {
    throw new NotFoundError(`Asset ${target.assetId} does not exist`);
  }

  const relativePath =
    target === null
      ? inboxPath(file.id, file.originalName)
      : assetFilePath(target.assetId, target.role, file.id, file.originalName);
  const assetId = target?.assetId ?? null;
  const role = target?.role ?? null;

  if (relativePath === file.relativePath) {
    if (assetId === file.assetId && role === file.role) return file;
    return s.database.files.setPlacement(file.id, { relativePath, assetId, role });
  }

  await s.database.fileMoves.begin({
    fileId: file.id,
    kind: 'relocate',
    targetRelativePath: relativePath,
    targetAssetId: assetId,
    targetRole: role,
    createdAt: s.now().toISOString(),
  });
  try {
    await s.storage.move(file.relativePath, relativePath);
  } catch (error) {
    try {
      await s.database.fileMoves.abort(file.id);
    } catch {
      // The source is still in place, so recovery discards the row on the next open.
    }
    if (error instanceof AssetForgeError) throw error;
    throw new InvalidOperationError(
      'The file could not be moved; it may be in use, missing, or the target already exists',
      { cause: error },
    );
  }
  // If the commit fails, the move row stays and recovery completes it on the next open.
  return s.database.fileMoves.commit(file.id);
}

/**
 * Places several files on one asset with one role, one `relocateFile` after the other in request
 * order. Each file succeeds or fails on its own: an error is caught and reported for that file, and
 * the files before and after it are still placed.
 */
export async function assignFiles(
  s: WorkspaceSession,
  r: { fileIds: readonly string[]; assetId: string; role: FileRole },
): Promise<{ fileId: string; file: FileRecord | null; error: Error | null }[]> {
  const target: FileTarget = { assetId: r.assetId, role: r.role };
  const results: { fileId: string; file: FileRecord | null; error: Error | null }[] = [];
  for (const fileId of r.fileIds) {
    try {
      results.push({ fileId, file: await relocateFile(s, fileId, target), error: null });
    } catch (error) {
      results.push({
        fileId,
        file: null,
        error: error instanceof Error ? error : new Error('Unexpected error', { cause: error }),
      });
    }
  }
  return results;
}
