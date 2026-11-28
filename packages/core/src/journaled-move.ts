import type { FileRecord } from '@assetforge/contracts';
import { AssetForgeError, InvalidOperationError } from './errors.js';
import { resolvePendingFileMove } from './file-move-recovery.js';
import type { WorkspaceSession } from './session.js';

const MOVE_FAILED = 'The file could not be moved; it may be in use, missing, or the target already exists';

/**
 * Journaled move of a file to `target` (the move row is already begun): moves the binary, aborts the row on
 * failure, then commits through `commitMove`.
 *
 * @param session the open workspace
 * @param file the file to move
 * @param target the relative path it moves to
 * @returns the file as committed
 * @throws the move's AssetForgeError, else InvalidOperationError when the binary could not be moved, or the
 *   commit's error when the move could not be completed (see `commitMove`)
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
  return commitMove(session, file.id);
}

/**
 * Commits the begun move row of a file. When the commit fails, the row is resolved at once with the recovery rule
 * of the open (`resolvePendingFileMove`), so the file row and the binary agree again: a resolve that completes the
 * move answers the file as moved; one that discards the row (the binary moved back or never moved) rethrows the
 * commit's error. A resolve that fails too leaves the row for the recovery on the next open and rethrows the
 * commit's error as well.
 *
 * @param session the open workspace
 * @param fileId the file whose move row is committed
 * @returns the file as committed
 * @throws the commit's error when the move was not completed
 */
export async function commitMove(session: WorkspaceSession, fileId: string): Promise<FileRecord> {
  try {
    return await session.database.fileMoves.commit(fileId);
  } catch (error) {
    const completed = await isCompletedByResolve(session, fileId);
    const file = completed ? await session.database.files.get(fileId) : null;
    if (file === null) throw error;
    return file;
  }
}

/**
 * Resolves the open move row of a file after its commit failed; best effort.
 *
 * @param session the open workspace
 * @param fileId the file
 * @returns true when the resolve completed the move; false when it discarded the row, found none or failed
 */
async function isCompletedByResolve(session: WorkspaceSession, fileId: string): Promise<boolean> {
  try {
    const dependencies = {
      storage: session.storage,
      files: session.database.files,
      fileMoves: session.database.fileMoves,
    };
    return (await resolvePendingFileMove(dependencies, fileId)) === 'completed';
  } catch {
    // The row stays and is repaired by `recoverFileMoves` on the next open.
    return false;
  }
}
