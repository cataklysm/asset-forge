import { IMAGE_GENERATE_JOB, type FileRecord, type FileRole } from '@assetforge/contracts';
import { resolvePendingFileMove } from './file-move-recovery.js';
import { AssetForgeError, InvalidOperationError, NotFoundError, StorageUnreachableError } from './errors.js';
import { settleGenerationOfJob } from './generations.js';
import { cancelJob, type JobControl } from './jobs.js';
import { assetFilePath, inboxPath, stagingPath, TRASH_DIR, trashPath } from './paths.js';
import type { WorkspaceSession } from './session.js';

/** The outcome of one file of a batch: the file afterwards (null once it is gone) or the error. */
export type FileBatchItem = { fileId: string; file: FileRecord | null; error: Error | null };

/** Where a restored file goes: its relative path, and its asset and role (both null in the inbox). */
interface RestorePlacement {
  relativePath: string;
  assetId: string | null;
  role: FileRole | null;
}

/** How many files `emptyTrash` purges in one batch. */
const EMPTY_CHUNK = 200;
/** The refusal of a purge while a generation of the file runs. */
export const RUNNING_GENERATION_MESSAGE = 'This file still has a running generation';
const MOVE_FAILED = 'The file could not be moved; it may be in use, missing, or the target already exists';
const NOT_IN_TRASH = 'The file is not in the trash';

/**
 * Runs `operation` for each id in request order; a failure is reported for its file and never stops the next.
 *
 * @param fileIds the files, in request order
 * @param operation the work for one file; resolves to the file afterwards, null once it is gone
 * @returns one item per file, in request order
 */
async function eachFile(
  fileIds: readonly string[],
  operation: (fileId: string) => Promise<FileRecord | null>,
): Promise<FileBatchItem[]> {
  const items: FileBatchItem[] = [];
  for (const fileId of fileIds) {
    try {
      items.push({ fileId, file: await operation(fileId), error: null });
    } catch (error) {
      items.push({
        fileId,
        file: null,
        error: error instanceof Error ? error : new Error('Unexpected error', { cause: error }),
      });
    }
  }
  return items;
}

/**
 * The file row.
 *
 * @param session the open workspace
 * @param fileId the file
 * @returns the file
 * @throws NotFoundError for an unknown file
 */
async function requireFile(session: WorkspaceSession, fileId: string): Promise<FileRecord> {
  const file = await session.database.files.get(fileId);
  if (file === null) throw new NotFoundError(`File ${fileId} does not exist`);
  return file;
}

/**
 * Refuses a file in the trash: it can be restored or purged, but not placed, tagged, opened or analysed.
 *
 * @param file the file to check
 * @throws InvalidOperationError for a file in the trash
 */
export function requireLiveFile(file: FileRecord): void {
  if (file.deletedAt !== null) throw new InvalidOperationError('The file is in the trash');
}

/**
 * Refuses while the storage of the workspace cannot be reached.
 *
 * @param session the open workspace
 * @returns resolves when the storage is reachable
 * @throws StorageUnreachableError otherwise
 */
async function requireReachable(session: WorkspaceSession): Promise<void> {
  if (!(await session.storage.isReachable())) {
    throw new StorageUnreachableError('The storage of this workspace is not reachable');
  }
}

/**
 * Resolves an open move row of the file left by an earlier failed commit (see `recoverFileMoves`).
 *
 * @param session the open workspace
 * @param fileId the file
 * @returns how the row was resolved; null without a row
 */
function resolvePendingMove(session: WorkspaceSession, fileId: string): Promise<'completed' | 'discarded' | null> {
  return resolvePendingFileMove(
    { storage: session.storage, files: session.database.files, fileMoves: session.database.fileMoves },
    fileId,
  );
}

/**
 * The file after an open move row of it is resolved: read again when there was one, else as it was.
 *
 * @param session the open workspace
 * @param file the file as read before
 * @returns the current file
 */
