import type { FileRecord, FileRole } from '@assetforge/contracts';
import { InvalidOperationError, NotFoundError, type FileMove, type FileMoveRepository } from '@assetforge/core';
import { asc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { clearCoverOutside, toRecordWithTags } from './file-records.js';
import { file, fileMove } from './schema.js';
import { reindexAssets } from './search-index.js';

/**
 * The journal entry of a row.
 *
 * @param row the move row
 * @returns the journal entry
 */
const toMove = (row: typeof fileMove.$inferSelect): FileMove => ({
  fileId: row.fileId,
  kind: row.kind,
  targetRelativePath: row.targetRelativePath,
  targetAssetId: row.targetAssetId,
  targetRole: row.targetRole,
  createdAt: row.createdAt,
});

/**
 * The placement columns a move commit writes, by kind. `trash` records the current asset and role as
 * the origin, clears them and stamps `deleted_at` with the move's time; `restore` places the file at
 * the move's target and clears the three trash columns; `relocate` places it at the target.
 *
 * @param move the move row
 * @param current the file's current asset and role
 * @returns the columns to write
 */
function placementOf(
  move: typeof fileMove.$inferSelect,
  current: { assetId: string | null; role: FileRole | null },
): Partial<typeof file.$inferInsert> {
  switch (move.kind) {
    case 'trash':
      return {
        assetId: null,
        role: null,
        deletedAt: move.createdAt,
        trashedAssetId: current.assetId,
        trashedRole: current.role,
      };
    case 'restore':
      return {
        assetId: move.targetAssetId,
        role: move.targetRole,
        deletedAt: null,
        trashedAssetId: null,
        trashedRole: null,
      };
    case 'relocate':
      return { assetId: move.targetAssetId, role: move.targetRole };
  }
}

/**
 * Keeps the trash invariant (a trashed file has no asset and no role) and its origin: only `trash`
 * leaves a live file for the trash, only `restore` brings a trashed file back.
 *
 * @param kind the move's kind
 * @param trashed whether the file is in the trash
 * @returns nothing; throws InvalidOperationError when the move does not fit
 */
function refuseAgainstTrash(kind: FileMove['kind'], trashed: boolean): void {
  if (kind === 'relocate' && trashed) throw new InvalidOperationError('The file is in the trash');
  if (kind === 'trash' && trashed) throw new InvalidOperationError('The file is already in the trash');
  if (kind === 'restore' && !trashed) throw new InvalidOperationError('The file is not in the trash');
}

/**
 * The file move journal over the workspace database.
 *
 * @param database the workspace database
 * @returns the repository
 */
export function createFileMoveRepository(database: BetterSQLite3Database): FileMoveRepository {
  return {
    begin: (move) => beginMove(database, move),
    commit: (fileId) => commitMove(database, fileId),
    abort: (fileId) => abortMove(database, fileId),
    list: () => listMoves(database),
  };
}

/**
 * Writes the journal row unless the file already has one.
 *
 * @param database the workspace database
 * @param move the journal entry
 * @returns nothing
 */
async function beginMove(database: BetterSQLite3Database, move: FileMove): Promise<void> {
  database.transaction((transaction) => {
    if (transaction.select().from(fileMove).where(eq(fileMove.fileId, move.fileId)).get()) {
      throw new InvalidOperationError(`File ${move.fileId} is already being moved`);
    }
    transaction
      .insert(fileMove)
      .values({
        fileId: move.fileId,
        kind: move.kind,
        targetRelativePath: move.targetRelativePath,
        targetAssetId: move.targetAssetId,
        targetRole: move.targetRole,
        createdAt: move.createdAt,
      })
      .run();
  });
}

/**
 * Copies the move's target into the file row, clears foreign covers, reindexes and deletes the journal row.
 *
 * @param database the workspace database
 * @param fileId the file
 * @returns the moved file
 */
async function commitMove(database: BetterSQLite3Database, fileId: string): Promise<FileRecord> {
  // Throwing inside the transaction rolls back every statement. The same commit runs in startup
  // recovery, so an interrupted move into or out of the trash ends consistent in either direction.
  return database.transaction((transaction) => {
    const move = transaction.select().from(fileMove).where(eq(fileMove.fileId, fileId)).get();
    if (!move) throw new NotFoundError(`File ${fileId} has no move in progress`);
    const current = transaction
      .select({ assetId: file.assetId, role: file.role, deletedAt: file.deletedAt })
      .from(file)
      .where(eq(file.id, fileId))
      .get();
    if (!current) throw new NotFoundError(`File ${fileId} does not exist`);
    // A refused commit keeps the journal row and the file row as they are.
    refuseAgainstTrash(move.kind, current.deletedAt !== null);
    // The row was read in this transaction just above, so the update always returns it.
    const row = transaction
      .update(file)
      .set({ relativePath: move.targetRelativePath, ...placementOf(move, current) })
      .where(eq(file.id, fileId))
      .returning()
      .get()!;
    // A trashed file is in no asset, so every chosen cover pointing at it is cleared; a restore
    // never makes it a chosen cover again.
    clearCoverOutside(transaction, fileId, row.assetId);
    reindexAssets(transaction, [current.assetId, row.assetId]);
    transaction.delete(fileMove).where(eq(fileMove.fileId, fileId)).run();
    return toRecordWithTags(transaction, row);
  });
}

/**
 * Deletes the journal row.
 *
 * @param database the workspace database
 * @param fileId the file
 * @returns nothing
 */
async function abortMove(database: BetterSQLite3Database, fileId: string): Promise<void> {
  database.delete(fileMove).where(eq(fileMove.fileId, fileId)).run();
}

/**
 * Every journal row, oldest first.
 *
 * @param database the workspace database
 * @returns the journal entries
 */
async function listMoves(database: BetterSQLite3Database): Promise<FileMove[]> {
  return database.select().from(fileMove).orderBy(asc(fileMove.createdAt), asc(fileMove.fileId)).all().map(toMove);
}
