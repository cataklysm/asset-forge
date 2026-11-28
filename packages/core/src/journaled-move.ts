import type { FileRecord } from '@assetforge/contracts';
import { AssetForgeError, InvalidOperationError } from './errors.js';
import type { WorkspaceSession } from './session.js';

const MOVE_FAILED = 'The file could not be moved; it may be in use, missing, or the target already exists';

/**
 * Journaled move of a file to `target` (the move row is already begun): moves the binary, aborts the row on
 * failure, then commits. A failed commit leaves the row for `recoverFileMoves` on the next open.
 *
 * @param session the open workspace
 * @param file the file to move
 * @param target the relative path it moves to
 * @returns the file as committed
 * @throws the move's AssetForgeError, else InvalidOperationError when the binary could not be moved
 */
export async function moveAndCommit(session: WorkspaceSession, file: FileRecord, target: string): Promise<FileRecord> {
  try {
    await session.storage.move(file.relativePath, target);
  } catch (error) {
    try {
      await session.database.fileMoves.abort(file.id);
    } catch {
      // The source is still in place, so recovery discards the row on the next open.
    }
    if (error instanceof AssetForgeError) throw error;
    throw new InvalidOperationError(MOVE_FAILED, { cause: error });
  }
  return session.database.fileMoves.commit(file.id);
}
