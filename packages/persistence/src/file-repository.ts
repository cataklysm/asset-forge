import type { FileList, FileRecord, FileScope, ImportStatus } from '@assetforge/contracts';
import { NotFoundError, isOpenable, isPreviewable, type FileRepository } from '@assetforge/core';
import { and, asc, count, desc, eq, isNull, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { asset, file } from './schema.js';

// Row shape equals FileRecord; spelled out so schema drift fails at compile time.
export const toRecord = (row: typeof file.$inferSelect): FileRecord => ({
  id: row.id,
  storageId: row.storageId,
  assetId: row.assetId,
  role: row.role,
  originalName: row.originalName,
  relativePath: row.relativePath,
  mimeType: row.mimeType,
  sizeBytes: row.sizeBytes,
  sha256: row.sha256,
  status: row.status,
  error: row.error,
  importedAt: row.importedAt,
  previewable: isPreviewable(row.mimeType),
  openable: isOpenable(row.relativePath),
});

/**
 * Clears the chosen cover of every asset other than `assetId` (the file's new asset, or null for
 * the inbox) that uses the file. Leaves `updated_at` alone: this is a side effect, not an edit.
 */
export function clearCoverOutside(tx: Pick<BetterSQLite3Database, 'update'>, fileId: string, assetId: string | null): void {
  tx.update(asset)
    .set({ coverFileId: null })
    .where(and(eq(asset.coverFileId, fileId), sql`${asset.id} is not ${assetId}`))
    .run();
}

const scopeMatches =(scope: FileScope) => {
  switch (scope.kind) {
    case 'all':
      return undefined;
    case 'inbox':
      return isNull(file.assetId);
    case 'asset':
      return eq(file.assetId, scope.assetId);
  }
};

export function createFileRepository(db: BetterSQLite3Database): FileRepository {
  const requireChanged = (changes: number, id: string) => {
    if (changes === 0) throw new NotFoundError(`File ${id} does not exist`);
  };

  return {
    async insertPending(r) {
      db.insert(file)
        .values({
          id: r.id,
          storageId: r.storageId,
          originalName: r.originalName,
          relativePath: r.relativePath,
          mimeType: r.mimeType,
          importedAt: r.importedAt,
          status: 'pending',
        })
        .run();
    },
    async markComplete(id, r) {
      const { changes } = db
        .update(file)
        .set({ sizeBytes: r.sizeBytes, sha256: r.sha256, status: 'complete', error: null })
        .where(eq(file.id, id))
        .run();
      requireChanged(changes, id);
    },
    async markFailed(id, error) {
      const { changes } = db.update(file).set({ status: 'failed', error }).where(eq(file.id, id)).run();
      requireChanged(changes, id);
    },
    async findCompleteBySha256(sha256) {
      return db
        .select()
        .from(file)
        .where(and(eq(file.sha256, sha256), eq(file.status, 'complete')))
        .orderBy(asc(file.importedAt), asc(file.id))
        .all()
        .map(toRecord);
    },
    async listByStatus(status: ImportStatus) {
      return db
        .select()
        .from(file)
        .where(eq(file.status, status))
        .orderBy(asc(file.importedAt), asc(file.id))
        .all()
        .map(toRecord);
    },
    async get(id) {
      const row = db.select().from(file).where(eq(file.id, id)).get();
      return row ? toRecord(row) : null;
    },
    async setPlacement(id, placement) {
      // Throwing inside the transaction rolls back both statements.
      return db.transaction((tx) => {
        const row = tx
          .update(file)
          .set({ relativePath: placement.relativePath, assetId: placement.assetId, role: placement.role })
          .where(eq(file.id, id))
          .returning()
          .get();
        if (!row) throw new NotFoundError(`File ${id} does not exist`);
        clearCoverOutside(tx, id, placement.assetId);
        return toRecord(row);
      });
    },
    async list({ limit, offset, scope }): Promise<FileList> {
      const where = scopeMatches(scope);
      // One read transaction, so the page and the total describe the same snapshot.
      return db.transaction(
        (tx) => {
          const items = tx
            .select()
            .from(file)
            .where(where)
            .orderBy(desc(file.importedAt), desc(file.id))
            .limit(limit)
            .offset(offset)
            .all()
            .map(toRecord);
          const total = tx.select({ n: count() }).from(file).where(where).get()?.n ?? 0;
          return { items, total };
        },
        { behavior: 'deferred' },
      );
    },
  };
}
