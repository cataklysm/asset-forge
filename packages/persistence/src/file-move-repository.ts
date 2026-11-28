import type { FileRole } from '@assetforge/contracts';
import { InvalidOperationError, NotFoundError, type FileMove, type FileMoveRepository } from '@assetforge/core';
import { asc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { clearCoverOutside, toRecordWithTags } from './file-records.js';
import { file, fileMove } from './schema.js';
import { reindexAssets } from './search-index.js';

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
 */
function placementOf(
  move: typeof fileMove.$inferSelect,
  current: { assetId: string | null; role: FileRole | null },
): Partial<typeof file.$inferInsert> {
  switch (move.kind) {
    case 'trash':
      return { assetId: null, role: null, deletedAt: move.createdAt, trashedAssetId: current.assetId, trashedRole: current.role };
    case 'restore':
      return { assetId: move.targetAssetId, role: move.targetRole, deletedAt: null, trashedAssetId: null, trashedRole: null };
    case 'relocate':
      return { assetId: move.targetAssetId, role: move.targetRole };
  }
}

/**
 * Keeps the trash invariant (a trashed file has no asset and no role) and its origin: only `trash`
 * leaves a live file for the trash, only `restore` brings a trashed file back.
 */
function refuseAgainstTrash(kind: FileMove['kind'], trashed: boolean): void {
  if (kind === 'relocate' && trashed) throw new InvalidOperationError('The file is in the trash');
  if (kind === 'trash' && trashed) throw new InvalidOperationError('The file is already in the trash');
  if (kind === 'restore' && !trashed) throw new InvalidOperationError('The file is not in the trash');
}

export function createFileMoveRepository(db: BetterSQLite3Database): FileMoveRepository {
  return {
    async begin(move) {
      db.transaction((tx) => {
        if (tx.select().from(fileMove).where(eq(fileMove.fileId, move.fileId)).get()) {
          throw new InvalidOperationError(`File ${move.fileId} is already being moved`);
        }
        tx.insert(fileMove)
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
    },
    async commit(fileId) {
      // Throwing inside the transaction rolls back every statement. The same commit runs in startup
      // recovery, so an interrupted move into or out of the trash ends consistent in either direction.
      return db.transaction((tx) => {
        const move = tx.select().from(fileMove).where(eq(fileMove.fileId, fileId)).get();
        if (!move) throw new NotFoundError(`File ${fileId} has no move in progress`);
        const current = tx
          .select({ assetId: file.assetId, role: file.role, deletedAt: file.deletedAt })
          .from(file)
          .where(eq(file.id, fileId))
          .get();
        if (!current) throw new NotFoundError(`File ${fileId} does not exist`);
        // A refused commit keeps the journal row and the file row as they are.
        refuseAgainstTrash(move.kind, current.deletedAt !== null);
        const row = tx
          .update(file)
          .set({ relativePath: move.targetRelativePath, ...placementOf(move, current) })
          .where(eq(file.id, fileId))
          .returning()
          .get();
        if (!row) throw new NotFoundError(`File ${fileId} does not exist`);
        // A trashed file is in no asset, so every chosen cover pointing at it is cleared; a restore
        // never makes it a chosen cover again.
        clearCoverOutside(tx, fileId, row.assetId);
        reindexAssets(tx, [current.assetId, row.assetId]);
        tx.delete(fileMove).where(eq(fileMove.fileId, fileId)).run();
        return toRecordWithTags(tx, row);
      });
    },
    async abort(fileId) {
      db.delete(fileMove).where(eq(fileMove.fileId, fileId)).run();
    },
    async list() {
      return db.select().from(fileMove).orderBy(asc(fileMove.createdAt), asc(fileMove.fileId)).all().map(toMove);
    },
  };
}
