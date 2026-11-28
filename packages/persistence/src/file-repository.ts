import { IMAGE_GENERATE_JOB } from '@assetforge/contracts';
import type { FileList, ImportStatus } from '@assetforge/contracts';
import { InvalidOperationError, NotFoundError, RUNNING_GENERATION_MESSAGE, type FileRepository } from '@assetforge/core';
import { and, asc, count, desc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { countQuery, fileListWhere, live, pageQuery, trashed } from './file-list.js';
import { clearCoverOutside, toRecordWithTags, toRecords } from './file-records.js';
import { file, fileAnalysis, fileAnalysisProposal, fileMove, fileOrigin, filePurge, fileTag, job } from './schema.js';
import { assetOfFile, reindexAssets } from './search-index.js';

export function createFileRepository(db: BetterSQLite3Database): FileRepository {
  return {
    async insertPending(r) {
      db.transaction((tx) => {
        tx.insert(file)
          .values({
            id: r.id,
            storageId: r.storageId,
            originalName: r.originalName,
            relativePath: r.relativePath,
            mimeType: r.mimeType,
            importedAt: r.importedAt,
            kind: r.kind,
            status: 'pending',
          })
          .run();
        if (r.origin !== undefined) {
          tx.insert(fileOrigin).values({ id: r.origin.id, fileId: r.id, url: r.origin.url, createdAt: r.importedAt }).run();
        }
      });
    },
    async deletePending(id) {
      // The origins go by their cascade; a pending row has no other dependents.
      return db
        .delete(file)
        .where(and(eq(file.id, id), eq(file.status, 'pending')))
        .run().changes > 0;
    },
    async listPendingDownloadIds() {
      return db
        .selectDistinct({ id: file.id })
        .from(file)
        .innerJoin(fileOrigin, eq(fileOrigin.fileId, file.id))
        .where(eq(file.status, 'pending'))
        .orderBy(asc(file.id))
        .all()
        .map((r) => r.id);
    },
    async markComplete(id, r) {
      db.transaction((tx) => {
        const row = tx
          .update(file)
          .set({ sizeBytes: r.sizeBytes, sha256: r.sha256, width: r.width, height: r.height, status: 'complete', error: null })
          .where(eq(file.id, id))
          .returning({ assetId: file.assetId })
          .get();
        if (!row) throw new NotFoundError(`File ${id} does not exist`);
        reindexAssets(tx, [row.assetId]);
      });
    },
    async setDimensions(id, size) {
      return db.transaction((tx) => {
        // An undefined duration leaves the column as it is; null clears it.
        const values =
          size.durationMs === undefined
            ? { width: size.width, height: size.height }
            : { width: size.width, height: size.height, durationMs: size.durationMs };
        const row = tx.update(file).set(values).where(eq(file.id, id)).returning().get();
        if (!row) throw new NotFoundError(`File ${id} does not exist`);
        return toRecordWithTags(tx, row);
      });
    },
    async markFailed(id, error) {
      db.transaction((tx) => {
        const row = tx
          .update(file)
          .set({ status: 'failed', error })
          .where(eq(file.id, id))
          .returning({ assetId: file.assetId })
          .get();
        if (!row) throw new NotFoundError(`File ${id} does not exist`);
        reindexAssets(tx, [row.assetId]);
      });
    },
    async findCompleteBySha256(sha256) {
      return db.transaction(
        (tx) =>
          toRecords(
            tx,
            tx
              .select()
              .from(file)
              .where(and(eq(file.sha256, sha256), eq(file.status, 'complete'), live())) // a trashed file is no duplicate
              .orderBy(asc(file.importedAt), asc(file.id))
              .all(),
          ),
        { behavior: 'deferred' },
      );
    },
    async listByStatus(status: ImportStatus) {
      return db.transaction(
        (tx) =>
          toRecords(
            tx,
            tx
              .select()
              .from(file)
              .where(eq(file.status, status))
              .orderBy(asc(file.importedAt), asc(file.id))
              .all(),
          ),
        { behavior: 'deferred' },
      );
    },
    async get(id) {
      return db.transaction(
        (tx) => {
          const row = tx.select().from(file).where(eq(file.id, id)).get();
          return row ? toRecordWithTags(tx, row) : null;
        },
        { behavior: 'deferred' },
      );
    },
    async setPlacement(id, placement) {
      // Throwing inside the transaction rolls back both statements.
      return db.transaction((tx) => {
        // A trashed file has no asset and no role; only a restore move places it again.
        const trashed = tx.select({ deletedAt: file.deletedAt }).from(file).where(eq(file.id, id)).get();
        if (trashed?.deletedAt != null) throw new InvalidOperationError('The file is in the trash');
        const left = assetOfFile(tx, id);
        const row = tx
          .update(file)
          .set({ relativePath: placement.relativePath, assetId: placement.assetId, role: placement.role })
          .where(eq(file.id, id))
          .returning()
          .get();
        if (!row) throw new NotFoundError(`File ${id} does not exist`);
        clearCoverOutside(tx, id, placement.assetId);
        reindexAssets(tx, [left, row.assetId]);
        return toRecordWithTags(tx, row);
      });
    },
    async list(q): Promise<FileList> {
      // One read transaction, so the tag ids, the page and the total describe the same snapshot.
      return db.transaction(
        (tx) => {
          const filter = fileListWhere(tx, q);
          if (filter === null) return { items: [], total: 0 };
          const items = toRecords(tx, pageQuery(tx, q, filter.where).all());
          const total = countQuery(tx, filter.where).get()?.n ?? 0;
          return { items, total };
        },
        { behavior: 'deferred' },
      );
    },
    async purge(id) {
      return db.transaction((tx) => {
        const row = tx.select({ deletedAt: file.deletedAt, status: file.status }).from(file).where(eq(file.id, id)).get();
        if (!row || (row.deletedAt === null && row.status !== 'failed')) return false;
        // An open move may have put the binary outside the trash; it is resolved first, never dropped.
        if (tx.select({ fileId: fileMove.fileId }).from(fileMove).where(eq(fileMove.fileId, id)).get()) {
          throw new InvalidOperationError('The file is being moved');
        }
        // A running generation still links its result to this file; its job row must outlive the run.
        const generating = tx
          .select({ id: job.id })
          .from(job)
          .where(and(eq(job.fileId, id), eq(job.type, IMAGE_GENERATE_JOB), eq(job.status, 'running')))
          .get();
        if (generating) throw new InvalidOperationError(RUNNING_GENERATION_MESSAGE);
        // Dependents first, so the foreign keys hold at every statement. A chosen cover is cleared by
        // its `set null` rule (only a failed inbox file could still be one; a trashed file is none), the
        // origins by their cascade.
        tx.delete(fileTag).where(eq(fileTag.fileId, id)).run();
        tx.delete(fileAnalysis).where(eq(fileAnalysis.fileId, id)).run();
        tx.delete(fileAnalysisProposal).where(eq(fileAnalysisProposal.fileId, id)).run();
        tx.delete(job).where(eq(job.fileId, id)).run();
        const left = assetOfFile(tx, id);
        tx.delete(file).where(eq(file.id, id)).run();
        // The tombstone tells the trash sweep that a leftover binary of this id may go.
        if (row.deletedAt !== null) {
          tx.insert(filePurge).values({ fileId: id, purgedAt: new Date().toISOString() }).onConflictDoNothing().run();
        }
        reindexAssets(tx, [left]);
        return true;
      });
    },
    async listPurgedIds() {
      return db
        .select({ id: filePurge.fileId })
        .from(filePurge)
        .orderBy(asc(filePurge.fileId))
        .all()
        .map((r) => r.id);
    },
    async forgetPurge(id) {
      db.delete(filePurge).where(eq(filePurge.fileId, id)).run();
    },
    async countTrashed() {
      return db.select({ n: count() }).from(file).where(trashed()).get()?.n ?? 0;
    },
    async listTrashedIds() {
      return db
        .select({ id: file.id })
        .from(file)
        .where(trashed())
        .orderBy(desc(file.deletedAt), desc(file.id))
        .all()
        .map((r) => r.id);
    },
  };
}
