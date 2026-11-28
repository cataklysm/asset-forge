import type { FileMove, FileMoveRepository, FileRepository } from './ports/file-repositories.js';
import type { Storage } from './ports/storage.js';

/**
 * Startup recovery of interrupted moves: a move whose target exists and whose source (the
 * file row's current path) is gone happened and is committed. Every other move is discarded
 * without touching the file row or either file. Best effort: a row that cannot be resolved
 * now stays and is retried on the next open.
 */
export async function recoverFileMoves(ctx: {
  storage: Storage;
  files: Pick<FileRepository, 'get'>;
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
      if ((await resolveFileMove(ctx, move)) === 'completed') result.completed.push(move.fileId);
      else result.discarded.push(move.fileId);
    } catch {
      // The row stays and is retried on the next open.
    }
  }
  return result;
}

type MoveContext = Parameters<typeof recoverFileMoves>[0];

/** The recovery rule for one move row: commit when the target exists and the source is gone, else abort. */
async function resolveFileMove(ctx: MoveContext, move: FileMove): Promise<'completed' | 'discarded'> {
  const file = await ctx.files.get(move.fileId);
  const moved =
    file !== null &&
    (await ctx.storage.exists(move.targetRelativePath)) &&
    !(await ctx.storage.exists(file.relativePath));
  if (moved) {
    await ctx.fileMoves.commit(move.fileId);
    return 'completed';
  }
  await ctx.fileMoves.abort(move.fileId);
  return 'discarded';
}

/**
 * Resolves an open move row of one file with the recovery rule, so a move whose commit failed in an
 * earlier session is completed or discarded before the file is acted on again. Null without a row.
 * Throws when the row cannot be resolved; it then stays for the next open.
 */
export async function resolvePendingFileMove(
  ctx: MoveContext,
  fileId: string,
): Promise<'completed' | 'discarded' | null> {
  const move = (await ctx.fileMoves.list()).find((m) => m.fileId === fileId);
  return move === undefined ? null : resolveFileMove(ctx, move);
}
