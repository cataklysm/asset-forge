import { InvalidOperationError } from './errors.js';
import type { FileRecord } from '@assetforge/contracts';
import type { FileMove, FileMoveRepository, FileRepository } from './ports/file-repositories.js';
import type { Storage } from './ports/storage.js';
import { requireReachableStorage } from './storage-reachability.js';

/** What the recovery of moves reads and writes. */
export interface MoveRecoveryDependencies {
  storage: Storage;
  files: Pick<FileRepository, 'get'>;
  fileMoves: FileMoveRepository;
}

/** How one move row was resolved. */
type MoveResolution = 'completed' | 'discarded';

/**
 * Startup recovery of interrupted moves: a move whose target exists and whose source (the
 * file row's current path) is gone happened and is committed. Every other move is discarded
 * without touching the file row or either file. Best effort: a row that cannot be resolved
 * now stays and is retried on the next open.
 *
 * @param dependencies the storage, the files and the move rows of the workspace
 * @returns the ids of the files whose move was completed and of those whose move was discarded
 */
export async function recoverFileMoves(
  dependencies: MoveRecoveryDependencies,
): Promise<{ completed: string[]; discarded: string[] }> {
  const result = { completed: [] as string[], discarded: [] as string[] };
  let moves;
  try {
    moves = await dependencies.fileMoves.list();
  } catch {
    return result;
  }
  for (const move of moves) {
    try {
      if ((await resolveFileMove(dependencies, move)) === 'completed') result.completed.push(move.fileId);
      else result.discarded.push(move.fileId);
    } catch {
      // The row stays and is retried on the next open.
    }
  }
  return result;
}

/**
 * Commits a move whose binary already moved. A commit the repository refuses because the kind no longer fits the
 * file (a relocate or trash of a file in the trash, a restore of one outside it) would be refused on every open and
 * block restore and purge, so the binary is moved back to the path the file row still holds and the row is then
 * discarded. The move back never overwrites a binary at that path; when it fails the row stays for the next open.
 *
 * @param dependencies the storage, the files and the move rows of the workspace
 * @param move the open move row
 * @param file the file row of the move
 * @returns how the row was resolved
 * @throws when the commit fails otherwise or the binary cannot be moved back; the row then stays
 */
async function commitOrDiscard(
  dependencies: MoveRecoveryDependencies,
  move: FileMove,
  file: FileRecord,
): Promise<MoveResolution> {
  try {
    await dependencies.fileMoves.commit(move.fileId);
    return 'completed';
  } catch (error) {
    if (!(error instanceof InvalidOperationError)) throw error;
    // `move` rejects when the old path exists, so a binary there is never overwritten.
    await dependencies.storage.move(move.targetRelativePath, file.relativePath);
    await dependencies.fileMoves.abort(move.fileId);
    return 'discarded';
  }
}

/**
 * The recovery rule for one move row: commit when the target exists and the source is gone, else abort while the
 * storage is still reachable after the checks.
 *
 * @param dependencies the storage, the files and the move rows of the workspace
 * @param move the open move row
 * @returns how the row was resolved
 * @throws StorageUnreachableError when the storage cannot be reached before an abort; the row then stays
 */
async function resolveFileMove(dependencies: MoveRecoveryDependencies, move: FileMove): Promise<MoveResolution> {
  const file = await dependencies.files.get(move.fileId);
  const isMoved =
    file !== null &&
    (await dependencies.storage.exists(move.targetRelativePath)) &&
    !(await dependencies.storage.exists(file.relativePath));
  // The move is one atomic rename, so an existing target means it happened; a source that only looked missing
  // because the share dropped can at most leave an orphan behind, never a row that points at nothing.
  if (isMoved) return commitOrDiscard(dependencies, move, file);
  // A share that dropped during the checks answers "missing"; never take that for a move that did not happen.
  await requireReachableStorage(dependencies.storage);
  await dependencies.fileMoves.abort(move.fileId);
  return 'discarded';
}

/**
 * Resolves an open move row of one file with the recovery rule, so a move whose commit failed in an
 * earlier session is completed or discarded before the file is acted on again.
 *
 * @param dependencies the storage, the files and the move rows of the workspace
 * @param fileId the file whose move row is resolved
 * @returns how the row was resolved; null without a row
 * @throws when the row cannot be resolved; it then stays for the next open
 */
export async function resolvePendingFileMove(
  dependencies: MoveRecoveryDependencies,
  fileId: string,
): Promise<MoveResolution | null> {
  const move = (await dependencies.fileMoves.list()).find((candidate) => candidate.fileId === fileId);
  return move === undefined ? null : resolveFileMove(dependencies, move);
}
