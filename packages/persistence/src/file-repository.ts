import type { FileList, FileRecord, ImportStatus } from '@assetforge/contracts';
import type { FileRepository } from '@assetforge/core';
import { and, asc, count, desc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { file } from './schema.js';

// Row shape equals FileRecord; spelled out so schema drift fails at compile time.
const toRecord = (row: typeof file.$inferSelect): FileRecord => ({
  id: row.id,
  assetId: row.assetId,
  originalName: row.originalName,
  relativePath: row.relativePath,
  mimeType: row.mimeType,
  sizeBytes: row.sizeBytes,
  sha256: row.sha256,
  status: row.status,
  error: row.error,
  importedAt: row.importedAt,
});

export function createFileRepository(db: BetterSQLite3Database): FileRepository {
  return {
    async insertPending(r) {
      db.insert(file).values({ ...r, status: 'pending' }).run();
    },
    async markComplete(id, r) {
      db.update(file)
        .set({ sizeBytes: r.sizeBytes, sha256: r.sha256, status: 'complete', error: null })
        .where(eq(file.id, id))
        .run();
    },
    async markFailed(id, error) {
      db.update(file).set({ status: 'failed', error }).where(eq(file.id, id)).run();
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
    async list({ limit, offset }): Promise<FileList> {
      const items = db
        .select()
        .from(file)
        .orderBy(desc(file.importedAt), desc(file.id))
        .limit(limit)
        .offset(offset)
        .all()
        .map(toRecord);
      const total = db.select({ n: count() }).from(file).get()?.n ?? 0;
      return { items, total };
    },
  };
}
