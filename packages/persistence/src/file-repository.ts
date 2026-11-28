import { IMAGE_GENERATE_JOB } from '@assetforge/contracts';
import type { FileList, FileRecord, ImportStatus } from '@assetforge/contracts';
import {
  InvalidOperationError,
  NotFoundError,
  RUNNING_GENERATION_MESSAGE,
  type FileQuery,
  type FileRepository,
} from '@assetforge/core';
import { and, asc, count, desc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { countQuery, fileListWhere, live, pageQuery, trashed } from './file-list.js';
import { clearCoverOutside, toRecordWithTags, toRecords } from './file-records.js';
import { file, fileAnalysis, fileAnalysisProposal, fileMove, fileOrigin, filePurge, fileTag, job } from './schema.js';
import { assetOfFile, reindexAssets } from './search-index.js';
import { dropUnusedTags } from './tag-links.js';

/**
 * The file repository on the workspace database.
 *
 * @param database the workspace database
 * @returns the repository
 */
export function createFileRepository(database: BetterSQLite3Database): FileRepository {
  return {
    insertPending: (pending) => insertPending(database, pending),
    deletePending: (id) => deletePending(database, id),
    listPendingDownloadIds: () => listPendingDownloadIds(database),
    markComplete: (id, result) => markComplete(database, id, result),
    setDimensions: (id, size) => setDimensions(database, id, size),
    markFailed: (id, error) => markFailed(database, id, error),
    findCompleteBySha256: (sha256) => findCompleteBySha256(database, sha256),
    listByStatus: (status) => listByStatus(database, status),
    get: (id) => getFile(database, id),
    setPlacement: (id, placement) => setPlacement(database, id, placement),
    list: (query) => listFiles(database, query),
    purge: (id, purgedAt) => purge(database, id, purgedAt),
    listPurgedIds: () => listPurgedIds(database),
    forgetPurge: (id) => forgetPurge(database, id),
    countTrashed: () => countTrashed(database),
    listTrashedIds: () => listTrashedIds(database),
  };
}

/**
 * Inserts a pending file row and, for a download, its origin, in one transaction.
 *
 * @param database the workspace database
 * @param pending the file
 * @returns nothing
 */
async function insertPending(
  database: BetterSQLite3Database,
  pending: Parameters<FileRepository['insertPending']>[0],
): Promise<void> {
  database.transaction((transaction) => {
    transaction
      .insert(file)
      .values({
        id: pending.id,
        storageId: pending.storageId,
        originalName: pending.originalName,
        relativePath: pending.relativePath,
        mimeType: pending.mimeType,
        importedAt: pending.importedAt,
        kind: pending.kind,
        status: 'pending',
      })
      .run();
    if (pending.origin !== undefined) {
      transaction
        .insert(fileOrigin)
        .values({ id: pending.origin.id, fileId: pending.id, url: pending.origin.url, createdAt: pending.importedAt })
        .run();
    }
  });
}

/**
 * Deletes a pending file row.
 *
 * @param database the workspace database
 * @param id the file
 * @returns true when a pending row was deleted
 */
async function deletePending(database: BetterSQLite3Database, id: string): Promise<boolean> {
  // The origins go by their cascade; a pending row has no other dependents.
  return (
    database
      .delete(file)
      .where(and(eq(file.id, id), eq(file.status, 'pending')))
      .run().changes > 0
  );
}

/**
 * The pending files that have an origin, so a download left them.
 *
 * @param database the workspace database
 * @returns their ids in id order
 */
async function listPendingDownloadIds(database: BetterSQLite3Database): Promise<string[]> {
  return database
    .selectDistinct({ id: file.id })
    .from(file)
    .innerJoin(fileOrigin, eq(fileOrigin.fileId, file.id))
    .where(eq(file.status, 'pending'))
    .orderBy(asc(file.id))
    .all()
    .map((row) => row.id);
}

/**
 * Marks a file complete with its size, checksum and dimensions and reindexes its asset, in one transaction.
 *
 * @param database the workspace database
 * @param id the file
 * @param result the size, checksum and dimensions
 * @returns nothing; rejects with `NotFoundError` for an unknown file
 */
async function markComplete(
  database: BetterSQLite3Database,
  id: string,
  result: Parameters<FileRepository['markComplete']>[1],
): Promise<void> {
  database.transaction((transaction) => {
    const row = transaction
      .update(file)
      .set({
        sizeBytes: result.sizeBytes,
        sha256: result.sha256,
        width: result.width,
        height: result.height,
        status: 'complete',
        error: null,
      })
      .where(eq(file.id, id))
      .returning({ assetId: file.assetId })
      .get();
    if (!row) throw new NotFoundError(`File ${id} does not exist`);
    reindexAssets(transaction, [row.assetId]);
  });
}

/**
 * Stores the measured dimensions and, when given, the duration of a file.
 *
 * @param database the workspace database
 * @param id the file
 * @param size the width, the height and the optional duration
 * @returns the record; rejects with `NotFoundError` for an unknown file
 */
async function setDimensions(
  database: BetterSQLite3Database,
  id: string,
  size: Parameters<FileRepository['setDimensions']>[1],
): Promise<FileRecord> {
  return database.transaction((transaction) => {
    // An undefined duration leaves the column as it is; null clears it.
    const values =
      size.durationMs === undefined
        ? { width: size.width, height: size.height }
        : { width: size.width, height: size.height, durationMs: size.durationMs };
    const row = transaction.update(file).set(values).where(eq(file.id, id)).returning().get();
    if (!row) throw new NotFoundError(`File ${id} does not exist`);
    return toRecordWithTags(transaction, row);
  });
}

/**
 * Marks a file failed with its error and reindexes its asset, in one transaction.
 *
 * @param database the workspace database
 * @param id the file
 * @param error the fixed error message
 * @returns nothing; rejects with `NotFoundError` for an unknown file
 */
async function markFailed(database: BetterSQLite3Database, id: string, error: string): Promise<void> {
  database.transaction((transaction) => {
    const row = transaction
      .update(file)
      .set({ status: 'failed', error })
      .where(eq(file.id, id))
      .returning({ assetId: file.assetId })
      .get();
    if (!row) throw new NotFoundError(`File ${id} does not exist`);
    reindexAssets(transaction, [row.assetId]);
  });
}

/**
 * The complete files outside the trash with this checksum, oldest import first.
 *
 * @param database the workspace database
 * @param sha256 the checksum
 * @returns the records
 */
async function findCompleteBySha256(database: BetterSQLite3Database, sha256: string): Promise<FileRecord[]> {
  return database.transaction(
    (transaction) =>
      toRecords(
        transaction,
        transaction
          .select()
          .from(file)
          .where(and(eq(file.sha256, sha256), eq(file.status, 'complete'), live())) // a trashed file is no duplicate
          .orderBy(asc(file.importedAt), asc(file.id))
          .all(),
      ),
    { behavior: 'deferred' },
  );
}

/**
 * The files in one import status, oldest import first.
 *
 * @param database the workspace database
 * @param status the status
 * @returns the records
 */
async function listByStatus(database: BetterSQLite3Database, status: ImportStatus): Promise<FileRecord[]> {
  return database.transaction(
    (transaction) =>
      toRecords(
        transaction,
        transaction
          .select()
          .from(file)
          .where(eq(file.status, status))
          .orderBy(asc(file.importedAt), asc(file.id))
          .all(),
      ),
    { behavior: 'deferred' },
  );
}

/**
 * One file.
 *
 * @param database the workspace database
 * @param id the file
 * @returns the record; null when it does not exist
 */
async function getFile(database: BetterSQLite3Database, id: string): Promise<FileRecord | null> {
  return database.transaction(
    (transaction) => {
      const row = transaction.select().from(file).where(eq(file.id, id)).get();
      return row ? toRecordWithTags(transaction, row) : null;
    },
    { behavior: 'deferred' },
  );
}

/**
 * Places a file outside the trash: path, asset and role; clears a cover it leaves and reindexes both assets.
 *
 * @param database the workspace database
 * @param id the file
 * @param placement the relative path, the asset (null for the inbox) and the role
 * @returns the record; rejects with `InvalidOperationError` for a trashed file and `NotFoundError` for an unknown one
 */
async function setPlacement(
  database: BetterSQLite3Database,
  id: string,
  placement: Parameters<FileRepository['setPlacement']>[1],
): Promise<FileRecord> {
  // Throwing inside the transaction rolls back both statements.
  return database.transaction((transaction) => {
    // A trashed file has no asset and no role; only a restore move places it again.
    const trashedRow = transaction.select({ deletedAt: file.deletedAt }).from(file).where(eq(file.id, id)).get();
    if (trashedRow?.deletedAt != null) throw new InvalidOperationError('The file is in the trash');
    const left = assetOfFile(transaction, id);
    const row = transaction
      .update(file)
      .set({ relativePath: placement.relativePath, assetId: placement.assetId, role: placement.role })
      .where(eq(file.id, id))
      .returning()
      .get();
    if (!row) throw new NotFoundError(`File ${id} does not exist`);
    clearCoverOutside(transaction, id, placement.assetId);
    reindexAssets(transaction, [left, row.assetId]);
    return toRecordWithTags(transaction, row);
  });
}

/**
 * One page of a file list and the number of files matching its filters.
 *
 * @param database the workspace database
 * @param query the filters and the page
 * @returns the page and the total
 */
async function listFiles(database: BetterSQLite3Database, query: FileQuery): Promise<FileList> {
  // One read transaction, so the tag ids, the page and the total describe the same snapshot.
  return database.transaction(
    (transaction) => {
      const filter = fileListWhere(transaction, query);
      if (filter === null) return { items: [], total: 0 };
      const items = toRecords(transaction, pageQuery(transaction, query, filter.where).all());
      const total = countQuery(transaction, filter.where).get()?.n ?? 0;
      return { items, total };
    },
    { behavior: 'deferred' },
  );
}

/**
 * Deletes a trashed or failed file with its tags, analysis, proposal and jobs, and leaves a tombstone for a trashed
 * one, in one transaction.
 *
 * @param database the workspace database
 * @param id the file
 * @param purgedAt the time stamped on the tombstone
 * @returns true when it was deleted; false for an unknown file or one neither trashed nor failed; rejects with
 *   `InvalidOperationError` while it is being moved or a generation of it runs
 */
async function purge(database: BetterSQLite3Database, id: string, purgedAt: string): Promise<boolean> {
  return database.transaction((transaction) => {
    const row = transaction
      .select({ deletedAt: file.deletedAt, status: file.status })
      .from(file)
      .where(eq(file.id, id))
      .get();
    if (!row || (row.deletedAt === null && row.status !== 'failed')) return false;
    // An open move may have put the binary outside the trash; it is resolved first, never dropped.
    if (transaction.select({ fileId: fileMove.fileId }).from(fileMove).where(eq(fileMove.fileId, id)).get()) {
      throw new InvalidOperationError('The file is being moved');
    }
    // A running generation still links its result to this file; its job row must outlive the run.
    const generating = transaction
      .select({ id: job.id })
      .from(job)
      .where(and(eq(job.fileId, id), eq(job.type, IMAGE_GENERATE_JOB), eq(job.status, 'running')))
      .get();
    if (generating) throw new InvalidOperationError(RUNNING_GENERATION_MESSAGE);
    // Dependents first, so the foreign keys hold at every statement. A chosen cover is cleared by
    // its `set null` rule (only a failed inbox file could still be one; a trashed file is none), the
    // origins by their cascade.
    const tagIds = transaction.select({ tagId: fileTag.tagId }).from(fileTag).where(eq(fileTag.fileId, id)).all();
    transaction.delete(fileTag).where(eq(fileTag.fileId, id)).run();
    dropUnusedTags(
      transaction,
      tagIds.map((link) => link.tagId),
    );
    transaction.delete(fileAnalysis).where(eq(fileAnalysis.fileId, id)).run();
    transaction.delete(fileAnalysisProposal).where(eq(fileAnalysisProposal.fileId, id)).run();
    transaction.delete(job).where(eq(job.fileId, id)).run();
    const left = assetOfFile(transaction, id);
    transaction.delete(file).where(eq(file.id, id)).run();
    // The tombstone tells the trash sweep that a leftover binary of this id may go.
    if (row.deletedAt !== null) {
      transaction.insert(filePurge).values({ fileId: id, purgedAt }).onConflictDoNothing().run();
    }
    reindexAssets(transaction, [left]);
    return true;
  });
}

/**
 * The files with a tombstone.
 *
 * @param database the workspace database
 * @returns their ids in id order
 */
async function listPurgedIds(database: BetterSQLite3Database): Promise<string[]> {
  return database
    .select({ id: filePurge.fileId })
    .from(filePurge)
    .orderBy(asc(filePurge.fileId))
    .all()
    .map((row) => row.id);
}

/**
 * Removes the tombstone of a file.
 *
 * @param database the workspace database
 * @param id the file
 * @returns nothing
 */
async function forgetPurge(database: BetterSQLite3Database, id: string): Promise<void> {
  database.delete(filePurge).where(eq(filePurge.fileId, id)).run();
}

/**
 * The number of files in the trash.
 *
 * @param database the workspace database
 * @returns the count
 */
async function countTrashed(database: BetterSQLite3Database): Promise<number> {
  return database.select({ n: count() }).from(file).where(trashed()).get()?.n ?? 0;
}

/**
 * The files in the trash, newest deletion first.
 *
 * @param database the workspace database
 * @returns their ids
 */
async function listTrashedIds(database: BetterSQLite3Database): Promise<string[]> {
  return database
    .select({ id: file.id })
    .from(file)
    .where(trashed())
    .orderBy(desc(file.deletedAt), desc(file.id))
    .all()
    .map((row) => row.id);
}
