import { InvalidOperationError, NotFoundError, type FileMove, type FileMoveRepository } from '@assetforge/core';
import { asc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { clearCoverOutside, toRecordWithTags } from './file-repository.js';
import { file, fileMove } from './schema.js';

const toMove = (row: typeof fileMove.$inferSelect): FileMove => ({
  fileId: row.fileId,
  targetRelativePath: row.targetRelativePath,
  targetAssetId: row.targetAssetId,
  targetRole: row.targetRole,
  createdAt: row.createdAt,
});

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
            targetRelativePath: move.targetRelativePath,
            targetAssetId: move.targetAssetId,
            targetRole: move.targetRole,
            createdAt: move.createdAt,
          })
          .run();
      });
    },
    async commit(fileId) {
      // Throwing inside the transaction rolls back every statement.
      return db.transaction((tx) => {
        const move = tx.select().from(fileMove).where(eq(fileMove.fileId, fileId)).get();
        if (!move) throw new NotFoundError(`File ${fileId} has no move in progress`);
        const row = tx
          .update(file)
          .set({ relativePath: move.targetRelativePath, assetId: move.targetAssetId, role: move.targetRole })
          .where(eq(file.id, fileId))
          .returning()
          .get();
        if (!row) throw new NotFoundError(`File ${fileId} does not exist`);
        clearCoverOutside(tx, fileId, move.targetAssetId);
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
