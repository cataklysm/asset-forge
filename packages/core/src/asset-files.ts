import type { FileRecord, FileRole, FileTarget } from '@assetforge/contracts';
import { InvalidOperationError, NotFoundError } from './errors.js';
import { eachFile, type FileBatchItem } from './file-batch.js';
import { requireLiveFile } from './file-trash.js';
import { moveAndCommit } from './journaled-move.js';
import { assetFilePath, inboxPath } from './paths.js';
import { requireAsset } from './require-asset.js';
import type { WorkspaceSession } from './session.js';

/** Where a file is placed: its relative path, and its asset and role (both null in the inbox). */
interface Placement {
  relativePath: string;
  assetId: string | null;
  role: FileRole | null;
}

/**
 * Attaches a complete file to an asset with a role (`target`), or detaches it back to the
 * inbox (`null`). A change of path is journaled: the move row is written before the file
 * moves and is committed together with the file row, so a crash in between is resolved by
 * `recoverFileMoves` on the next open. The target is never overwritten.
 *
 * @param session the open workspace
 * @param fileId the file to place
 * @param target the asset and role; null for the inbox
 * @returns the file as placed
 * @throws NotFoundError for an unknown file or asset, InvalidOperationError for a file in the trash, one not
 *   completely imported, or one whose binary could not be moved
 */
export async function relocateFile(
  session: WorkspaceSession,
  fileId: string,
  target: FileTarget | null,
): Promise<FileRecord> {
  const file = await requirePlaceableFile(session, fileId, target);
  const placement = placementOf(file, target);
  if (placement.relativePath === file.relativePath) {
    if (placement.assetId === file.assetId && placement.role === file.role) return file;
    return session.database.files.setPlacement(file.id, placement);
  }
  return moveJournaled(session, file, placement);
}

/**
 * The file to place, after the checks of the file and the target asset.
 *
 * @param session the open workspace
 * @param fileId the file to place
 * @param target the asset and role; null for the inbox
 * @returns the file as it is now
 * @throws NotFoundError for an unknown file or asset, InvalidOperationError for a file in the trash or one not
 *   completely imported
 */
async function requirePlaceableFile(
  session: WorkspaceSession,
  fileId: string,
  target: FileTarget | null,
): Promise<FileRecord> {
  const file = await session.database.files.get(fileId);
  if (file === null) throw new NotFoundError(`File ${fileId} does not exist`);
  requireLiveFile(file);
  if (file.status !== 'complete') {
    throw new InvalidOperationError(`File ${fileId} is not completely imported`);
  }
  if (target !== null) await requireAsset(session, target.assetId);
  return file;
}

/**
 * Where the file goes for a target.
 *
 * @param file the file to place
 * @param target the asset and role; null for the inbox
 * @returns the relative path, asset and role of the placement
 */
function placementOf(file: FileRecord, target: FileTarget | null): Placement {
  const relativePath =
    target === null
      ? inboxPath(file.id, file.originalName)
      : assetFilePath(target.assetId, target.role, file.id, file.originalName);
  return { relativePath, assetId: target?.assetId ?? null, role: target?.role ?? null };
}

/**
 * The journaled move: begins the move row, then moves the binary and commits through `moveAndCommit`.
 *
 * @param session the open workspace
 * @param file the file to move
 * @param placement where it goes
 * @returns the file as committed
 * @throws the move's AssetForgeError, else InvalidOperationError when the binary could not be moved
 */
async function moveJournaled(session: WorkspaceSession, file: FileRecord, placement: Placement): Promise<FileRecord> {
  await session.database.fileMoves.begin({
    fileId: file.id,
    kind: 'relocate',
    targetRelativePath: placement.relativePath,
    targetAssetId: placement.assetId,
    targetRole: placement.role,
    createdAt: session.now().toISOString(),
  });
  return moveAndCommit(session, file, placement.relativePath);
}

/**
 * Places several files on one asset with one role, one `relocateFile` after the other in request
 * order. Each file succeeds or fails on its own: an error is caught and reported for that file, and
 * the files before and after it are still placed.
 *
 * @param session the open workspace
 * @param request the files, the asset and the role
 * @returns one result per file, in request order
 */
export function assignFiles(
  session: WorkspaceSession,
  request: { fileIds: readonly string[]; assetId: string; role: FileRole },
): Promise<FileBatchItem[]> {
  const target: FileTarget = { assetId: request.assetId, role: request.role };
  return eachFile(request.fileIds, (fileId) => relocateFile(session, fileId, target));
}