async function afterPendingMove(session: WorkspaceSession, file: FileRecord): Promise<FileRecord> {
  if ((await resolvePendingMove(session, file.id)) === null) return file;
  return requireFile(session, file.id);
}

/**
 * Cancels the active jobs of a file being trashed; a running one is only asked to stop, not awaited. A running
 * generation is paid work and finishes (its result goes to the asset the file was in); a waiting one is cancelled
 * only while it is still pending, so one claimed meanwhile finishes too.
 *
 * @param session the open workspace
 * @param control the job control that stops running jobs
 * @param fileId the file being trashed
 * @returns resolves once every job is cancelled or asked to stop
 */
async function cancelJobsOnTrash(session: WorkspaceSession, control: JobControl, fileId: string): Promise<void> {
  for (const job of await session.database.jobs.activeForFile(fileId)) {
    if (job.type !== IMAGE_GENERATE_JOB) await cancelJob(session, control, job.id);
    else if (job.status !== 'running') await cancelJob(session, control, job.id, { pendingOnly: true });
  }
}

/**
 * Ends the jobs of a file before its purge. Refused while a generation of the file runs. The check and the cancel
 * of every pending job (a generation settled `cancelled`) are one transaction, so no generation can start in
 * between; a running job of another type is then asked to stop.
 *
 * @param session the open workspace
 * @param control the job control that stops running jobs
 * @param fileId the file being purged
 * @returns resolves once every job is cancelled or asked to stop
 * @throws InvalidOperationError while a generation of the file runs
 */
async function cancelJobsOnPurge(session: WorkspaceSession, control: JobControl, fileId: string): Promise<void> {
  const { refused } = await session.database.jobs.cancelPendingOfFile({
    fileId,
    refuseRunning: [IMAGE_GENERATE_JOB],
    now: session.now().toISOString(),
    settled: (job) => settleGenerationOfJob(session, job, { status: 'cancelled' }),
  });
  if (refused) throw new InvalidOperationError(RUNNING_GENERATION_MESSAGE);
  for (const job of await session.database.jobs.activeForFile(fileId)) await cancelJob(session, control, job.id);
}

/**
 * Refuses a purge before anything is written while a generation of the file runs.
 *
 * @param session the open workspace
 * @param fileId the file to purge
 * @returns resolves when no generation of the file runs
 * @throws InvalidOperationError otherwise
 */
