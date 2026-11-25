import type { FileList, FileRecord, FileScope, FileTarget } from '@assetforge/contracts';
import { InvalidOperationError, NotFoundError } from './errors.js';
import { assetFilePath, inboxPath } from './paths.js';
import type { FileMoveRepository, Page, Storage } from './ports.js';
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
      // The target does not exist, so recovery discards the row on the next open.
    }
    throw error;
  }
  // If the commit fails, the move row stays and recovery completes it on the next open.
  return s.database.fileMoves.commit(file.id);
}

/**
 * Startup recovery of interrupted moves: a move whose target exists happened and is
 * committed; any other move never happened and is discarded. Best effort: a row that
 * cannot be resolved now stays and is retried on the next open.
 */
export async function recoverFileMoves(ctx: {
  storage: Storage;
  fileMoves: FileMoveRepository;
}): Promise<{ completed: string[]; discarded: string[] }> {
  const result = { completed: [] as string[], discarded: [] as string[] };
  let moves;
  try {
    moves = await ctx.fileMoves.list();
  } catch {
    return result;
  }
  for (const move of moves) {
    try {
      if (await ctx.storage.exists(move.targetRelativePath)) {
        await ctx.fileMoves.commit(move.fileId);
        result.completed.push(move.fileId);
      } else {
        await ctx.fileMoves.abort(move.fileId);
        result.discarded.push(move.fileId);
      }
    } catch {
      // The row stays and is retried on the next open.
    }
  }
  return result;
}

export function listFiles(s: WorkspaceSession, q: Page & { scope: FileScope }): Promise<FileList> {
  return s.database.files.list(q);
}
