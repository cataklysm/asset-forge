import { FileKindSchema } from '@assetforge/contracts';
import type { FileList, FileRecord, FileScope, ImportStatus, TagAssignment } from '@assetforge/contracts';
import { NotFoundError, isOpenable, isPreviewable, type FileRepository } from '@assetforge/core';
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { asset, file, fileTag, tag } from './schema.js';
import { assetOfFile, reindexAssets } from './search-index.js';

// Row shape equals FileRecord apart from the tags; spelled out so schema drift fails at compile time.
const toRecord = (row: typeof file.$inferSelect, tags: TagAssignment[]): FileRecord => ({
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
  kind: FileKindSchema.catch('other').parse(row.kind), // the column has no CHECK; an unknown value reads as 'other'
  tags,
});

/** Turns rows into records; the file tags of all rows come from one query. */
export function toRecords(tx: Pick<BetterSQLite3Database, 'select'>, rows: (typeof file.$inferSelect)[]): FileRecord[] {
  if (rows.length === 0) return [];
  const byFile = new Map<string, TagAssignment[]>();
  const assignments = tx
    .select({ fileId: fileTag.fileId, name: tag.name, displayName: tag.displayName, origin: fileTag.origin })
    .from(fileTag)
    .innerJoin(tag, eq(tag.id, fileTag.tagId))
    .where(
      inArray(
        fileTag.fileId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(tag.name), asc(fileTag.origin))
    .all();
  for (const { fileId, ...assignment } of assignments) {
    const list = byFile.get(fileId);
    if (list) list.push(assignment);
    else byFile.set(fileId, [assignment]);
  }
  return rows.map((row) => toRecord(row, byFile.get(row.id) ?? []));
}

export function toRecordWithTags(tx: Pick<BetterSQLite3Database, 'select'>, row: typeof file.$inferSelect): FileRecord {
  return toRecords(tx, [row])[0]!;
}

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

const scopeMatches = (scope: FileScope) => {
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
          kind: r.kind,
          status: 'pending',
        })
        .run();
    },
    async markComplete(id, r) {
      db.transaction((tx) => {
        const row = tx
          .update(file)
          .set({ sizeBytes: r.sizeBytes, sha256: r.sha256, status: 'complete', error: null })
          .where(eq(file.id, id))
          .returning({ assetId: file.assetId })
          .get();
        if (!row) throw new NotFoundError(`File ${id} does not exist`);
        reindexAssets(tx, [row.assetId]);
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
              .where(and(eq(file.sha256, sha256), eq(file.status, 'complete')))
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
    async list({ limit, offset, scope }): Promise<FileList> {
      const where = scopeMatches(scope);
      // One read transaction, so the page and the total describe the same snapshot.
      return db.transaction(
        (tx) => {
          const items = toRecords(
            tx,
            tx
              .select()
              .from(file)
              .where(where)
              .orderBy(desc(file.importedAt), desc(file.id))
              .limit(limit)
              .offset(offset)
              .all(),
          );
          const total = tx.select({ n: count() }).from(file).where(where).get()?.n ?? 0;
          return { items, total };
        },
        { behavior: 'deferred' },
      );
    },
  };
}