async function refuseRunningGeneration(session: WorkspaceSession, fileId: string): Promise<void> {
  const jobs = await session.database.jobs.activeForFile(fileId);
  if (jobs.some((job) => job.type === IMAGE_GENERATE_JOB && job.status === 'running')) {
    throw new InvalidOperationError(RUNNING_GENERATION_MESSAGE);
  }
}

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
async function moveAndCommit(session: WorkspaceSession, file: FileRecord, target: string): Promise<FileRecord> {
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

/**
 * Moves files into the trash. A complete file keeps its tags, analysis and proposal; its origin is
 * recorded so a restore can return it. A failed import has nothing worth keeping and is removed
 * outright. A file whose binary is missing is still trashed, without a move.
 *
 * @param session the open workspace
 * @param control the job control that stops running jobs of the files
 * @param fileIds the files, in request order
 * @returns one item per file: the trashed file, null for a removed failed import, or the error
 */
export function trashFiles(
  session: WorkspaceSession,
  control: JobControl,
  fileIds: readonly string[],
): Promise<FileBatchItem[]> {
  return eachFile(fileIds, (fileId) => trashFile(session, control, fileId));
}

/**
 * Moves one file into the trash, or removes it when its import failed.
 *
 * @param session the open workspace
 * @param control the job control that stops running jobs of the file
 * @param fileId the file
 * @returns the trashed file; null for a removed failed import
 */
async function trashFile(session: WorkspaceSession, control: JobControl, fileId: string): Promise<FileRecord | null> {
  const file = await requireFile(session, fileId);
  if (file.status === 'pending') throw new InvalidOperationError('The file is still being imported');
  if (file.deletedAt !== null) throw new InvalidOperationError('The file is already in the trash');
  await requireReachable(session);

  if (file.status === 'failed') {
    await removeFailedImport(session, file);
    return null;
  }

  await cancelJobsOnTrash(session, control, file.id);
  const target = trashPath(file.id, file.originalName);
  await session.database.fileMoves.begin({
    fileId: file.id,
    kind: 'trash',
    targetRelativePath: target,
    targetAssetId: null,
    targetRole: null,
    createdAt: session.now().toISOString(),
  });
  if (!(await isBinaryPresent(session, file))) return session.database.fileMoves.commit(file.id);
  return moveAndCommit(session, file, target);
}

/**
 * Removes a failed import outright: its staging and inbox paths, then its row.
 *
 * @param session the open workspace
 * @param file the failed file
 * @returns resolves once the row is gone
 * @throws NotFoundError when the row was already gone
 */
async function removeFailedImport(session: WorkspaceSession, file: FileRecord): Promise<void> {
  await session.storage.remove(stagingPath(file.id));
  await session.storage.remove(file.relativePath);
  if (!(await session.database.files.purge(file.id))) throw new NotFoundError(`File ${file.id} does not exist`);
}

/**
 * Whether the binary of a file being trashed is there; aborts the begun move row when the check fails.
 *
 * @param session the open workspace
 * @param file the file being trashed
 * @returns true when the binary exists, false when it is missing on a reachable storage
 * @throws the failure of the check, StorageUnreachableError among them
 */
async function isBinaryPresent(session: WorkspaceSession, file: FileRecord): Promise<boolean> {
  try {
    const exists = await session.storage.exists(file.relativePath);
    // A share that dropped after the first check also answers "missing": never trash as missing then.
    if (!exists) await requireReachable(session);
    return exists;
  } catch (error) {
    await session.database.fileMoves.abort(file.id).catch(() => undefined);
    throw error;
  }
}

/**
 * Returns trashed files to their asset and role, or to the inbox when that asset is gone.
 *
 * @param session the open workspace
 * @param fileIds the files, in request order
 * @returns one item per file: the restored file or the error
 */
export function restoreFiles(session: WorkspaceSession, fileIds: readonly string[]): Promise<FileBatchItem[]> {
  return eachFile(fileIds, (fileId) => restoreFile(session, fileId));
}

/**
 * Returns one trashed file.
 *
 * @param session the open workspace
 * @param fileId the file
 * @returns the restored file
 */
async function restoreFile(session: WorkspaceSession, fileId: string): Promise<FileRecord> {
  const trashed = await requireFile(session, fileId);
  if (trashed.deletedAt === null) throw new InvalidOperationError(NOT_IN_TRASH);
  await requireReachable(session);
  const file = await afterPendingMove(session, trashed);
  // An earlier restore whose commit failed has just been completed.
  if (file.deletedAt === null) return file;
  await requireBinaryToRestore(session, file);

  const placement = await restorePlacementOf(session, file);
  await session.database.fileMoves.begin({
    fileId: file.id,
    kind: 'restore',
    targetRelativePath: placement.relativePath,
    targetAssetId: placement.assetId,
    targetRole: placement.role,
    createdAt: session.now().toISOString(),
  });
  return moveAndCommit(session, file, placement.relativePath);
}

/**
 * Refuses a restore whose binary is missing.
 *
 * @param session the open workspace
 * @param file the trashed file
 * @returns resolves when the binary exists
 * @throws StorageUnreachableError when the storage dropped meanwhile, else InvalidOperationError
 */
async function requireBinaryToRestore(session: WorkspaceSession, file: FileRecord): Promise<void> {
  if (await session.storage.exists(file.relativePath)) return;
  // A storage that dropped after the first check answers the storage error, not "missing".
  await requireReachable(session);
  throw new InvalidOperationError('The file is missing on disk and cannot be restored');
}

/**
 * Where a restored file goes: back to its asset and role while that asset exists, else to the inbox.
 *
 * @param session the open workspace
 * @param file the trashed file
 * @returns the relative path, asset and role of the restored file
 */
async function restorePlacementOf(session: WorkspaceSession, file: FileRecord): Promise<RestorePlacement> {
  const isBackToAsset =
    file.trashedAssetId !== null &&
    file.trashedRole !== null &&
    (await session.database.assets.get(file.trashedAssetId)) !== null;
  const assetId = isBackToAsset ? file.trashedAssetId : null;
  const role = isBackToAsset ? file.trashedRole : null;
  const relativePath =
    assetId !== null && role !== null
      ? assetFilePath(assetId, role, file.id, file.originalName)
      : inboxPath(file.id, file.originalName);
  return { relativePath, assetId, role };
}

/**
 * Deletes trashed files for good: the row (with its tags, analysis, proposal and jobs) first, then
 * the binary. A binary that cannot be removed now is left for `sweepTrash`; the file counts as purged. A file
 * with a running generation is refused (`This file still has a running generation`) before anything is written.
 *
 * @param session the open workspace
 * @param control the job control that stops running jobs of the files
 * @param fileIds the files, in request order
 * @returns one item per file: null for a purged file, or the error
 */
export function purgeFiles(
  session: WorkspaceSession,
  control: JobControl,
  fileIds: readonly string[],
): Promise<FileBatchItem[]> {
  return eachFile(fileIds, (fileId) => purgeFile(session, control, fileId));
}

/**
 * Deletes one trashed file for good.
 *
 * @param session the open workspace
 * @param control the job control that stops running jobs of the file
 * @param fileId the file
 * @returns null once the file is purged
 */
async function purgeFile(session: WorkspaceSession, control: JobControl, fileId: string): Promise<null> {
  const trashed = await requireFile(session, fileId);
  if (trashed.deletedAt === null) throw new InvalidOperationError(NOT_IN_TRASH);
  await requireReachable(session);
  await refuseRunningGeneration(session, trashed.id);
  const file = await afterPendingMove(session, trashed);
  // An earlier restore whose commit failed has just been completed: the file is live again.
  if (file.deletedAt === null) throw new InvalidOperationError(NOT_IN_TRASH);
  await cancelJobsOnPurge(session, control, file.id);
  if (!(await session.database.files.purge(file.id))) throw new InvalidOperationError(NOT_IN_TRASH);
  await removePurgedBinary(session, file);
  return null;
}

/**
 * Removes the binary of a purged file from the trash directory, then its tombstone; best effort.
 *
 * @param session the open workspace
 * @param file the purged file as it was read
 * @returns resolves once done; never rejects
 */
async function removePurgedBinary(session: WorkspaceSession, file: FileRecord): Promise<void> {
  if (!file.relativePath.startsWith(`${TRASH_DIR}/`)) return;
  try {
    await session.storage.remove(file.relativePath);
    await session.database.files.forgetPurge(file.id);
  } catch {
    // The tombstone stays; the sweep on the next open removes the binary and then the tombstone.
  }
}

/**
 * Purges every file in the trash in chunks.
 *
 * @param session the open workspace
 * @param control the job control that stops running jobs of the files
 * @returns how many files were purged and how many failed
 */
export async function emptyTrash(
  session: WorkspaceSession,
  control: JobControl,
): Promise<{ purged: number; failed: number }> {
  const ids = await session.database.files.listTrashedIds();
  const result = { purged: 0, failed: 0 };
  for (let i = 0; i < ids.length; i += EMPTY_CHUNK) {
    for (const item of await purgeFiles(session, control, ids.slice(i, i + EMPTY_CHUNK))) {
      if (item.error === null) result.purged++;
      else result.failed++;
    }
  }
  return result;
}

/**
 * The number of files in the trash.
 *
 * @param session the open workspace
 * @returns the count
 */
export function trashCount(session: WorkspaceSession): Promise<number> {
  return session.database.files.countTrashed();
}
