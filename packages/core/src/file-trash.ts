import type { FileRecord } from '@assetforge/contracts';
import { AssetForgeError, InvalidOperationError, NotFoundError, StorageUnreachableError } from './errors.js';
import { cancelJob, type JobControl } from './jobs.js';
import { assetFilePath, inboxPath, stagingPath, TRASH_DIR, trashPath } from './paths.js';
import type { FileRepository, Storage } from './ports.js';
import type { WorkspaceSession } from './session.js';

/** The outcome of one file of a batch: the file afterwards (null once it is gone) or the error. */
export type FileBatchItem = { fileId: string; file: FileRecord | null; error: Error | null };

const EMPTY_CHUNK = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MOVE_FAILED = 'The file could not be moved; it may be in use, missing, or the target already exists';

/** Runs `op` for each id in request order; a failure is reported for its file and never stops the next. */
async function eachFile(
  fileIds: readonly string[],
  op: (fileId: string) => Promise<FileRecord | null>,
): Promise<FileBatchItem[]> {
  const items: FileBatchItem[] = [];
  for (const fileId of fileIds) {
    try {
      items.push({ fileId, file: await op(fileId), error: null });
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

async function requireFile(s: WorkspaceSession, fileId: string): Promise<FileRecord> {
  const file = await s.database.files.get(fileId);
  if (file === null) throw new NotFoundError(`File ${fileId} does not exist`);
  return file;
}

/** Refuses a file in the trash: it can be restored or purged, but not placed, tagged, opened or analysed. */
export function requireLiveFile(file: FileRecord): void {
  if (file.deletedAt !== null) throw new InvalidOperationError('The file is in the trash');
}

async function requireReachable(s: WorkspaceSession): Promise<void> {
  if (!(await s.storage.isReachable())) {
    throw new StorageUnreachableError('The storage of this workspace is not reachable');
  }
}

/** Cancels every active job of the file; a running one is only asked to stop, not awaited. */
async function cancelFileJobs(s: WorkspaceSession, control: JobControl, fileId: string): Promise<void> {
  for (const job of await s.database.jobs.activeForFile(fileId)) await cancelJob(s, control, job.id);
}

/**
 * Journaled move of a file to `target` (the move row is already begun): moves the binary when
 * `moveBinary`, aborts the row on failure, then commits. A failed commit leaves the row for
 * `recoverFileMoves` on the next open.
 */
async function moveAndCommit(s: WorkspaceSession, file: FileRecord, target: string, moveBinary: boolean): Promise<FileRecord> {
  if (moveBinary) {
    try {
      await s.storage.move(file.relativePath, target);
    } catch (error) {
      try {
        await s.database.fileMoves.abort(file.id);
      } catch {
        // The source is still in place, so recovery discards the row on the next open.
      }
      if (error instanceof AssetForgeError) throw error;
      throw new InvalidOperationError(MOVE_FAILED, { cause: error });
    }
  }
  return s.database.fileMoves.commit(file.id);
}

/**
 * Moves files into the trash. A complete file keeps its tags, analysis and proposal; its origin is
 * recorded so a restore can return it. A failed import has nothing worth keeping and is removed
 * outright. A file whose binary is missing is still trashed, without a move.
 */
export function trashFiles(s: WorkspaceSession, control: JobControl, fileIds: readonly string[]): Promise<FileBatchItem[]> {
  return eachFile(fileIds, async (fileId) => {
    const file = await requireFile(s, fileId);
    if (file.status === 'pending') throw new InvalidOperationError('The file is still being imported');
    if (file.deletedAt !== null) throw new InvalidOperationError('The file is already in the trash');
    await requireReachable(s);

    if (file.status === 'failed') {
      await s.storage.remove(stagingPath(file.id));
      await s.storage.remove(file.relativePath);
      if (!(await s.database.files.purge(file.id))) throw new NotFoundError(`File ${fileId} does not exist`);
      return null;
    }

    await cancelFileJobs(s, control, file.id);
    const target = trashPath(file.id, file.originalName);
    await s.database.fileMoves.begin({
      fileId: file.id,
      kind: 'trash',
      targetRelativePath: target,
      targetAssetId: null,
      targetRole: null,
      createdAt: s.now().toISOString(),
    });
    let exists: boolean;
    try {
      exists = await s.storage.exists(file.relativePath);
    } catch (error) {
      await s.database.fileMoves.abort(file.id).catch(() => undefined);
      throw error;
    }
    return moveAndCommit(s, file, target, exists);
  });
}

/** Returns trashed files to their asset and role, or to the inbox when that asset is gone. */
export function restoreFiles(s: WorkspaceSession, fileIds: readonly string[]): Promise<FileBatchItem[]> {
  return eachFile(fileIds, async (fileId) => {
    const file = await requireFile(s, fileId);
    if (file.deletedAt === null) throw new InvalidOperationError('The file is not in the trash');
    await requireReachable(s);
    if (!(await s.storage.exists(file.relativePath))) {
      throw new InvalidOperationError('The file is missing on disk and cannot be restored');
    }

    const backToAsset =
      file.trashedAssetId !== null &&
      file.trashedRole !== null &&
      (await s.database.assets.get(file.trashedAssetId)) !== null;
    const assetId = backToAsset ? file.trashedAssetId : null;
    const role = backToAsset ? file.trashedRole : null;
    const target =
      assetId !== null && role !== null
        ? assetFilePath(assetId, role, file.id, file.originalName)
        : inboxPath(file.id, file.originalName);
    await s.database.fileMoves.begin({
      fileId: file.id,
      kind: 'restore',
      targetRelativePath: target,
      targetAssetId: assetId,
      targetRole: role,
      createdAt: s.now().toISOString(),
    });
    return moveAndCommit(s, file, target, true);
  });
}

/**
 * Deletes trashed files for good: the row (with its tags, analysis, proposal and jobs) first, then
 * the binary. A binary that cannot be removed now is left for `sweepTrash`; the file counts as purged.
 */
export function purgeFiles(s: WorkspaceSession, control: JobControl, fileIds: readonly string[]): Promise<FileBatchItem[]> {
  return eachFile(fileIds, async (fileId) => {
    const file = await requireFile(s, fileId);
    if (file.deletedAt === null) throw new InvalidOperationError('The file is not in the trash');
    await requireReachable(s);
    await cancelFileJobs(s, control, file.id);
    if (!(await s.database.files.purge(file.id))) throw new InvalidOperationError('The file is not in the trash');
    if (file.relativePath.startsWith(`${TRASH_DIR}/`)) {
      try {
        await s.storage.remove(file.relativePath);
      } catch {
        // Without a row the binary is an orphan; the sweep on the next open removes it.
      }
    }
    return null;
  });
}

/** Purges every file in the trash in chunks; counts the files purged and those that failed. */
export async function emptyTrash(s: WorkspaceSession, control: JobControl): Promise<{ purged: number; failed: number }> {
  const ids = await s.database.files.listTrashedIds();
  const result = { purged: 0, failed: 0 };
  for (let i = 0; i < ids.length; i += EMPTY_CHUNK) {
    for (const item of await purgeFiles(s, control, ids.slice(i, i + EMPTY_CHUNK))) {
      if (item.error === null) result.purged++;
      else result.failed++;
    }
  }
  return result;
}

export function trashCount(s: WorkspaceSession): Promise<number> {
  return s.database.files.countTrashed();
}

/**
 * Startup cleanup of the trash directory: an entry named `<file id>_…` whose id has no row is a
 * binary left behind by a purge and is removed. Every other entry stays. Never throws.
 */
export async function sweepTrash(ctx: {
  storage: Storage;
  files: Pick<FileRepository, 'get'>;
}): Promise<{ removed: string[]; skipped: string[] }> {
  const result = { removed: [] as string[], skipped: [] as string[] };
  let entries: string[];
  try {
    entries = await ctx.storage.list(TRASH_DIR);
  } catch {
    return result;
  }
  for (const name of entries) {
    const id = name.slice(0, 36);
    if (!UUID.test(id) || name[36] !== '_') continue;
    const path = `${TRASH_DIR}/${name}`;
    try {
      if ((await ctx.files.get(id)) !== null) continue;
      await ctx.storage.remove(path);
      result.removed.push(path);
    } catch {
      result.skipped.push(path);
    }
  }
  return result;
}
